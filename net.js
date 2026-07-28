(function () {
  "use strict";

  /* =========================================================
     The live channel.

     Everything else in this game talks to Supabase over REST and
     polls every few seconds. A shared board cannot: a tower
     placed three seconds ago has already been shot past. So this
     is one WebSocket to Supabase Realtime, carrying broadcast
     messages between the browsers in a party.

     There is no SDK. Realtime speaks the Phoenix channel
     protocol, which is four message shapes over a socket:

       phx_join      ask to be on a topic
       heartbeat     say you are still here, or be dropped
       access_token  hand over a fresh JWT
       broadcast     the actual traffic

     Written as one module with no game knowledge at all. It
     moves objects between browsers; what they mean is the
     match's business.

     WHAT THIS IS NOT: authoritative. Anything arriving here was
     sent by another player's browser and is only as honest as
     they are. The host checks what it is told before acting on
     it, and the things that must not be forged — rewards, who
     is in a run — stay in Postgres where a client cannot reach
     them.
     ========================================================= */

  /* Phoenix drops a socket that has not spoken in 60 seconds. */
  var HEARTBEAT_MS = 25000;

  /* Reconnect backoff, in order. Stops at the last one and
     keeps trying at that interval — a player whose wifi died
     for five minutes should still find their way back. */
  var BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

  var socket = null;
  var topic = null;
  var heartbeat = null;
  var reconnect = null;
  var attempts = 0;
  var counter = 0;

  /* Set once connect() is asked for, cleared by disconnect(), so
     a socket that drops knows whether it is wanted back. */
  var wanted = false;
  var joined = false;

  /* event name -> [functions] */
  var listeners = {};

  /* Sent while the socket was down. Replayed on rejoin rather
     than dropped, because the messages that go missing during a
     blip are exactly the ones that matter — a tower placement
     lost is a tower the other players never see. */
  var outbox = [];
  var MAX_OUTBOX = 40;

  function ref() {
    counter += 1;
    return String(counter);
  }

  function socketUrl() {
    var base = String(window.MRTD.url || "").replace(/^http/, "ws");

    return base + "/realtime/v1/websocket?apikey=" +
      encodeURIComponent(window.MRTD.key) + "&vsn=1.0.0";
  }

  function token() {
    var session = window.MRTD.session && window.MRTD.session();

    return session && session.access_token ? session.access_token : null;
  }

  function push(message) {
    if (!socket || socket.readyState !== 1) {
      return false;
    }

    socket.send(JSON.stringify(message));
    return true;
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach(function (fn) {
      try {
        fn(payload);
      } catch (error) {
        /* One bad handler must not stop the others, or a single
           rendering slip would take the whole channel down. */
        if (window.console) {
          window.console.error("net handler failed", error);
        }
      }
    });
  }

  /* =========================================================
     Connection
     ========================================================= */

  function startHeartbeat() {
    window.clearInterval(heartbeat);

    heartbeat = window.setInterval(function () {
      push({ topic: "phoenix", event: "heartbeat", payload: {}, ref: ref() });
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    window.clearInterval(heartbeat);
    heartbeat = null;
  }

  function join() {
    var jwt = token();

    push({
      topic: topic,
      event: "phx_join",
      payload: {
        config: {
          /* self: true so the sender also receives what it sends.
             The host acts on its own messages through the same
             path as everyone else's, which means one code path
             instead of two that have to agree. */
          broadcast: { self: true, ack: false },
          presence: { key: window.MRTD.userId ? window.MRTD.userId() : "" },

          /* A private channel is checked against RLS on
             realtime.messages before anyone is let on. Without
             it the topic is open to anyone who can guess a run
             id — they could not cheat with it, since rewards and
             membership live in Postgres, but they could watch a
             game they were not invited to. */
          private: true
        },

        /* Carried in the join itself, not sent after it. A
           private channel is authorised at the moment of joining,
           so a token arriving a message later is a message too
           late and the join is refused. */
        access_token: jwt
      },
      ref: ref()
    });
  }

  function flush() {
    var pending = outbox.slice();

    outbox = [];

    pending.forEach(function (message) {
      send(message.event, message.payload);
    });
  }

  function scheduleReconnect() {
    if (!wanted || reconnect) {
      return;
    }

    var wait = BACKOFF[Math.min(attempts, BACKOFF.length - 1)];

    attempts += 1;

    reconnect = window.setTimeout(function () {
      reconnect = null;
      open();
    }, wait);
  }

  function open() {
    if (!wanted || !topic) {
      return;
    }

    /* A socket left half open would leak, and two sockets on one
       topic would double every message. */
    if (socket) {
      try {
        socket.onclose = null;
        socket.close();
      } catch (error) {
        /* Already gone. */
      }
    }

    joined = false;

    try {
      socket = new WebSocket(socketUrl());
    } catch (error) {
      scheduleReconnect();
      return;
    }

    socket.onopen = function () {
      attempts = 0;
      startHeartbeat();
      join();
    };

    socket.onmessage = function (event) {
      var message;

      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (message.event === "phx_reply" && message.topic === topic) {
        var ok = message.payload && message.payload.status === "ok";

        if (ok && !joined) {
          joined = true;
          emit("_open", {});
          flush();
          return;
        }

        /* A private channel refuses anyone RLS does not recognise
           as being in this run. Retrying forever would look
           exactly like a slow connection, so it is reported
           instead — the usual cause is a run that has ended, and
           the answer is to go back to the lobby, not to wait. */
        if (!ok && !joined) {
          var reason =
            (message.payload &&
              message.payload.response &&
              (message.payload.response.reason ||
                message.payload.response.error)) ||
            "not allowed on this channel";

          wanted = false;
          emit("_refused", { reason: reason });
        }

        return;
      }

      /* Realtime wraps a broadcast: the outer event is
         "broadcast" and the real one is inside the payload. */
      if (message.event === "broadcast" && message.payload) {
        emit(message.payload.event, message.payload.payload);
        return;
      }

      /* The server can ask a client to go away and come back,
         usually because the token expired. */
      if (message.event === "phx_close" || message.event === "phx_error") {
        joined = false;
        scheduleReconnect();
      }
    };

    socket.onclose = function () {
      joined = false;
      stopHeartbeat();
      emit("_closed", {});
      scheduleReconnect();
    };

    socket.onerror = function () {
      /* onclose always follows, so the reconnect is handled
         there rather than twice. */
    };
  }

  /* =========================================================
     What the match uses
     ========================================================= */

  function send(event, payload) {
    if (!wanted) {
      return false;
    }

    var sent = joined && push({
      topic: topic,
      event: "broadcast",
      payload: { type: "broadcast", event: event, payload: payload },
      ref: ref()
    });

    if (!sent) {
      /* Oldest first out. A backlog longer than this is a socket
         that has been down long enough that replaying stale
         positions would be worse than dropping them. */
      outbox.push({ event: event, payload: payload });

      if (outbox.length > MAX_OUTBOX) {
        outbox.shift();
      }
    }

    return sent;
  }

  function connect(name) {
    wanted = true;
    topic = "realtime:" + name;
    attempts = 0;
    open();
  }

  function disconnect() {
    wanted = false;
    joined = false;
    outbox = [];

    window.clearTimeout(reconnect);
    reconnect = null;
    stopHeartbeat();

    if (socket) {
      try {
        socket.onclose = null;
        socket.close();
      } catch (error) {
        /* Already gone. */
      }
    }

    socket = null;
    topic = null;
  }

  function on(event, fn) {
    listeners[event] = listeners[event] || [];
    listeners[event].push(fn);
  }

  function off(event) {
    delete listeners[event];
  }

  window.MRTD = window.MRTD || {};

  window.MRTD.net = {
    connect: connect,
    disconnect: disconnect,
    send: send,
    on: on,
    off: off,
    isReady: function () {
      return Boolean(joined);
    },
    /* For the match to show "reconnecting..." rather than
       silently freezing. */
    isWanted: function () {
      return wanted;
    }
  };

  /* A refreshed JWT has to reach the socket too, or Realtime
     drops the connection when the old one expires mid-run. */
  document.addEventListener("mrtd:token", function () {
    var jwt = token();

    if (joined && jwt) {
      push({
        topic: topic,
        event: "access_token",
        payload: { access_token: jwt },
        ref: ref()
      });
    }
  });

  document.addEventListener("mrtd:locked", disconnect);
})();
