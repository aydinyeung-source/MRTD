(function () {
  "use strict";

  /* =========================================================
     The Shop: the chest, and nothing else.

     What you own and what you can merge live on the Collection
     tab now — this screen only sells.

     Rolling runs as a Postgres function, not as a write from
     here: the browser can ask for a roll but cannot grant itself
     one.
     ========================================================= */

  /* Fallback only — the card normally shows the fully merged
     top view. The art never changes with evolution; only the
     border does. */
  var ICON_LEVEL = 10;


  var status = document.getElementById("shop-status");
  var coinsDisplay = document.getElementById("shop-coins");
  var buyOne = document.getElementById("shop-buy-1");
  var buyTen = document.getElementById("shop-buy-10");
  var buyAll = document.getElementById("shop-buy-all");
  var oddsLine = document.getElementById("shop-odds");
  var oddsLabel = document.getElementById("shop-odds-label");

  if (!status) {
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

  /* =========================================================
     Rendering
     ========================================================= */

  /* stats.js is the only tower list that is guaranteed complete.
     The local one this file used to keep had five towers in it,
     so everything added since — the axe, the boosters, Quantum —
     came out of the chest showing its raw key instead of a name.

     Pulls arrive as variants: 'sniper' or 'sniper#shiny'. Both
     have to read as names, and a shiny has to say so. */
  function labelFor(name) {
    var variant = window.MRTD.stats.variantOf(name);
    var tower = window.MRTD.stats.towers[variant.key];
    var label = tower ? tower.label : variant.key;

    return variant.shiny ? "Shiny " + label : label;
  }


  function render(profile) {
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
  }

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  /* =========================================================
     Actions
     ========================================================= */

  function refresh() {
    return Promise.all([loadProfile(), loadOdds()])
      .then(function (results) {
        render(results[0]);
        renderOdds(results[1]);

        /* A pull changes what the other two tabs are showing. */
        if (window.MRTD.refreshCollection) {
          window.MRTD.refreshCollection();
        }

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
      /* One decimal, because the shares are not all whole
         numbers, but no trailing ".0" when they are. */
      var percent = (row.weight / total) * 100;

      chance.textContent =
        (percent < 10 ? percent.toFixed(1) : Math.round(percent * 10) / 10) + "%";
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

  /* This used to clear a panel that no longer exists, which threw
     on every sign out. */
  document.addEventListener("mrtd:locked", function () {
    oddsLine.textContent = "";
    coinsDisplay.textContent = "0";
    setStatus("");
  });
})();
