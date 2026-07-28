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
    /* Doubles every merge, so a level 10 farm pays 51,200 a wave
       and the three that pay bring in 153,600.

       This was a flat +100 a merge, capping a level 10 at 1,000
       — 3,000 a wave from three farms, against a fully merged
       Quantum at 5000 x 2^9 = 2,560,000. That is 853 waves of
       saving, so the top of the buy list was not reachable in
       any run anyone would actually play. At x2 the same
       purchase takes about 17 waves. */
    coins: { mode: "multiply", factor: 2 },
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
    },
    loadout_slots: {
      label: "Loadout slot",
      note: "A sixth tower in the hotbar, and a sixth key to reach it",
      max: 1
    }
  };

  /* Towers you can equip before the upgrade. The hotbar and the
     Towers tab both read this rather than keeping their own copy
     — they used to, with a comment asking whoever changed one to
     remember the other. */
  var BASE_LOADOUT_SLOTS = 5;

  function loadoutSlots(level) {
    return BASE_LOADOUT_SLOTS + (level || 0);
  }

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
  /* weight divides pushback, so a heavier enemy is shoved less by
     the same Fan. It affects nothing else. */
  var ENEMIES = {
    /* The opening fodder. Weak enough that the one dagger a player
       can afford at wave 1 actually kills things. */
    crawler: { label: "Crawler", hp: 60, speed: 1, dps: 12, bounty: 12, weight: 0.6, colour: "#8a7f9c" },
    grunt: { label: "Grunt", hp: 250, speed: 1.2, dps: 50, bounty: 25, weight: 1, colour: "#7a5c8a" },
    runner: { label: "Runner", hp: 200, speed: 2.6, dps: 40, bounty: 20, weight: 0.8, colour: "#c98f6a" },
    /* Slow and very heavy: a Fan barely moves one. */
    brute: { label: "Brute", hp: 1200, speed: 0.6, dps: 240, bounty: 120, weight: 2.5, colour: "#5a6b52" }
  };

  function weightOf(kind) {
    var enemy = ENEMIES[kind];

    return enemy && enemy.weight ? enemy.weight : 1;
  }

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

  /* =========================================================
     Bosses

     Every tenth wave up to 100, then every fiftieth. A boss wave
     is the boss plus a small escort — enough to keep the towers
     busy, not enough to hide it.

     Bosses scale off the brute of the same wave, so they ride
     the same 1.12 curve as everything else and never need their
     own table of numbers per wave.
     ========================================================= */

  function isBossWave(wave) {
    if (!wave || wave < 10) {
      return false;
    }

    return wave <= 100 ? wave % 10 === 0 : wave % 50 === 0;
  }

  /* Which boss this is, counting from the first. Used to pick one
     from the roster, so they come round in order rather than at
     random and a player learns them. */
  function bossNumber(wave) {
    if (!isBossWave(wave)) {
      return 0;
    }

    return wave <= 100
      ? wave / 10
      : 10 + (wave - 100) / 50;
  }

  var BOSS = {
    /* Health as a multiple of a brute at the same wave. */
    hpMultiple: 25,
    /* Slower than anything else — a boss is a wall, not a race. */
    speed: 0.45,

    /* Heavy, but not immune. At 4 a Fan left a boss with 88% of
       its pace, which is close enough to nothing that the tower
       looked broken against the one enemy you most want to hold
       back. 1.5 leaves it 67%, so a Fan is worth building for a
       boss wave without ever being a wall — a boss still crosses
       the map, just slowly enough to be shot at properly. */
    weight: 1.5,
    bountyMultiple: 20,
    /* Ordinary enemies alongside it. */
    escort: 6
  };

  /* The roster, in the order they appear.

     Deliberately NOT here: stunning towers. During a wave the
     player cannot change anything, so a stun is damage taken
     away with nothing to answer it — every other ability asks
     whether the build is good, that one only asks whether it was
     lucky. Sapper slows nearby fire rate instead, which spreading
     out actually answers. */
  var BOSSES = {
    warden: {
      label: "Warden",
      colour: "#43648c",
      ability: "shield",

      /* Flat immunity while it is up, nothing while it is down,
         on a fixed cycle in game seconds. The window it is down
         is the whole fight — spend a timestop on one and a
         Warden dies in gaps.

         This began as a pool that absorbed damage and refilled,
         which is a damage FLOOR wearing a shield's clothes: with
         the pool coming back every 12 seconds you had to
         out-damage 2.5% of the boss's health a second before its
         health moved at all, and below that it took literally
         nothing, forever. A cycle cannot do that. However small
         your damage, `down` seconds of it always land.

         Down for longer than it is up, so the fight is mostly
         fighting. */
      up: 5,
      down: 8
    },
    brood: {
      label: "Brood",
      colour: "#6b4f8c",
      ability: "spawn",
      /* Crawlers of the current wave, so the escort keeps pace
         without a second scaling rule. */
      spawns: 4,
      every: 8
    },
    cleaver: {
      label: "Cleaver",
      colour: "#8c5340",
      ability: "split",
      /* Two halves on death, at this share of full health each.
         The halves do not split again — a chain would turn one
         boss into an unbounded crowd. */
      pieces: 2,
      piece: 0.3
    },
    sapper: {
      label: "Sapper",
      colour: "#7d6a2f",
      ability: "sap",
      /* Towers within this many tiles fire at this share of
         their rate. Not a stun: they keep working, and moving
         damage further out answers it. */
      radius: 6,
      rate: 0.5
    },
    wraith: {
      label: "Wraith",
      colour: "#3f7a63",
      ability: "regen",
      /* Heals this share of full health a second, ONLY while no
         tower can reach it. Tied to coverage rather than to
         damage taken, because "not being shot" is a state the
         player controls and "out-healing your damage" is one
         they cannot — the second version makes a boss that never
         dies and a wave that never ends. */
      heal: 0.04,

      /* It has to be unreachable this long before healing starts,
         and the count resets the moment anything can reach it
         again. Without the delay it took every frame it could
         find between two towers' coverage and healed through
         gaps too brief to be worth calling gaps. */
      delay: 0.2
    }
  };

  var BOSS_ORDER = ["warden", "brood", "cleaver", "sapper", "wraith"];

  function bossFor(wave) {
    var number = bossNumber(wave);

    if (!number) {
      return null;
    }

    return BOSS_ORDER[(number - 1) % BOSS_ORDER.length];
  }

  function bossHp(wave) {
    return waveEnemyHp("brute", wave) * BOSS.hpMultiple;
  }

  function bossBounty(wave) {
    return waveBounty("brute", wave) * BOSS.bountyMultiple;
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
    icecannon: {
      /* Not a damage tower. Anything inside its splash walks at
         half speed, which buys every other tower twice as long to
         shoot. The 10 dps is a courtesy, not a plan. */
      label: "Ice Cannon", role: "damage",
      damage: 5, range: 12, cooldown: 0.5, cost: 2000, // 10 dps
      attack: { shape: "circle", angle: 360 },
      slow: 0.5
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
    fan: {
      /* Hits everything around it and shoves it back down the
         path. The damage is ordinary for the price — what 4000
         buys is the pushback, which is worth most exactly when
         you are losing, and nothing at all when the lane is
         already clear. */
      label: "Fan", role: "damage",
      damage: 60, range: 15, cooldown: 1, cost: 4000, // 60 dps
      attack: { shape: "circle", angle: 360 },

      /* How much of its own movement an enemy loses each second
         while standing in a Fan: half a second's worth of ground
         per second, before weight.

         This is a FRACTION of what the enemy would have walked,
         not a distance in tiles, and that is the whole point.
         The first version was a fixed shove per hit, which meant
         an Ice Cannon slowing an enemy halved how far it walked
         while the shove stayed the same size — the two crossed
         over and the lane ran backwards forever. Taking a share
         of movement can slow an enemy to a crawl and can never
         reverse it, however many effects land at once.

         Being an effect it does not stack: the strongest Fan
         covering an enemy is the one it feels, and firing rate no
         longer comes into it at all. Cooldown is only damage now.

         Weight divides it, so a brute keeps four fifths of its
         pace and a crawler about a sixth. */
      pushback: 0.5
    },
    clocktower: {
      /* A piercing shot down the lane, and once every five
         minutes it stops time.

         The attack is only decent for 5000 — Quantum out damages
         it three to one. The ability is what is being bought. */
      label: "Clock Tower", role: "damage",
      /* 45 worked out to 27.5 tiles fully merged and evolved, on
         a map 15 tiles from centre to corner — its beam covered
         the whole board and never had to be aimed. 20 lands at
         12.2, so it holds a stretch of lane rather than all of
         them. */
      damage: 900, range: 20, cooldown: 2, cost: 5000, // 450 dps
      /* The beam carries on through whatever it hits, so a shot
         lined up with the lane catches everything standing in
         it. Width is the corridor either side of the line. */
      attack: { shape: "pierce", width: 12 },

      /* Timings are game seconds, so they run at whatever speed
         the match is set to. `every` is how long it takes to
         charge, not how often it fires — once charged it waits
         for the player to press Q.

         The ability belongs to the board, not to the tower — one
         timer no matter how many Clock Towers are standing. Per
         timers would mean five of them held time still forever,
         which is not a strategy, it is an off switch. */
      ability: {
        every: 300,
        lasts: 60,
        /* Enemies take double while frozen. */
        damage: 2
      }
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
      /* Reaches less far than the single boosters on purpose. At
         25 it worked out to 20.3 tiles fully merged and evolved,
         and the map is 26x15 — 15 tiles centre to corner — so one
         of these covered the entire board and placement stopped
         being a decision. 12 lands at 12.3 tiles instead. */
      boost: 6, range: 12,
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

  /* =========================================================
     Rarity

     The chest_odds table is where rarity really lives, and the
     shop reads it from there so the colours can never disagree
     with the odds they describe. This copy exists because the
     collection has to sort towers by rarity before any network
     call has come back — and because a player can hold a tower
     that has since been taken out of the chest entirely.

     If the two ever disagree, the database wins.
     ========================================================= */

  /* Best first. Anything unlisted sorts last. */
  var RARITY_ORDER = ["godly", "mythic", "legendary", "epic", "rare", "common"];

  var RARITY = {
    quantum: "godly",
    clocktower: "godly",
    fan: "mythic",
    djtv: "mythic",
    icecannon: "mythic",
    beacon: "legendary",
    forge: "legendary",
    metronome: "legendary",
    blender: "epic",
    spawner: "epic",
    farm: "rare",
    sniper: "rare",
    shotgunner: "rare",
    dagger: "common",
    axe: "common"
  };

  function rarityOf(name) {
    return RARITY[name] || "common";
  }

  /* Lower is rarer, so a plain ascending sort puts the best at
     the top. Unknown rarities land after everything known. */
  function rarityRank(rarity) {
    var index = RARITY_ORDER.indexOf(rarity);

    return index < 0 ? RARITY_ORDER.length : index;
  }

  /* =========================================================
     Shiny

     One pull in a hundred comes out shiny. A shiny is a separate
     line from the normal copy of the same tower and never merges
     with it — two shinies make a higher shiny, two normals make a
     higher normal, and the two never meet. That is what makes a
     shiny worth keeping rather than feeding to the pile.

     The 1% roll happens in Postgres. The number is repeated here
     only so the handbook can quote it.
     ========================================================= */

  var SHINY = {
    chance: 0.01,
    /* Half again the damage, on towers and on spawner allies. */
    damage: 0.5,
    /* Farms have no damage to raise, so they earn more instead. */
    coins: 0.1,
    /* Nor do boosters. Theirs lifts what they give everyone else,
       which is worth more than it looks — it multiplies across
       every tower standing in range. */
    boost: 0.1
  };

  /* A tower and its shiny are two different things everywhere the
     player picks one — the hotbar, the loadout, the collection —
     so they need one name that says which. Plain keys stay plain,
     which keeps every loadout saved before shinies existed valid. */
  var SHINY_MARK = "#shiny";

  function variantName(key, shiny) {
    return shiny ? key + SHINY_MARK : key;
  }

  function variantOf(name) {
    var mark = String(name || "").indexOf(SHINY_MARK);

    return mark < 0
      ? { key: name, shiny: false }
      : { key: String(name).slice(0, mark), shiny: true };
  }

  /* What a shiny multiplies a given stat by. Anything not listed
     is unaffected — range, cooldown and health are the same. */
  function shinyFactor(stat, shiny) {
    if (!shiny) {
      return 1;
    }

    if (stat === "damage") {
      return 1 + SHINY.damage;
    }

    if (stat === "coins") {
      return 1 + SHINY.coins;
    }

    if (stat === "boost") {
      return 1 + SHINY.boost;
    }

    return 1;
  }

  /* What being shiny is worth to this particular tower, in words.
     Which stat it lifts depends on the role, so every screen that
     mentions it asks here rather than working it out again. */
  function shinySummary(key) {
    var tower = TOWERS[key];

    if (!tower) {
      return "";
    }

    if (tower.role === "booster") {
      return "+" + Math.round(SHINY.boost * 100) + "% boost";
    }

    if (tower.role === "economy") {
      return "+" + Math.round(SHINY.coins * 100) + "% cash";
    }

    /* Damage towers, and spawners through their allies. */
    return "+" + Math.round(SHINY.damage * 100) + "% damage";
  }

  /* Allies scale health and damage on different curves, which is
     the one place in the game where a merge does not do the same
     thing to both.

     Health at root 10 per merge, damage at root 5. Enemy damage
     compounds 1.12x every wave, so an ally on the root 5 curve
     stops surviving contact at all somewhere around wave 61;
     root 10 carries it to about wave 89. Damage deliberately
     stays on root 5 — an ally is chip damage that stacks, not a
     damage dealer, and root 10 there would put a fully merged
     and evolved one near 4.9M a hit.

     Evolution splits the same way. Health takes 15%, which is
     what the spawner's role in ROLES has always advertised on
     the card — the code applied 10% and quietly disagreed with
     its own label until v1.34.2. Damage keeps the universal 10%.

     Neither curve fixes the real problem: all four numbers are
     constants and enemy scaling is not, so any multiplier is
     overtaken in the end. Only tying ally health to the current
     wave would hold indefinitely. */
  var ALLY = {
    healthMerge: Math.sqrt(10),
    damageMerge: Math.sqrt(5),
    /* Keep in step with ROLES.spawner, which is what the player
       is shown. */
    healthEvolution: 0.15,
    damageEvolution: 0.1
  };

  function allyStat(base, merge, growth, level, evolution) {
    return (
      base *
      Math.pow(merge, (level || 1) - 1) *
      Math.pow(1 + growth, evolution || 0)
    );
  }

  function allyHealth(key, level, evolution) {
    var tower = base(key);

    return tower && tower.allyHp
      ? allyStat(
          tower.allyHp,
          ALLY.healthMerge,
          ALLY.healthEvolution,
          level,
          evolution
        )
      : 0;
  }

  /* A shiny spawner has no attack of its own, so its half again
     damage lands on what its allies hit for. */
  function allyDamage(key, level, evolution, shiny) {
    var tower = base(key);

    return tower && tower.allyDamage
      ? allyStat(
          tower.allyDamage,
          ALLY.damageMerge,
          ALLY.damageEvolution,
          level,
          evolution
        ) * shinyFactor("damage", shiny)
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

  function damage(key, level, evolution, shiny) {
    return statValue(key, "damage", level, evolution) *
      shinyFactor("damage", shiny);
  }

  function range(key, level, evolution) {
    return statValue(key, "range", level, evolution);
  }

  function health(key, level, evolution) {
    return statValue(key, "health", level, evolution);
  }

  /* Match coins per wave. Only economy towers earn. */
  function coins(key, level, evolution, shiny) {
    return statValue(key, "coins", level, evolution) *
      shinyFactor("coins", shiny);
  }

  /* Percentage a single booster grants to the towers it affects. */
  function boost(key, level, evolution, shiny) {
    return statValue(key, "boost", level, evolution) *
      shinyFactor("boost", shiny);
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
  function damageAtDistance(key, level, evolution, distance, shiny) {
    var full = damage(key, level, evolution, shiny);
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
  /* The share of its own movement this tower takes off an enemy
     each second. Flat, so it is the same at merge 1 and merge 10
     — a pushback that grew would eventually take all of it. */
  function pushbackOf(key) {
    var tower = TOWERS[key];

    return tower && tower.pushback ? tower.pushback : 0;
  }

  /* What is left of an enemy's pace once a pushback has taken its
     share, given how heavy the enemy is.

     Floored well above zero. A factor of 0 is a wall, and a wall
     on an endless map is a wave that never finishes — the exact
     failure this rewrite exists to remove. It multiplies with a
     slow rather than being compared against it, so an Ice Cannon
     over a Fan is slower than either and still moving. */
  var PUSH_FLOOR = 0.15;

  function pushFactor(pushback, weight) {
    if (!pushback) {
      return 1;
    }

    return Math.max(PUSH_FLOOR, 1 - pushback / (weight || 1));
  }

  /* The timed ability a tower carries, or null. */
  function abilityOf(key) {
    var tower = TOWERS[key];

    return tower && tower.ability ? tower.ability : null;
  }

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

  /* How much a tower slows what it covers, as a speed multiplier.
     1 means no slowing. */
  function slowOf(key) {
    var tower = base(key);

    return tower && tower.slow ? tower.slow : 1;
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
    rarityOrder: RARITY_ORDER,
    rarityOf: rarityOf,
    rarityRank: rarityRank,
    shiny: SHINY,
    variantName: variantName,
    variantOf: variantOf,
    shinyFactor: shinyFactor,
    shinySummary: shinySummary,
    merge: MERGE,
    maxMerge: MAX_MERGE,
    maxEvolution: MAX_EVOLUTION,
    rangePerTile: RANGE_PER_TILE,
    startingCash: STARTING_CASH,
    basePlacements: BASE_PLACEMENTS,
    baseLoadoutSlots: BASE_LOADOUT_SLOTS,
    loadoutSlots: loadoutSlots,
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
    isBossWave: isBossWave,
    bossNumber: bossNumber,
    bossFor: bossFor,
    bosses: BOSSES,
    boss: BOSS,
    bossHp: bossHp,
    bossBounty: bossBounty,
    runReward: runReward,
    evolutionAll: EVOLUTION_ALL,
    cost: cost,
    boostsWhat: boostsWhat,
    slowOf: slowOf,
    buyCost: buyCost,
    sellValue: sellValue,
    attack: attackOf,
    damageAtDistance: damageAtDistance,
    inArc: inArc,
    pushback: pushbackOf,
    pushFactor: pushFactor,
    weight: weightOf,
    ability: abilityOf,
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
