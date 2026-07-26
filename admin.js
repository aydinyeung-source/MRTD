(function () {
  "use strict";

  /* =========================================================
     Admin panel.

     Everything here is gated twice: the panel only renders for
     an account the database flags AND names as an admin, and
     every function refuses in Postgres regardless of what the
     browser sends.

     Unlike developer mode, these grants are real and permanent —
     they land on other people's accounts and are written to
     admin_grants.
     ========================================================= */

  var panel = document.getElementById("admin");

  if (!panel) {
    return;
  }

  var onlineCount = document.getElementById("admin-online");
  var status = document.getElementById("admin-status");
  var onlineOnly = document.getElementById("admin-online-only");

  var coinsInput = document.getElementById("admin-coins");
  var chestsInput = document.getElementById("admin-chests");
  var towerSelect = document.getElementById("admin-tower");
  var copiesInput = document.getElementById("admin-copies");
  var messageInput = document.getElementById("admin-message");

  var giveCoins = document.getElementById("admin-give-coins");
  var giveChests = document.getElementById("admin-give-chests");
  var giveTowers = document.getElementById("admin-give-towers");
  var sendMessage = document.getElementById("admin-send");

  var pending = null;
  var onlineTimer = null;

  function api(path, body) {
    var session = window.MRTD.session();

    if (!session || !session.access_token) {
      return Promise.reject(new Error("Not logged in"));
    }

    return fetch(window.MRTD.url + path, {
      method: "POST",
      headers: {
        apikey: window.MRTD.key,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          throw new Error(data.message || data.msg || "Request failed");
        }
        return data;
      });
    });
  }

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  function refreshOnline() {
    api("/rest/v1/rpc/online_count")
      .then(function (count) {
        onlineCount.textContent = String(count || 0);
      })
      .catch(function () {
        onlineCount.textContent = "?";
      });
  }

  /* Grants hit other people's accounts and cannot be undone, so
     every button asks once before it fires. */
  function confirmThen(button, label, run) {
    if (pending === button) {
      pending = null;
      button.textContent = button.dataset.label;
      button.classList.remove("is-armed");
      run();
      return;
    }

    if (pending) {
      pending.textContent = pending.dataset.label;
      pending.classList.remove("is-armed");
    }

    pending = button;
    button.dataset.label = button.dataset.label || button.textContent;
    button.textContent = "Confirm?";
    button.classList.add("is-armed");
    setStatus(label);
  }

  function target() {
    return onlineOnly.checked;
  }

  function report(verb) {
    return function (count) {
      setStatus(verb + " " + count + " player" + (count === 1 ? "" : "s") + ".");
      refreshOnline();
    };
  }

  function fail(error) {
    setStatus(error.message, true);
  }

  giveCoins.addEventListener("click", function () {
    var amount = Number(coinsInput.value);

    confirmThen(giveCoins, "Give " + amount + " coins to " +
      (target() ? "online players" : "everyone") + "?", function () {
      api("/rest/v1/rpc/admin_grant_coins", {
        amount: amount,
        online_only: target()
      })
        .then(report("Gave coins to"))
        .catch(fail);
    });
  });

  giveChests.addEventListener("click", function () {
    var draws = Number(chestsInput.value);

    confirmThen(giveChests, "Give " + draws + " chest(s) each to " +
      (target() ? "online players" : "everyone") + "?", function () {
      api("/rest/v1/rpc/admin_grant_chests", {
        draws: draws,
        online_only: target()
      })
        .then(report("Opened chests for"))
        .catch(fail);
    });
  });

  giveTowers.addEventListener("click", function () {
    var tower = towerSelect.value || null;
    var copies = Number(copiesInput.value);

    confirmThen(giveTowers, "Give " + copies + " " +
      (tower || "random") + " card(s) to " +
      (target() ? "online players" : "everyone") + "?", function () {
      api("/rest/v1/rpc/admin_grant_towers", {
        tower_key: tower,
        copies: copies,
        online_only: target()
      })
        .then(report("Gave cards to"))
        .catch(fail);
    });
  });

  sendMessage.addEventListener("click", function () {
    var body = messageInput.value.trim();

    if (!body) {
      setStatus("Message is empty.", true);
      return;
    }

    api("/rest/v1/rpc/admin_announce", { body: body })
      .then(function () {
        messageInput.value = "";
        setStatus("Broadcast sent.");
      })
      .catch(fail);
  });

  messageInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      sendMessage.click();
    }
  });

  /* The panel appears only once the server has confirmed this
     account is an admin. */
  function reveal() {
    var session = window.MRTD.session();
    var id = window.MRTD.userId();

    if (!session || !session.access_token || !id) {
      return;
    }

    /* Filtered to your own row: profiles are readable by everyone,
       so an unfiltered query returns a stranger. */
    fetch(
      window.MRTD.url +
        "/rest/v1/profiles?select=is_dev,username&id=eq." + id + "&limit=1",
      {
        headers: {
          apikey: window.MRTD.key,
          Authorization: "Bearer " + session.access_token
        }
      }
    )
      .then(function (response) {
        return response.ok ? response.json() : [];
      })
      .then(function (rows) {
        var allowed = rows.length && rows[0].is_dev;

        panel.hidden = !allowed;

        if (allowed) {
          refreshOnline();
          onlineTimer = window.setInterval(refreshOnline, 15000);
        }
      })
      .catch(function () {
        panel.hidden = true;
      });
  }

  document.addEventListener("mrtd:unlocked", reveal);
  document.addEventListener("mrtd:locked", function () {
    panel.hidden = true;

    if (onlineTimer) {
      window.clearInterval(onlineTimer);
      onlineTimer = null;
    }
  });
})();
