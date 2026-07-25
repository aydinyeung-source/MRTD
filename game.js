(function () {
  "use strict";

  /* =========================================================
     Merge board.

     Towers merge when they are the SAME TYPE and the SAME LEVEL.
     Anything else swaps places. Levels live only on the board —
     they are match state, not saved progress.
     ========================================================= */

  var COLS = 5;
  var ROWS = 4;
  /* Level n costs 2^(n-1) level-1 towers of the same type — 512 at
     level 10. Reachable because matches are endless. */
  var MAX_LEVEL = 10;

  /* One entry per tower type. Sprites replace `colour` later; the
     shape of this list is what the rest of the file depends on. */
  var TYPES = [
    { key: "blender", label: "Blender", colour: "#4f6a78" },
    { key: "dagger", label: "Dagger", colour: "#7fa5b8" },
    { key: "farm", label: "Farm", colour: "#6d8a6f" },
    { key: "shotgunner", label: "Shotgunner", colour: "#3c4a52" },
    { key: "sniper", label: "Sniper", colour: "#8a6a78" }
  ];

  /* Tier decoration, reused across every type: the ring colour
     changes every three levels. */
  var TIERS = ["#c3d2da", "#9db8c4", "#d8b98a", "#c98f6a"];

  /* Sprites live at towers/<type>/<level>.svg — one image per level,
     1 through MAX_LEVEL. A missing file is not fatal: that level
     falls back to the placeholder shape. */
  var SPRITE_ROOT = "towers";
  var SPRITE_EXT = ".svg";

  var sprites = {};

  var canvas = document.getElementById("board");
  var addButton = document.getElementById("board-add");

  if (!canvas) {
    return;
  }

  var ctx = canvas.getContext("2d");

  /* cells[i] is null or { type: "arrow", level: 1 } */
  var cells = new Array(COLS * ROWS).fill(null);

  var drag = null;
  var metrics = { cell: 0, gap: 0, pad: 0 };

  /* =========================================================
     Sprites

     Everything is fetched up front so no tower pops in mid-match
     the first time it appears on the board.
     ========================================================= */

  function spriteUrl(key, level) {
    return SPRITE_ROOT + "/" + key + "/" + level + SPRITE_EXT;
  }

  function spriteFor(tower) {
    return sprites[tower.type] ? sprites[tower.type][tower.level] : null;
  }

  function loadSprite(key, level, settle) {
    var image = new Image();

    image.onload = function () {
      sprites[key][level] = image;
      settle();
    };

    /* A missing level just draws the placeholder instead. */
    image.onerror = function () {
      sprites[key][level] = null;
      settle();
    };

    image.src = spriteUrl(key, level);
  }

  function preload(done) {
    var pending = TYPES.length * MAX_LEVEL;

    function settle() {
      pending -= 1;

      if (pending === 0) {
        done();
      }
    }

    TYPES.forEach(function (type) {
      sprites[type.key] = {};

      for (var level = 1; level <= MAX_LEVEL; level += 1) {
        loadSprite(type.key, level, settle);
      }
    });
  }

  /* =========================================================
     Layout
     ========================================================= */

  function resize() {
    var available = canvas.parentNode.clientWidth;
    var width = Math.min(available, 460);
    var pad = 14;
    var gap = 10;
    var cell = Math.floor((width - pad * 2 - gap * (COLS - 1)) / COLS);

    /* The board is laid out behind the login gate, where it has no
       width yet. The observer below calls back once it is shown. */
    if (cell < 1) {
      return;
    }

    width = cell * COLS + gap * (COLS - 1) + pad * 2;

    var height = cell * ROWS + gap * (ROWS - 1) + pad * 2;
    var ratio = window.devicePixelRatio || 1;

    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    metrics = { cell: cell, gap: gap, pad: pad };
    draw();
  }

  function cellRect(index) {
    var col = index % COLS;
    var row = Math.floor(index / COLS);

    return {
      x: metrics.pad + col * (metrics.cell + metrics.gap),
      y: metrics.pad + row * (metrics.cell + metrics.gap),
      size: metrics.cell
    };
  }

  function cellAt(x, y) {
    var step = metrics.cell + metrics.gap;
    var col = Math.floor((x - metrics.pad) / step);
    var row = Math.floor((y - metrics.pad) / step);

    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
      return -1;
    }

    /* Reject the gaps between cells. */
    if ((x - metrics.pad) % step > metrics.cell) {
      return -1;
    }
    if ((y - metrics.pad) % step > metrics.cell) {
      return -1;
    }

    return row * COLS + col;
  }

  function pointerPosition(event) {
    var bounds = canvas.getBoundingClientRect();

    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top
    };
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

    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function typeOf(key) {
    return TYPES.filter(function (type) {
      return type.key === key;
    })[0];
  }

  function drawSlot(rect) {
    roundedPath(rect.x, rect.y, rect.size, rect.size, 12);
    ctx.fillStyle = "rgba(34, 42, 47, 0.04)";
    ctx.fill();
    ctx.strokeStyle = "rgba(34, 42, 47, 0.10)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawTower(tower, x, y, size) {
    var type = typeOf(tower.type);
    var inset = size * 0.1;
    var box = size - inset * 2;
    var sprite = spriteFor(tower);

    /* Real art carries the level on its own — no ring, no number.
       Sprites keep their aspect ratio and sit on the bottom of the
       cell, so a wide, short tower is not stretched into a square. */
    if (sprite) {
      var scale = Math.min(box / sprite.width, box / sprite.height);
      var width = sprite.width * scale;
      var height = sprite.height * scale;

      ctx.drawImage(
        sprite,
        x + (size - width) / 2,
        y + size - inset - height,
        width,
        height
      );
      return;
    }

    roundedPath(x + inset, y + inset, box, box, 10);
    ctx.fillStyle = type.colour;
    ctx.fill();

    ctx.strokeStyle = TIERS[Math.min(Math.floor((tower.level - 1) / 3), TIERS.length - 1)];
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "#f9fbfc";
    ctx.font = "600 " + Math.round(size * 0.32) + "px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(tower.level), x + size / 2, y + size / 2);
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    cells.forEach(function (tower, index) {
      var rect = cellRect(index);
      drawSlot(rect);

      /* The dragged tower is drawn under the pointer instead. */
      if (!tower || (drag && drag.from === index)) {
        return;
      }

      drawTower(tower, rect.x, rect.y, rect.size);
    });

    if (drag) {
      var target = cellAt(drag.x, drag.y);

      if (target >= 0 && target !== drag.from) {
        var rect = cellRect(target);
        roundedPath(rect.x, rect.y, rect.size, rect.size, 12);
        ctx.strokeStyle = canMerge(cells[drag.from], cells[target])
          ? "#4f6a78"
          : "rgba(34, 42, 47, 0.25)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      var size = metrics.cell;
      drawTower(cells[drag.from], drag.x - size / 2, drag.y - size / 2, size);
    }

    addButton.disabled = freeCell() < 0;
  }

  /* =========================================================
     Rules
     ========================================================= */

  function canMerge(source, target) {
    return Boolean(
      source &&
        target &&
        source.type === target.type &&
        source.level === target.level &&
        source.level < MAX_LEVEL
    );
  }

  function resolve(from, to) {
    if (to < 0 || to === from) {
      return;
    }

    var source = cells[from];
    var target = cells[to];

    if (!target) {
      cells[to] = source;
      cells[from] = null;
      return;
    }

    if (canMerge(source, target)) {
      cells[to] = { type: target.type, level: target.level + 1 };
      cells[from] = null;
      return;
    }

    cells[to] = source;
    cells[from] = target;
  }

  function freeCell() {
    return cells.indexOf(null);
  }

  function addTower() {
    var index = freeCell();

    if (index < 0) {
      return;
    }

    var type = TYPES[Math.floor(Math.random() * TYPES.length)];

    cells[index] = { type: type.key, level: 1 };
    draw();
  }

  /* =========================================================
     Input
     ========================================================= */

  canvas.addEventListener("pointerdown", function (event) {
    var point = pointerPosition(event);
    var index = cellAt(point.x, point.y);

    if (index < 0 || !cells[index]) {
      return;
    }

    drag = { from: index, x: point.x, y: point.y };
    canvas.setPointerCapture(event.pointerId);
    draw();
  });

  canvas.addEventListener("pointermove", function (event) {
    if (!drag) {
      return;
    }

    var point = pointerPosition(event);

    drag.x = point.x;
    drag.y = point.y;
    draw();
  });

  function endDrag(event) {
    if (!drag) {
      return;
    }

    var point = pointerPosition(event);

    resolve(drag.from, cellAt(point.x, point.y));
    drag = null;
    draw();
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", function () {
    drag = null;
    draw();
  });

  addButton.addEventListener("click", addTower);

  /* Fires on window resize and, crucially, the moment the board gains
     width after login — so the canvas sizes itself without the auth
     code needing to know the board exists. */
  if (window.ResizeObserver) {
    new ResizeObserver(resize).observe(canvas.parentNode);
  } else {
    window.addEventListener("resize", resize);
  }

  resize();
  preload(draw);
})();
