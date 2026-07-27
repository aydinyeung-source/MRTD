(function () {
  "use strict";

  /* =========================================================
     The match.

     Everything is a tile, and one tile is stats.rangePerTile
     worth of range. The path switchbacks so a long ranged tower
     parked between two runs can cover both.

     A run only ends when the base falls.
     ========================================================= */

  var stats = window.MRTD && window.MRTD.stats;

  var GRID = { cols: 26, rows: 15 };

  /* Corners of the path in landscape tiles. Portal first, base last.

     Spawn on the left, base on the right, with a wide circuit
     across the top and a coil through the middle. Runs sit two to
     three tiles apart in several places, so a long ranged tower
     parked between them covers more than one lane. */
  var WAYPOINTS = [
    [0, 6],
    [6, 6],
    [6, 1],
    [20, 1],
    [20, 4],
    [11, 4],
    [11, 8],
    [22, 8],
    [22, 11],
    [4, 11],
    [4, 13],
    [25, 13]
  ];

  /* How far buildable ground reaches from the path. Produces an
     irregular island hugging the route instead of a full
     rectangle of buildable tiles. */
  var LAND_REACH = 3;

  var MAX_LEVEL = 10;
  var TOWER_KEYS = ["dagger", "blender", "shotgunner", "sniper", "farm"];

  /* Towers with drawn top down artwork. Everything else uses the
     plan views below, which are built in code. */
  var ART_TOWERS = ["sniper"];

  /* Fallback plan designs, drawn in code. Used only for a tower
     whose artwork has not loaded, so the board still reads while
     a sprite is missing. */
  var TOKENS = {
    blender: { body: "#8e8e8e", accent: "#ff140a", plan: "blades" },
    dagger: { body: "#949494", accent: "#bb0000", plan: "knives" },
    farm: { body: "#eae484", accent: "#b8ae4a", plan: "field" },
    shotgunner: { body: "#656565", accent: "#8c8c8c", plan: "barrels" },
    sniper: { body: "#2b2b2b", accent: "#8c8c8c", plan: "barrel" }
  };

  var root = document.getElementById("match");
  var canvas = document.getElementById("match-canvas");
  var exitButton = document.getElementById("match-exit");
  var forfeitButton = document.getElementById("match-forfeit");
  var startButton = document.getElementById("match-start");
  var speedButton = document.getElementById("match-speed");
  var skipButton = document.getElementById("match-skip");
  var autoButton = document.getElementById("match-auto");
  var hotbar = document.getElementById("hotbar");
  var levels = document.getElementById("levels");
  var inspect = document.getElementById("inspect");
  var cashDisplay = document.getElementById("match-cash");
  var hpDisplay = document.getElementById("match-hp");
  var placedDisplay = document.getElementById("match-placed");
  var waveDisplay = document.getElementById("match-wave");
  var aliveDisplay = document.getElementById("match-alive");
  var beatenDisplay = document.getElementById("match-beaten");
  var payoutDisplay = document.getElementById("match-payout");
  var gameover = document.getElementById("gameover");
  var gameoverWaves = document.getElementById("gameover-waves");
  var gameoverCoins = document.getElementById("gameover-coins");
  var gameoverNote = document.getElementById("gameover-note");
  var gameoverLeave = document.getElementById("gameover-leave");
  var cashfeed = document.getElementById("cashfeed");
  var playButton = document.getElementById("play");

  if (!canvas || !root) {
    return;
  }

  var ctx = canvas.getContext("2d");

  var towers = {};
  var sprites = {};
  var enemies = [];
  var shots = [];

  /* Thrown daggers in flight, and coins drifting off a farm. */
  var projectiles = [];
  var particles = [];

  /* How fast a blender's blades turn at full spin, in radians per
     second, and how quickly spin and recoil fall away. */
  var SPIN_RATE = 16;
  var SPIN_DECAY = 1.6;
  var RECOIL_DECAY = 7;

  var cash = 0;
  var baseHp = 0;
  var wave = 0;
  var wavesSurvived = 0;
  var spawnQueue = [];
  var spawnTimer = 0;
  var waveActive = false;
  var running = false;
  var lastFrame = 0;

  /* Bonus paid the moment a wave is cleared, on top of farm income. */
  var WAVE_BONUS = 100;

  /* Breather between waves before the next one starts itself. */
  var BREAK_SECONDS = 15;

  var speed = 1;
  var breakLeft = 0;

  /* The in-flight bank_run call, so leaving waits for it. */
  var banking = null;


  /* Simulation is advanced in fixed slices. Without this, 10x
     would take one huge step per frame and cooldowns would drift —
     a 0.4s tower would fire once per frame instead of several
     times. */
  var STEP = 1 / 60;
  var MAX_STEPS = 40;

  /* Chains waves without waiting: starts the next one the moment
     the current one has finished spawning. Deliberately not
     remembered — every match begins with it off. */
  var autoSkip = false;

  var view = { cols: 0, rows: 0, size: 0, x: 0, y: 0, path: [] };
  var drag = null;
  var hover = null;
  var sellZone = null;

  /* Tile of the tower whose stats panel is open, so its cover
     stays on screen while you read it. */
  var inspected = null;

  /* The tower waiting to be positioned, as { key, level }. Shown
     semi-opaque until a second click commits it. */
  var placing = null;
  var pointer = { x: 0, y: 0 };

  /* Long press on a hotbar slot opens the level picker. */
  var HOLD_MS = 400;
  var holdTimer = null;
  var held = false;

  /* =========================================================
     Map geometry
     ========================================================= */

  function key(col, row) {
    return col + "," + row;
  }

  function waypoints(portrait) {
    return WAYPOINTS.map(function (point) {
      return portrait ? [point[1], point[0]] : point;
    });
  }

  function buildPath(points) {
    var tiles = [];

    points.forEach(function (point, index) {
      if (index === 0) {
        tiles.push([point[0], point[1]]);
        return;
      }

      var from = points[index - 1];
      var stepX = Math.sign(point[0] - from[0]);
      var stepY = Math.sign(point[1] - from[1]);
      var col = from[0];
      var row = from[1];

      while (col !== point[0] || row !== point[1]) {
        col += stepX;
        row += stepY;
        tiles.push([col, row]);
      }
    });

    return tiles;
  }

  function layout() {
    var portrait = window.innerHeight > window.innerWidth;
    var cols = portrait ? GRID.rows : GRID.cols;
    var rows = portrait ? GRID.cols : GRID.rows;
    var width = window.innerWidth;
    var height = window.innerHeight;
    var size = Math.floor(Math.min(width / cols, height / rows));

    if (size < 1) {
      return false;
    }

    var ratio = window.devicePixelRatio || 1;

    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    var points = waypoints(portrait);

    view = {
      cols: cols,
      rows: rows,
      size: size,
      x: Math.floor((width - cols * size) / 2),
      y: Math.floor((height - rows * size) / 2),
      path: buildPath(points),
      portal: points[0],
      base: points[points.length - 1],
      pathSet: {}
    };

    view.path.forEach(function (tile) {
      view.pathSet[key(tile[0], tile[1])] = true;
    });

    buildLand();

    return true;
  }

  /* Ground is anything within reach of the path. Corners get
     clipped so the coastline is ragged rather than a rounded
     rectangle. */
  function buildLand() {
    view.landSet = {};

    view.path.forEach(function (tile) {
      for (var dx = -LAND_REACH; dx <= LAND_REACH; dx += 1) {
        for (var dy = -LAND_REACH; dy <= LAND_REACH; dy += 1) {
          var col = tile[0] + dx;
          var row = tile[1] + dy;

          if (!inBounds(col, row)) {
            continue;
          }

          if (Math.abs(dx) + Math.abs(dy) > LAND_REACH + 1) {
            continue;
          }

          view.landSet[key(col, row)] = true;
        }
      }
    });
  }

  function isLand(col, row) {
    return Boolean(view.landSet && view.landSet[key(col, row)]);
  }

  function isPath(col, row) {
    return Boolean(view.pathSet[key(col, row)]);
  }

  function inBounds(col, row) {
    return col >= 0 && col < view.cols && row >= 0 && row < view.rows;
  }

  /* Only the island is buildable, and never the path itself. */
  function buildable(col, row) {
    return inBounds(col, row) && isLand(col, row) && !isPath(col, row);
  }

  function tileRect(col, row) {
    return {
      x: view.x + col * view.size,
      y: view.y + row * view.size,
      size: view.size
    };
  }

  function tileCentre(col, row) {
    var rect = tileRect(col, row);

    return { x: rect.x + rect.size / 2, y: rect.y + rect.size / 2 };
  }

  function tileAt(x, y) {
    var col = Math.floor((x - view.x) / view.size);
    var row = Math.floor((y - view.y) / view.size);

    return inBounds(col, row) ? [col, row] : null;
  }

  function pointerPosition(event) {
    var bounds = canvas.getBoundingClientRect();

    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  /* Position of an enemy that has walked `progress` tiles. */
  function pathPoint(progress) {
    var index = Math.floor(progress);
    var fraction = progress - index;

    if (index >= view.path.length - 1) {
      var last = view.path[view.path.length - 1];
      return tileCentre(last[0], last[1]);
    }

    var from = tileCentre(view.path[index][0], view.path[index][1]);
    var to = tileCentre(view.path[index + 1][0], view.path[index + 1][1]);

    return {
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction
    };
  }

  /* =========================================================
     Sprites
     ========================================================= */

  /* The turning piece, if a tower has one drawn. Bases stay flat
     and this is laid over them. */
  var tops = {};

  function loadSprites() {
    ART_TOWERS.forEach(function (name) {
      sprites[name] = {};

      for (var level = 1; level <= MAX_LEVEL; level += 1) {
        loadSprite(name, level);
      }

      loadTop(name);
    });
  }

  function loadTop(name) {
    var image = new Image();

    image.onload = function () {
      tops[name] = image;
    };

    image.onerror = function () {
      tops[name] = null;
    };

    image.src = "towers/" + name + "/top.svg";
  }

  /* The largest costume a tower has, so the others can be drawn in
     proportion to it. Scratch exports each costume cropped to its
     own artwork, so scaling every one to fill the tile would make
     a level 1 and a level 10 the same size on screen. Measuring
     them here means the files are never edited. */
  var spriteScale = {};

  function noteSpriteSize(name, image) {
    var largest = Math.max(image.width, image.height);

    if (!spriteScale[name] || largest > spriteScale[name]) {
      spriteScale[name] = largest;
    }
  }

  function loadSprite(name, level) {
    var image = new Image();

    image.onload = function () {
      sprites[name][level] = image;
      noteSpriteSize(name, image);
    };

    image.onerror = function () {
      sprites[name][level] = null;
    };

    image.src = "towers/" + name + "/" + level + ".svg";
  }

  /* =========================================================
     Drawing
     ========================================================= */

  function roundedPath(x, y, width, height, radius) {
    ctx.beginPath();

    if (ctx.roundRect) {
      ctx.roundRect(x, y, width, height, radius);
      return;
    }

    ctx.rect(x, y, width, height);
  }

  /* Every plan changes on every merge — one more blade, one more
     knife, one more crop row, a longer barrel — so an upgrade is
     always visible on the board and not only in the number. */

  /* Blender: a disc of blades that gains one per merge. */
  function planBlades(token, radius, level) {
    var count = 3 + (level - 1);
    var reach = radius * (1.32 + level * 0.02);

    ctx.fillStyle = token.accent;

    for (var i = 0; i < count; i += 1) {
      ctx.save();
      ctx.rotate((i / count) * Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(-radius * 0.15, 0);
      ctx.lineTo(0, -reach);
      ctx.lineTo(radius * 0.15, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /* Dagger: nothing radial. A forward fan of straight blades over
     a diamond body, so it reads as thrown knives rather than a
     spinning disc. */
  function planKnives(token, radius, level) {
    var count = 2 + Math.floor(level / 2);
    var length = radius * (1.15 + level * 0.055);
    var spread = 0.16 + level * 0.012;

    for (var i = 0; i < count; i += 1) {
      var offset = (i - (count - 1) / 2) * spread;

      ctx.save();
      ctx.rotate(offset);

      /* Blade. */
      ctx.beginPath();
      ctx.moveTo(-radius * 0.075, -radius * 0.2);
      ctx.lineTo(0, -length);
      ctx.lineTo(radius * 0.075, -radius * 0.2);
      ctx.closePath();
      ctx.fillStyle = "#d2d2d2";
      ctx.fill();

      /* Tip. */
      ctx.beginPath();
      ctx.moveTo(-radius * 0.075, -length * 0.72);
      ctx.lineTo(0, -length);
      ctx.lineTo(radius * 0.075, -length * 0.72);
      ctx.closePath();
      ctx.fillStyle = token.accent;
      ctx.fill();

      ctx.restore();
    }
  }

  /* Farm: crop rows, plus silos as it grows. */
  function planField(token, radius, level) {
    var rows = 2 + Math.floor(level / 2);
    var silos = Math.floor(level / 4);

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1, radius * 0.09);
    ctx.beginPath();

    for (var i = 1; i <= rows; i += 1) {
      var y = -radius + (radius * 2 * i) / (rows + 1);
      ctx.moveTo(-radius * 0.78, y);
      ctx.lineTo(radius * 0.78, y);
    }

    ctx.stroke();

    ctx.fillStyle = "#8a7f3a";

    for (var s = 0; s < silos; s += 1) {
      ctx.beginPath();
      ctx.arc(
        -radius * 0.55 + s * radius * 0.55,
        radius * 0.62,
        radius * 0.16,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }

  /* Shotgunner: barrels that widen and lengthen as it merges. */
  function planBarrels(token, radius, level) {
    var count = 2 + Math.floor((level - 1) / 3);
    var width = radius * 0.24;
    var length = radius * (0.9 + level * 0.055);
    var span = width * (count - 1) * 1.5;

    ctx.fillStyle = token.accent;

    for (var i = 0; i < count; i += 1) {
      var offset = -span / 2 + i * width * 1.5;

      ctx.fillRect(offset - width / 2, -radius * 0.4 - length, width, length);
    }

    /* Choke on the muzzle, thicker each merge. */
    ctx.fillStyle = "#3a3f42";
    ctx.fillRect(
      -span / 2 - width,
      -radius * 0.4 - length,
      span + width * 2,
      radius * (0.06 + level * 0.012)
    );
  }

  function planBarrel(token, radius, level) {
    var length = radius * (1.2 + level * 0.09);

    ctx.fillStyle = token.accent;
    ctx.fillRect(-radius * 0.13, -length, radius * 0.26, length);

    if (level >= 6) {
      ctx.fillRect(-radius * 0.26, -length, radius * 0.52, radius * 0.18);
    }
  }

  var PLANS = {
    blades: planBlades,
    knives: planKnives,
    field: planField,
    barrels: planBarrels,
    barrel: planBarrel
  };

  function drawTopTower(tower, x, y, size) {
    var token = TOKENS[tower.key];

    if (!token) {
      return;
    }

    /* The footprint itself creeps up with every merge. */
    var radius = size * 0.32 * (0.82 + tower.level * 0.02);
    var isField = token.plan === "field";
    var isKnives = token.plan === "knives";

    ctx.save();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate(tower.angle || 0);

    /* Blades keep turning while the blender is cutting. */
    if (token.plan === "blades") {
      ctx.rotate(tower.spin || 0);
    }

    /* Kick backwards along the barrel. */
    if (tower.recoil) {
      ctx.translate(0, tower.recoil * radius * 0.3);
    }

    if (!isField && PLANS[token.plan]) {
      PLANS[token.plan](token, radius, tower.level);
    }

    ctx.beginPath();

    if (isField) {
      roundedPath(-radius, -radius, radius * 2, radius * 2, radius * 0.3);
    } else if (isKnives) {
      /* A diamond, so the dagger is not another disc. */
      var half = radius * 0.78;

      ctx.moveTo(0, -half);
      ctx.lineTo(half, 0);
      ctx.lineTo(0, half);
      ctx.lineTo(-half, 0);
      ctx.closePath();
    } else {
      ctx.arc(0, 0, radius * 0.82, 0, Math.PI * 2);
    }

    ctx.fillStyle = token.body;
    ctx.fill();
    ctx.strokeStyle = "rgba(249, 251, 252, 0.85)";
    ctx.lineWidth = Math.max(1.5, size * 0.04);
    ctx.stroke();

    if (isField) {
      PLANS[token.plan](token, radius, tower.level);
    }

    ctx.restore();

    ctx.fillStyle = isField ? "#3f3a12" : "#f9fbfc";
    ctx.font = "600 " + Math.max(9, Math.round(size * 0.3)) + "px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(tower.level), x + size / 2, y + size / 2);
  }

  /* The firing arc, drawn out to the full range so it is obvious
     what the tower actually covers. Cone towers only. */
  function drawCone(tower, x, y, size) {
    var attack = stats.attack(tower.key);

    if (!attack || attack.shape !== "cone") {
      return;
    }

    var reach =
      (stats.range(tower.key, tower.level, evolutionFor(tower)) /
        stats.rangePerTile) *
      view.size;
    var half = (attack.angle * Math.PI) / 360;

    ctx.save();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate(tower.angle || 0);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, reach, -Math.PI / 2 - half, -Math.PI / 2 + half);
    ctx.closePath();

    ctx.fillStyle = "rgba(79, 106, 120, 0.14)";
    ctx.fill();
    ctx.strokeStyle = "rgba(79, 106, 120, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  /* The turning piece. Uses the tower's own top.svg when one has
     been drawn, and falls back to a plain barrel when it has not,
     so aim is always visible. */
  function drawBarrel(tower, x, y, size) {
    if (!stats.attack(tower.key)) {
      return;
    }

    var top = tops[tower.key];

    if (top) {
      var reference = spriteScale[tower.key] || Math.max(top.width, top.height);
      var scale = size / reference;

      ctx.save();
      ctx.translate(x + size / 2, y + size / 2);
      ctx.rotate(tower.angle || 0);
      ctx.translate(0, (tower.recoil || 0) * size * 0.09);
      ctx.drawImage(
        top,
        (-top.width * scale) / 2,
        (-top.height * scale) / 2,
        top.width * scale,
        top.height * scale
      );
      ctx.restore();
      return;
    }

    var length = size * (0.3 + tower.level * 0.022);
    var width = size * 0.13;

    ctx.save();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate(tower.angle || 0);
    ctx.translate(0, (tower.recoil || 0) * size * 0.09);

    roundedPath(-width / 2, -length, width, length, width * 0.4);
    ctx.fillStyle = "#3a3f42";
    ctx.fill();
    ctx.strokeStyle = "rgba(249, 251, 252, 0.7)";
    ctx.lineWidth = Math.max(1, size * 0.02);
    ctx.stroke();

    /* Muzzle, so the far end reads at small tile sizes. */
    roundedPath(-width * 0.75, -length, width * 1.5, width * 0.6, width * 0.3);
    ctx.fillStyle = "#8c8c8c";
    ctx.fill();

    ctx.restore();
  }

  /* The artwork is the base and does not turn. It is drawn in
     proportion to the tower's largest costume, so higher levels
     really are bigger on the board. */
  function drawTower(tower, x, y, size) {
    var sprite = sprites[tower.key] && sprites[tower.key][tower.level];

    if (!sprite) {
      drawTopTower(tower, x, y, size);
      return;
    }

    var reference = spriteScale[tower.key] || Math.max(sprite.width, sprite.height);
    var scale = size / reference;
    var width = sprite.width * scale;
    var height = sprite.height * scale;

    ctx.drawImage(
      sprite,
      x + (size - width) / 2,
      y + (size - height) / 2,
      width,
      height
    );

    drawBarrel(tower, x, y, size);

    /* Level sits square to the screen, never rotated with the art. */
    ctx.fillStyle = "#222a2f";
    ctx.font =
      "600 " + Math.max(9, Math.round(size * 0.26)) + "px 'IBM Plex Mono', monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(tower.level), x + size - 2, y + size - 1);
  }

  function drawRange(tower, centreX, centreY) {
    var tiles =
      stats.range(tower.key, tower.level, evolutionFor(tower)) /
      stats.rangePerTile;

    if (tiles <= 0) {
      return;
    }

    ctx.beginPath();
    ctx.arc(centreX, centreY, tiles * view.size, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(79, 106, 120, 0.12)";
    ctx.fill();
    ctx.strokeStyle = "rgba(79, 106, 120, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawRangeLabel(tower, rect) {
    var tiles =
      stats.range(tower.key, tower.level, evolutionFor(tower)) /
      stats.rangePerTile;
    var text =
      stats.towers[tower.key].label + " " + tower.level +
      "  ·  " + (Math.round(tiles * 10) / 10) + " tiles";

    ctx.font = "500 12px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    var width = ctx.measureText(text).width + 16;
    var x = rect.x + rect.size / 2;
    var y = rect.y - 14;

    roundedPath(x - width / 2, y - 11, width, 22, 6);
    ctx.fillStyle = "rgba(249, 251, 252, 0.94)";
    ctx.fill();
    ctx.strokeStyle = "rgba(34, 42, 47, 0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#222a2f";
    ctx.fillText(text, x, y);
  }

  function drawField() {
    /* Only the island is drawn, so the map reads as terrain rather
       than a grid that happens to have a path on it. */
    ctx.fillStyle = "#dfe7ea";

    Object.keys(view.landSet).forEach(function (position) {
      var parts = position.split(",");
      var rect = tileRect(Number(parts[0]), Number(parts[1]));

      ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
    });

    /* Grid lines, clipped to the island. */
    ctx.strokeStyle = "rgba(34, 42, 47, 0.07)";
    ctx.lineWidth = 1;

    Object.keys(view.landSet).forEach(function (position) {
      var parts = position.split(",");
      var rect = tileRect(Number(parts[0]), Number(parts[1]));

      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.size - 1, rect.size - 1);
    });

    ctx.fillStyle = "#b9c6cc";
    view.path.forEach(function (tile) {
      var rect = tileRect(tile[0], tile[1]);
      ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
    });

    /* Dark kerb along the path edges, as in the reference. */
    ctx.strokeStyle = "rgba(45, 54, 60, 0.55)";
    ctx.lineWidth = 2;

    view.path.forEach(function (tile) {
      var rect = tileRect(tile[0], tile[1]);

      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (step) {
        if (isPath(tile[0] + step[0], tile[1] + step[1])) {
          return;
        }

        ctx.beginPath();

        if (step[0] === 1) {
          ctx.moveTo(rect.x + rect.size, rect.y);
          ctx.lineTo(rect.x + rect.size, rect.y + rect.size);
        } else if (step[0] === -1) {
          ctx.moveTo(rect.x, rect.y);
          ctx.lineTo(rect.x, rect.y + rect.size);
        } else if (step[1] === 1) {
          ctx.moveTo(rect.x, rect.y + rect.size);
          ctx.lineTo(rect.x + rect.size, rect.y + rect.size);
        } else {
          ctx.moveTo(rect.x, rect.y);
          ctx.lineTo(rect.x + rect.size, rect.y);
        }

        ctx.stroke();
      });
    });
  }

  function drawPortal() {
    var centre = tileCentre(view.portal[0], view.portal[1]);
    /* Green at the spawn, red at the base, as in the reference. */
    var radius = view.size * 0.42;

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#3d3350";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = "#6f5f92";
    ctx.fill();
  }

  function drawBase() {
    var rect = tileRect(view.base[0], view.base[1]);
    var inset = rect.size * 0.12;

    roundedPath(rect.x + inset, rect.y + inset, rect.size - inset * 2, rect.size - inset * 2, rect.size * 0.18);
    ctx.fillStyle = "#4f6a78";
    ctx.fill();
    ctx.strokeStyle = "#2a3d47";
    ctx.lineWidth = 2;
    ctx.stroke();

    /* Health ring around the base. */
    var fraction = baseHp / stats.baseHp;

    ctx.beginPath();
    ctx.arc(
      rect.x + rect.size / 2,
      rect.y + rect.size / 2,
      rect.size * 0.62,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * Math.max(0, fraction)
    );
    ctx.strokeStyle = fraction > 0.3 ? "#4f6a78" : "#9d4b45";
    ctx.lineWidth = 3;
    ctx.stroke();

    /* The ring reads at a glance, the number tells you how many
       more leaks you can survive. */
    outlinedText(
      Math.max(0, Math.ceil(baseHp)) + " / " + stats.baseHp,
      rect.x + rect.size / 2,
      rect.y + rect.size + Math.max(12, rect.size * 0.34),
      Math.max(10, Math.round(rect.size * 0.24)),
      fraction > 0.3 ? "#222a2f" : "#9d4b45"
    );
  }

  /* Health runs into the millions, so long numbers are shortened
     rather than overflowing the tile. */
  function formatHp(value) {
    var amount = Math.max(0, Math.ceil(value));

    if (amount >= 1000000) {
      return Math.round(amount / 100000) / 10 + "M";
    }

    if (amount >= 1000) {
      return Math.round(amount / 100) / 10 + "k";
    }

    return String(amount);
  }

  /* Text with a pale halo, so it stays readable over the path,
     the grass and the enemies alike. */
  function outlinedText(text, x, y, size, colour) {
    ctx.font = "600 " + size + "px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, size * 0.28);
    ctx.strokeStyle = "rgba(249, 251, 252, 0.9)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }

  /* PLACEHOLDER enemy art: a coloured disc with a health bar.
     Swap for enemies/<kind>.svg when the drawings land. */
  function drawEnemy(enemy) {
    var point = pathPoint(enemy.progress);
    var radius = view.size * 0.3;
    var definition = stats.enemies[enemy.kind];

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = definition.colour;
    ctx.fill();
    ctx.strokeStyle = "rgba(15, 18, 16, 0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    var width = view.size * 0.7;
    var fraction = Math.max(0, enemy.hp / enemy.maxHp);
    var barY = point.y - radius - 7;

    ctx.fillStyle = "rgba(34, 42, 47, 0.25)";
    ctx.fillRect(point.x - width / 2, barY, width, 4);
    ctx.fillStyle = fraction > 0.4 ? "#5f8a63" : "#9d4b45";
    ctx.fillRect(point.x - width / 2, barY, width * fraction, 4);

    /* The bar shows how hurt it is; the number shows how much is
       actually left, which is what decides whether a tower can
       finish it. */
    outlinedText(
      formatHp(enemy.hp),
      point.x,
      barY - Math.max(7, view.size * 0.14),
      Math.max(9, Math.round(view.size * 0.2)),
      "#222a2f"
    );
  }

  /* A thrown dagger: a round pommel with a blade ahead of it,
     pointing the way it is travelling. */
  function drawProjectiles() {
    projectiles.forEach(function (shot) {
      var x = shot.fromX + (shot.toX - shot.fromX) * shot.progress;
      var y = shot.fromY + (shot.toY - shot.fromY) * shot.progress;
      var scale = view.size * 0.11;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(shot.angle);

      ctx.beginPath();
      ctx.moveTo(0, -scale * 0.45);
      ctx.lineTo(scale * 1.7, 0);
      ctx.lineTo(0, scale * 0.45);
      ctx.closePath();
      ctx.fillStyle = "#d2d2d2";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(-scale * 0.2, 0, scale * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = "#bb0000";
      ctx.fill();

      ctx.restore();
    });
  }

  /* Coins lifting off a farm as it pays out. */
  function drawParticles() {
    particles.forEach(function (coin) {
      if (coin.delay > 0) {
        return;
      }

      var lift = (1 - coin.life) * coin.rise;
      var radius = view.size * 0.09;

      ctx.globalAlpha = Math.max(0, Math.min(1, coin.life));
      ctx.beginPath();
      ctx.arc(coin.x, coin.y - lift, radius, 0, Math.PI * 2);
      ctx.fillStyle = "#d2ae59";
      ctx.fill();
      ctx.strokeStyle = "#8a7f3a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  function drawShots() {
    shots.forEach(function (shot) {
      ctx.beginPath();
      ctx.moveTo(shot.fromX, shot.fromY);
      ctx.lineTo(shot.toX, shot.toY);
      ctx.strokeStyle = "rgba(34, 42, 47, " + Math.max(0, shot.life * 4) + ")";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  function drawSellZone(tower, pointerX, pointerY) {
    var rect = sellZone;
    var active = inSellZone(pointerX, pointerY);
    var value = stats.sellValue(tower.key, tower.level);

    roundedPath(rect.x, rect.y, rect.width, rect.height, 14);
    ctx.fillStyle = active ? "rgba(157, 75, 69, 0.92)" : "rgba(249, 251, 252, 0.94)";
    ctx.fill();
    ctx.strokeStyle = active ? "#9d4b45" : "rgba(34, 42, 47, 0.2)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = active ? "#f9fbfc" : "#222a2f";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = "700 15px 'Nunito', sans-serif";
    ctx.fillText("Sell", rect.x + rect.width / 2, rect.y + 20);

    ctx.font = "500 12px 'IBM Plex Mono', monospace";
    ctx.fillText("+" + Math.floor(value) + " cash", rect.x + rect.width / 2, rect.y + 42);
  }

  /* Range circle plus, for cone towers, the arc they actually
     fire into. */
  function showCover(position) {
    var tower = position && towers[position];

    if (!tower) {
      return;
    }

    var parts = position.split(",");
    var rect = tileRect(Number(parts[0]), Number(parts[1]));

    drawRange(tower, rect.x + rect.size / 2, rect.y + rect.size / 2);
    drawCone(tower, rect.x, rect.y, rect.size);
  }

  function draw() {
    if (!view.size) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawField();
    drawPortal();
    drawBase();

    /* Cover is only drawn for a tower you are hovering or have
       open in the stats panel — showing every cone at once made
       the map unreadable. */
    showCover(hover && !drag && !placing ? hover : null);
    showCover(inspected);

    Object.keys(towers).forEach(function (position) {
      if (drag && drag.from === position) {
        return;
      }

      var parts = position.split(",");
      var rect = tileRect(Number(parts[0]), Number(parts[1]));

      drawTower(towers[position], rect.x, rect.y, rect.size);
    });

    enemies.forEach(drawEnemy);
    drawShots();
    drawProjectiles();
    drawParticles();

    /* Ghost of the tower waiting to be committed. */
    if (placing) {
      var tile = tileAt(pointer.x, pointer.y);
      var ghost = placing;

      if (tile) {
        var target = tileRect(tile[0], tile[1]);
        var allowed = buildable(tile[0], tile[1]) && !towers[key(tile[0], tile[1])];

        drawRange(ghost, target.x + target.size / 2, target.y + target.size / 2);
        drawCone(ghost, target.x, target.y, target.size);

        ctx.globalAlpha = 0.55;
        drawTower(ghost, target.x, target.y, target.size);
        ctx.globalAlpha = 1;

        ctx.strokeStyle = allowed ? "#4f6a78" : "rgba(157, 75, 69, 0.85)";
        ctx.lineWidth = 3;
        ctx.strokeRect(target.x + 1.5, target.y + 1.5, target.size - 3, target.size - 3);
      }
    }

    if (drag) {
      drawRange(drag.tower, drag.x, drag.y);
      drawCone(
        drag.tower,
        drag.x - view.size / 2,
        drag.y - view.size / 2,
        view.size
      );

      var dropTile = inSellZone(drag.x, drag.y) ? null : tileAt(drag.x, drag.y);

      if (dropTile) {
        var dropRect = tileRect(dropTile[0], dropTile[1]);
        var occupant = towers[key(dropTile[0], dropTile[1])];

        ctx.strokeStyle = canMerge(drag.tower, occupant)
          ? "#c9992b"
          : buildable(dropTile[0], dropTile[1])
            ? "#4f6a78"
            : "rgba(157, 75, 69, 0.8)";
        ctx.lineWidth = 3;
        ctx.strokeRect(dropRect.x + 1.5, dropRect.y + 1.5, dropRect.size - 3, dropRect.size - 3);
      }

      drawSellZone(drag.tower, drag.x, drag.y);
      drawTower(drag.tower, drag.x - view.size / 2, drag.y - view.size / 2, view.size);
    }

    if (!drag && !placing && hover && towers[hover]) {
      var labelAt = hover.split(",");
      drawRangeLabel(towers[hover], tileRect(Number(labelAt[0]), Number(labelAt[1])));
    }
  }

  /* =========================================================
     Waves and combat
     ========================================================= */

  /* Startable when nothing is queued: either between waves, or
     early while the tail of the last wave is still walking. */
  function canStart() {
    return baseHp > 0 && !spawnQueue.length;
  }

  function startWave() {
    if (!canStart()) {
      return;
    }

    wave += 1;
    waveActive = true;
    breakLeft = 0;
    spawnTimer = 0;
    spawnQueue = [];

    var pool = stats.wavePool(wave);
    var count = stats.waveCount(wave);

    for (var i = 0; i < count; i += 1) {
      spawnQueue.push(pool[Math.floor(Math.random() * pool.length)]);
    }

    refreshHud();
  }

  /* Skipping jumps straight into the next wave, bypassing the
     intermission where the payout normally happens — so it pays
     here instead. During an intermission the money has already
     been handed over, so it just starts. */
  function beginNextWave() {
    if (waveActive) {
      payWave();
    }

    startWave();
  }

  function spawn(kind) {
    var hp = stats.waveEnemyHp(kind, wave);

    enemies.push({
      kind: kind,
      hp: hp,
      maxHp: hp,
      progress: 0,
      speed: stats.enemies[kind].speed
    });
  }

  function enemyAt(enemy) {
    return pathPoint(enemy.progress);
  }

  function distanceTo(origin, progress) {
    var point = pathPoint(progress);
    var dx = point.x - origin.x;
    var dy = point.y - origin.y;

    return Math.sqrt(dx * dx + dy * dy);
  }

  /* True once an enemy has stopped closing on the tower — it is at
     the nearest point of its walk, or already moving away.

     Cone towers wait for this instead of firing the moment
     something clips their range, so the point blank multiplier
     lands on the lead enemy rather than being wasted at maximum
     distance for a tenth of the damage. */
  function atClosestApproach(origin, enemy) {
    var now = distanceTo(origin, enemy.progress);
    var soon = distanceTo(origin, enemy.progress + enemy.speed * 0.2);

    return soon >= now;
  }

  /* Towers shoot the enemy furthest along the path, which is the
     one closest to the base. */
  function fire(position, tower, delta) {
    var definition = stats.towers[tower.key];

    if (!definition.attack) {
      return;
    }

    tower.cooldown = (tower.cooldown || 0) - delta;

    if (tower.cooldown > 0 || !enemies.length) {
      return;
    }

    var parts = position.split(",");
    var origin = tileCentre(Number(parts[0]), Number(parts[1]));
    var evolution = evolutionFor(tower);
    var reach =
      (stats.range(tower.key, tower.level, evolution) / stats.rangePerTile) *
      view.size;
    var attack = definition.attack;

    var inRange = enemies.filter(function (enemy) {
      var point = enemyAt(enemy);
      var dx = point.x - origin.x;
      var dy = point.y - origin.y;

      return Math.sqrt(dx * dx + dy * dy) <= reach;
    });

    if (!inRange.length) {
      return;
    }

    inRange.sort(function (a, b) {
      return b.progress - a.progress;
    });

    var primary = inRange[0];
    var aim = enemyAt(primary);

    /* Always face the lead enemy, even while holding fire. */
    tower.angle = Math.atan2(aim.y - origin.y, aim.x - origin.x) + Math.PI / 2;

    /* Cones hold until the lead enemy is at point blank. The
       cooldown is left ready so the shot goes off the instant it
       arrives. */
    if (attack.shape === "cone" && !atClosestApproach(origin, primary)) {
      return;
    }

    tower.cooldown = stats.cooldown(tower.key);

    var targets = attack.shape === "single" ? [primary] : inRange;

    targets.forEach(function (enemy) {
      var point = enemyAt(enemy);
      var dx = point.x - origin.x;
      var dy = point.y - origin.y;
      var distance = Math.sqrt(dx * dx + dy * dy);

      /* Cones only hit what is inside the arc. */
      if (attack.shape === "cone") {
        var angle = Math.atan2(dy, dx);

        if (!stats.inArc(tower.key, Math.atan2(aim.y - origin.y, aim.x - origin.x), angle)) {
          return;
        }
      }

      var statDistance = (distance / view.size) * stats.rangePerTile;

      enemy.hp -= stats.damageAtDistance(
        tower.key,
        tower.level,
        evolution,
        statDistance
      );
    });

    recordFiring(tower, origin, aim);
  }

  /* What firing looks like, per tower. */
  function recordFiring(tower, origin, aim) {
    if (tower.key === "blender") {
      /* Blades wind up while it is cutting and coast down after. */
      tower.spinPower = 1;
      return;
    }

    if (tower.key === "dagger") {
      projectiles.push({
        fromX: origin.x,
        fromY: origin.y,
        toX: aim.x,
        toY: aim.y,
        angle: Math.atan2(aim.y - origin.y, aim.x - origin.x),
        progress: 0,
        speed: 4.5
      });
      return;
    }

    /* Sniper and shotgunner kick back and leave a tracer. */
    tower.recoil = 1;

    shots.push({
      fromX: origin.x,
      fromY: origin.y,
      toX: aim.x,
      toY: aim.y,
      life: 0.12
    });
  }

  /* Coins drifting up off a farm as it pays out. */
  function spendParticles(position) {
    var parts = position.split(",");
    var centre = tileCentre(Number(parts[0]), Number(parts[1]));

    for (var i = 0; i < 5; i += 1) {
      particles.push({
        x: centre.x + (Math.random() - 0.5) * view.size * 0.6,
        y: centre.y + (Math.random() - 0.5) * view.size * 0.3,
        rise: view.size * (0.6 + Math.random() * 0.5),
        life: 1,
        delay: i * 0.08
      });
    }
  }

  /* The wave payout: a flat bonus plus every farm's output.

     Paid when the NEXT wave becomes imminent — the moment the
     intermission opens, or the moment Skip is pressed — so the
     money is in hand while there is still time to spend it.
     Wave 1 pays nothing; you begin with starting cash only. */
  function payWave() {
    var total = WAVE_BONUS;
    var farmed = 0;

    Object.keys(towers).forEach(function (position) {
      var tower = towers[position];
      var income = stats.coins(tower.key, tower.level, evolutionFor(tower));

      if (!income) {
        return;
      }

      /* Every farm pays; the board already caps how many of each
         level can exist. */
      total += income;
      farmed += income;
      spendParticles(position);
    });

    cash += total;

    notifyCash(WAVE_BONUS, "wave " + (wave + 1));

    if (farmed > 0) {
      notifyCash(farmed, "farms");
    }
  }

  /* Spin, recoil, thrown daggers and farm coins all decay or
     travel on their own once started. */
  function advanceEffects(delta) {
    Object.keys(towers).forEach(function (position) {
      var tower = towers[position];

      if (tower.spinPower) {
        tower.spin = (tower.spin || 0) + tower.spinPower * SPIN_RATE * delta;
        tower.spinPower = Math.max(0, tower.spinPower - SPIN_DECAY * delta);
      }

      if (tower.recoil) {
        tower.recoil = Math.max(0, tower.recoil - RECOIL_DECAY * delta);
      }
    });

    projectiles = projectiles.filter(function (shot) {
      shot.progress += shot.speed * delta;
      return shot.progress < 1;
    });

    particles = particles.filter(function (coin) {
      if (coin.delay > 0) {
        coin.delay -= delta;
        return true;
      }

      coin.life -= delta * 0.9;
      return coin.life > 0;
    });
  }

  function update(delta) {
    if (baseHp <= 0) {
      return;
    }

    /* Spawning. */
    if (waveActive && spawnQueue.length) {
      spawnTimer -= delta;

      if (spawnTimer <= 0) {
        spawn(spawnQueue.shift());
        spawnTimer = stats.wave.spawnGap;
      }
    }

    /* Movement, then anything that reached the base. */
    var end = view.path.length - 1;

    enemies.forEach(function (enemy) {
      enemy.progress += enemy.speed * delta;
    });

    enemies = enemies.filter(function (enemy) {
      if (enemy.hp <= 0) {
        var bounty = stats.waveBounty(enemy.kind, wave);

        cash += bounty;
        poolBounty(bounty);
        return false;
      }

      /* A leak costs the base whatever hp the enemy had left, so
         damage done on the way still counts for something. It pays
         no bounty, but the wave still counts as survived. */
      if (enemy.progress >= end) {
        baseHp = Math.max(0, baseHp - enemy.hp);
        return false;
      }

      return true;
    });

    Object.keys(towers).forEach(function (position) {
      fire(position, towers[position], delta);
    });

    shots = shots.filter(function (shot) {
      shot.life -= delta;
      return shot.life > 0;
    });

    advanceEffects(delta);
    flushBounty(delta);

    /* A wave counts once nothing is left on the path, however it
       got there. Tanking a wave with the base is a valid way to
       survive it — the cost is the health, not the credit. */
    if (waveActive && !spawnQueue.length && !enemies.length) {
      waveActive = false;
      wavesSurvived = wave;
      breakLeft = BREAK_SECONDS;

      /* The intermission belongs to the wave ahead, so it pays
         out as it opens. */
      payWave();
    }

    /* The breather runs itself out and starts the next wave. */
    if (!waveActive && breakLeft > 0) {
      breakLeft -= delta;

      if (breakLeft <= 0) {
        breakLeft = 0;
        startWave();
      }
    }

    /* Auto skip does not wait for either. Starting fills the spawn
       queue, so canStart goes false again immediately and waves
       chain rather than firing every frame. */
    if (autoSkip && canStart()) {
      beginNextWave();
    }

    if (baseHp <= 0) {
      endRun();
    }
  }

  function loop(timestamp) {
    if (!running) {
      return;
    }

    var delta = Math.min((timestamp - lastFrame) / 1000, 0.05);

    lastFrame = timestamp;

    /* Fixed slices, so 2x and 10x are genuinely the same game
       running faster rather than a coarser one. */
    var remaining = delta * speed;
    var steps = 0;

    while (remaining > 0 && steps < MAX_STEPS && running) {
      update(Math.min(STEP, remaining));
      remaining -= STEP;
      steps += 1;
    }

    refreshHud();
    draw();

    window.requestAnimationFrame(loop);
  }

  /* =========================================================
     Cash, base, selling
     ========================================================= */

  function isDev() {
    return Boolean(window.MRTD && window.MRTD.dev);
  }

  function upgradeLevel(name) {
    return window.MRTD.upgrade ? window.MRTD.upgrade(name) : 0;
  }

  /* Permanent progression, read once when a tower is placed and
     carried on the tower itself so it survives merges. */
  function evolutionOf(name) {
    return window.MRTD.evolutionOf ? window.MRTD.evolutionOf(name) : 0;
  }

  function evolutionFor(tower) {
    return tower.evolution === undefined
      ? evolutionOf(tower.key)
      : tower.evolution;
  }

  function placementLimit() {
    return stats.placementLimit(upgradeLevel("placements"));
  }

  function placed() {
    return Object.keys(towers).length;
  }

  /* =========================================================
     Money notifications

     Kills are pooled for a moment before being announced —
     one line per enemy would be unreadable at 10x.
     ========================================================= */

  var BOUNTY_FLUSH = 0.9;

  var bountyPool = 0;
  var bountyTimer = 0;

  function notifyCash(amount, reason) {
    var rounded = Math.round(amount);

    if (!rounded || !cashfeed) {
      return;
    }

    var line = document.createElement("p");

    line.className = "cashfeed__line";
    line.textContent = "+" + rounded + "  " + reason;
    cashfeed.appendChild(line);

    window.setTimeout(function () {
      if (line.parentNode) {
        line.parentNode.removeChild(line);
      }
    }, 1800);
  }

  function poolBounty(amount) {
    bountyPool += amount;
  }

  function flushBounty(delta) {
    if (bountyPool <= 0) {
      return;
    }

    bountyTimer += delta;

    if (bountyTimer < BOUNTY_FLUSH) {
      return;
    }

    notifyCash(bountyPool, "kills");
    bountyPool = 0;
    bountyTimer = 0;
  }

  function refreshHud() {
    cashDisplay.textContent = isDev() ? "∞" : String(Math.floor(cash));
    hpDisplay.textContent = String(Math.max(0, Math.round(baseHp)));
    placedDisplay.textContent = placed() + " / " + placementLimit();
    waveDisplay.textContent = String(wave);

    /* Everything on the path, including whatever is still queued
       to spawn this wave. */
    aliveDisplay.textContent = String(enemies.length + spawnQueue.length);

    /* What the run is worth if it ended right now. Surviving a
       wave is enough — tanking one with the base still counts. */
    beatenDisplay.textContent = String(wavesSurvived);
    payoutDisplay.textContent = isDev()
      ? "0"
      : String(stats.runReward(wavesSurvived));
    exitButton.disabled = baseHp > 0;

    /* Skip is offered once the wave has finished spawning and
       there is still something left to kill. The two buttons do
       the same job, so only one is ever shown. */
    var canSkip = waveActive && !spawnQueue.length && enemies.length > 0;

    skipButton.hidden = !canSkip;
    startButton.hidden = canSkip;

    /* Counts down through the intermission, then starts itself. */
    startButton.disabled = !canStart();
    startButton.textContent =
      breakLeft > 0 ? "Start wave (" + Math.ceil(breakLeft) + ")" : "Start wave";

    refreshHotbar();
  }

  function sellZoneRect() {
    var width = Math.min(260, window.innerWidth - 40);
    var height = 62;

    return {
      x: (window.innerWidth - width) / 2,
      y: window.innerHeight - height - 110,
      width: width,
      height: height
    };
  }

  function inSellZone(x, y) {
    if (!sellZone) {
      return false;
    }

    return (
      x >= sellZone.x && x <= sellZone.x + sellZone.width &&
      y >= sellZone.y && y <= sellZone.y + sellZone.height
    );
  }

  function sell(from) {
    var tower = towers[from];

    if (!tower) {
      return;
    }

    var refund = stats.sellValue(tower.key, tower.level);

    cash += refund;
    notifyCash(refund, "sold");
    delete towers[from];
    refreshHud();
  }

  /* =========================================================
     Hotbar
     ========================================================= */

  /* The five towers equipped in the Towers tab. Falls back to the
     full list so the match is still playable before anything is
     owned. */
  function loadoutKeys() {
    /* Developer mode ignores the loadout and unlocks everything. */
    if (isDev()) {
      return TOWER_KEYS;
    }

    var equipped = window.MRTD.loadout ? window.MRTD.loadout() : [];

    return equipped.length ? equipped : TOWER_KEYS;
  }

  function buildHotbar() {
    hotbar.textContent = "";
    closeLevels();

    loadoutKeys().forEach(function (name) {
      var button = document.createElement("button");

      button.className = "hotbar__slot";
      button.type = "button";
      button.dataset.tower = name;

      var icon = document.createElement("img");
      icon.className = "hotbar__icon";
      icon.src = towerArt(name);
      icon.alt = stats.towers[name].label;
      button.appendChild(icon);

      var price = document.createElement("span");
      price.className = "hotbar__cost";
      price.textContent = String(stats.cost(name));
      button.appendChild(price);

      /* The slots are icons only, so the name appears above the
         one under the pointer. */
      var label = document.createElement("span");
      label.className = "hotbar__name";
      label.textContent = stats.towers[name].label;
      button.appendChild(label);
      button.title = stats.towers[name].label;

      /* Tap selects a level 1. Hold opens the level picker, which
         is the Quick buy upgrade. */
      button.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        held = false;

        if (!upgradeLevel("quick_buy")) {
          return;
        }

        holdTimer = window.setTimeout(function () {
          held = true;
          openLevels(name, button);
        }, HOLD_MS);
      });

      button.addEventListener("pointerup", function () {
        window.clearTimeout(holdTimer);

        if (held) {
          return;
        }

        select(name, 1);
      });

      button.addEventListener("pointerleave", function () {
        window.clearTimeout(holdTimer);
      });

      hotbar.appendChild(button);
    });
  }

  function select(name, level) {
    var same = placing && placing.key === name && placing.level === level;

    placing = same ? null : { key: name, level: level };
    closeLevels();
    refreshHotbar();
    draw();
  }

  function affordable(name, level) {
    if (placed() >= placementLimit()) {
      return false;
    }

    return isDev() || stats.buyCost(name, level) <= cash;
  }

  /* Quick buy level 1 unlocks merge level 2, level 9 unlocks 10.
     Level 1 towers never need the upgrade. */
  function maxBuyLevel() {
    return Math.min(MAX_LEVEL, 1 + upgradeLevel("quick_buy"));
  }

  /* Buy a merged tower outright: 1n, 2n, 4n, 8n and so on. */
  function openLevels(name, button) {
    var ceiling = maxBuyLevel();

    levels.textContent = "";

    for (var level = 1; level <= ceiling; level += 1) {
      levels.appendChild(levelRow(name, level));
    }

    var box = button.getBoundingClientRect();

    levels.hidden = false;
    levels.style.left = Math.max(8, box.left) + "px";
    levels.style.bottom = window.innerHeight - box.top + 8 + "px";
  }

  function levelRow(name, level) {
    var row = document.createElement("button");
    var price = stats.buyCost(name, level);

    row.className = "levels__row";
    row.type = "button";
    row.disabled = !affordable(name, level);

    var label = document.createElement("span");
    label.textContent = "Lv " + level;
    row.appendChild(label);

    var amount = document.createElement("span");
    amount.className = "levels__price";
    amount.textContent = isDev() ? "free" : String(price);
    row.appendChild(amount);

    row.addEventListener("click", function () {
      select(name, level);
    });

    return row;
  }

  function closeLevels() {
    levels.hidden = true;
  }

  /* =========================================================
     Inspect panel — right click a placed tower
     ========================================================= */

  function describeAttack(name) {
    var attack = stats.attack(name);

    if (!attack) {
      return "None";
    }

    if (attack.shape === "cone") {
      return attack.angle + "° cone, falls to " +
        Math.round(attack.falloffTo * 100) + "% at max range";
    }

    if (attack.shape === "circle") {
      return "All targets in range";
    }

    return "Single target";
  }

  function statLine(label, value) {
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

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function openInspect(tower, x, y) {
    var definition = stats.towers[tower.key];
    var evolution = evolutionFor(tower);
    var damage = stats.damage(tower.key, tower.level, evolution);
    var cooldown = stats.cooldown(tower.key);
    var reach =
      stats.range(tower.key, tower.level, evolution) / stats.rangePerTile;

    inspect.textContent = "";

    var title = document.createElement("p");
    title.className = "inspect__title";
    title.textContent =
      definition.label + "  ·  Level " + tower.level +
      (evolution ? "  ·  Evo " + evolution : "");
    inspect.appendChild(title);

    if (damage > 0) {
      inspect.appendChild(statLine("Damage", String(Math.round(damage))));
      inspect.appendChild(statLine("Cooldown", cooldown + "s"));
      inspect.appendChild(
        statLine("DPS", String(Math.round(damage / cooldown)))
      );
    }

    var coins = stats.coins(tower.key, tower.level, evolution);

    if (coins > 0) {
      inspect.appendChild(
        statLine("Cash per wave", String(Math.round(coins)))
      );
    }

    inspect.appendChild(statLine("Range", round(reach) + " tiles"));
    inspect.appendChild(statLine("Attack", describeAttack(tower.key)));
    inspect.appendChild(
      statLine("Worth", String(Math.round(stats.buyCost(tower.key, tower.level))))
    );
    inspect.appendChild(
      statLine("Sells for", String(Math.round(stats.sellValue(tower.key, tower.level))))
    );

    inspect.hidden = false;

    /* Kept inside the window whichever corner it is opened in. */
    var box = inspect.getBoundingClientRect();
    var left = Math.min(x + 14, window.innerWidth - box.width - 12);
    var top = Math.min(y + 14, window.innerHeight - box.height - 12);

    inspect.style.left = Math.max(12, left) + "px";
    inspect.style.top = Math.max(12, top) + "px";
  }

  function closeInspect() {
    inspect.hidden = true;
    inspected = null;
  }

  function refreshHotbar() {
    Array.prototype.forEach.call(hotbar.children, function (button) {
      var name = button.dataset.tower;

      button.disabled = !affordable(name, 1);
      button.classList.toggle(
        "is-selected",
        Boolean(placing && placing.key === name)
      );
    });
  }

  function place(tile) {
    if (!tile || !placing) {
      return;
    }

    /* Guards against a stale selection after an upgrade change. */
    if (placing.level > maxBuyLevel()) {
      placing = null;
      return;
    }

    var at = key(tile[0], tile[1]);

    if (!buildable(tile[0], tile[1]) || towers[at]) {
      return;
    }

    /* Merging never breaches the limit, only new placements do. */
    if (placed() >= placementLimit()) {
      return;
    }

    var price = stats.buyCost(placing.key, placing.level);

    if (!isDev()) {
      if (price > cash) {
        return;
      }

      cash -= price;
    }

    towers[at] = {
      key: placing.key,
      level: placing.level,
      evolution: evolutionOf(placing.key),
      cooldown: 0,
      angle: 0
    };
    placing = null;
    resolveFarms();
    refreshHud();
  }

  /* =========================================================
     Input
     ========================================================= */

  /* Right click a placed tower to read everything about it. */
  canvas.addEventListener("contextmenu", function (event) {
    event.preventDefault();

    var point = pointerPosition(event);
    var tile = tileAt(point.x, point.y);
    var tower = tile && towers[key(tile[0], tile[1])];

    if (!tower) {
      closeInspect();
      return;
    }

    inspected = key(tile[0], tile[1]);
    openInspect(tower, event.clientX, event.clientY);
    draw();
  });

  canvas.addEventListener("pointerdown", function (event) {
    var point = pointerPosition(event);
    var tile = tileAt(point.x, point.y);

    closeInspect();

    /* Second click commits the tower being positioned. */
    if (placing) {
      place(tile);
      draw();
      return;
    }

    if (!tile) {
      return;
    }

    var at = key(tile[0], tile[1]);

    if (!towers[at]) {
      return;
    }

    drag = { from: at, tower: towers[at], x: point.x, y: point.y };
    sellZone = sellZoneRect();
    canvas.setPointerCapture(event.pointerId);
    draw();
  });

  canvas.addEventListener("pointermove", function (event) {
    var point = pointerPosition(event);

    pointer = point;

    if (drag) {
      drag.x = point.x;
      drag.y = point.y;
      draw();
      return;
    }

    if (placing) {
      draw();
      return;
    }

    var tile = tileAt(point.x, point.y);
    var next = tile ? key(tile[0], tile[1]) : null;

    if (next !== hover) {
      hover = next;
      draw();
    }
  });

  canvas.addEventListener("pointerup", function (event) {
    if (!drag) {
      return;
    }

    var point = pointerPosition(event);

    if (inSellZone(point.x, point.y)) {
      sell(drag.from);
    } else {
      drop(drag.from, tileAt(point.x, point.y));
    }

    drag = null;
    sellZone = null;
    draw();
  });

  canvas.addEventListener("pointercancel", function () {
    drag = null;
    sellZone = null;
    draw();
  });

  canvas.addEventListener("pointerleave", function () {
    if (hover !== null) {
      hover = null;
      draw();
    }
  });

  /* Escape cancels a pending placement. */
  window.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") {
      return;
    }

    if (!inspect.hidden) {
      closeInspect();
      return;
    }

    if (!levels.hidden) {
      closeLevels();
      return;
    }

    if (placing) {
      placing = null;
      refreshHotbar();
      draw();
    }
  });

  /* Clicking away closes the level picker. */
  document.addEventListener("pointerdown", function (event) {
    if (levels.hidden || levels.contains(event.target)) {
      return;
    }

    if (hotbar.contains(event.target)) {
      return;
    }

    closeLevels();
  });

  /* =========================================================
     Placing and merging
     ========================================================= */

  /* At most two farms of any one level may stand on the board. A
     third folds two of them into the next level up, cascading if
     that lands on a full level too. */
  var FARMS_PER_LEVEL = 2;

  function resolveFarms() {
    var merged = true;

    while (merged) {
      merged = false;

      var byLevel = {};

      Object.keys(towers).forEach(function (position) {
        var tower = towers[position];

        if (tower.key !== "farm") {
          return;
        }

        byLevel[tower.level] = byLevel[tower.level] || [];
        byLevel[tower.level].push(position);
      });

      var levels = Object.keys(byLevel);

      for (var i = 0; i < levels.length; i += 1) {
        var level = Number(levels[i]);
        var group = byLevel[level];

        if (group.length > FARMS_PER_LEVEL && level < MAX_LEVEL) {
          towers[group[0]].level = level + 1;
          delete towers[group[1]];
          merged = true;
          break;
        }
      }
    }
  }

  function canMerge(source, target) {
    return Boolean(
      source && target &&
      source.key === target.key &&
      source.level === target.level &&
      source.level < MAX_LEVEL
    );
  }

  function drop(from, target) {
    var tower = towers[from];

    if (!target || !buildable(target[0], target[1])) {
      return;
    }

    var to = key(target[0], target[1]);

    if (to === from) {
      return;
    }

    var occupant = towers[to];

    if (canMerge(tower, occupant)) {
      towers[to] = {
        key: tower.key,
        level: tower.level + 1,
        evolution: evolutionFor(tower),
        cooldown: 0,
        angle: tower.angle || 0
      };
      delete towers[from];
      resolveFarms();
      return;
    }

    if (!occupant) {
      towers[to] = tower;
      delete towers[from];
      return;
    }

    towers[to] = tower;
    towers[from] = occupant;
  }

  /* =========================================================
     Run lifecycle
     ========================================================= */

  function startRun() {
    towers = {};
    enemies = [];
    shots = [];
    projectiles = [];
    particles = [];
    spawnQueue = [];
    cash = stats.startingCashFor(upgradeLevel("starting_cash"));
    baseHp = stats.baseHp;
    wave = 0;
    wavesSurvived = 0;
    waveActive = false;

    /* The same breather as between waves, so there is time to
       place towers before anything walks in. */
    breakLeft = BREAK_SECONDS;

    /* Never carried over from the last match. */
    setAuto(false);
    placing = null;
    drag = null;
    hover = null;
    gameover.hidden = true;
    refreshHud();
  }

  function endRun() {
    running = false;
    waveActive = false;

    gameoverWaves.textContent = String(wavesSurvived);
    gameoverCoins.textContent = isDev()
      ? "0"
      : String(stats.runReward(wavesSurvived));
    gameoverNote.hidden = false;
    gameoverNote.textContent = isDev()
      ? "Dev mode — nothing banked"
      : "Banking...";
    gameover.hidden = false;

    banking = bankRun(wavesSurvived);
  }

  /* Credit the coins server side. The reward is recalculated in
     Postgres from the wave count, so the browser cannot name its
     own figure.

     Whatever happens is reported on the panel — a run that pays
     nothing should say why rather than look broken. */
  function bankRun(waves) {
    var session = window.MRTD.session();

    if (isDev()) {
      return Promise.resolve();
    }

    if (!session || !session.access_token) {
      gameoverNote.textContent = "Not signed in — nothing banked";
      return Promise.resolve();
    }

    return fetch(window.MRTD.url + "/rest/v1/rpc/bank_run", {
      method: "POST",
      headers: {
        apikey: window.MRTD.key,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ waves_beaten: waves, sandbox: false })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) {
            throw new Error(data.message || data.msg || "Request failed");
          }

          return data;
        });
      })
      .then(function (balance) {
        gameoverNote.textContent = "Banked · " + balance + " coins total";
      })
      .catch(function (error) {
        gameoverNote.textContent = "Could not bank: " + error.message;
      });
  }

  function open() {
    root.hidden = false;
    buildHotbar();
    startRun();

    if (layout()) {
      draw();
    }

    running = true;
    lastFrame = window.performance.now();
    window.requestAnimationFrame(loop);
  }

  function close() {
    if (baseHp > 0) {
      return;
    }

    running = false;
    gameover.hidden = true;
    root.hidden = true;
  }

  if (playButton) {
    playButton.addEventListener("click", function () {
      /* Deliberately unhurried: two to five seconds. */
      var wait = 2000 + Math.floor(Math.random() * 3000);

      window.MRTD.load("Preparing the field", wait, open);
    });
  }

  /* The lobby is re-entered through a full reload, so a player
     coming out of a match always picks up whatever has been
     deployed since they started it — but never before the coins
     have finished banking. */
  function leave() {
    close();
    window.MRTD.load("Returning to lobby", 1400, function () {
      Promise.resolve(banking).then(function () {
        window.location.reload();
      });
    });
  }

  exitButton.addEventListener("click", leave);
  gameoverLeave.addEventListener("click", leave);
  startButton.addEventListener("click", startWave);

  /* Skipping starts the next wave while stragglers are still on
     the path, and pays out as it goes. */
  skipButton.addEventListener("click", beginNextWave);

  /* 2x is an upgrade. 10x only exists while an admin has switched
     it on, so players see no trace of it until then. */
  function speedChoices() {
    var choices = isDev() || upgradeLevel("game_speed") ? [1, 2] : [1];

    if (isDev() || (window.MRTD.feature && window.MRTD.feature("speed10"))) {
      choices.push(10);
    }

    return choices;
  }

  function setSpeed(next) {
    speed = next;
    speedButton.textContent = speed + "×";
    speedButton.classList.toggle("is-on", speed > 1);
  }

  speedButton.addEventListener("click", function () {
    var choices = speedChoices();
    var index = choices.indexOf(speed);

    setSpeed(choices[(index + 1) % choices.length]);
  });

  function setAuto(on) {
    autoSkip = Boolean(on);
    autoButton.textContent = "Auto: " + (autoSkip ? "on" : "off");
    autoButton.classList.toggle("is-on", autoSkip);
  }

  autoButton.addEventListener("click", function () {
    setAuto(!autoSkip);
  });

  /* Toggling developer mode mid match takes effect immediately. */
  /* A switch turned off mid match must not leave the player on a
     speed they no longer have. */
  document.addEventListener("mrtd:settings", function () {
    if (speedChoices().indexOf(speed) < 0) {
      setSpeed(1);
    }
  });

  document.addEventListener("mrtd:dev", function () {
    /* Leaving developer mode while at 10x drops back to normal. */
    if (speedChoices().indexOf(speed) < 0) {
      setSpeed(1);
    }

    if (!root.hidden) {
      buildHotbar();
      refreshHud();
      draw();
    }
  });


  /* Nothing else can finish a run early, and without this the
     player would be stuck once they stop pressing Start wave. */
  forfeitButton.addEventListener("click", function () {
    baseHp = 0;
    endRun();
    refreshHud();
    draw();
  });

  window.addEventListener("resize", function () {
    if (!root.hidden && layout()) {
      draw();
    }
  });

  /* Card art for the lobby: the drawn plan view at full merge
     level, rendered offscreen once and handed over as an image.
     Towers with real artwork use their own top level costume. */
  function towerArt(name, level) {
    var at = level || MAX_LEVEL;

    if (ART_TOWERS.indexOf(name) >= 0) {
      return "towers/" + name + "/" + at + ".svg";
    }

    var size = 160;
    var off = document.createElement("canvas");
    var previous = ctx;

    off.width = size;
    off.height = size;

    /* drawTopTower paints through the module context, so it is
       pointed at the offscreen canvas for the duration. */
    ctx = off.getContext("2d");
    drawTopTower({ key: name, level: at, angle: 0 }, 0, 0, size);
    ctx = previous;

    return off.toDataURL();
  }

  window.MRTD.towerArt = towerArt;
  document.dispatchEvent(new CustomEvent("mrtd:art"));

  buildHotbar();
  setAuto(false);
  loadSprites();
})();
