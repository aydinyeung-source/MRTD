(function () {
  "use strict";

  /* =========================================================
     The Towers tab: pick which five towers go into a match.

     Only towers the player owns can be equipped, and the highest
     evolution of each is shown first — that is the copy the match
     uses, so the strongest version leads.
     ========================================================= */

  var SLOTS = 5;
  var STORAGE_KEY = "mrtd.loadout";

  var slotsHost = document.getElementById("loadout-slots");
  var ownedHost = document.getElementById("loadout-owned");
  var status = document.getElementById("loadout-status");

  if (!slotsHost) {
    return;
  }

  /* [{ key, evolution, copies }], best evolution first. */
  var owned = [];
  var equipped = [];

  /* =========================================================
     Storage
     ========================================================= */

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

      return Array.isArray(saved) ? saved.slice(0, SLOTS) : [];
    } catch (error) {
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(equipped));
    } catch (error) {
      /* Private browsing can refuse storage. */
    }
  }

  /* =========================================================
     Collection
     ========================================================= */

  function fetchOwned() {
    var session = window.MRTD.session();

    if (!session || !session.access_token) {
      return Promise.resolve([]);
    }

    return fetch(
      window.MRTD.url +
        "/rest/v1/player_towers?select=tower_key,evolution,copies&copies=gt.0",
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
      .catch(function () {
        return [];
      });
  }

  /* One entry per tower, carrying its best evolution. */
  function condense(rows) {
    var best = {};

    rows.forEach(function (row) {
      var current = best[row.tower_key];

      if (!current || row.evolution > current.evolution) {
        best[row.tower_key] = {
          key: row.tower_key,
          evolution: row.evolution,
          copies: row.copies
        };
      }
    });

    return Object.keys(best)
      .map(function (name) {
        return best[name];
      })
      .sort(function (a, b) {
        return b.evolution - a.evolution;
      });
  }

  /* =========================================================
     Rendering
     ========================================================= */

  function ownedEntry(name) {
    return owned.filter(function (entry) {
      return entry.key === name;
    })[0];
  }

  function towerCard(entry, className) {
    var card = document.createElement("button");

    card.className = className;
    card.type = "button";
    card.dataset.tower = entry.key;
    card.dataset.evolution = String(entry.evolution);

    var icon = document.createElement("img");
    icon.className = "loadout__icon";
    icon.src = "towers/" + entry.key + "/1.svg";
    icon.alt = window.MRTD.stats.towers[entry.key].label;
    card.appendChild(icon);

    var name = document.createElement("span");
    name.className = "loadout__name";
    name.textContent = window.MRTD.stats.towers[entry.key].label;
    card.appendChild(name);

    var meta = document.createElement("span");
    meta.className = "loadout__meta";
    meta.textContent = entry.evolution > 0 ? "Evo " + entry.evolution : "Base";
    card.appendChild(meta);

    return card;
  }

  function render() {
    slotsHost.textContent = "";

    for (var index = 0; index < SLOTS; index += 1) {
      var name = equipped[index];
      var entry = name ? ownedEntry(name) : null;

      if (entry) {
        var filled = towerCard(entry, "loadout__slot is-filled");

        filled.addEventListener("click", unequip.bind(null, entry.key));
        slotsHost.appendChild(filled);
      } else {
        var empty = document.createElement("div");

        empty.className = "loadout__slot";
        slotsHost.appendChild(empty);
      }
    }

    ownedHost.textContent = "";

    owned.forEach(function (entry) {
      var card = towerCard(entry, "loadout__card");
      var isEquipped = equipped.indexOf(entry.key) >= 0;

      card.classList.toggle("is-equipped", isEquipped);
      card.addEventListener("click", function () {
        if (isEquipped) {
          unequip(entry.key);
        } else {
          equip(entry.key);
        }
      });

      ownedHost.appendChild(card);
    });

    if (!owned.length) {
      status.textContent = "No towers yet. Open a chest in the Shop.";
    } else if (!equipped.length) {
      status.textContent = "Equip up to five towers to take into a match.";
    } else {
      status.textContent = equipped.length + " of " + SLOTS + " slots filled.";
    }
  }

  function equip(name) {
    if (equipped.indexOf(name) >= 0 || equipped.length >= SLOTS) {
      return;
    }

    equipped.push(name);
    save();
    render();
  }

  function unequip(name) {
    equipped = equipped.filter(function (entry) {
      return entry !== name;
    });
    save();
    render();
  }

  function refresh() {
    return fetchOwned().then(function (rows) {
      owned = condense(rows);

      /* Drop anything no longer owned. */
      equipped = load().filter(function (name) {
        return ownedEntry(name);
      });

      save();
      render();
    });
  }

  /* What the match reads when it builds the hotbar. */
  window.MRTD = window.MRTD || {};
  window.MRTD.loadout = function () {
    return equipped.slice();
  };
  window.MRTD.refreshLoadout = refresh;

  document.addEventListener("mrtd:unlocked", refresh);
  document.addEventListener("mrtd:locked", function () {
    owned = [];
    equipped = [];
    render();
  });

  render();
})();
