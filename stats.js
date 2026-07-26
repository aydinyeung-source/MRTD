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

  /* One map tile is worth this much range. A tower with 90 range
     reaches 9 tiles. */
  var RANGE_PER_TILE = 10;

  /* PLACEHOLDER base values — level 1, evolution 0. Only the farm's
     100 coins is real; everything else is a guess waiting to be
     tuned. Cooldown is fixed for the life of a tower: it never
     changes with merge level or evolution.

     A booster starts at 6% boost and would look like:
       { label: "...", role: "booster", boost: 6, range: 120, cooldown: 0 }
     A spawner like:
       { label: "...", role: "spawner", health: 50, range: 0, cooldown: 3 } */
  var TOWERS = {
    blender: {
      label: "Blender", role: "damage", damage: 12, range: 90, cooldown: 0.6,
      attack: { shape: "single" }
    },
    dagger: {
      label: "Dagger", role: "damage", damage: 8, range: 70, cooldown: 0.35,
      attack: { shape: "single" }
    },
    farm: {
      label: "Farm", role: "economy", damage: 0, range: 0, cooldown: 0, coins: 100,
      attack: null
    },
    shotgunner: {
      label: "Shotgunner", role: "damage", damage: 20, range: 110, cooldown: 0.9,
      /* A 100 degree spread in front. Full damage at the muzzle,
         falling linearly to 30% at maximum range. */
      attack: { shape: "cone", angle: 100, falloffTo: 0.3 }
    },
    sniper: {
      label: "Sniper", role: "damage", damage: 45, range: 260, cooldown: 1.6,
      attack: { shape: "single" }
    }
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

  /* Percentage a single booster grants to the towers it affects. */
  function boost(key, level, evolution) {
    return statValue(key, "boost", level, evolution);
  }

  /* Boosts DO NOT STACK. A tower sitting inside several booster
     auras gets the single strongest one, never the sum — ten
     boosters at 58.5% grant 58.5%, not 585%.

     Accepts plain percentages or { key, level, evolution }. */
  function effectiveBoost(sources) {
    if (!sources || !sources.length) {
      return 0;
    }

    return sources.reduce(function (best, source) {
      var value =
        typeof source === "number"
          ? source
          : boost(source.key, source.level, source.evolution);

      return value > best ? value : best;
    }, 0);
  }

  /* Applies a boost percentage to any stat value. Always feed this
     the result of effectiveBoost, not a running total. */
  function boosted(value, percent) {
    return value * (1 + (percent || 0) / 100);
  }

  /* Set at spawn and never changed. */
  function cooldown(key) {
    var tower = base(key);

    return tower ? tower.cooldown : 0;
  }

  function attackOf(key) {
    var tower = base(key);

    return tower ? tower.attack : null;
  }

  /* Damage actually dealt at a given distance. Only towers with
     falloff care; everyone else deals full damage anywhere inside
     their range. */
  function damageAtDistance(key, level, evolution, distance) {
    var full = damage(key, level, evolution);
    var reach = range(key, level, evolution);
    var attack = attackOf(key);

    if (!attack || distance > reach) {
      return distance > reach ? 0 : full;
    }

    if (attack.falloffTo === undefined || !reach) {
      return full;
    }

    var ratio = Math.min(distance / reach, 1);

    return full * (1 - ratio * (1 - attack.falloffTo));
  }

  /* Is a target inside the firing arc? Angles in radians.
     Cones face wherever the tower is aimed. */
  function inArc(key, towerAngle, targetAngle) {
    var attack = attackOf(key);

    if (!attack || attack.shape !== "cone") {
      return true;
    }

    var half = (attack.angle * Math.PI) / 360;
    var difference = Math.abs(targetAngle - towerAngle) % (Math.PI * 2);

    if (difference > Math.PI) {
      difference = Math.PI * 2 - difference;
    }

    return difference <= half;
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
    rangePerTile: RANGE_PER_TILE,
    attack: attackOf,
    damageAtDistance: damageAtDistance,
    inArc: inArc,
    damage: damage,
    range: range,
    health: health,
    coins: coins,
    boost: boost,
    effectiveBoost: effectiveBoost,
    boosted: boosted,
    cooldown: cooldown,
    evolutionSummary: evolutionSummary
  };
})();
