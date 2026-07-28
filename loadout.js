(function () {
  "use strict";

  /* =========================================================
     The Towers tab: pick which five towers go into a match.

     Only towers the player owns can be equipped, and the highest
     evolution of each is shown first — that is the copy the match
     uses, so the strongest version leads.
     ========================================================= */

  /* Per account, not per browser.

     It was one shared key, so two accounts in the same browser
     shared one loadout — and since loading prunes it to what you
     actually own, signing in as the second account rewrote the
     first account's loadout down to whatever they had in common,
     then saved that over it. Testing with two accounts wiped a
     loadout every single time.

     The old key is read once and adopted if this account has
     nothing yet, so an existing loadout survives the change. */
  var STORAGE_ROOT = "mrtd.loadout";

  function storageKey() {
    var id = window.MRTD.userId && window.MRTD.userId();

    return id ? STORAGE_ROOT + "." + id : STORAGE_ROOT;
  }

  /* Five, or six once the Loadout slot upgrade is bought. Read
     fresh every time rather than cached, so buying the upgrade
     takes effect without a reload. Developer mode owns it. */
  function slots() {
    var level = window.MRTD.upgrade ? window.MRTD.upgrade("loadout_slots") : 0;

    return window.MRTD.stats.loadoutSlots(level);
  }

  /* Frozen for as long as this player is tied to a run, present
     in it or not.

     Stepping out of a match, rebuilding the loadout in the lobby
     and coming back would let a player answer a wave they had
     already seen — walk out on the boss, swap in whatever counters
     it, walk back. The towers already on the board are what you
     committed to; the hotbar has to be the same. */
  function lockedByRun() {
    var party = window.MRTD.party ? window.MRTD.party() : null;

    return Boolean(party && party.runId);
  }

  var slotsHost = document.getElementById("loadout-slots");
  var heading = document.getElementById("loadout-heading");
  var ownedHost = document.getElementById("loadout-owned");
  var status = document.getElementById("loadout-status");
  /* The overlay, and the panel inside it that holds the stats. */
  var detail = document.getElementById("loadout-detail");
  var detailPanel = document.getElementById("loadout-detail-panel");

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
      var saved = JSON.parse(localStorage.getItem(storageKey()));

      /* Nothing under this account's key yet: inherit whatever
         the old shared one held. Only once — the moment anything
         is saved, this account has its own. */
      if (!Array.isArray(saved)) {
        saved = JSON.parse(localStorage.getItem(STORAGE_ROOT));
      }

      return Array.isArray(saved) ? saved.slice(0, slots()) : [];
    } catch (error) {
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(equipped));
    } catch (error) {
      /* Private browsing can refuse storage. */
    }
  }

  /* =========================================================
     Collection
     ========================================================= */

  /* Resolves to null when the collection could not be read, and
     only to an array when it genuinely came back. The difference
     matters: this used to answer [] for a failed request as well
     as for an empty collection, and the caller could not tell
     them apart — so a request that failed after a match looked
     like the player owning nothing, and the saved loadout was
     pruned down to nothing and written back. */
  function fetchOwned() {
    var session = window.MRTD.session();

    if (!session || !session.access_token) {
      return Promise.resolve(null);
    }

    return fetch(
      window.MRTD.url +
        "/rest/v1/player_towers?select=tower_key,evolution,copies,shiny&copies=gt.0",
      {
        headers: {
          apikey: window.MRTD.key,
          Authorization: "Bearer " + session.access_token
        }
      }
    )
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  /* One entry per variant, carrying its best evolution. A tower
     and its shiny are two entries, because they are two separate
     things to equip — you take one or the other into a match. */
  function condense(rows) {
    var best = {};

    rows.forEach(function (row) {
      var shiny = Boolean(row.shiny);
      var name = window.MRTD.stats.variantName(row.tower_key, shiny);
      var current = best[name];

      if (!current || row.evolution > current.evolution) {
        best[name] = {
          name: name,
          key: row.tower_key,
          shiny: shiny,
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
        /* Shinies lead their normal twin at equal evolution. */
        return b.evolution - a.evolution || (b.shiny ? 1 : 0) - (a.shiny ? 1 : 0);
      });
  }

  /* =========================================================
     Rendering
     ========================================================= */

  function ownedEntry(name) {
    return owned.filter(function (entry) {
      return entry.name === name;
    })[0];
  }

  /* Cards show the tower as it appears on the board, fully merged.
     Falls back to the plain file if the match module has not
     finished loading yet. */
  function artFor(name) {
    return window.MRTD.towerArt
      ? window.MRTD.towerArt(name)
      : "towers/" + name + "/10.svg";
  }

  function towerCard(entry, className) {
    var card = document.createElement("button");

    card.className = className;
    card.type = "button";
    card.dataset.tower = entry.name;
    card.dataset.evolution = String(entry.evolution);

    if (entry.shiny) {
      card.dataset.shiny = "true";
    }

    var icon = document.createElement("img");
    icon.className = "loadout__icon";
    /* Same art either way — a shiny is marked by its frame, not
       by a second set of drawings. */
    icon.src = artFor(entry.key);
    icon.alt = window.MRTD.stats.towers[entry.key].label;
    card.appendChild(icon);

    var name = document.createElement("span");
    name.className = "loadout__name";
    name.textContent = window.MRTD.stats.towers[entry.key].label;
    card.appendChild(name);

    var meta = document.createElement("span");
    meta.className = "loadout__meta";
    meta.textContent =
      (entry.shiny ? "Shiny · " : "") +
      (entry.evolution > 0 ? "Evo " + entry.evolution : "Base");
    card.appendChild(meta);

    return card;
  }

  function render() {
    var total = slots();

    if (heading) {
      heading.textContent = "Equipped · " + total + " slots";
    }

    slotsHost.textContent = "";

    for (var index = 0; index < total; index += 1) {
      var name = equipped[index];
      var entry = name ? ownedEntry(name) : null;

      if (entry) {
        var filled = towerCard(entry, "loadout__slot is-filled");

        /* Opens the same panel an owned card does, rather than
           unequipping on the spot. One click used to remove a
           tower with nothing shown and nothing to undo it. */
        filled.addEventListener("click", showDetail.bind(null, entry));
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

      card.classList.toggle("is-equipped", equipped.indexOf(entry.name) >= 0);
      card.addEventListener("click", function () {
        showDetail(entry);
      });

      ownedHost.appendChild(card);
    });

    if (lockedByRun()) {
      status.textContent =
        "Locked while your run is going — this is the loadout you took in.";
    } else if (!owned.length) {
      status.textContent = "No towers yet. Open a chest in the Shop.";
    } else if (!equipped.length) {
      status.textContent =
        "Equip up to " + slots() + " towers to take into a match.";
    } else {
      status.textContent = equipped.length + " of " + slots() + " slots filled.";
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
      return attack.falloffTo === undefined
        ? attack.angle + "° cone, full damage"
        : attack.angle + "° cone, falls to " +
            Math.round(attack.falloffTo * 100) + "% at range";
    }

    return attack.shape === "circle" ? "All in range" : "Single target";
  }

  function showDetail(entry) {
    var stats = window.MRTD.stats;
    var name = entry.key;
    var shiny = entry.shiny;
    var evolution = entry.evolution;
    var damage = stats.damage(name, 1, evolution, shiny);
    var cooldown = stats.cooldown(name);
    var coins = stats.coins(name, 1, evolution, shiny);
    var reach = stats.range(name, 1, evolution) / stats.rangePerTile;

    detailPanel.textContent = "";

    var title = document.createElement("p");
    title.className = "inspect__title";
    title.textContent =
      (shiny ? "Shiny " : "") +
      stats.towers[name].label +
      (evolution ? "  ·  Evo " + evolution : "  ·  Base");
    detailPanel.appendChild(title);

    var note = document.createElement("p");
    note.className = "inspect__note";
    note.textContent = "At merge level 1. Merging multiplies these.";
    detailPanel.appendChild(note);

    if (damage > 0) {
      detailPanel.appendChild(statRow("Damage", String(Math.round(damage))));
      detailPanel.appendChild(statRow("Cooldown", cooldown + "s"));
      detailPanel.appendChild(statRow("DPS", String(Math.round(damage / cooldown))));
    }

    if (coins > 0) {
      detailPanel.appendChild(statRow("Cash per wave", String(Math.round(coins))));
    }

    detailPanel.appendChild(statRow("Range", Math.round(reach * 10) / 10 + " tiles"));
    detailPanel.appendChild(statRow("Attack", describeAttack(name)));
    detailPanel.appendChild(statRow("Cost", String(stats.cost(name))));
    detailPanel.appendChild(statRow("Copies held", String(entry.copies)));

    if (evolution) {
      detailPanel.appendChild(
        statRow("Evolution", stats.evolutionSummary(name, evolution))
      );
    }

    if (shiny) {
      detailPanel.appendChild(statRow("Shiny", stats.shinySummary(name)));
    }

    var action = document.createElement("button");
    /* Equipping is per variant, so a shiny and its normal twin
       can both sit in the loadout at once. */
    var isEquipped = equipped.indexOf(entry.name) >= 0;

    action.className = "inspect__action";
    action.type = "button";
    action.textContent = lockedByRun()
      ? "Locked — run in progress"
      : isEquipped ? "Unequip" : "Equip";
    action.disabled = lockedByRun() ||
      (!isEquipped && equipped.length >= slots());

    action.addEventListener("click", function () {
      if (isEquipped) {
        unequip(entry.name);
      } else {
        equip(entry.name);
      }

      /* Closes on the way out. The panel was opened to make one
         decision, and leaving it up over a board that has just
         changed underneath it only invites a second click on a
         button that now means the opposite. */
      closeDetail();
    });

    detailPanel.appendChild(action);

    var close = document.createElement("button");

    close.className = "inspect__close";
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", closeDetail);
    detailPanel.appendChild(close);

    detail.hidden = false;
  }

  function closeDetail() {
    detail.hidden = true;
  }

  /* Clicking the backdrop, but not the panel sitting on it. */
  detail.addEventListener("click", function (event) {
    if (event.target === detail) {
      closeDetail();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !detail.hidden) {
      closeDetail();
    }
  });

  function equip(name) {
    if (lockedByRun() || equipped.indexOf(name) >= 0 ||
        equipped.length >= slots()) {
      return;
    }

    equipped.push(name);
    save();
    render();
  }

  function unequip(name) {
    if (lockedByRun()) {
      return;
    }

    equipped = equipped.filter(function (entry) {
      return entry !== name;
    });
    save();
    render();
  }

  /* Developer mode owns everything at full evolution, shiny and
     normal both, so shinies can be tested without waiting on a
     1% roll. */
  function everything() {
    var stats = window.MRTD.stats;
    var all = [];

    Object.keys(stats.towers).forEach(function (name) {
      [false, true].forEach(function (shiny) {
        all.push({
          name: stats.variantName(name, shiny),
          key: name,
          shiny: shiny,
          evolution: stats.maxEvolution,
          copies: 1
        });
      });
    });

    return all;
  }

  function refresh() {
    if (window.MRTD.dev) {
      owned = everything();
      equipped = load().filter(ownedEntry);
      render();
      return Promise.resolve();
    }

    return fetchOwned().then(function (rows) {
      /* The read failed. Keep showing what we had and, above all,
         do not write a pruned loadout over a good one — a blip
         here is not evidence that anything was lost. */
      if (rows === null) {
        equipped = load();
        render();
        return;
      }

      owned = condense(rows);

      /* Drop anything genuinely no longer owned — traded away,
         or merged into a higher evolution. */
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

  /* The evolution a tower fights at: the best copy owned of that
     exact variant, or the ceiling in developer mode. Takes the
     variant name, so a shiny reports its own evolution and not
     its normal twin's. */
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

  /* The match module supplies the drawn card art, so anything
     rendered before it loaded is redrawn once it is ready. */
  document.addEventListener("mrtd:art", render);

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

    /* Index entries scroll the panel rather than linking, so
       reading the handbook never leaves a hash in the URL that
       a reload would then jump to. */
    handbook.addEventListener("click", function (event) {
      var jump = event.target.dataset && event.target.dataset.jump;

      if (!jump) {
        return;
      }

      var section = document.getElementById(jump);

      if (section) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
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
