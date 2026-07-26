(function () {
  "use strict";

  /* =========================================================
     Tower stats — the single source of truth for balance.

     Two independent scales:

       merge level  1-10, per match, resets every run
       evolution    0-10, permanent, bought with duplicates

     A tower's ROLE decides what evolution improves. Merge
     scaling is the same for everyone.

     Currencies are separate and never convert automatically:
       match coins  earned by farms during a run, spent in-run
       meta coins   spent outside a match, not modelled yet
     ========================================================= */

  /* Per merge level, compounding. Being roots, every two merges is
     exactly x5 damage and x2 range. */
  var MERGE = {
    damage: Math.sqrt(5), // 2.2360
    range: Math.sqrt(2),  // 1.4142
    coins: Math.sqrt(5),  // 2.2360
    health: Math.sqrt(5)  // PLACEHOLDER — merge scaling for spawners unspecified
  };

  /* What one evolution does, by role.
     "multiply" compounds per evolution; "add" is flat per evolution. */
  var ROLES = {
    damage: { stat: "damage", mode: "multiply", rate: 0.175 },
    spawner: { stat: "health", mode: "multiply", rate: 0.15 },
    booster: { stat: "range", mode: "add", amount: 5 },
    economy: { stat: "coins", mode: "multiply", rate: 0.1 }
  };

  var MAX_MERGE = 10;
  var MAX_EVOLUTION = 10;

  /* PLACEHOLDER base values — level 1, evolution 0. Only the farm's
     100 coins is real; damage, range, health and cooldown are
     guesses waiting to be tuned.

     Cooldown is fixed for the life of a tower: it never changes
     with merge level or evolution. */
  var TOWERS = {
    blender: { label: "Blender", role: "damage", damage: 12, range: 90, cooldown: 0.6 },
    dagger: { label: "Dagger", role: "damage", damage: 8, range: 70, cooldown: 0.35 },
    farm: { label: "Farm", role: "economy", damage: 0, range: 0, cooldown: 0, coins: 100 },
    shotgunner: { label: "Shotgunner", role: "damage", damage: 20, range: 110, cooldown: 0.9 },
    sniper: { label: "Sniper", role: "damage", damage: 45, range: 260, cooldown: 1.6 }
  };

  function base(key) {
    return TOWERS[key] || null;
  }

  function roleOf(key) {
    var tower = base(key);

    return tower ? ROLES[tower.role] : null;
  }

  /* The evolution contribution for one stat. Returns a multiplier
     for "multiply" roles and a flat amount for "add" roles, or the
     neutral value when this role does not touch that stat. */
  function evolutionFactor(key, stat, evolution) {
    var role = roleOf(key);
    var steps = evolution || 0;

    if (!role || role.stat !== stat) {
      return role && role.mode === "add" ? 0 : 1;
    }

    if (role.mode === "add") {
      return role.amount * steps;
    }

    return Math.pow(1 + role.rate, steps);
  }

  function damage(key, level, evolution) {
    var tower = base(key);

    if (!tower) {
      return 0;
    }

    return (
      tower.damage *
      Math.pow(MERGE.damage, level - 1) *
      (roleOf(key).stat === "damage" ? evolutionFactor(key, "damage", evolution) : 1)
    );
  }

  /* Boosters add flat range per evolution; everyone else only
     gains range from merging. */
  function range(key, level, evolution) {
    var tower = base(key);

    if (!tower) {
      return 0;
    }

    var scaled = tower.range * Math.pow(MERGE.range, level - 1);
    var role = roleOf(key);

    return role.stat === "range" && role.mode === "add"
      ? scaled + evolutionFactor(key, "range", evolution)
      : scaled;
  }

  function health(key, level, evolution) {
    var tower = base(key);

    if (!tower || !tower.health) {
      return 0;
    }

    return (
      tower.health *
      Math.pow(MERGE.health, level - 1) *
      (roleOf(key).stat === "health" ? evolutionFactor(key, "health", evolution) : 1)
    );
  }

  /* Match coins per wave. Only economy towers earn. */
  function coins(key, level, evolution) {
    var tower = base(key);

    if (!tower || !tower.coins) {
      return 0;
    }

    return (
      tower.coins *
      Math.pow(MERGE.coins, level - 1) *
      evolutionFactor(key, "coins", evolution)
    );
  }

  /* Set at spawn and never changed. */
  function cooldown(key) {
    var tower = base(key);

    return tower ? tower.cooldown : 0;
  }

  /* Human readable summary of what an evolution level is worth,
     for the shop card. */
  function evolutionSummary(key, evolution) {
    var role = roleOf(key);

    if (!role || !evolution) {
      return "";
    }

    if (role.mode === "add") {
      return "+" + role.amount * evolution + " " + role.stat;
    }

    return (
      "+" +
      Math.round((Math.pow(1 + role.rate, evolution) - 1) * 100) +
      "% " +
      role.stat
    );
  }

  window.MRTD = window.MRTD || {};
  window.MRTD.stats = {
    towers: TOWERS,
    roles: ROLES,
    merge: MERGE,
    maxMerge: MAX_MERGE,
    maxEvolution: MAX_EVOLUTION,
    damage: damage,
    range: range,
    health: health,
    coins: coins,
    cooldown: cooldown,
    evolutionSummary: evolutionSummary
  };
})();
