(function () {
  "use strict";

  /* =========================================================
     Player Upgrades tab.

     Levels and prices both come from the database, and buying
     happens in Postgres. The match reads the owned levels from
     window.MRTD.upgrade().
     ========================================================= */

  var host = document.getElementById("upgrades-list");
  var coinsDisplay = document.getElementById("upgrades-coins");
  var status = document.getElementById("upgrades-status");

  if (!host) {
    return;
  }

  var owned = {};
  var costs = {};
  var coins = 0;

  function api(path, options) {
    var session = window.MRTD.session();
    var config = options || {};

    if (!session || !session.access_token) {
      return Promise.reject(new Error("Not logged in"));
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

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  /* Developer mode owns every upgrade outright, so the tab shows
     them maxed rather than at the account's real levels. */
  function levelOf(name) {
    if (window.MRTD.dev) {
      return window.MRTD.stats.upgrades[name].max;
    }

    return owned[name] || 0;
  }

  /* Price of the NEXT level, or null when maxed. */
  function nextCost(name) {
    var level = levelOf(name);
    var table = costs[name] || {};

    return table[level + 1] === undefined ? null : table[level + 1];
  }

  /* What the upgrade is currently worth, in its own terms. */
  function valueFor(name, level) {
    var stats = window.MRTD.stats;

    if (name === "placements") {
      return stats.placementLimit(level) + " towers";
    }

    if (name === "starting_cash") {
      return stats.startingCashFor(level) + " cash";
    }

    if (name === "quick_buy") {
      return level ? "up to merge " + (level + 1) : "locked";
    }

    return level ? "unlocked" : "locked";
  }

  /* One segment per level, filled up to what is owned — a bar
     graph running the length of the row. */
  function meter(level, max) {
    var track = document.createElement("div");

    track.className = "upgrade__meter";

    for (var i = 1; i <= max; i += 1) {
      var segment = document.createElement("span");

      segment.className = "upgrade__seg";

      if (i <= level) {
        segment.classList.add("is-filled");
      }

      track.appendChild(segment);
    }

    return track;
  }

  function row(name) {
    var definition = window.MRTD.stats.upgrades[name];
    var level = levelOf(name);
    var price = nextCost(name);
    var dev = Boolean(window.MRTD.dev);

    var card = document.createElement("article");
    card.className = "upgrade";

    var info = document.createElement("div");
    info.className = "upgrade__info";

    var title = document.createElement("p");
    title.className = "upgrade__name";
    title.textContent = definition.label;
    info.appendChild(title);

    var note = document.createElement("p");
    note.className = "upgrade__note";
    note.textContent = definition.note;
    info.appendChild(note);

    card.appendChild(info);

    var track = document.createElement("div");
    track.className = "upgrade__progress";

    track.appendChild(meter(level, definition.max));

    var counts = document.createElement("p");
    counts.className = "upgrade__counts";
    counts.textContent =
      level + " / " + definition.max + "  ·  " + valueFor(name, level);
    track.appendChild(counts);

    card.appendChild(track);

    var button = document.createElement("button");
    button.className = "upgrade__buy";
    button.type = "button";

    if (price === null) {
      button.textContent = "Maxed";
      button.disabled = true;
    } else {
      button.textContent = dev ? "Free" : String(price);
      button.disabled = !dev && coins < price;
      button.addEventListener("click", function () {
        buy(name, button);
      });
    }

    card.appendChild(button);

    return card;
  }

  function render() {
    coinsDisplay.textContent = window.MRTD.dev ? "∞" : String(coins);
    host.textContent = "";

    Object.keys(window.MRTD.stats.upgrades).forEach(function (name) {
      host.appendChild(row(name));
    });
  }

  function buy(name, button) {
    button.disabled = true;
    setStatus("Buying...");

    api("/rest/v1/rpc/buy_upgrade", {
      method: "POST",
      body: { p_key: name, p_sandbox: Boolean(window.MRTD.dev) }
    })
      .then(function (level) {
        setStatus(
          window.MRTD.stats.upgrades[name].label + " is now level " + level +
            (window.MRTD.dev ? "  (dev mode — not kept)" : "")
        );
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
        button.disabled = false;
      });
  }

  function refresh() {
    var id = window.MRTD.userId && window.MRTD.userId();

    if (!id) {
      return Promise.resolve();
    }

    return Promise.all([
      api("/rest/v1/player_upgrades?select=upgrade_key,level"),
      api("/rest/v1/upgrade_costs?select=upgrade_key,level,cost"),
      api("/rest/v1/profiles?select=coins&id=eq." + id + "&limit=1")
    ])
      .then(function (results) {
        owned = {};
        results[0].forEach(function (entry) {
          owned[entry.upgrade_key] = entry.level;
        });

        costs = {};
        results[1].forEach(function (entry) {
          costs[entry.upgrade_key] = costs[entry.upgrade_key] || {};
          costs[entry.upgrade_key][entry.level] = entry.cost;
        });

        coins = Number((results[2][0] || {}).coins || 0);

        render();
      })
      .catch(function (error) {
        setStatus(error.message, true);
      });
  }

  /* What the match asks for. Developer mode owns everything. */
  window.MRTD = window.MRTD || {};
  window.MRTD.upgrade = levelOf;
  window.MRTD.refreshUpgrades = refresh;

  document.addEventListener("mrtd:unlocked", refresh);
  document.addEventListener("mrtd:dev", render);
  document.addEventListener("mrtd:granted", refresh);
  document.addEventListener("mrtd:locked", function () {
    owned = {};
    coins = 0;
    render();
  });

  render();
})();
