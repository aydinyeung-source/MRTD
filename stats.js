(function () {
  "use strict";

  /* =========================================================
     Tower stats — the single source of truth for balance.

     Two independent scales:

       merge level  1-10, per match, resets every run
       evolution    0-10, permanent, bought with duplicates

     Both compound. Nothing here reads the DOM or the network,
     so it can be tuned without touching game or shop code.
     ========================================================= */

  /* Per merge level, compounding. Squared, root5 means every two
     merges is exactly x5 damage and x2 range. */
  var MERGE = {
    damage: Math.sqrt(5), // 2.2360
    range: Math.sqrt(2),  // 1.4142
    cash: Math.sqrt(5)    // 2.2360
  };

  /* Per evolution, compounding. */
  var EVOLUTION = {
    damage: 0.175, // 5.02x at evolution 10
    cash: 0.1      // 2.59x at evolution 10
  };

  var MAX_MERGE = 10;
  var MAX_EVOLUTION = 10;

  /* PLACEHOLDER base values — level 1, evolution 0.
     Only the farm's 100 cash is a real number so far; the damage,
     range and cooldown figures are guesses waiting to be tuned.
     Cooldown is fixed for the life of a tower: it never changes
     with merge level or evolution. */
  var TOWERS = {
    blender: { label: "Blender", damage: 12, range: 90, cooldown: 0.6 },
    dagger: { label: "Dagger", damage: 8, range: 70, cooldown: 0.35 },
    farm: { label: "Farm", damage: 0, range: 0, cooldown: 0, cash: 100 },
    shotgunner: { label: "Shotgunner", damage: 20, range: 110, cooldown: 0.9 },
    sniper: { label: "Sniper", damage: 45, range: 260, cooldown: 1.6 }
  };

  function base(key) {
    return TOWERS[key] || null;
  }

  function damage(key, level, evolution) {
    var tower = base(key);

    if (!tower) {
      return 0;
    }

    return (
      tower.damage *
      Math.pow(MERGE.damage, level - 1) *
      Math.pow(1 + EVOLUTION.damage, evolution || 0)
    );
  }

  function range(key, level) {
    var tower = base(key);

    return tower ? tower.range * Math.pow(MERGE.range, level - 1) : 0;
  }

  /* Set at spawn and never changed. */
  function cooldown(key) {
    var tower = base(key);

    return tower ? tower.cooldown : 0;
  }

  /* Cash per wave. Only the farm earns. */
  function cash(key, level, evolution) {
    var tower = base(key);

    if (!tower || !tower.cash) {
      return 0;
    }

    return (
      tower.cash *
      Math.pow(MERGE.cash, level - 1) *
      Math.pow(1 + EVOLUTION.cash, evolution || 0)
    );
  }

  /* Percentage a given evolution adds, for display. */
  function evolutionBonus(kind, evolution) {
    var rate = EVOLUTION[kind] || 0;

    return Math.round((Math.pow(1 + rate, evolution) - 1) * 100);
  }

  window.MRTD = window.MRTD || {};
  window.MRTD.stats = {
    towers: TOWERS,
    merge: MERGE,
    evolution: EVOLUTION,
    maxMerge: MAX_MERGE,
    maxEvolution: MAX_EVOLUTION,
    damage: damage,
    range: range,
    cooldown: cooldown,
    cash: cash,
    evolutionBonus: evolutionBonus
  };
})();
