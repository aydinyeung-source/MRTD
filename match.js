(function () {
  "use strict";

  /* =========================================================
     The match map.

     Everything is a tile, and one tile is stats.rangePerTile
     worth of range. Nothing spawns yet — this is the field, the
     portal, the base, and tower placement only.

     The path switchbacks across the map so a long ranged tower
     parked between two runs can cover both.
     ========================================================= */

  var stats = window.MRTD && window.MRTD.stats;

  var GRID = { cols: 26, rows: 15 };

  /* Corners of the path, in landscape tile coordinates. Portal is
     the first, base is the last. Segments are always straight. */
  var WAYPOINTS = [
    [0, 2],
    [21, 2],
    [21, 6],
    [4, 6],
    [4, 10],
    [22, 10],
    [22, 13],
    [1, 13]
  ];

  var MAX_LEVEL = 10;

  var TOWER_KEYS = ["blender", "dagger", "farm", "shotgunner", "sniper"];

  var root = document.getElementById("match");
  var canvas = document.getElementById("match-canvas");
  var exitButton = document.getElementById("match-exit");
  var addButton = document.getElementById("match-add");
  var playButton = document.getElementById("play");

  if (!canvas || !root) {
    return;
  }

  var ctx = canvas.getContext("2d");

  /* Tower positions, keyed "col,row". */
  var towers = {};
  var sprites = {};

  var view = { cols: 0, rows: 0, size: 0, x: 0, y: 0, path: [], portrait: false };
  var drag = null;

  /* Tile key currently under the pointer, so its range can be
     previewed without picking the tower up. */
  var hover = null;

  /* =========================================================
     Map geometry
     ========================================================= */

  function key(col, row) {
    return col + "," + row;
  }

  /* Phones are tall and monitors are wide, so the whole map is
     transposed in portrait. A mirrored path is still the same
     path. */
  function waypoints(portrait) {
    return WAYPOINTS.map(function (point) {
      return portrait ? [point[1], point[0]] : point;
    });
  }

  /* Fills in every tile between the corners. */
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
      portrait: portrait
    };

    view.pathSet = {};
    view.path.forEach(function (tile) {
      view.pathSet[key(tile[0], tile[1])] = true;
    });

    return true;
  }

  function isPath(col, row) {
    return Boolean(view.pathSet[key(col, row)]);
  }

  function inBounds(col, row) {
    return col >= 0 && col < view.cols && row >= 0 && row < view.rows;
  }

  function buildable(col, row) {
    return inBounds(col, row) && !isPath(col, row);
  }

  function tileRect(col, row) {
    return {
      x: view.x + col * view.size,
      y: view.y + row * view.size,
      size: view.size
    };
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
      draw();
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

  function drawField() {
    var width = view.cols * view.size;
    var height = view.rows * view.size;

    ctx.fillStyle = "#dfe7ea";
    ctx.fillRect(view.x, view.y, width, height);

    /* Tile grid, faint. */
    ctx.strokeStyle = "rgba(34, 42, 47, 0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (var col = 0; col <= view.cols; col += 1) {
      ctx.moveTo(view.x + col * view.size, view.y);
      ctx.lineTo(view.x + col * view.size, view.y + height);
    }

    for (var row = 0; row <= view.rows; row += 1) {
      ctx.moveTo(view.x, view.y + row * view.size);
      ctx.lineTo(view.x + width, view.y + row * view.size);
    }

    ctx.stroke();
  }

  function drawPath() {
    ctx.fillStyle = "#b9c6cc";

    view.path.forEach(function (tile) {
      var rect = tileRect(tile[0], tile[1]);
      ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
    });
  }

  function drawPortal() {
    var rect = tileRect(view.portal[0], view.portal[1]);
    var centreX = rect.x + rect.size / 2;
    var centreY = rect.y + rect.size / 2;

    ctx.beginPath();
    ctx.arc(centreX, centreY, rect.size * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = "#3d3350";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(centreX, centreY, rect.size * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = "#6f5f92";
    ctx.fill();
  }

  function drawBase() {
    var rect = tileRect(view.base[0], view.base[1]);
    var inset = rect.size * 0.12;

    roundedPath(
      rect.x + inset,
      rect.y + inset,
      rect.size - inset * 2,
      rect.size - inset * 2,
      rect.size * 0.18
    );
    ctx.fillStyle = "#4f6a78";
    ctx.fill();
    ctx.strokeStyle = "#2a3d47";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawTower(tower, x, y, size) {
    var sprite = sprites[tower.key] && sprites[tower.key][tower.level];

    if (sprite) {
      var scale = Math.min(size / sprite.width, size / sprite.height);
      var width = sprite.width * scale;
      var height = sprite.height * scale;

      ctx.drawImage(
        sprite,
        x + (size - width) / 2,
        y + size - height,
        width,
        height
      );
    } else {
      roundedPath(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7, 6);
      ctx.fillStyle = "#4f6a78";
      ctx.fill();
    }

    /* Merge level, bottom right of the tile. */
    ctx.fillStyle = "#222a2f";
    ctx.font = "600 " + Math.max(9, Math.round(size * 0.26)) + "px 'IBM Plex Mono', monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(tower.level), x + size - 2, y + size - 1);
  }

  /* Range is expressed in stat units, so it converts to tiles:
     radius in tiles is range / rangePerTile. */
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

  /* Name and reach of the tower being hovered, drawn above it. */
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

  function draw() {
    if (!view.size) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawField();
    drawPath();
    drawPortal();
    drawBase();

    /* Hover preview sits under the towers so it never hides them. */
    if (!drag && hover && towers[hover]) {
      var parts = hover.split(",");
      var rect = tileRect(Number(parts[0]), Number(parts[1]));

      drawRange(towers[hover], rect.x + rect.size / 2, rect.y + rect.size / 2);
    }

    Object.keys(towers).forEach(function (at) {
      if (drag && drag.from === at) {
        return;
      }

      var parts = at.split(",");
      var rect = tileRect(Number(parts[0]), Number(parts[1]));

      drawTower(towers[at], rect.x, rect.y, rect.size);
    });

    if (drag) {
      drawRange(drag.tower, drag.x, drag.y);

      var target = tileAt(drag.x, drag.y);

      if (target) {
        var rect = tileRect(target[0], target[1]);
        var occupant = towers[key(target[0], target[1])];

        ctx.strokeStyle = canMerge(drag.tower, occupant)
          ? "#c9992b"
          : buildable(target[0], target[1])
            ? "#4f6a78"
            : "rgba(157, 75, 69, 0.8)";
        ctx.lineWidth = 3;
        ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.size - 3, rect.size - 3);
      }

      drawTower(
        drag.tower,
        drag.x - view.size / 2,
        drag.y - view.size / 2,
        view.size
      );
    }

    /* Label last, so nothing is drawn over it. */
    if (!drag && hover && towers[hover]) {
      var at = hover.split(",");
      drawRangeLabel(towers[hover], tileRect(Number(at[0]), Number(at[1])));
    }
  }

  /* =========================================================
     Placing and merging
     ========================================================= */

  function canMerge(source, target) {
    return Boolean(
      source &&
        target &&
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

    /* Dropping onto an identical tower merges without asking. */
    if (canMerge(tower, occupant)) {
      towers[to] = { key: tower.key, level: tower.level + 1 };
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

  function freeTile() {
    for (var attempt = 0; attempt < 400; attempt += 1) {
      var col = Math.floor(Math.random() * view.cols);
      var row = Math.floor(Math.random() * view.rows);

      if (buildable(col, row) && !towers[key(col, row)]) {
        return [col, row];
      }
    }

    return null;
  }

  function addTower() {
    var tile = freeTile();

    if (!tile) {
      return;
    }

    var name = TOWER_KEYS[Math.floor(Math.random() * TOWER_KEYS.length)];

    towers[key(tile[0], tile[1])] = { key: name, level: 1 };
    draw();
  }

  /* =========================================================
     Input
     ========================================================= */

  canvas.addEventListener("pointerdown", function (event) {
    var point = pointerPosition(event);
    var tile = tileAt(point.x, point.y);

    if (!tile) {
      return;
    }

    var at = key(tile[0], tile[1]);

    if (!towers[at]) {
      return;
    }

    drag = { from: at, tower: towers[at], x: point.x, y: point.y };
    canvas.setPointerCapture(event.pointerId);
    draw();
  });

  canvas.addEventListener("pointermove", function (event) {
    var point = pointerPosition(event);

    if (drag) {
      drag.x = point.x;
      drag.y = point.y;
      draw();
      return;
    }

    /* Hovering a tower previews its range. Only redraw when the
       tile under the pointer actually changes. */
    var tile = tileAt(point.x, point.y);
    var next = tile ? key(tile[0], tile[1]) : null;

    if (next !== hover) {
      hover = next;
      draw();
    }
  });

  canvas.addEventListener("pointerleave", function () {
    if (hover !== null) {
      hover = null;
      draw();
    }
  });

  canvas.addEventListener("pointerup", function (event) {
    if (!drag) {
      return;
    }

    var point = pointerPosition(event);

    drop(drag.from, tileAt(point.x, point.y));
    drag = null;
    draw();
  });

  canvas.addEventListener("pointercancel", function () {
    drag = null;
    draw();
  });

  /* =========================================================
     Open and close
     ========================================================= */

  function open() {
    root.hidden = false;

    if (layout()) {
      draw();
    }
  }

  function close() {
    root.hidden = true;
  }

  if (playButton) {
    playButton.addEventListener("click", open);
  }

  exitButton.addEventListener("click", close);
  addButton.addEventListener("click", addTower);

  window.addEventListener("resize", function () {
    if (!root.hidden && layout()) {
      draw();
    }
  });

  loadSprites();
})();
