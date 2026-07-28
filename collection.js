(function () {
  "use strict";

  /* =========================================================
     The Collection tab: everything the player owns, and where
     merging happens.

     This used to sit under the chest in the Shop, which had two
     problems. It listed towers from a hardcoded array of five,
     so anything won after that array was written — the axe, the
     boosters, Quantum — simply never appeared no matter how many
     you held. And it put the reward for opening chests directly
     underneath the button that sells them.

     So the list now comes from stats.js, which knows every tower
     that exists, and lives on its own tab.

     Merging still runs as a Postgres function. The browser can
     ask for a merge but cannot grant itself one.
     ========================================================= */

  var MAX_EVOLUTION = 10;

  /* Fallback only — the card normally shows the fully merged top
     view, matching what the board draws. */
  var ICON_LEVEL = 10;

  var list = document.getElementById("collection-list");
  var status = document.getElementById("collection-status");
  var search = document.getElementById("collection-search");
  var mergeAllButton = document.getElementById("collection-evolve-all");

  if (!list) {
    return;
  }

  /* Rows straight from the database, and the current filter. */
  var held = [];
  var query = "";

  /* tower_key -> rarity, read from the chest. Empty until the
     first load answers; stats.js covers the gap. */
  var rarities = {};

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

  function loadHeld() {
    return api(
      "/rest/v1/player_towers?select=tower_key,evolution,copies,shiny&copies=gt.0"
    );
  }

  /* Rarity is really the chest's business, so it is asked rather
     than assumed. If the table is not readable from here the
     stats.js copy takes over and nothing breaks. */
  function loadRarities() {
    return api("/rest/v1/chest_odds?select=tower_key,rarity")
      .then(function (rows) {
        var found = {};

        (rows || []).forEach(function (row) {
          found[row.tower_key] = row.rarity;
        });

        return found;
      })
      .catch(function () {
        return {};
      });
  }

  function rarityOf(key) {
    return rarities[key] || window.MRTD.stats.rarityOf(key);
  }

  /* =========================================================
     Building the list
     ========================================================= */

  function labelFor(key) {
    var tower = window.MRTD.stats.towers[key];

    return tower ? tower.label : key;
  }

  function artFor(key) {
    return window.MRTD.towerArt
      ? window.MRTD.towerArt(key)
      : "towers/" + key + "/" + ICON_LEVEL + ".svg";
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);

    node.className = className;

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  }

  /* Spelling has to be right — no guessing at what was meant —
     but case does not matter and a partial name is enough. */
  function matches(key) {
    if (!query) {
      return true;
    }

    return labelFor(key).toLowerCase().indexOf(query) >= 0;
  }

  /* Every tower in the game, rarest first, each carrying the
     tiers actually held. Towers you own nothing of are dropped
     after the grouping, not before, so the order never depends
     on what happens to be in your collection.

     A tower and its shiny are two groups, never one. They cannot
     merge into each other, so showing their tiers side by side
     would only invite trying. */
  function groups() {
    var stats = window.MRTD.stats;
    var out = [];

    Object.keys(stats.towers)
      .filter(matches)
      .forEach(function (key) {
        [true, false].forEach(function (shiny) {
          var tiers = held
            .filter(function (row) {
              return row.tower_key === key && Boolean(row.shiny) === shiny;
            })
            .sort(function (a, b) {
              return a.evolution - b.evolution;
            });

          if (tiers.length) {
            out.push({
              key: key,
              shiny: shiny,
              rarity: rarityOf(key),
              tiers: tiers
            });
          }
        });
      });

    return out.sort(function (a, b) {
      var byRarity = stats.rarityRank(a.rarity) - stats.rarityRank(b.rarity);

      if (byRarity) {
        return byRarity;
      }

      /* Within a rarity, alphabetical — an arbitrary order would
         shuffle every time the data came back — and a shiny sits
         directly above the normal copy of the same tower. */
      return (
        labelFor(a.key).localeCompare(labelFor(b.key)) ||
        (b.shiny ? 1 : 0) - (a.shiny ? 1 : 0)
      );
    });
  }

  function buildCard(row) {
    var shiny = Boolean(row.shiny);
    var card = element("article", "tower-card");

    card.dataset.evolution = String(row.evolution);

    if (shiny) {
      card.dataset.shiny = "true";
    }

    var icon = document.createElement("img");
    icon.className = "tower-card__icon";
    icon.src = artFor(row.tower_key);
    icon.alt = labelFor(row.tower_key);
    card.appendChild(icon);

    card.appendChild(
      element(
        "p",
        "tower-card__name",
        (shiny ? "Shiny " : "") + labelFor(row.tower_key)
      )
    );

    var meta =
      row.evolution === 0
        ? "Base"
        : "Evolution " + row.evolution + " · " +
          window.MRTD.stats.evolutionSummary(row.tower_key, row.evolution);
    card.appendChild(element("p", "tower-card__meta", meta));

    card.appendChild(element("p", "tower-card__count", "×" + row.copies));

    if (row.copies >= 2 && row.evolution < MAX_EVOLUTION) {
      var button = element("button", "tower-card__evolve", "Merge 2 →");
      button.type = "button";

      button.addEventListener("click", function () {
        merge(row.tower_key, row.evolution, shiny, button);
      });

      card.appendChild(button);
    } else if (row.evolution >= MAX_EVOLUTION) {
      card.appendChild(element("p", "tower-card__maxed", "Fully evolved"));
    }

    return card;
  }

  function render() {
    var shown = groups();

    list.textContent = "";

    if (!shown.length) {
      list.appendChild(
        element(
          "p",
          "collection__empty",
          query
            ? "No tower called “" + query + "” in your collection."
            : "No towers yet — open the chest in the Shop."
        )
      );
      return;
    }

    shown.forEach(function (group) {
      var section = element("section", "collection__group");
      /* Rarity is a data attribute rather than a class so the
         stylesheet colours it from one rule. */
      section.dataset.rarity = group.rarity;

      if (group.shiny) {
        section.dataset.shiny = "true";
      }

      var head = element("div", "collection__group-head");
      head.appendChild(
        element(
          "h3",
          "collection__group-title",
          (group.shiny ? "Shiny " : "") + labelFor(group.key)
        )
      );
      head.appendChild(
        element(
          "p",
          "collection__group-rarity",
          group.shiny ? group.rarity + " · shiny" : group.rarity
        )
      );

      var total = group.tiers.reduce(function (sum, row) {
        return sum + row.copies;
      }, 0);
      head.appendChild(
        element("p", "collection__group-count", total + " owned")
      );

      section.appendChild(head);

      var tiers = element("div", "collection__tiers");
      group.tiers.forEach(function (row) {
        tiers.appendChild(buildCard(row));
      });

      section.appendChild(tiers);
      list.appendChild(section);
    });
  }

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  /* =========================================================
     Actions
     ========================================================= */

  /* Developer mode owns one of everything at full evolution, the
     same as the Towers tab treats it — a single copy, so nothing
     offers a merge that would not really happen. */
  function everything() {
    var all = [];

    Object.keys(window.MRTD.stats.towers).forEach(function (key) {
      [false, true].forEach(function (shiny) {
        all.push({
          tower_key: key,
          evolution: window.MRTD.stats.maxEvolution,
          copies: 1,
          shiny: shiny
        });
      });
    });

    return all;
  }

  function refresh() {
    return Promise.all([loadHeld(), loadRarities()])
      .then(function (results) {
        held = window.MRTD.dev ? everything() : results[0] || [];

        if (Object.keys(results[1]).length) {
          rarities = results[1];
        }

        render();

        /* The Towers tab equips out of the same collection. */
        if (window.MRTD.refreshLoadout) {
          window.MRTD.refreshLoadout();
        }
      })
      .catch(function (error) {
        setStatus(error.message, true);
      });
  }

  function merge(key, evolution, shiny, button) {
    button.disabled = true;
    setStatus("Merging...");

    api("/rest/v1/rpc/evolve_tower", {
      method: "POST",
      body: {
        target_key: key,
        from_evolution: evolution,
        /* Which line to merge. The database pairs like with like,
           so a shiny is never consumed by a normal merge. */
        p_shiny: shiny,
        sandbox: Boolean(window.MRTD.dev)
      }
    })
      .then(function (next) {
        setStatus(
          (shiny ? "Shiny " : "") + labelFor(key) +
            " reached evolution " + next + " · " +
            window.MRTD.stats.evolutionSummary(key, next)
        );
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
        button.disabled = false;
      });
  }

  /* Runs every merge the collection can pay for, lowest tier
     first so pairs cascade upward. */
  mergeAllButton.addEventListener("click", function () {
    mergeAllButton.disabled = true;
    setStatus("Merging...");

    api("/rest/v1/rpc/evolve_all", {
      method: "POST",
      body: { p_sandbox: Boolean(window.MRTD.dev) }
    })
      .then(function (count) {
        setStatus(
          count
            ? count + " merge" + (count === 1 ? "" : "s") + " done."
            : "Nothing to merge — you need two of a tier."
        );
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message, true);
      })
      .then(function () {
        mergeAllButton.disabled = false;
      });
  });

  search.addEventListener("input", function () {
    query = search.value.trim().toLowerCase();
    render();
  });

  /* Escape clears rather than leaving a filter the player has to
     work out how to undo. */
  search.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      search.value = "";
      query = "";
      render();
    }
  });

  document.addEventListener("mrtd:unlocked", function () {
    setStatus("");
    refresh();
  });

  document.addEventListener("mrtd:dev", refresh);
  document.addEventListener("mrtd:granted", refresh);

  /* match.js draws the card art and loads last, so anything
     rendered before it was ready gets redrawn. */
  document.addEventListener("mrtd:art", render);

  document.addEventListener("mrtd:locked", function () {
    held = [];
    list.textContent = "";
    setStatus("");
  });

  window.MRTD = window.MRTD || {};
  window.MRTD.refreshCollection = refresh;
})();
