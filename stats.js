(function () {
  "use strict";

  /* =========================================================
     Tower stats — the single source of truth for balance.

     Two independent scales:

       merge level  1-10, per match, resets every run
       evolution    0-10, permanent, bought with duplicates

     A tower's ROLE decides what evolution improves, and a role
     may improve more than one stat. Merge scaling is the same
     for everyone.

     Currencies are separate and never convert automatically:
       match coins  earned by farms during a run, spent in-run
       meta coins   spent outside a match, not modelled yet
     ========================================================= */

  /* What one merge does. Most stats multiply — being roots, every
     two merges is exactly x5 damage and x2 range.

     Boost is the exception: it is a percentage other towers
     receive, so multiplying it by the x5 curve would have a level
     10 booster granting 1397x. It adds instead. */
  var MERGE = {
    damage: { mode: "multiply", factor: Math.sqrt(5) }, // 2.2360
    range: { mode: "multiply", factor: Math.sqrt(2) },  // 1.4142
    coins: { mode: "multiply", factor: Math.sqrt(5) },
    health: { mode: "multiply", factor: Math.sqrt(5) }, // PLACEHOLDER — unspecified
    boost: { mode: "add", amount: 2.5, percent: true }
  };

  /* What one evolution does, by role. Each effect is either
     "multiply" (compounds per evolution) or "add" (flat per
     evolution). percent: true means the value is itself a
     percentage, so it reads as points rather than a factor. */
  var ROLES = {
    damage: [{ stat: "damage", mode: "multiply", rate: 0.175 }],
    spawner: [{ stat: "health", mode: "multiply", rate: 0.15 }],
    booster: [
      { stat: "boost", mode: "add", amount: 3, percent: true },
      { stat: "range", mode: "add", amount: 2.5 }
    ],
    economy: [{ stat: "coins", mode: "multiply", rate: 0.1 }]
  };

  var MAX_MERGE = 10;
  var MAX_EVOLUTION = 10;

  /* PLACEHOLDER base values — level 1, evolution 0. Only the farm's
     100 coins is real; everything else is a guess waiting to be
     tuned. Cooldown is fixed for the life of a tower: it never
     changes with merge level or evolution.

     A booster starts at 6% boost and would look like:
       { label: "...", role: "booster", boost: 6, range: 120, cooldown: 0 }
     A spawner like:
       { label: "...", role: "spawner", health: 50, range: 0, cooldown: 3 } */
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

  function effectsFor(key) {
    var tower = base(key);

    return tower ? ROLES[tower.role] || [] : [];
  }

  function effectOn(key, stat) {
    return effectsFor(key).filter(function (effect) {
      return effect.stat === stat;
    })[0];
  }

  /* Merge scaling applied first, then evolution on top. Each can be
     multiplicative or additive independently. */
  function statValue(key, stat, level, evolution) {
    var tower = base(key);

    if (!tower || tower[stat] === undefined) {
      return 0;
    }

    var merges = (level || 1) - 1;
    var steps = evolution || 0;
    var curve = MERGE[stat];
    var value = tower[stat];

    if (curve) {
      value =
        curve.mode === "add"
          ? value + curve.amount * merges
          : value * Math.pow(curve.factor, merges);
    }

    var effect = effectOn(key, stat);

    if (!effect || !steps) {
      return value;
    }

    return effect.mode === "add"
      ? value + effect.amount * steps
      : value * Math.pow(1 + effect.rate, steps);
  }

  function damage(key, level, evolution) {
    return statValue(key, "damage", level, evolution);
  }

  function range(key, level, evolution) {
    return statValue(key, "range", level, evolution);
  }

  function health(key, level, evolution) {
    return statValue(key, "health", level, evolution);
  }

  /* Match coins per wave. Only economy towers earn. */
  function coins(key, level, evolution) {
    return statValue(key, "coins", level, evolution);
  }

  /* Percentage a booster grants to the towers it affects. */
  function boost(key, level, evolution) {
    return statValue(key, "boost", level, evolution);
  }

  /* Set at spawn and never changed. */
  function cooldown(key) {
    var tower = base(key);

    return tower ? tower.cooldown : 0;
  }

  function describe(effect, evolution) {
    if (effect.mode === "add") {
      var amount = effect.amount * evolution;

      return "+" + amount + (effect.percent ? "% " : " ") + effect.stat;
    }

    return (
      "+" +
      Math.round((Math.pow(1 + effect.rate, evolution) - 1) * 100) +
      "% " +
      effect.stat
    );
  }

  /* Human readable summary for the shop card. Roles with several
     effects list all of them. */
  function evolutionSummary(key, evolution) {
    if (!evolution) {
      return "";
    }

    return effectsFor(key)
      .map(function (effect) {
        return describe(effect, evolution);
      })
      .join(" · ");
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
    boost: boost,
    cooldown: cooldown,
    evolutionSummary: evolutionSummary
  };
})();
