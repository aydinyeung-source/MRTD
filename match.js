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

  /* Top down designs, drawn rather than imported. Colours come from
     the real SVGs so both views agree, and detail grows with merge
     level. These are authored plan views, not conversions — a side
     elevation carries no depth information to convert from. */
  var TOKENS = {
    blender: { body: "#8e8e8e", accent: "#ff140a", plan: "blades" },
    dagger: { body: "#949494", accent: "#bb0000", plan: "blades" },
    farm: { body: "#eae484", accent: "#b8ae4a", plan: "field" },
    shotgunner: { body: "#656565", accent: "#8c8c8c", plan: "barrels" },
    sniper: { body: "#2b2b2b", accent: "#8c8c8c", plan: "barrel" }
  };

  var VIEW_KEY = "mrtd.view";
  var viewMode = "top";

  var root = document.getElementById("match");
  var canvas = document.getElementById("match-canvas");
  var exitButton = document.getElementById("match-exit");
  var viewButton = document.getElementById("match-view");
  var forfeitButton = document.getElementById("match-forfeit");
  var startButton = document.getElementById("match-start");
  var speedButton = document.getElementById("match-speed");
  var skipButton = document.getElementById("match-skip");
  var hotbar = document.getElementById("hotbar");
  var cashDisplay = document.getElementById("match-cash");
  var hpDisplay = document.getElementById("match-hp");
  var waveDisplay = document.getElementById("match-wave");
  var gameover = document.getElementById("gameover");
  var gameoverWaves = document.getElementById("gameover-waves");
  var gameoverCoins = document.getElementById("gameover-coins");
  var gameoverNote = document.getElementById("gameover-note");
  var gameoverLeave = document.getElementById("gameover-leave");
  var playButton = document.getElementById("play");

  if (!canvas || !root) {
    return;
  }

  var ctx = canvas.getContext("2d");

  var towers = {};
  var sprites = {};
  var enemies = [];
  var shots = [];

  var cash = 0;
  var baseHp = 0;
  var wave = 0;
  var wavesBeaten = 0;
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

  var view = { cols: 0, rows: 0, size: 0, x: 0, y: 0, path: [] };
  var drag = null;
  var hover = null;
  var sellZone = null;

  /* The tower waiting to be positioned: shown semi-opaque until a
     second click commits it. */
  var placing = null;
  var pointer = { x: 0, y: 0 };

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

  function loadSprites() {
    TOWER_KEYS.forEach(function (name) {
      sprites[name] = {};

      for (var level = 1; level <= MAX_LEVEL; level += 1) {
        loadSprite(name, level);
      }
    });
  }

  function loadSprite(name, level) {
    var image = new Image();

    image.onload = function () {
      sprites[name][level] = image;
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

  function planBlades(token, radius, level) {
    var count = 3 + Math.floor((level - 1) / 2);

    ctx.fillStyle = token.accent;

    for (var i = 0; i < count; i += 1) {
      ctx.save();
      ctx.rotate((i / count) * Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(-radius * 0.16, 0);
      ctx.lineTo(0, -radius * 1.45);
      ctx.lineTo(radius * 0.16, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function planField(token, radius, level) {
    var rows = 2 + Math.floor(level / 2);

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1, radius * 0.1);
    ctx.beginPath();

    for (var i = 1; i <= rows; i += 1) {
      var y = -radius + (radius * 2 * i) / (rows + 1);
      ctx.moveTo(-radius * 0.78, y);
      ctx.lineTo(radius * 0.78, y);
    }

    ctx.stroke();
  }

  function planBarrels(token, radius, level) {
    var count = level < 4 ? 2 : level < 8 ? 3 : 4;
    var width = radius * 0.26;
    var span = width * (count - 1) * 1.5;

    ctx.fillStyle = token.accent;

    for (var i = 0; i < count; i += 1) {
      var offset = -span / 2 + i * width * 1.5;
      ctx.fillRect(offset - width / 2, -radius * 1.5, width, radius * 1.1);
    }
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
    field: planField,
    barrels: planBarrels,
    barrel: planBarrel
  };

  function drawTopTower(tower, x, y, size) {
    var token = TOKENS[tower.key];

    if (!token) {
      return;
    }

    var radius = size * 0.32;
    var attack = stats.attack(tower.key);
    var isField = token.plan === "field";

    ctx.save();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate(tower.angle || 0);

    if (attack && attack.shape === "cone") {
      var half = (attack.angle * Math.PI) / 360;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius * 2, -Math.PI / 2 - half, -Math.PI / 2 + half);
      ctx.closePath();
      ctx.fillStyle = "rgba(34, 42, 47, 0.12)";
      ctx.fill();
    }

    if (!isField && PLANS[token.plan]) {
      PLANS[token.plan](token, radius, tower.level);
    }

    ctx.beginPath();

    if (isField) {
      roundedPath(-radius, -radius, radius * 2, radius * 2, radius * 0.3);
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

  function drawTower(tower, x, y, size) {
    if (viewMode === "top") {
      drawTopTower(tower, x, y, size);
      return;
    }

    var sprite = sprites[tower.key] && sprites[tower.key][tower.level];

    if (sprite) {
      var scale = Math.min(size / sprite.width, size / sprite.height);
      var width = sprite.width * scale;
      var height = sprite.height * scale;

      ctx.drawImage(sprite, x + (size - width) / 2, y + size - height, width, height);
    } else {
      roundedPath(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7, 6);
      ctx.fillStyle = "#4f6a78";
      ctx.fill();
    }

    ctx.fillStyle = "#222a2f";
    ctx.font = "600 " + Math.max(9, Math.round(size * 0.26)) + "px 'IBM Plex Mono', monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(tower.level), x + size - 2, y + size - 1);
  }

  function drawRange(tower, centreX, centreY) {
    var tiles = stats.range(tower.key, tower.level, 0) / stats.rangePerTile;

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
    var tiles = stats.range(tower.key, tower.level, 0) / stats.rangePerTile;
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

    ctx.fillStyle = "rgba(34, 42, 47, 0.25)";
    ctx.fillRect(point.x - width / 2, point.y - radius - 7, width, 4);
    ctx.fillStyle = fraction > 0.4 ? "#5f8a63" : "#9d4b45";
    ctx.fillRect(point.x - width / 2, point.y - radius - 7, width * fraction, 4);
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

  function draw() {
    if (!view.size) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawField();
    drawPortal();
    drawBase();

    if (!drag && !placing && hover && towers[hover]) {
      var at = hover.split(",");
      var centre = tileCentre(Number(at[0]), Number(at[1]));
      drawRange(towers[hover], centre.x, centre.y);
    }

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

    /* Ghost of the tower waiting to be committed. */
    if (placing) {
      var tile = tileAt(pointer.x, pointer.y);
      var ghost = { key: placing, level: 1 };

      if (tile) {
        var target = tileRect(tile[0], tile[1]);
        var allowed = buildable(tile[0], tile[1]) && !towers[key(tile[0], tile[1])];

        drawRange(ghost, target.x + target.size / 2, target.y + target.size / 2);

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

    /* Paid up front, so the money is available to spend on the
       wave you are about to face. */
    payWave();

    var pool = stats.wavePool(wave);
    var count = stats.waveCount(wave);

    for (var i = 0; i < count; i += 1) {
      spawnQueue.push(pool[Math.floor(Math.random() * pool.length)]);
    }

    refreshHud();
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
    var reach = (stats.range(tower.key, tower.level, 0) / stats.rangePerTile) * view.size;
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

    /* Face the target: the plan view rotates to match. */
    tower.angle = Math.atan2(aim.y - origin.y, aim.x - origin.x) + Math.PI / 2;
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

      enemy.hp -= stats.damageAtDistance(tower.key, tower.level, 0, statDistance);
    });

    shots.push({
      fromX: origin.x,
      fromY: origin.y,
      toX: aim.x,
      toY: aim.y,
      life: 0.12
    });
  }

  /* Paid when a wave starts: a flat bonus plus every farm's
     output for that wave. */
  function payWave() {
    var total = WAVE_BONUS;

    Object.keys(towers).forEach(function (position) {
      var tower = towers[position];

      total += stats.coins(tower.key, tower.level, 0);
    });

    cash += total;
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
        cash += stats.waveBounty(enemy.kind, wave);
        return false;
      }

      /* A leak costs the base whatever hp the enemy had left, so
         damage done on the way still counts for something. */
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

    /* Wave clears when everything is spawned and dead. */
    if (waveActive && !spawnQueue.length && !enemies.length) {
      waveActive = false;
      wavesBeaten = wave;
      breakLeft = BREAK_SECONDS;
    }

    /* The breather runs itself out and starts the next wave. */
    if (!waveActive && breakLeft > 0) {
      breakLeft -= delta;

      if (breakLeft <= 0) {
        breakLeft = 0;
        startWave();
      }
    }

    if (baseHp <= 0) {
      endRun();
    }

    refreshHud();
  }

  function loop(timestamp) {
    if (!running) {
      return;
    }

    var delta = Math.min((timestamp - lastFrame) / 1000, 0.05);

    lastFrame = timestamp;

    update(delta * speed);
    draw();

    window.requestAnimationFrame(loop);
  }

  /* =========================================================
     Cash, base, selling
     ========================================================= */

  function isDev() {
    return Boolean(window.MRTD && window.MRTD.dev);
  }

  function refreshHud() {
    cashDisplay.textContent = isDev() ? "∞" : String(Math.floor(cash));
    hpDisplay.textContent = String(Math.max(0, Math.round(baseHp)));
    waveDisplay.textContent = String(wave);
    exitButton.disabled = baseHp > 0;

    /* Counts down through the break, then starts itself. */
    startButton.disabled = !canStart();
    startButton.textContent =
      breakLeft > 0 ? "Start wave (" + Math.ceil(breakLeft) + ")" : "Start wave";

    /* Only offered once the wave has finished spawning and there
       is still something left to kill. */
    skipButton.hidden = !(waveActive && !spawnQueue.length && enemies.length > 0);

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

    cash += stats.sellValue(tower.key, tower.level);
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

    loadoutKeys().forEach(function (name) {
      var button = document.createElement("button");

      button.className = "hotbar__slot";
      button.type = "button";
      button.dataset.tower = name;

      var icon = document.createElement("img");
      icon.className = "hotbar__icon";
      icon.src = "towers/" + name + "/1.svg";
      icon.alt = stats.towers[name].label;
      button.appendChild(icon);

      var price = document.createElement("span");
      price.className = "hotbar__cost";
      price.textContent = String(stats.cost(name));
      button.appendChild(price);

      button.addEventListener("click", function () {
        placing = placing === name ? null : name;
        refreshHotbar();
        draw();
      });

      hotbar.appendChild(button);
    });
  }

  function refreshHotbar() {
    Array.prototype.forEach.call(hotbar.children, function (button) {
      var name = button.dataset.tower;

      button.disabled = !isDev() && stats.cost(name) > cash;
      button.classList.toggle("is-selected", placing === name);
    });
  }

  function place(tile) {
    if (!tile || !placing) {
      return;
    }

    var at = key(tile[0], tile[1]);

    if (!buildable(tile[0], tile[1]) || towers[at]) {
      return;
    }

    var price = stats.cost(placing);

    if (!isDev()) {
      if (price > cash) {
        return;
      }

      cash -= price;
    }
    towers[at] = { key: placing, level: 1, cooldown: 0, angle: 0 };
    placing = null;
    refreshHud();
  }

  /* =========================================================
     Input
     ========================================================= */

  canvas.addEventListener("pointerdown", function (event) {
    var point = pointerPosition(event);
    var tile = tileAt(point.x, point.y);

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
    if (event.key === "Escape" && placing) {
      placing = null;
      refreshHotbar();
      draw();
    }
  });

  /* =========================================================
     Placing and merging
     ========================================================= */

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
        cooldown: 0,
        angle: tower.angle || 0
      };
      delete towers[from];
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
    spawnQueue = [];
    cash = stats.startingCash;
    baseHp = stats.baseHp;
    wave = 0;
    wavesBeaten = 0;
    waveActive = false;
    breakLeft = 0;
    placing = null;
    drag = null;
    hover = null;
    gameover.hidden = true;
    refreshHud();
  }

  function endRun() {
    running = false;
    waveActive = false;

    gameoverWaves.textContent = String(wavesBeaten);
    gameoverCoins.textContent = isDev()
      ? "0"
      : String(stats.runReward(wavesBeaten));
    gameoverNote.hidden = !isDev();
    gameover.hidden = false;

    bankRun(wavesBeaten);
  }

  /* Credit the coins server side. The reward is recalculated in
     Postgres from the wave count, so the browser cannot name its
     own figure. */
  function bankRun(waves) {
    var session = window.MRTD.session();

    if (!session || !session.access_token) {
      return;
    }

    fetch(window.MRTD.url + "/rest/v1/rpc/bank_run", {
      method: "POST",
      headers: {
        apikey: window.MRTD.key,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        waves_beaten: waves,
        /* Developer runs pay nothing and leave no trace. */
        sandbox: isDev()
      })
    }).catch(function () {
      /* Offline: the run still shows its reward on screen. */
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

  /* =========================================================
     View setting
     ========================================================= */

  function applyView(mode) {
    viewMode = mode === "3d" ? "3d" : "top";
    viewButton.textContent = viewMode === "3d" ? "View: 3D - beta" : "View: Top";

    try {
      localStorage.setItem(VIEW_KEY, viewMode);
    } catch (error) {
      /* Private browsing can refuse storage; the view still works. */
    }

    draw();
  }

  function restoreView() {
    var saved = null;

    try {
      saved = localStorage.getItem(VIEW_KEY);
    } catch (error) {
      saved = null;
    }

    applyView(saved || "top");
  }

  if (playButton) {
    playButton.addEventListener("click", open);
  }

  exitButton.addEventListener("click", close);
  gameoverLeave.addEventListener("click", close);
  startButton.addEventListener("click", startWave);

  /* Skipping starts the next wave while stragglers are still on
     the path, which is the same call. */
  skipButton.addEventListener("click", startWave);

  speedButton.addEventListener("click", function () {
    speed = speed === 1 ? 2 : 1;
    speedButton.textContent = speed + "×";
    speedButton.classList.toggle("is-on", speed === 2);
  });

  /* Toggling developer mode mid match takes effect immediately. */
  document.addEventListener("mrtd:dev", function () {
    if (!root.hidden) {
      buildHotbar();
      refreshHud();
      draw();
    }
  });

  viewButton.addEventListener("click", function () {
    applyView(viewMode === "top" ? "3d" : "top");
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

  buildHotbar();
  restoreView();
  loadSprites();
})();
