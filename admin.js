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
  var towerSearch = document.getElementById("admin-tower-search");
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

      /* The grant includes the admin, so their own coins, cards
         and upgrades need re-reading. */
      document.dispatchEvent(new CustomEvent("mrtd:granted"));
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

  /* =========================================================
     The card list

     This was five hardcoded <option> tags, written when the game
     had five towers — everything added since could not be granted
     at all. It is built from stats.js now, so a new tower appears
     here the moment it exists.

     Rarest first, matching the Collection tab, with the rarity on
     each line: the list is long enough that alphabetical order
     alone makes the interesting ones hard to find.
     ========================================================= */

  function towerOrder() {
    var stats = window.MRTD.stats;

    return Object.keys(stats.towers).sort(function (a, b) {
      var byRarity =
        stats.rarityRank(stats.rarityOf(a)) -
        stats.rarityRank(stats.rarityOf(b));

      return byRarity || stats.towers[a].label.localeCompare(stats.towers[b].label);
    });
  }

  function buildTowers() {
    var stats = window.MRTD.stats;
    var filter = towerSearch.value.trim().toLowerCase();
    var chosen = towerSelect.value;

    towerSelect.textContent = "";

    /* Random stays whatever the filter is — it is not a tower. */
    var random = document.createElement("option");
    random.value = "";
    random.textContent = "Random";
    towerSelect.appendChild(random);

    var shown = towerOrder().filter(function (key) {
      return !filter || stats.towers[key].label.toLowerCase().indexOf(filter) >= 0;
    });

    shown.forEach(function (key) {
      var option = document.createElement("option");

      option.value = key;
      option.textContent =
        stats.towers[key].label + " · " + stats.rarityOf(key);
      towerSelect.appendChild(option);
    });

    /* Keep the current pick if it survived the filter; otherwise
       a single match selects itself, which is the whole point of
       typing a name. */
    if (chosen && shown.indexOf(chosen) >= 0) {
      towerSelect.value = chosen;
    } else if (shown.length === 1) {
      towerSelect.value = shown[0];
    }
  }

  towerSearch.addEventListener("input", buildTowers);

  towerSearch.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      towerSearch.value = "";
      buildTowers();
    }
  });

  buildTowers();

  giveTowers.addEventListener("click", function () {
    var tower = towerSelect.value || null;
    var copies = Number(copiesInput.value);

    confirmThen(giveTowers, "Give " + copies + " " +
      (tower ? window.MRTD.stats.towers[tower].label : "random") + " card(s) to " +
      (target() ? "online players" : "everyone") + "?", function () {
      api("/rest/v1/rpc/admin_grant_towers", {
        p_tower: tower,
        p_copies: copies,
        p_online_only: target()
      })
        .then(report("Gave cards to"))
        .catch(fail);
    });
  });

  /* Live events. Turning one on reaches every signed in player on
     their next heartbeat, and it lapses by itself. */
  var settingSelect = document.getElementById("admin-setting");
  var minutesSelect = document.getElementById("admin-minutes");
  var eventOn = document.getElementById("admin-event-on");
  var eventOff = document.getElementById("admin-event-off");

  function setEvent(enabled, button) {
    var name = settingSelect.value;
    var minutes = enabled ? Number(minutesSelect.value) : null;

    button.disabled = true;

    api("/rest/v1/rpc/admin_set_setting", {
      p_key: name,
      p_enabled: enabled,
      p_minutes: minutes
    })
      .then(function () {
        setStatus(
          enabled
            ? settingSelect.options[settingSelect.selectedIndex].text +
                " on for " + minutes + " minutes."
            : "Event stopped."
        );
        button.disabled = false;
      })
      .catch(function (error) {
        fail(error);
        button.disabled = false;
      });
  }

  eventOn.addEventListener("click", function () {
    setEvent(true, eventOn);
  });

  eventOff.addEventListener("click", function () {
    setEvent(false, eventOff);
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
