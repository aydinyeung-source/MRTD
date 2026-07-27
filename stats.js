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
    range: { mode: "multiply", factor: 1.1 },           // +10% per merge
    /* Flat, not compounding: a farm is worth 100 per merge level,
       so a level 10 pays 1000 rather than six figures. */
    coins: { mode: "add", amount: 100 },
    health: { mode: "multiply", factor: Math.sqrt(5) }, // PLACEHOLDER — unspecified
    boost: { mode: "add", amount: 2.5, percent: true }
  };

  /* Scaling every tower gets per evolution regardless of role.
     Role effects below apply on top of this. */
  var EVOLUTION_ALL = {
    range: { mode: "multiply", factor: 1.1 } // +10% per evolution
  };

  /* Cash the player starts a match with — exactly one dagger. */
  var STARTING_CASH = 100;

  var BASE_HP = 1000;

  /* Towers allowed on the field before any upgrade. */
  var BASE_PLACEMENTS = 15;

  /* What each upgrade level is worth. Prices live in the database. */
  var UPGRADES = {
    placements: {
      label: "Placement limit",
      note: "One more tower on the field",
      max: 10
    },
    starting_cash: {
      label: "Starting cash",
      note: "+25 cash at the start of a run",
      max: 10
    },
    quick_buy: {
      label: "Quick buy",
      note: "Hold a hotbar slot to buy merged towers outright. Each level unlocks one merge level higher.",
      max: 9
    },
    game_speed: {
      label: "2× speed",
      note: "Fast forward a match",
      max: 1
    }
  };

  function placementLimit(level) {
    return BASE_PLACEMENTS + (level || 0);
  }

  function startingCash(level) {
    return STARTING_CASH + (level || 0) * 25;
  }

  /* PLACEHOLDER enemies. Speed is tiles per second, bounty is match
     cash. There is no damage stat: an enemy that reaches the base
     takes its REMAINING hp off the base, so wounding something still
     counts even if it gets through. Colours stand in until the SVGs
     arrive. */
  /* dps is what an enemy deals to an ally blocking its path. It
     scales with the same wave curve as health. */
  var ENEMIES = {
    /* The opening fodder. Weak enough that the one dagger a player
       can afford at wave 1 actually kills things. */
    crawler: { label: "Crawler", hp: 60, speed: 1, dps: 12, bounty: 12, colour: "#8a7f9c" },
    grunt: { label: "Grunt", hp: 250, speed: 1.2, dps: 50, bounty: 25, colour: "#7a5c8a" },
    runner: { label: "Runner", hp: 200, speed: 2.6, dps: 40, bounty: 20, colour: "#c98f6a" },
    brute: { label: "Brute", hp: 1200, speed: 0.6, dps: 240, bounty: 120, colour: "#5a6b52" }
  };

  /* PLACEHOLDER wave shape. Endless, so everything scales forever. */
  var WAVE = {
    hpGrowth: 1.12,   // per wave, compounding

    /* Deliberately far below hpGrowth. Bounty compounding anywhere
       near enemy health means late waves pay out faster than there
       is anything to spend it on. */
    bountyGrowth: 1.015,
    countBase: 4,
    countPerWave: 1.5,
    spawnGap: 0.75    // seconds between spawns
  };

  function waveEnemyHp(kind, wave) {
    var enemy = ENEMIES[kind];

    return enemy ? enemy.hp * Math.pow(WAVE.hpGrowth, wave - 1) : 0;
  }

  function waveEnemyDps(kind, wave) {
    var enemy = ENEMIES[kind];

    return enemy ? enemy.dps * Math.pow(WAVE.hpGrowth, wave - 1) : 0;
  }

  function waveBounty(kind, wave) {
    var enemy = ENEMIES[kind];

    return enemy ? enemy.bounty * Math.pow(WAVE.bountyGrowth, wave - 1) : 0;
  }

  function waveCount(wave) {
    return Math.floor(WAVE.countBase + wave * WAVE.countPerWave);
  }

  /* Which enemies appear, by wave. The early waves are crawlers
     only, so the opening is survivable on one tower; everything
     else joins gradually. */
  function wavePool(wave) {
    var pool = ["crawler"];

    if (wave >= 3) {
      pool.push("grunt");
    }

    if (wave >= 6) {
      pool.push("runner");
    }

    if (wave >= 12) {
      pool.push("brute");
    }

    return pool;
  }

  /* Meta coins taken back to the lobby, from the last wave BEATEN. */
  function runReward(wavesBeaten) {
    return Math.floor(5 * Math.pow(Math.max(0, wavesBeaten), 1.25));
  }

  /* What one evolution does, by role. Each effect is either
     "multiply" (compounds per evolution) or "add" (flat per
     evolution). percent: true means the value is itself a
     percentage, so it reads as points rather than a factor. */
  var ROLES = {
    /* 10% a level, so evolution 10 is x2.59 — the same shape as
       range and farm coins. */
    damage: [{ stat: "damage", mode: "multiply", rate: 0.1 }],
    spawner: [{ stat: "health", mode: "multiply", rate: 0.15 }],
    booster: [
      { stat: "boost", mode: "add", amount: 3, percent: true },
      { stat: "range", mode: "add", amount: 5 }
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
  /* Base values: merge level 1, evolution 0. Radius in tiles is
     range / 10, so 20 range is 2 tiles.

     Cooldown is fixed for the life of a tower — it never changes
     with merge level or evolution, so DPS scales purely on damage. */
  var TOWERS = {
    blender: {
      label: "Blender", role: "damage",
      damage: 45, range: 15, cooldown: 0.5, cost: 900, // 90 dps, 0.10 per cash
      attack: { shape: "circle", angle: 360 }
    },
    dagger: {
      /* Best value per coin by a distance, paid for with a one
         tile reach — it only works where the path comes to it. */
      label: "Dagger", role: "damage",
      damage: 100, range: 10, cooldown: 1, cost: 100, // 100 dps, 1.00 per cash
      attack: { shape: "single" }
    },
    axe: {
      /* The dagger's cheaper cousin: four fifths the output, but
         it throws five times as often, so almost nothing is lost
         to overkill on weak enemies. */
      label: "Axe", role: "damage",
      damage: 16, range: 10, cooldown: 0.2, cost: 100, // 80 dps, 0.80 per cash
      attack: { shape: "single" }
    },
    farm: {
      label: "Farm", role: "economy",
      damage: 0, range: 0, cooldown: 0, cost: 250, coins: 100,
      attack: null
    },
    shotgunner: {
      label: "Shotgunner", role: "damage",
      /* Pinned at three times the blender's output. Both scale on
         the same curves, so the ratio holds at every merge level
         and every evolution. */
      damage: 675, range: 20, cooldown: 2.5, cost: 600, // 270 dps, 0.45 per cash
      /* 100 degree spread in front, full damage anywhere inside
         it. No falloff, so all that matters is being in the arc. */
      attack: { shape: "cone", angle: 100 }
    },
    sniper: {
      label: "Sniper", role: "damage",
      damage: 900, range: 60, cooldown: 3, cost: 600, // 300 dps, 0.50 per cash
      attack: { shape: "single" }
    },
    /* The three boosters. Each lifts one stat for every tower
       inside its aura, and `boosts` says which. Their own range
       IS the aura. Boosts never stack — only the strongest of a
       given kind counts. */
    beacon: {
      label: "Beacon", role: "booster", boosts: "range",
      damage: 0, cooldown: 0, cost: 1200,
      boost: 6, range: 25,
      attack: null
    },
    forge: {
      label: "Forge", role: "booster", boosts: "damage",
      damage: 0, cooldown: 0, cost: 1200,
      boost: 6, range: 25,
      attack: null
    },
    metronome: {
      label: "Metronome", role: "booster", boosts: "cooldown",
      damage: 0, cooldown: 0, cost: 1200,
      boost: 6, range: 25,
      attack: null
    },
    quantum: {
      /* 1500 dps to everything in reach at once. Four times the
         blender's efficiency per coin with nearly three times the
         radius — it is meant to be the best thing in the chest,
         and it is priced and gated accordingly. */
      label: "Quantum", role: "damage",
      damage: 150, range: 42, cooldown: 0.1, cost: 5000, // 1500 dps, 0.30 per cash
      attack: { shape: "circle", angle: 360 }
    },
    djtv: {
      /* Does all three boosters' jobs at once, at the same
         strength each. One of these replaces a Beacon, a Forge
         and a Metronome — and since boosts never stack, standing
         one next to those makes them redundant rather than
         additive. */
      label: "DJTV", role: "booster",
      boosts: ["range", "damage", "cooldown"],
      damage: 0, cooldown: 0, cost: 2500,
      boost: 6, range: 25,
      attack: null
    },
    spawner: {
      /* Builds nothing itself. Every 15 seconds it puts an ally on
         the path, which blocks enemies and fights back. Allies are
         where all its strength lives. */
      label: "Spawner", role: "spawner",
      damage: 0, range: 0, cooldown: 0, cost: 1000,
      attack: null,

      allyHp: 60,
      allyDamage: 60,
      allyCooldown: 1,
      /* Fixed at 1.5 tiles forever. Merging and evolving make an
         ally tougher and stronger, never further reaching — only a
         booster can change this. */
      allyRange: 15,
      spawnEvery: 15,

      /* Allies walk up the lane towards the portal, tiles per
         second. They stop to fight anything they meet, and any
         that reach the portal are lost — that, not a cap, is what
         keeps their numbers in check. */
      allySpeed: 0.8
    }
  };

  /* Allies scale on the same curves as everything else: root 5 per
     merge, 10% per evolution, applied to both health and damage. */
  var ALLY = { merge: Math.sqrt(5), evolution: 0.1 };

  function allyStat(base, level, evolution) {
    return (
      base *
      Math.pow(ALLY.merge, (level || 1) - 1) *
      Math.pow(1 + ALLY.evolution, evolution || 0)
    );
  }

  function allyHealth(key, level, evolution) {
    var tower = base(key);

    return tower && tower.allyHp ? allyStat(tower.allyHp, level, evolution) : 0;
  }

  function allyDamage(key, level, evolution) {
    var tower = base(key);

    return tower && tower.allyDamage
      ? allyStat(tower.allyDamage, level, evolution)
      : 0;
  }

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

    /* Scaling every tower gets per evolution, whatever its role. */
    var universal = EVOLUTION_ALL[stat];

    if (universal) {
      value =
        universal.mode === "add"
          ? value + universal.amount * steps
          : value * Math.pow(universal.factor, steps);
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

  /* Human readable summary for the shop card: what every tower gets
     per evolution, then whatever its role adds. */
  function evolutionSummary(key, evolution) {
    if (!evolution) {
      return "";
    }

    var parts = Object.keys(EVOLUTION_ALL).map(function (stat) {
      var curve = EVOLUTION_ALL[stat];

      return describe(
        curve.mode === "add"
          ? { stat: stat, mode: "add", amount: curve.amount }
          : { stat: stat, mode: "multiply", rate: curve.factor - 1 },
        evolution
      );
    });

    effectsFor(key).forEach(function (effect) {
      parts.push(describe(effect, evolution));
    });

    return parts.join(" · ");
  }

  /* Which stats a booster lifts. Always a list, so a tower that
     boosts one thing and one that boosts three are read the same
     way. Empty for everything that is not a booster. */
  function boostsWhat(key) {
    var tower = base(key);

    if (!tower || !tower.boosts) {
      return [];
    }

    return [].concat(tower.boosts);
  }

  function cost(key) {
    var tower = base(key);

    return tower ? tower.cost : 0;
  }

  /* Buying a merged tower outright costs exactly what building it
     from level 1s would: 2^(n-1) towers. So 1n, 2n, 4n, 8n... */
  function buyCost(key, level) {
    return cost(key) * Math.pow(2, (level || 1) - 1);
  }

  /* Half of everything spent building it, so a level 5 refunds
     eight towers' worth and a level 1 refunds half of one. */
  function sellValue(key, level) {
    return buyCost(key, level) / 2;
  }

  window.MRTD = window.MRTD || {};
  window.MRTD.stats = {
    towers: TOWERS,
    roles: ROLES,
    merge: MERGE,
    maxMerge: MAX_MERGE,
    maxEvolution: MAX_EVOLUTION,
    rangePerTile: RANGE_PER_TILE,
    startingCash: STARTING_CASH,
    basePlacements: BASE_PLACEMENTS,
    upgrades: UPGRADES,
    placementLimit: placementLimit,
    startingCashFor: startingCash,
    baseHp: BASE_HP,
    enemies: ENEMIES,
    wave: WAVE,
    waveEnemyHp: waveEnemyHp,
    waveEnemyDps: waveEnemyDps,
    allyHealth: allyHealth,
    allyDamage: allyDamage,
    waveBounty: waveBounty,
    waveCount: waveCount,
    wavePool: wavePool,
    runReward: runReward,
    evolutionAll: EVOLUTION_ALL,
    cost: cost,
    boostsWhat: boostsWhat,
    buyCost: buyCost,
    sellValue: sellValue,
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
