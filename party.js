(function () {
  "use strict";

  /* =========================================================
     Parties: up to five players in one run.

     This is the lobby half — who is in the party, who leads it,
     and the invites going back and forth. It knows nothing about
     the match itself.

     Everything that changes membership is a Postgres function.
     The browser can ask to join a party and cannot write itself
     into one, which matters here more than usual: party size
     multiplies enemy health, so a client that could add ghost
     members could make every wave five times easier.

     State is polled rather than pushed, on the same interval the
     friends panel already uses. A lobby does not need to be
     quicker than that; the match will.
     ========================================================= */

  var POLL_MS = 3000;

  var panel = document.getElementById("party");
  var openButton = document.getElementById("party-open");
  var closeButton = document.getElementById("party-close");
  var membersHost = document.getElementById("party-members");
  var invitesHost = document.getElementById("party-invites");
  var friendsHost = document.getElementById("party-friends");
  var status = document.getElementById("party-status");
  var leaveButton = document.getElementById("party-leave");
  var badge = document.getElementById("party-badge");
  var dot = document.getElementById("party-dot");

  var popup = document.getElementById("partyrequest");
  var popupText = document.getElementById("partyrequest-text");
  var popupActions = document.getElementById("partyrequest-actions");

  /* How long an invite sits in the corner before folding back to
     the dot. Long enough to read and answer, short enough not to
     sit over the lobby. */
  var POPUP_MS = 10000;

  if (!panel) {
    return;
  }

  /* Whatever party_state() last told us. */
  var state = { party_id: null, leader: null, status: null, members: [], invites: [] };
  var poll = null;

  /* Invite ids already shown in the corner. An invite pops up
     once — polling every three seconds would otherwise re-announce
     the same one forever, and the dot is what carries it after
     that. */
  var announced = {};
  var popupTimer = null;

  /* How often the panel is currently asking. Changes with what
     the party is doing — see pollRate. */
  var rate = POLL_MS;

  /* =========================================================
     Supabase
     ========================================================= */

  function api(path, options) {
    var session = window.MRTD.session();
    var config = options || {};

    if (!session || !session.access_token) {
      return Promise.reject(new Error("Not logged in."));
    }

    return fetch(window.MRTD.url + path, {
      method: config.method || "GET",
      headers: {
        apikey: window.MRTD.key,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: config.body ? JSON.stringify(config.body) : undefined
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          throw new Error(data.message || data.msg || "Request failed");
        }
        return data;
      });
    });
  }

  function rpc(name, body) {
    return api("/rest/v1/rpc/" + name, { method: "POST", body: body || {} });
  }

  /* Accepted friends only — the same people the database will
     let you invite, so the list never offers something that will
     be refused. */
  function loadFriends() {
    var mine = window.MRTD.userId();

    if (!mine) {
      return Promise.resolve([]);
    }

    return api(
      "/rest/v1/friendships?select=requester_id,addressee_id,status" +
        "&status=eq.accepted" +
        "&or=(requester_id.eq." + mine + ",addressee_id.eq." + mine + ")"
    )
      .then(function (rows) {
        var ids = (rows || []).map(function (row) {
          return row.requester_id === mine ? row.addressee_id : row.requester_id;
        });

        if (!ids.length) {
          return [];
        }

        return api(
          "/rest/v1/profiles?select=id,username&id=in.(" + ids.join(",") + ")"
        );
      })
      .catch(function () {
        return [];
      });
  }

  /* =========================================================
     Rendering
     ========================================================= */

  function element(tag, className, text) {
    var node = document.createElement(tag);

    node.className = className;

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  }

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  function isLeader() {
    return state.leader && state.leader === window.MRTD.userId();
  }

  function inParty() {
    return Boolean(state.party_id) && state.members.length > 1;
  }

  /* =========================================================
     The corner popup

     Same place and shape as a trade request, because it is the
     same kind of interruption: someone is asking for an answer.
     It goes away by itself after ten seconds and leaves a dot
     behind, so an invite arriving mid-lobby is noticed without
     having to be dealt with then and there.
     ========================================================= */

  function hidePopup() {
    window.clearTimeout(popupTimer);
    popupTimer = null;
    popup.hidden = true;
  }

  function showPopup(invite) {
    popupText.textContent = "Player " + invite.from + " invited you to a party!";
    popupActions.textContent = "";

    var yes = element("button", "traderequest__button", "Join");
    yes.type = "button";
    yes.addEventListener("click", function () {
      hidePopup();
      act(yes, rpc("accept_party_invite", { p_id: invite.id }), "Joined.");
    });

    var no = element("button", "traderequest__button", "No");
    no.type = "button";
    no.addEventListener("click", function () {
      hidePopup();
      act(no, rpc("decline_party_invite", { p_id: invite.id }), "");
    });

    popupActions.appendChild(yes);
    popupActions.appendChild(no);
    popup.hidden = false;

    window.clearTimeout(popupTimer);
    popupTimer = window.setTimeout(hidePopup, POPUP_MS);
  }

  /* Announces the newest invite not yet shown. Only one at a
     time — two popups in the same corner would sit on top of each
     other, and the dot already says how many are waiting. */
  function announce() {
    var fresh = state.invites.filter(function (invite) {
      return !announced[invite.id];
    });

    if (!fresh.length) {
      return;
    }

    fresh.forEach(function (invite) {
      announced[invite.id] = true;
    });

    showPopup(fresh[0]);
  }

  function render(friends) {
    var mine = window.MRTD.userId();
    var size = state.members.length || 1;
    var full = size >= window.MRTD.stats.maxParty;
    var waiting = state.invites.length;

    /* The corner button carries the count, so party size is
       visible without opening anything — it is the number that
       decides how hard the next run is. */
    if (badge) {
      badge.textContent = inParty() ? "Party " + size + "/5" : "Party";
      badge.classList.toggle("is-on", inParty());
    }

    /* What the popup leaves behind. Stays until the invites are
       actually answered, which is the point — a notice you can
       miss is not a notice. */
    if (dot) {
      dot.hidden = !waiting;
      dot.textContent = String(waiting);
    }

    membersHost.textContent = "";

    if (!state.members.length) {
      membersHost.appendChild(
        element("p", "party__empty", "Not in a party. Invite a friend to start one.")
      );
    }

    state.members.forEach(function (member) {
      var row = element("div", "party__member");

      row.appendChild(
        element(
          "span",
          "party__name",
          member.username + (member.id === mine ? " (you)" : "")
        )
      );

      if (member.id === state.leader) {
        row.appendChild(element("span", "party__tag", "leader"));
      }

      /* Only the leader can remove someone, and never themselves
         — leaving is a different button with different rules. */
      if (isLeader() && member.id !== mine) {
        var kick = element("button", "party__small", "Remove");
        kick.type = "button";
        kick.addEventListener("click", function () {
          act(kick, rpc("kick_from_party", { p_player: member.id }), "Removed.");
        });
        row.appendChild(kick);
      }

      membersHost.appendChild(row);
    });

    /* Invites waiting on you. */
    invitesHost.textContent = "";

    state.invites.forEach(function (invite) {
      var row = element("div", "party__invite");

      row.appendChild(
        element("span", "party__name", invite.from + " invited you")
      );

      var yes = element("button", "party__small is-primary", "Join");
      yes.type = "button";
      yes.addEventListener("click", function () {
        act(yes, rpc("accept_party_invite", { p_id: invite.id }), "Joined.");
      });
      row.appendChild(yes);

      var no = element("button", "party__small", "No");
      no.type = "button";
      no.addEventListener("click", function () {
        act(no, rpc("decline_party_invite", { p_id: invite.id }), "");
      });
      row.appendChild(no);

      invitesHost.appendChild(row);
    });

    /* Friends you could invite, minus the ones already here. */
    friendsHost.textContent = "";

    var already = state.members.map(function (member) {
      return member.id;
    });

    var invitable = (friends || []).filter(function (friend) {
      return already.indexOf(friend.id) < 0;
    });

    if (!invitable.length) {
      friendsHost.appendChild(
        element(
          "p",
          "party__empty",
          friends && friends.length
            ? "Everyone on your list is already here."
            : "Add friends before you can invite anyone."
        )
      );
    }

    invitable.forEach(function (friend) {
      var row = element("div", "party__member");

      row.appendChild(element("span", "party__name", friend.username));

      var ask = element("button", "party__small", "Invite");
      ask.type = "button";
      /* Someone has to lead, and inviting is what creates a party
         — so this is only blocked once a party exists and you are
         not the one running it. */
      ask.disabled = full || (state.party_id && !isLeader());
      ask.addEventListener("click", function () {
        act(ask, rpc("invite_to_party", { p_to: friend.id }), "Invited.");
      });
      row.appendChild(ask);

      friendsHost.appendChild(row);
    });

    leaveButton.hidden = !state.party_id;
    refreshPlayButton();
  }

  /* Play means different things depending on the party, and one
     of them is "not yet".

     A member who is not the leader must not be able to start
     anything: pressing it would give them a solo run, and then
     the leader's start would quietly enrol them in a party run
     they are not in and cannot see. Blocking it is what stops
     that, and saying why is what stops it looking broken. */
  function refreshPlayButton() {
    var play = document.getElementById("play");

    if (!play) {
      return;
    }

    var inRun = Boolean(state.run_id);
    var present = Boolean(state.run_present);
    var waiting = inParty() && !isLeader() && !inRun;

    play.disabled = waiting;

    play.textContent = inRun && !present
      ? "Rejoin"
      : waiting
        ? "Waiting for the leader"
        : "Play";
  }

  /* =========================================================
     Actions
     ========================================================= */

  /* The leader has started; everyone else goes in.

     Only for players the run says are PRESENT. Someone who
     stepped out is deliberately not in it, and pulling them back
     the moment they reached the lobby would make leaving
     impossible — that is what the Rejoin button is for. */
  function followLeader() {
    if (!state.run_id || !state.run_present) {
      return;
    }

    if (!window.MRTD.enterRun || !window.MRTD.matchOpen) {
      return;
    }

    /* The leader is already in the match it just started, and
       anyone mid-run is already where this would send them. */
    if (window.MRTD.matchOpen()) {
      return;
    }

    window.MRTD.enterRun(state.run_id, isLeader());
  }

  /* Polled harder while a party is sitting in the lobby, because
     that is the one moment the delay is felt: everybody is
     looking at the screen waiting for the leader. Three seconds
     of nothing happening after they press it reads as broken.

     Back to the slow rate once a run exists, when nothing on
     this panel is time critical any more. */
  function pollRate() {
    return inParty() && !state.run_id ? 1000 : POLL_MS;
  }

  function repoll() {
    window.clearInterval(poll);
    poll = window.setInterval(refresh, pollRate());
  }

  function act(button, promise, done) {
    button.disabled = true;
    setStatus("");

    promise
      .then(function () {
        setStatus(done);
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
        button.disabled = false;
      });
  }

  function refresh() {
    if (!window.MRTD.session || !window.MRTD.session()) {
      return Promise.resolve();
    }

    return Promise.all([rpc("party_state"), loadFriends()])
      .then(function (results) {
        state = results[0] || state;
        state.members = state.members || [];
        state.invites = state.invites || [];
        render(results[1]);
        announce();
        followLeader();

        /* Only restarted when the interval would actually change,
           since resetting it every poll would keep pushing the
           next one further away. */
        if (pollRate() !== rate) {
          rate = pollRate();
          repoll();
        }
      })
      .catch(function (error) {
        setStatus(error.message, true);
      });
  }

  leaveButton.addEventListener("click", function () {
    act(leaveButton, rpc("leave_party"), "Left the party.");
  });

  /* =========================================================
     What the match reads
     ========================================================= */

  window.MRTD = window.MRTD || {};

  /* Enemy health multiplies by this. Solo is 1, and a party of
     one is also 1 — a party you are alone in should not make the
     game harder for no reason.

     Counted from who is actually IN the run, not from who is in
     the party. Someone sitting in the lobby while four play must
     not make those four's enemies a fifth tougher, and someone
     who stepped out mid-run must not keep the wave scaled for a
     player who is no longer shooting anything. */
  window.MRTD.partySize = function () {
    if (state.run_id) {
      return Math.max(1, Number(state.run_present_count) || 1);
    }

    return Math.max(1, state.members.length || 1);
  };

  window.MRTD.party = function () {
    return {
      id: state.party_id,
      leader: state.leader,
      status: state.status,
      isLeader: isLeader(),
      members: state.members.slice(),

      /* The run this player is tied to, and whether they are
         currently in it. Absent from a live run is the state that
         means "rejoin", and it is the only way to tell that from
         "no run at all". */
      runId: state.run_id || null,
      runPresent: Boolean(state.run_present),
      runPlayers: Number(state.run_present_count) || 0
    };
  };

  /* The leader starts when they like. Whoever has accepted by
     then is who plays — outstanding invites are closed rather
     than waited on, because waiting means one person who has not
     opened the game can stall four, and there is no way to tell
     that apart from someone still deciding. */
  window.MRTD.startParty = function () {
    return rpc("start_party_run").then(function (next) {
      if (next) {
        state = next;
        state.members = state.members || [];
        state.invites = state.invites || [];
        render([]);
      }

      return {
        runId: state.run_id || null,
        players: window.MRTD.partySize()
      };
    });
  };

  /* Back into the run you walked out of. The database refuses if
     it has finished or if everyone else has gone, so the answer
     to "can I still get back in" is asked rather than guessed. */
  window.MRTD.rejoinRun = function () {
    return rpc("rejoin_run").then(function (runId) {
      return refresh().then(function () {
        return runId;
      });
    });
  };

  /* Stepping out. Towers stay behind and keep working; the seat
     stays claimed so this player can come back to it. */
  window.MRTD.leaveRun = function () {
    return rpc("leave_run").catch(function () {
      /* Worth trying, not worth blocking the way out of a match
         over. The run ends by itself once nobody is present. */
    });
  };

  window.MRTD.endParty = function (waves) {
    return rpc("end_party_run", { p_waves: Math.max(0, waves || 0) })
      .catch(function () {
        /* A run ending is not worth an error in the player's
           face — the party reverts on its own next poll. */
      });
  };

  /* Somewhere for the match to put a party failure, since the
     match screen has no status line of its own for this. */
  window.MRTD.partyProblem = function (text) {
    setStatus(text, true);
    panel.hidden = false;
  };

  window.MRTD.refreshParty = refresh;

  /* =========================================================
     Panel
     ========================================================= */

  if (openButton) {
    openButton.addEventListener("click", function () {
      panel.hidden = false;
      refresh();
    });
  }

  if (closeButton) {
    closeButton.addEventListener("click", function () {
      panel.hidden = true;
    });
  }

  panel.addEventListener("click", function (event) {
    if (event.target === panel) {
      panel.hidden = true;
    }
  });

  document.addEventListener("mrtd:unlocked", function () {
    setStatus("");
    refresh();

    /* Polled even while the panel is shut, so an invite shows on
       the corner button without it being open — and so a run the
       leader starts pulls this player in whether or not they are
       looking at the party panel. */
    rate = pollRate();
    repoll();
  });

  document.addEventListener("mrtd:locked", function () {
    window.clearInterval(poll);
    poll = null;
    state = { party_id: null, leader: null, status: null, members: [], invites: [] };
    /* Cleared on sign out, so the next account is told about its
       own invites rather than inheriting these as already seen. */
    announced = {};
    hidePopup();
    panel.hidden = true;
    render([]);
  });
})();
