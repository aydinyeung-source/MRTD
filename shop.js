(function () {
  "use strict";

  /* =========================================================
     Shop and collection.

     Rolling and evolving both run as Postgres functions, not as
     writes from here — the browser can ask for a roll but cannot
     grant itself one.

     Evolution is meta progression and persists. It is separate
     from the merge levels inside a match.
     ========================================================= */

  var TOWERS = [
    { key: "blender", label: "Blender" },
    { key: "dagger", label: "Dagger" },
    { key: "farm", label: "Farm" },
    { key: "shotgunner", label: "Shotgunner" },
    { key: "sniper", label: "Sniper" }
  ];

  var MAX_EVOLUTION = 10;

  /* Which artwork stands in for the tower in the collection. The
     sprite never changes with evolution — only the border does. */
  var ICON_LEVEL = 1;


  var status = document.getElementById("shop-status");
  var collection = document.getElementById("shop-collection");
  var coinsDisplay = document.getElementById("shop-coins");
  var buyOne = document.getElementById("shop-buy-1");
  var buyTen = document.getElementById("shop-buy-10");
  var oddsLine = document.getElementById("shop-odds");

  if (!collection) {
    return;
  }

  /* The one free summon rides on the single draw button, which
     reverts to the paid version once it has been used. */
  var freeRollAvailable = false;

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

  /* Every logged in player can read the profiles table, so this
     has to filter to your own row or it reads a stranger's. */
  function loadProfile() {
    var id = window.MRTD.userId();

    if (!id) {
      return Promise.resolve({ free_roll_used: true, coins: 0 });
    }

    return api(
      "/rest/v1/profiles?select=free_roll_used,coins&id=eq." + id + "&limit=1"
    ).then(function (rows) {
      return rows[0] || { free_roll_used: true, coins: 0 };
    });
  }

  function loadOdds() {
    return api("/rest/v1/chest_odds?select=tower_key,weight&order=weight.desc")
      .catch(function () {
        return [];
      });
  }

  function loadCollection() {
    return api(
      "/rest/v1/player_towers?select=tower_key,evolution,copies&copies=gt.0"
    );
  }

  /* =========================================================
     Rendering
     ========================================================= */

  /* Each role improves a different stat, so the card asks stats.js
     what this tower's evolution is actually worth. */
  function bonusText(key, evolution) {
    return window.MRTD.stats.evolutionSummary(key, evolution);
  }

  function labelFor(key) {
    var match = TOWERS.filter(function (tower) {
      return tower.key === key;
    })[0];

    return match ? match.label : key;
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);

    node.className = className;

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  }

  function buildCard(row) {
    var card = element("article", "tower-card");
    card.dataset.evolution = String(row.evolution);

    var icon = document.createElement("img");
    icon.className = "tower-card__icon";
    icon.src = "towers/" + row.tower_key + "/" + ICON_LEVEL + ".svg";
    icon.alt = labelFor(row.tower_key);
    card.appendChild(icon);

    card.appendChild(element("p", "tower-card__name", labelFor(row.tower_key)));

    var meta =
      row.evolution === 0
        ? "Base"
        : "Evolution " + row.evolution + " · " +
          bonusText(row.tower_key, row.evolution);
    card.appendChild(element("p", "tower-card__meta", meta));

    card.appendChild(element("p", "tower-card__count", "×" + row.copies));

    if (row.copies >= 2 && row.evolution < MAX_EVOLUTION) {
      var button = element("button", "tower-card__evolve", "Evolve 2 →");
      button.type = "button";

      button.addEventListener("click", function () {
        evolve(row.tower_key, row.evolution, button);
      });

      card.appendChild(button);
    } else if (row.evolution >= MAX_EVOLUTION) {
      card.appendChild(element("p", "tower-card__maxed", "Fully evolved"));
    }

    return card;
  }

  function render(profile, rows) {
    collection.textContent = "";

    var coins = Number(profile.coins || 0);
    var dev = Boolean(window.MRTD.dev);

    freeRollAvailable = !profile.free_roll_used;

    /* Developers spend nothing — the server skips the charge too,
       so this is not just a display trick. */
    coinsDisplay.textContent = dev ? "∞" : String(coins);

    buyOne.textContent = freeRollAvailable
      ? "Summon ×1 — free"
      : "Summon ×1 — 100";
    buyOne.classList.toggle("is-free", freeRollAvailable);
    buyOne.disabled = !freeRollAvailable && !dev && coins < 100;

    buyTen.disabled = !dev && coins < 900;

    if (!rows.length) {
      collection.appendChild(
        element(
          "p",
          "shop__empty",
          profile.free_roll_used
            ? "No towers yet."
            : "Open your free roll to get your first tower."
        )
      );
      return;
    }

    /* Group by tower, then show each evolution tier held. */
    TOWERS.forEach(function (tower) {
      var owned = rows
        .filter(function (row) {
          return row.tower_key === tower.key;
        })
        .sort(function (a, b) {
          return a.evolution - b.evolution;
        });

      if (!owned.length) {
        return;
      }

      var group = element("section", "shop__group");
      group.appendChild(element("h3", "shop__group-title", tower.label));

      var list = element("div", "shop__tiers");
      owned.forEach(function (row) {
        list.appendChild(buildCard(row));
      });

      group.appendChild(list);
      collection.appendChild(group);
    });
  }

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  /* =========================================================
     Actions
     ========================================================= */

  function refresh() {
    return Promise.all([loadProfile(), loadCollection(), loadOdds()])
      .then(function (results) {
        render(results[0], results[1]);
        renderOdds(results[2]);

        /* The Towers tab reads the same collection. */
        if (window.MRTD.refreshLoadout) {
          window.MRTD.refreshLoadout();
        }
      })
      .catch(function (error) {
        setStatus(error.message, true);
      });
  }

  function renderOdds(rows) {
    if (!rows || !rows.length) {
      oddsLine.textContent = "";
      return;
    }

    var total = rows.reduce(function (sum, row) {
      return sum + row.weight;
    }, 0);

    oddsLine.textContent = rows
      .map(function (row) {
        return labelFor(row.tower_key) + " " + Math.round((row.weight / total) * 100) + "%";
      })
      .join("  ·  ");
  }

  function openChest(draws, button) {
    button.disabled = true;
    setStatus("Opening...");

    var sandbox = Boolean(window.MRTD.dev);

    api("/rest/v1/rpc/open_chest", {
      method: "POST",
      body: { draws: draws, sandbox: sandbox }
    })
      .then(function (result) {
        var names = (result || []).map(labelFor);

        setStatus(
          "Got: " + names.join(", ") +
            (sandbox ? "  (dev mode — not kept)" : "")
        );
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
        button.disabled = false;
      });
  }

  function roll() {
    buyOne.disabled = true;
    setStatus("Summoning...");

    api("/rest/v1/rpc/claim_free_roll", { method: "POST", body: {} })
      .then(function (key) {
        setStatus("You got the " + labelFor(key) + "!");
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
        buyOne.disabled = false;
      });
  }

  function evolve(key, evolution, button) {
    button.disabled = true;
    setStatus("Evolving...");

    api("/rest/v1/rpc/evolve_tower", {
      method: "POST",
      body: {
        target_key: key,
        from_evolution: evolution,
        sandbox: Boolean(window.MRTD.dev)
      }
    })
      .then(function (next) {
        setStatus(
          labelFor(key) + " reached evolution " + next +
            " · " + bonusText(key, next)
        );
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
        button.disabled = false;
      });
  }

  /* Same button, two jobs: the free summon while one is owed,
     the paid single draw afterwards. */
  buyOne.addEventListener("click", function () {
    if (freeRollAvailable) {
      roll();
      return;
    }

    openChest(1, buyOne);
  });

  buyTen.addEventListener("click", function () {
    openChest(10, buyTen);
  });

  document.addEventListener("mrtd:unlocked", function () {
    setStatus("");
    refresh();
  });

  document.addEventListener("mrtd:dev", refresh);
  document.addEventListener("mrtd:granted", refresh);

  document.addEventListener("mrtd:locked", function () {
    collection.textContent = "";
    rollPanel.hidden = true;
    setStatus("");
  });
})();
