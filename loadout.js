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
  var detail = document.getElementById("loadout-detail");

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

      card.classList.toggle("is-equipped", equipped.indexOf(entry.key) >= 0);
      card.addEventListener("click", function () {
        showDetail(entry);
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

  /* =========================================================
     Card detail — every stat, at the evolution you own
     ========================================================= */

  function statRow(label, value) {
    var row = document.createElement("p");

    row.className = "inspect__row";

    var name = document.createElement("span");
    name.textContent = label;
    row.appendChild(name);

    var amount = document.createElement("span");
    amount.className = "inspect__value";
    amount.textContent = value;
    row.appendChild(amount);

    return row;
  }

  function describeAttack(name) {
    var attack = window.MRTD.stats.attack(name);

    if (!attack) {
      return "None";
    }

    if (attack.shape === "cone") {
      return attack.angle + "° cone, falls to " +
        Math.round(attack.falloffTo * 100) + "% at range";
    }

    return attack.shape === "circle" ? "All in range" : "Single target";
  }

  function showDetail(entry) {
    var stats = window.MRTD.stats;
    var name = entry.key;
    var evolution = entry.evolution;
    var damage = stats.damage(name, 1, evolution);
    var cooldown = stats.cooldown(name);
    var coins = stats.coins(name, 1, evolution);
    var reach = stats.range(name, 1, evolution) / stats.rangePerTile;

    detail.textContent = "";

    var title = document.createElement("p");
    title.className = "inspect__title";
    title.textContent =
      stats.towers[name].label +
      (evolution ? "  ·  Evo " + evolution : "  ·  Base");
    detail.appendChild(title);

    var note = document.createElement("p");
    note.className = "inspect__note";
    note.textContent = "At merge level 1. Merging multiplies these.";
    detail.appendChild(note);

    if (damage > 0) {
      detail.appendChild(statRow("Damage", String(Math.round(damage))));
      detail.appendChild(statRow("Cooldown", cooldown + "s"));
      detail.appendChild(statRow("DPS", String(Math.round(damage / cooldown))));
    }

    if (coins > 0) {
      detail.appendChild(statRow("Cash per wave", String(Math.round(coins))));
    }

    detail.appendChild(statRow("Range", Math.round(reach * 10) / 10 + " tiles"));
    detail.appendChild(statRow("Attack", describeAttack(name)));
    detail.appendChild(statRow("Cost", String(stats.cost(name))));
    detail.appendChild(statRow("Copies held", String(entry.copies)));

    if (evolution) {
      detail.appendChild(
        statRow("Evolution", stats.evolutionSummary(name, evolution))
      );
    }

    var action = document.createElement("button");
    var isEquipped = equipped.indexOf(name) >= 0;

    action.className = "inspect__action";
    action.type = "button";
    action.textContent = isEquipped ? "Unequip" : "Equip";
    action.disabled = !isEquipped && equipped.length >= SLOTS;

    action.addEventListener("click", function () {
      if (isEquipped) {
        unequip(name);
      } else {
        equip(name);
      }

      showDetail(entry);
    });

    detail.appendChild(action);
    detail.hidden = false;
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

  /* Developer mode owns everything at full evolution. */
  function everything() {
    return Object.keys(window.MRTD.stats.towers).map(function (name) {
      return { key: name, evolution: window.MRTD.stats.maxEvolution, copies: 1 };
    });
  }

  function refresh() {
    if (window.MRTD.dev) {
      owned = everything();
      equipped = load().filter(ownedEntry);
      render();
      return Promise.resolve();
    }

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

  /* The evolution a tower fights at: the best copy owned, or the
     ceiling in developer mode. */
  window.MRTD.evolutionOf = function (name) {
    if (window.MRTD.dev) {
      return window.MRTD.stats.maxEvolution;
    }

    var entry = ownedEntry(name);

    return entry ? entry.evolution : 0;
  };
  window.MRTD.refreshLoadout = refresh;

  document.addEventListener("mrtd:unlocked", refresh);
  document.addEventListener("mrtd:dev", refresh);
  document.addEventListener("mrtd:granted", refresh);

  /* Handbook, opened from the lobby corner. */
  var handbook = document.getElementById("handbook");
  var handbookOpen = document.getElementById("handbook-open");
  var handbookClose = document.getElementById("handbook-close");

  if (handbook) {
    handbookOpen.addEventListener("click", function () {
      handbook.hidden = false;
    });

    handbookClose.addEventListener("click", function () {
      handbook.hidden = true;
    });

    handbook.addEventListener("click", function (event) {
      if (event.target === handbook) {
        handbook.hidden = true;
      }
    });
  }
  document.addEventListener("mrtd:locked", function () {
    owned = [];
    equipped = [];
    detail.hidden = true;
    render();
  });

  render();
})();
