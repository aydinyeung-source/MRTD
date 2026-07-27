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

  /* Fallback only — the card normally shows the fully merged
     top view. The art never changes with evolution; only the
     border does. */
  var ICON_LEVEL = 10;


  var status = document.getElementById("shop-status");
  var collection = document.getElementById("shop-collection");
  var coinsDisplay = document.getElementById("shop-coins");
  var buyOne = document.getElementById("shop-buy-1");
  var buyTen = document.getElementById("shop-buy-10");
  var buyAll = document.getElementById("shop-buy-all");
  var evolveAllButton = document.getElementById("shop-evolve-all");
  var oddsLine = document.getElementById("shop-odds");
  var oddsLabel = document.getElementById("shop-odds-label");

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
    /* The line-up rotates every half hour, so the chest is asked
       what is in it now rather than reading the whole table. */
    return api("/rest/v1/rpc/active_chest", { method: "POST", body: {} })
      .then(function (rows) {
        return (rows || []).sort(function (a, b) {
          return b.weight - a.weight;
        });
      })
      .catch(function () {
        return [];
      });
  }

  /* Same half hour boundary the database uses, so the countdown
     agrees with the rotation without asking. */
  function untilRotation() {
    var slot = 1800000;
    var next = (Math.floor(Date.now() / slot) + 1) * slot;
    var left = Math.max(0, Math.round((next - Date.now()) / 1000));
    var minutes = Math.floor(left / 60);
    var seconds = left % 60;

    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
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
    /* The tower as it looks fully merged, matching the board. */
    icon.src = window.MRTD.towerArt
      ? window.MRTD.towerArt(row.tower_key)
      : "towers/" + row.tower_key + "/" + ICON_LEVEL + ".svg";
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
    buyAll.disabled = !dev && coins < 100;
    buyAll.textContent = dev
      ? "Summon all — free"
      : "Summon all — " + Math.floor(coins / 100) + "×";

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

  /* Everything the chest can give, with its real odds read from
     the database rather than written here. */
  function renderOdds(rows) {
    oddsLine.textContent = "";

    if (oddsLabel) {
      oddsLabel.textContent = "Contents · rotates in " + untilRotation();
    }

    if (!rows || !rows.length) {
      return;
    }

    var total = rows.reduce(function (sum, row) {
      return sum + row.weight;
    }, 0);

    rows.forEach(function (row) {
      var item = document.createElement("article");

      item.className = "chestitem";
      /* Rarity comes from the database, so the colours cannot
         drift from the odds they describe. */
      item.dataset.rarity = row.rarity || "common";

      var rarity = document.createElement("p");
      rarity.className = "chestitem__rarity";
      rarity.textContent = row.rarity || "common";
      item.appendChild(rarity);

      var chance = document.createElement("p");
      chance.className = "chestitem__chance";
      chance.textContent = Math.round((row.weight / total) * 100) + "%";
      item.appendChild(chance);

      var icon = document.createElement("img");
      icon.className = "chestitem__icon";
      icon.src = window.MRTD.towerArt
        ? window.MRTD.towerArt(row.tower_key)
        : "towers/" + row.tower_key + "/" + ICON_LEVEL + ".svg";
      icon.alt = labelFor(row.tower_key);
      item.appendChild(icon);

      var name = document.createElement("p");
      name.className = "chestitem__name";
      name.textContent = labelFor(row.tower_key);
      item.appendChild(name);

      oddsLine.appendChild(item);
    });
  }

  /* A long pull is unreadable as a list, so identical towers are
     counted rather than repeated. */
  function summarise(result) {
    var tally = {};

    (result || []).forEach(function (name) {
      tally[name] = (tally[name] || 0) + 1;
    });

    return Object.keys(tally)
      .sort(function (a, b) {
        return tally[b] - tally[a];
      })
      .map(function (name) {
        return tally[name] + "× " + labelFor(name);
      })
      .join(", ");
  }

  /* The body is passed through untouched: the two functions name
     their sandbox argument differently, and sending both makes
     PostgREST look for a signature that does not exist. */
  function pull(path, body, button) {
    var sandbox = Boolean(window.MRTD.dev);

    button.disabled = true;
    setStatus("Opening...");

    api(path, { method: "POST", body: body })
      .then(function (result) {
        setStatus(
          "Got: " + summarise(result) +
            (sandbox ? "  (dev mode — not kept)" : "")
        );
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
      })
      .then(function () {
        button.disabled = false;
      });
  }

  function openChest(draws, button) {
    pull(
      "/rest/v1/rpc/open_chest",
      { draws: draws, sandbox: Boolean(window.MRTD.dev) },
      button
    );
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

  /* Every coin, at the single draw price — convenience over value.
     This one names its argument p_sandbox, not sandbox. */
  buyAll.addEventListener("click", function () {
    pull(
      "/rest/v1/rpc/open_chest_all",
      { p_sandbox: Boolean(window.MRTD.dev) },
      buyAll
    );
  });

  /* Runs every evolution the collection can pay for, lowest tier
     first so pairs cascade upward. */
  evolveAllButton.addEventListener("click", function () {
    evolveAllButton.disabled = true;
    setStatus("Evolving...");

    api("/rest/v1/rpc/evolve_all", {
      method: "POST",
      body: { p_sandbox: Boolean(window.MRTD.dev) }
    })
      .then(function (count) {
        setStatus(
          count
            ? count + " evolution" + (count === 1 ? "" : "s") + " done."
            : "Nothing to evolve — you need two of a tier."
        );
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
      })
      .then(function () {
        evolveAllButton.disabled = false;
      });
  });

  document.addEventListener("mrtd:unlocked", function () {
    setStatus("");
    refresh();
  });

  document.addEventListener("mrtd:dev", refresh);
  document.addEventListener("mrtd:granted", refresh);

  /* Keeps the countdown honest, and pulls the new line-up in when
     the half hour turns over. */
  window.setInterval(function () {
    if (!oddsLabel) {
      return;
    }

    var wasEnding = oddsLabel.textContent.indexOf("0:0") >= 0;

    oddsLabel.textContent = "Contents · rotates in " + untilRotation();

    if (wasEnding && untilRotation().indexOf("29:") === 0) {
      refresh();
    }
  }, 1000);

  document.addEventListener("mrtd:locked", function () {
    collection.textContent = "";
    rollPanel.hidden = true;
    setStatus("");
  });
})();
