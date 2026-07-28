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
  var TOWER_KEYS = [
    "dagger", "axe", "blender", "shotgunner", "sniper", "farm", "spawner",
    "beacon", "forge", "metronome", "djtv", "quantum", "icecannon",
    "fan", "clocktower"
  ];

  /* Towers with drawn top down artwork. Everything else uses the
     plan views below, which are built in code. */
  var ART_TOWERS = ["sniper"];

  /* Five, or six with the Loadout slot upgrade. loadout.js reads
     the same helper, so the two cannot drift apart. */
  function loadoutSlots() {
    return stats.loadoutSlots(upgradeLevel("loadout_slots"));
  }

  /* Fallback plan designs, drawn in code. Used only for a tower
     whose artwork has not loaded, so the board still reads while
     a sprite is missing. */
  var TOKENS = {
    blender: { body: "#8e8e8e", accent: "#ff140a", plan: "blades" },
    dagger: { body: "#5c6166", accent: "#bb0000", plan: "arm" },
    axe: { body: "#7d6a52", accent: "#cfd4d8", plan: "axes" },
    farm: { body: "#eae484", accent: "#b8ae4a", plan: "field" },
    shotgunner: { body: "#656565", accent: "#8c8c8c", plan: "barrels" },
    sniper: { body: "#2b2b2b", accent: "#8c8c8c", plan: "barrel" },
    spawner: { body: "#4a6b6e", accent: "#7fc4c9", plan: "gate" },
    beacon: { body: "#3f5a7a", accent: "#8fb7e2", plan: "aura" },
    forge: { body: "#7a4038", accent: "#e0895f", plan: "aura" },
    metronome: { body: "#6a5a7f", accent: "#b79ce0", plan: "aura" },
    djtv: { body: "#241f2e", accent: "#ff3ea5", plan: "decks" },
    quantum: { body: "#1b2b3a", accent: "#5fe3d0", plan: "orbit" },
    fan: { body: "#2f3f46", accent: "#9fd6e4", plan: "blades" },
    clocktower: { body: "#2a2436", accent: "#e0c063", plan: "clock" },
    icecannon: { body: "#5b7f9c", accent: "#cfeaf7", plan: "frost" }
  };

  var root = document.getElementById("match");
  var canvas = document.getElementById("match-canvas");
  var exitButton = document.getElementById("match-exit");
  var forfeitButton = document.getElementById("match-forfeit");
  var graphicsButton = document.getElementById("match-graphics");
  var jumpBox = document.getElementById("match-jump");
  var jumpInput = document.getElementById("match-jump-wave");
  var jumpButton = document.getElementById("match-jump-go");
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
  var timeDisplay = document.getElementById("match-time");
  var aliveDisplay = document.getElementById("match-alive");
  var netNote = document.getElementById("match-netnote");
  var playersStrip = document.getElementById("match-players");
  var netNoteTimer = null;

  var bossBar = document.getElementById("match-boss");
  var bossName = document.getElementById("match-boss-name");
  var bossNote = document.getElementById("match-boss-note");
  var bossFill = document.getElementById("match-boss-fill");
  var bossHp = document.getElementById("match-boss-hp");

  var abilityButton = document.getElementById("match-ability");
  var abilityState = document.getElementById("match-ability-state");
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

  /* Allies put on the path by spawner towers. They stand still,
     block whatever reaches them, and fight back. */
  var allies = [];

  /* How close an enemy must be to an ally to be stopped by it. */
  var BLOCK_TILES = 0.55;

  /* How fast a blender's blades turn at full spin, in radians per
     second, and how quickly spin and recoil fall away. */
  var SPIN_RATE = 16;
  var SPIN_DECAY = 1.6;
  var RECOIL_DECAY = 7;
  var PULSE_DECAY = 4;

  /* Towers animated by their own moving parts rather than by a
     shot leaving them. */
  var SPINNERS = ["blender", "quantum", "fan"];

  /* Most enemies on the path at once. Anything still owed waits
     in the queue rather than being cancelled, so the wave is the
     same size — it just does not all arrive at once. */
  var MAX_ALIVE = 1000;

  /* How much faster an ability charges in developer mode. Stacks
     with the speed setting, so 10x and dev together is a hundred
     times, which is the point: it makes an ability testable. */
  var DEV_CHARGE_RATE = 10;

  var cash = 0;
  var baseHp = 0;
  var wave = 0;
  var wavesSurvived = 0;
  var spawnQueue = [];
  var spawnTimer = 0;
  var waveActive = false;
  var running = false;
  var lastFrame = 0;

  /* =========================================================
     Timestop

     The Clock Tower holds the board still. The charge belongs to
     the board, not to any one tower: five Clock Towers charge one
     timer rather than five of their own, because per tower
     timers would mean enough of them stop time permanently.

     `charge` counts up in game seconds, so it runs at whatever
     speed the match is set to. Once it is full the ability waits
     on the player rather than firing itself — a freeze spent at
     the wrong moment is a freeze wasted, and only the player can
     see the wave coming. `left` is how much of it remains. */
  var timestop = { charge: 0, ready: false, left: 0 };

  /* Bonus paid the moment a wave is cleared, on top of farm income. */
  var WAVE_BONUS = 100;

  /* Breather between waves before the next one starts itself. */
  var BREAK_SECONDS = 15;

  var speed = 1;
  var breakLeft = 0;

  /* The in-flight bank_run call, so leaving waits for it. */
  var banking = null;

  /* Time the RUN has experienced, not wall clock. It advances with
     the simulation, so 2x and 10x speed it up exactly as they do
     everything else. */
  var elapsed = 0;


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

  /* Low graphics drops everything decorative — thrown daggers,
     tracers, coin puffs, blade spin, recoil — and keeps anything
     that tells you what is happening. Effects are not merely
     hidden but never created, so the arrays stay empty and the
     work disappears rather than moving. */
  var LOW_KEY = "mrtd.lowfx";
  var lowGraphics = false;

  var view = { cols: 0, rows: 0, size: 0, x: 0, y: 0, path: [] };
  var drag = null;
  var hover = null;
  var sellZone = null;

  /* Tile of the tower whose stats panel is open, so its cover
     stays on screen while you read it. */
  var inspected = null;

  /* Which way the map is currently laid out, so a flip can be
     detected and the board turned with it. */
  var portraitMode = null;

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

  /* The map is transposed in portrait, so anything already placed
     has to turn with it — otherwise a block of towers keeps its
     old shape on a grid that has swapped axes and ends up sitting
     on the path. */
  function transposeTowers() {
    var turned = {};

    Object.keys(towers).forEach(function (position) {
      var parts = position.split(",");

      turned[key(Number(parts[1]), Number(parts[0]))] = towers[position];
    });

    towers = turned;

    /* These all point at a tile by name and would now be wrong. */
    hover = null;
    inspected = null;
    drag = null;
    sellZone = null;
    closeInspect();
  }

  function layout() {
    var portrait = window.innerHeight > window.innerWidth;

    if (portraitMode !== null && portrait !== portraitMode) {
      transposeTowers();
    }

    portraitMode = portrait;

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

  /* Dagger: a robotic arm. Two jointed segments reaching forward
     with a blade at the tip, and a rack of spares behind it that
     fills up as the tower merges. */
  function planArm(token, radius, level) {
    var upper = radius * 0.75;
    var fore = radius * (0.6 + level * 0.045);
    var thick = radius * 0.22;

    /* Rack of spare daggers behind the shoulder. */
    var spares = 2 + Math.floor(level / 2);

    ctx.fillStyle = token.accent;

    for (var i = 0; i < spares; i += 1) {
      var x = -radius * 0.55 + (radius * 1.1 * i) / (spares - 1 || 1);

      ctx.fillRect(x - radius * 0.04, radius * 0.45, radius * 0.08, radius * 0.34);
    }

    ctx.save();

    /* Upper segment, angled out from the shoulder. */
    ctx.rotate(-0.35);
    ctx.fillStyle = "#3f4448";
    roundedPath(-thick / 2, -upper, thick, upper, thick * 0.45);
    ctx.fill();

    /* Elbow, then the forearm straightening towards the target. */
    ctx.translate(0, -upper);
    ctx.beginPath();
    ctx.arc(0, 0, thick * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = "#8c9296";
    ctx.fill();

    ctx.rotate(0.35);
    ctx.fillStyle = "#4d5357";
    roundedPath(-thick * 0.4, -fore, thick * 0.8, fore, thick * 0.35);
    ctx.fill();

    /* The blade it is about to fling. */
    ctx.beginPath();
    ctx.moveTo(-thick * 0.34, -fore);
    ctx.lineTo(0, -fore - radius * 0.5);
    ctx.lineTo(thick * 0.34, -fore);
    ctx.closePath();
    ctx.fillStyle = token.accent;
    ctx.fill();

    ctx.restore();
  }

  /* Axe: heads on short handles, thrown fast and often. */
  function planAxes(token, radius, level) {
    var count = 2 + Math.floor(level / 3);
    var reach = radius * (1.05 + level * 0.03);

    for (var i = 0; i < count; i += 1) {
      ctx.save();
      ctx.rotate(((i - (count - 1) / 2) * Math.PI) / 5);

      /* Handle. */
      ctx.fillStyle = "#6b573f";
      ctx.fillRect(-radius * 0.06, -reach, radius * 0.12, reach * 0.8);

      /* Head. */
      ctx.beginPath();
      ctx.moveTo(-radius * 0.06, -reach);
      ctx.lineTo(-radius * 0.34, -reach + radius * 0.22);
      ctx.lineTo(radius * 0.34, -reach + radius * 0.22);
      ctx.lineTo(radius * 0.06, -reach);
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

  /* Spawner: a gate with bars, gaining one per merge. */
  function planGate(token, radius, level) {
    var bars = 2 + Math.floor(level / 2);

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1.5, radius * 0.14);
    ctx.beginPath();

    for (var i = 0; i < bars; i += 1) {
      var x = -radius * 0.7 + (radius * 1.4 * i) / (bars - 1 || 1);

      ctx.moveTo(x, -radius * 0.7);
      ctx.lineTo(x, radius * 0.7);
    }

    ctx.stroke();
  }

  /* Boosters: rings radiating outward, one more per merge. */
  function planAura(token, radius, level) {
    var rings = 2 + Math.floor(level / 3);

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1.2, radius * 0.1);

    for (var i = 1; i <= rings; i += 1) {
      ctx.beginPath();
      ctx.arc(0, 0, radius * (0.5 + i * 0.34), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /* DJTV: a wide screen behind, decks in front. The screen gains
     bands as it merges. */
  function planDecks(token, radius, level) {
    var bands = 2 + Math.floor(level / 2);
    var screenW = radius * 2.1;
    var screenH = radius * 0.85;

    /* The screen, standing behind the booth. */
    roundedPath(-screenW / 2, -radius * 1.65, screenW, screenH, radius * 0.12);
    ctx.fillStyle = "#12101a";
    ctx.fill();
    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1, radius * 0.07);
    ctx.stroke();

    /* Bars on the display. */
    ctx.fillStyle = token.accent;

    for (var i = 0; i < bands; i += 1) {
      var w = screenW / (bands * 1.8);
      var x = -screenW / 2 + (screenW / bands) * i + w * 0.4;
      var h = screenH * (0.3 + ((i * 37) % 100) / 140);

      ctx.fillRect(x, -radius * 1.65 + (screenH - h) - radius * 0.02, w, h);
    }

    /* Two decks. */
    [-1, 1].forEach(function (side) {
      ctx.beginPath();
      ctx.arc(side * radius * 0.46, radius * 0.28, radius * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = "#3a3448";
      ctx.fill();
      ctx.strokeStyle = token.accent;
      ctx.lineWidth = Math.max(1, radius * 0.06);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(side * radius * 0.46, radius * 0.28, radius * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = token.accent;
      ctx.fill();
    });
  }

  /* Quantum: a core with electrons orbiting it, one more each
     merge, on a tilted ring.

     The orbit itself holds still and the electrons travel around
     it — that motion IS the attack animation, so Quantum needs no
     tracer and no pulse. It hits everything in reach at once, and
     nothing pointed at one enemy could say that honestly. */
  function planOrbit(token, radius, level, spin) {
    var particles = 3 + level;

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1, radius * 0.06);

    ctx.save();
    ctx.rotate(-0.4);
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.25, radius * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = token.accent;

    for (var i = 0; i < particles; i += 1) {
      var angle = (i / particles) * Math.PI * 2 + (spin || 0);

      ctx.beginPath();
      ctx.arc(
        Math.cos(angle) * radius * 1.25,
        Math.sin(angle) * radius * 0.55,
        radius * 0.11,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }

    ctx.restore();
  }

  /* Clock Tower: a face with two hands, gaining a marker every
     couple of merges. The hands turn with its charge rather than
     with anything it shoots. */
  function planClock(token, radius, level, spin) {
    var markers = 4 + Math.floor(level / 2) * 2;

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1, radius * 0.07);

    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.15, 0, Math.PI * 2);
    ctx.stroke();

    for (var i = 0; i < markers; i += 1) {
      var angle = (i / markers) * Math.PI * 2;

      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * radius * 0.92, Math.sin(angle) * radius * 0.92);
      ctx.lineTo(Math.cos(angle) * radius * 1.12, Math.sin(angle) * radius * 1.12);
      ctx.stroke();
    }

    /* Minute hand runs twelve times faster than the hour hand,
       the same as a real face. */
    var turn = spin || 0;

    ctx.lineWidth = Math.max(1.4, radius * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(turn - Math.PI / 2) * radius * 0.95,
               Math.sin(turn - Math.PI / 2) * radius * 0.95);
    ctx.stroke();

    ctx.lineWidth = Math.max(1.4, radius * 0.13);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(turn / 12 - Math.PI / 2) * radius * 0.6,
               Math.sin(turn / 12 - Math.PI / 2) * radius * 0.6);
    ctx.stroke();
  }

  /* Ice Cannon: frost spikes radiating from the barrel, gaining
     one every couple of merges. */
  function planFrost(token, radius, level) {
    var spikes = 6 + Math.floor(level / 2);

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1.2, radius * 0.09);

    for (var i = 0; i < spikes; i += 1) {
      ctx.save();
      ctx.rotate((i / spikes) * Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(0, -radius * 0.55);
      ctx.lineTo(0, -radius * 1.35);
      ctx.moveTo(-radius * 0.13, -radius * 1.05);
      ctx.lineTo(0, -radius * 1.3);
      ctx.lineTo(radius * 0.13, -radius * 1.05);
      ctx.stroke();
      ctx.restore();
    }
  }

  var PLANS = {
    aura: planAura,
    frost: planFrost,
    decks: planDecks,
    orbit: planOrbit,
    blades: planBlades,
    arm: planArm,
    axes: planAxes,
    field: planField,
    barrels: planBarrels,
    barrel: planBarrel,
    gate: planGate,
    clock: planClock
  };

  function drawTopTower(tower, x, y, size) {
    var token = TOKENS[tower.key];

    if (!token) {
      return;
    }

    /* The footprint itself creeps up with every merge. */
    var radius = size * 0.32 * (0.82 + tower.level * 0.02);
    var isField = token.plan === "field";
    /* The dagger's arm sits on a square housing rather than a
       disc, so it does not read as another spinner. */
    var isKnives = token.plan === "arm";

    ctx.save();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate(tower.angle || 0);

    /* Blades and vanes turn the whole housing while they are
       cutting. Orbits and clock faces do not — those draw their
       own moving parts from the spin value instead, so the ring
       and the dial stay put while what travels on them moves. */
    if (token.plan === "blades") {
      ctx.rotate(tower.spin || 0);
    }

    /* Kick backwards along the barrel. */
    if (tower.recoil) {
      ctx.translate(0, tower.recoil * radius * 0.3);
    }

    if (!isField && PLANS[token.plan]) {
      PLANS[token.plan](token, radius, tower.level, tower.spin || 0);
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
      PLANS[token.plan](token, radius, tower.level, tower.spin || 0);
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
  /* A shiny uses the same artwork as its normal twin, so the tile
     itself has to say which it is: a gold ring, and a soft glow
     under the tower. The ring stays in low graphics — it is what
     the tower IS, not an effect — and only the glow drops. */
  function drawShinyMark(x, y, size) {
    if (!lowGraphics) {
      var glow = ctx.createRadialGradient(
        x + size / 2,
        y + size / 2,
        size * 0.1,
        x + size / 2,
        y + size / 2,
        size * 0.62
      );

      glow.addColorStop(0, "rgba(255, 214, 110, 0.42)");
      glow.addColorStop(1, "rgba(255, 214, 110, 0)");

      ctx.fillStyle = glow;
      ctx.fillRect(x - size * 0.1, y - size * 0.1, size * 1.2, size * 1.2);
    }

    var inset = size * 0.06;

    ctx.strokeStyle = "#e0a92b";
    ctx.lineWidth = Math.max(1.5, size * 0.055);
    ctx.strokeRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
  }

  /* The ring an all round attack throws out. Widens and fades as
     it goes, so a Quantum reads as hitting everything at once
     rather than aiming at one thing. */
  function drawPulse(tower, x, y, size) {
    var strength = tower.pulse;

    if (!strength) {
      return;
    }

    var evolution = evolutionFor(tower);
    var reach =
      (stats.range(tower.key, tower.level, evolution) / stats.rangePerTile) *
      size;

    ctx.beginPath();
    ctx.arc(
      x + size / 2,
      y + size / 2,
      reach * (1 - strength) + size * 0.3,
      0,
      Math.PI * 2
    );
    ctx.strokeStyle = "rgba(94, 132, 214, " + strength * 0.5 + ")";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawTower(tower, x, y, size) {
    var sprite = sprites[tower.key] && sprites[tower.key][tower.level];

    if (tower.shiny) {
      drawShinyMark(x, y, size);
    }

    drawPulse(tower, x, y, size);

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

  /* An ally holding its spot on the path. Squared off so it never
     reads as an enemy. */
  function drawAlly(ally) {
    var point = allyAt(ally);
    var size = view.size * 0.44;

    roundedPath(point.x - size / 2, point.y - size / 2, size, size, size * 0.28);
    ctx.fillStyle = "#4a6b6e";
    ctx.fill();
    ctx.strokeStyle = "#7fc4c9";
    ctx.lineWidth = 2;
    ctx.stroke();

    var width = view.size * 0.6;
    var fraction = Math.max(0, ally.hp / ally.maxHp);
    var barY = point.y - size * 0.75;

    ctx.fillStyle = "rgba(34, 42, 47, 0.25)";
    ctx.fillRect(point.x - width / 2, barY, width, 3);
    ctx.fillStyle = "#7fc4c9";
    ctx.fillRect(point.x - width / 2, barY, width * fraction, 3);
  }

  /* PLACEHOLDER enemy art: a coloured disc with a health bar.
     Swap for enemies/<kind>.svg when the drawings land. */
  function drawEnemy(enemy) {
    var point = pathPoint(enemy.progress);
    var boss = enemy.boss && stats.bosses[enemy.boss];
    /* Bosses are drawn far larger, and a Cleaver's pieces smaller
       than the whole they came from. */
    var radius = boss
      ? view.size * (0.42 + 0.28 * enemy.share)
      : view.size * 0.3;
    var definition = stats.enemies[enemy.kind];

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = boss ? boss.colour : definition.colour;
    ctx.fill();

    /* Immunity reads as a solid ring standing off the body, so
       shots landing for nothing are obviously landing for
       nothing. A Wraith that has found a gap glows instead. */
    if (boss && enemy.immune) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120, 190, 235, 0.95)";
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(190, 226, 245, 0.45)";
      ctx.fill();
    }

    if (boss && enemy.healing) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120, 220, 160, 0.9)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    /* Chilled enemies wash out, so a slowed crowd is obvious
       without reading anything. */
    if (enemy.slowed) {
      ctx.fillStyle = "rgba(228, 245, 252, 0.5)";
      ctx.fill();
      ctx.strokeStyle = "#8fd3ea";
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = "rgba(15, 18, 16, 0.35)";
      ctx.lineWidth = 1.5;
    }

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
      var fade = Math.max(0, shot.life * 4);

      ctx.beginPath();
      ctx.moveTo(shot.fromX, shot.fromY);
      ctx.lineTo(shot.toX, shot.toY);
      /* A piercing beam is drawn heavier, so it reads as
         something that went through rather than a tracer that
         stopped at one enemy. */
      ctx.strokeStyle = shot.wide
        ? "rgba(94, 132, 214, " + fade + ")"
        : "rgba(34, 42, 47, " + fade + ")";
      ctx.lineWidth = shot.wide ? 6 : 2;
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

    /* A wash over the whole board while time is stopped, so it is
       obvious at a glance why nothing is walking. Drawn under the
       towers, which stay at full strength — they are the things
       still working. */
    if (frozen()) {
      ctx.fillStyle = "rgba(120, 168, 224, 0.16)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

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

    allies.forEach(drawAlly);
    enemies.forEach(drawEnemy);

    if (!lowGraphics) {
      drawShots();
      drawProjectiles();
      drawParticles();
    }

    /* Ghost of the tower waiting to be committed. */
    if (placing) {
      var tile = tileAt(pointer.x, pointer.y);
      var ghost = placing;

      if (tile) {
        var target = tileRect(tile[0], tile[1]);
        var under = towers[key(tile[0], tile[1])];
        var ground = buildable(tile[0], tile[1]);
        var merges = ground && canMerge(ghost, under);
        var allowed = ground && !under;

        drawRange(ghost, target.x + target.size / 2, target.y + target.size / 2);
        drawCone(ghost, target.x, target.y, target.size);

        ctx.globalAlpha = 0.55;
        drawTower(ghost, target.x, target.y, target.size);
        ctx.globalAlpha = 1;

        /* Gold means the purchase will merge into what is there. */
        ctx.strokeStyle = merges
          ? "#c9992b"
          : allowed
            ? "#4f6a78"
            : "rgba(157, 75, 69, 0.85)";
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

    /* Reaching wave n means the n-1 before it were survived. Waves
       chained by Skip or auto never leave a moment where the path
       is empty, so counting only on a clean clear would leave this
       stuck near zero for the whole run. */
    wavesSurvived = Math.max(wavesSurvived, wave - 1);

    waveActive = true;
    breakLeft = 0;
    spawnTimer = 0;
    spawnQueue = [];

    var pool = stats.wavePool(wave);
    var boss = stats.bossFor(wave);

    /* A boss wave is the boss and a short escort, not a boss on
       top of a full wave — the point is the one thing, with
       enough company that the towers cannot all face it. */
    var count = boss ? stats.boss.escort : stats.waveCount(wave);

    if (boss) {
      spawnQueue.push("boss:" + boss);
    }

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
    /* The queue holds enemy kinds, except for the one entry that
       names a boss. */
    if (kind.indexOf("boss:") === 0) {
      spawnBoss(kind.slice(5), 1, 0);
      return;
    }

    var hp = stats.waveEnemyHp(kind, wave, players());

    enemies.push({
      kind: kind,
      hp: hp,
      maxHp: hp,
      progress: 0,
      speed: stats.enemies[kind].speed
    });
  }

  /* `share` is how much of a full boss this one is — a whole boss
     is 1, a Cleaver's halves are less. `progress` lets a split
     appear where its parent died rather than back at the portal. */
  function spawnBoss(key, share, progress) {
    var definition = stats.bosses[key];

    if (!definition) {
      return;
    }

    var hp = stats.bossHp(wave, players()) * share;

    enemies.push({
      /* Bosses take the brute's damage and weight lookups, so
         everything that asks the enemy table still gets an
         answer. What makes it a boss is the `boss` flag. */
      kind: "brute",
      boss: key,
      share: share,
      hp: hp,
      maxHp: hp,
      /* Only the Warden is ever immune, and it arrives with the
         shield DOWN — a boss that is untouchable from the moment
         it appears tells the player nothing except to wait. */
      immune: false,
      abilityTimer: definition.down || definition.every || 0,
      progress: progress || 0,
      speed: stats.boss.speed
    });
  }

  function enemyAt(enemy) {
    return pathPoint(enemy.progress);
  }

  /* Every point that damages an enemy goes through here, so an
     immune boss cannot be hurt by one of them that forgot to
     check. There are two — towers and allies — and a shield
     honoured by only one would be a shield that mostly works. */
  function hurt(enemy, amount) {
    if (!(amount > 0) || enemy.immune) {
      return;
    }

    enemy.hp -= amount;
  }



  /* =========================================================
     Boss abilities

     Ticked once a frame for every boss on the path. Each one is
     a different question asked of the same build:

       Warden   can you burst through a shield before it returns
       Brood    can you clear adds and the boss at once
       Cleaver  is your damage spread enough for what it leaves
       Sapper   is all your damage sat in one place
       Wraith   does your coverage have a hole in it

     Nothing here stuns. During a wave the player cannot change
     anything, so taking their towers away is not a question, it
     is a penalty with no answer.
     ========================================================= */

  /* Is any tower close enough to shoot this point? Used only by
     the Wraith, which heals when the answer is no. */
  function covered(point) {
    return Object.keys(towers).some(function (at) {
      var tower = towers[at];

      if (!stats.attack(tower.key)) {
        return false;
      }

      var parts = at.split(",");
      var centre = tileCentre(Number(parts[0]), Number(parts[1]));
      var dx = point.x - centre.x;
      var dy = point.y - centre.y;
      var reach =
        (stats.boosted(
          stats.range(tower.key, tower.level, evolutionFor(tower)),
          boostFor(at, "range")
        ) /
          stats.rangePerTile) *
        view.size;

      return Math.sqrt(dx * dx + dy * dy) <= reach;
    });
  }

  /* How much a tower's fire rate is cut by Sappers standing near
     it. An effect, so the strongest wins rather than several
     Sappers multiplying into a standstill. */
  function sapAt(position) {
    var worst = 1;
    var parts = position.split(",");
    var centre = tileCentre(Number(parts[0]), Number(parts[1]));

    enemies.forEach(function (enemy) {
      if (!enemy.boss) {
        return;
      }

      var definition = stats.bosses[enemy.boss];

      if (!definition || definition.ability !== "sap") {
        return;
      }

      var point = enemyAt(enemy);
      var dx = point.x - centre.x;
      var dy = point.y - centre.y;
      var reach = definition.radius * view.size;

      if (Math.sqrt(dx * dx + dy * dy) <= reach && definition.rate < worst) {
        worst = definition.rate;
      }
    });

    return worst;
  }

  function tickBosses(delta) {
    enemies.forEach(function (enemy) {
      if (!enemy.boss || enemy.hp <= 0) {
        return;
      }

      var definition = stats.bosses[enemy.boss];

      if (!definition) {
        return;
      }

      if (definition.ability === "shield") {
        enemy.abilityTimer -= delta;

        /* Straight alternation. Damage does not shorten the up
           window and cannot lengthen it either — the cycle is the
           thing you play around. */
        if (enemy.abilityTimer <= 0) {
          enemy.immune = !enemy.immune;
          enemy.abilityTimer = enemy.immune
            ? definition.up
            : definition.down;
        }
      }

      if (definition.ability === "spawn") {
        enemy.abilityTimer -= delta;

        if (enemy.abilityTimer <= 0) {
          enemy.abilityTimer = definition.every;

          for (var i = 0; i < definition.spawns; i += 1) {
            /* Held to the same cap as everything else, so a Brood
               left alive cannot flood the board. */
            if (enemies.length >= MAX_ALIVE) {
              break;
            }

            var hp = stats.waveEnemyHp("crawler", wave, players());

            enemies.push({
              kind: "crawler",
              hp: hp,
              maxHp: hp,
              /* Dropped where the parent is, not at the portal —
                 they are being shed, not summoned from afar. */
              progress: enemy.progress,
              speed: stats.enemies.crawler.speed
            });
          }
        }
      }

      if (definition.ability === "regen") {
        /* Only while nothing can reach it, and only once it has
           been unreachable a moment. Tied to coverage rather than
           to damage taken: out-healing damage makes a boss that
           never dies, but walking through a gap in the towers is
           something the player chose.

           The delay is what stops it healing in the slivers
           between one tower's edge and the next — those are not
           gaps in any sense the player could act on. */
        if (covered(enemyAt(enemy))) {
          enemy.uncovered = 0;
          enemy.healing = false;
        } else {
          enemy.uncovered = (enemy.uncovered || 0) + delta;
          enemy.healing = enemy.uncovered >= definition.delay;

          if (enemy.healing) {
            enemy.hp = Math.min(
              enemy.maxHp,
              enemy.hp + enemy.maxHp * definition.heal * delta
            );
          }
        }
      }
    });
  }

  /* A Cleaver leaves two pieces where it fell. They are ordinary
     bosses at a fraction of the health, and they do not split
     again — a chain would turn one boss into a crowd without a
     ceiling. */
  function splitBoss(enemy) {
    var definition = stats.bosses[enemy.boss];

    if (!definition || definition.ability !== "split" || enemy.share < 1) {
      return;
    }

    for (var i = 0; i < definition.pieces; i += 1) {
      spawnBoss(
        enemy.boss,
        definition.piece,
        Math.max(0, enemy.progress - i * 0.4)
      );
    }
  }

  /* =========================================================
     Timestop
     ========================================================= */

  function frozen() {
    return timestop.left > 0;
  }

  /* Damage dealt to enemies right now. Doubled while time is
     stopped, which is the other half of what a Clock Tower is
     for — the freeze is only worth as much as what you do with
     it. */
  function damageMultiplier() {
    var ability = stats.ability("clocktower");

    return frozen() && ability ? ability.damage : 1;
  }

  /* The strongest Clock Tower ability on the board. They share
     one charge, so more of them is more damage, never more
     uptime. */
  function clockAbility() {
    var found = null;

    Object.keys(towers).forEach(function (position) {
      if (towers[position].key === "clocktower") {
        found = stats.ability("clocktower");
      }
    });

    return found;
  }

  function tickTimestop(delta) {
    var ability = clockAbility();

    if (!ability) {
      /* No Clock Tower standing: the charge drains away rather
         than banking while one is sold and rebought. */
      timestop.charge = 0;
      timestop.ready = false;
      timestop.left = 0;
      return;
    }

    if (timestop.left > 0) {
      timestop.left = Math.max(0, timestop.left - delta);
      return;
    }

    if (timestop.ready) {
      return;
    }

    /* delta is game seconds, so the charge already runs at
       whatever speed the match is set to — 300 game seconds is
       150 real ones at 2x and 30 at 10x, without this function
       knowing anything about it.

       Developer mode is the part that could not be reached that
       way: testing an ability on a five minute charge means five
       minutes per attempt, or thirty seconds if you also happen
       to have 10x switched on. It charges ten times faster
       instead, so an ability meant to be used once a wave can be
       used once a wave while it is being worked on. */
    timestop.charge += delta * (isDev() ? DEV_CHARGE_RATE : 1);

    if (timestop.charge >= ability.every) {
      timestop.charge = ability.every;
      timestop.ready = true;
    }
  }

  /* Q, or the button. Does nothing unless it is charged and not
     already running. */
  function useTimestop() {
    var ability = clockAbility();

    if (!ability || !timestop.ready || timestop.left > 0) {
      return;
    }

    /* One charge for the whole board, so a guest asks rather than
       freezing its own copy of a game everyone else is still
       playing at full speed. */
    if (mp.on && !mp.host) {
      ask("timestop", {});
      return;
    }

    timestop.ready = false;
    timestop.charge = 0;
    timestop.left = ability.lasts;

    refreshHud();
    draw();
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
      (stats.boosted(
        stats.range(tower.key, tower.level, evolution),
        boostFor(position, "range")
      ) /
        stats.rangePerTile) *
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

    tower.angle = Math.atan2(aim.y - origin.y, aim.x - origin.x) + Math.PI / 2;

    /* A cooldown boost shortens the wait rather than lengthening
       it, so the percentage divides instead of multiplying. */
    /* A Sapper standing near a tower stretches its wait rather
       than stopping it — the tower keeps firing, just slower, and
       damage placed further down the lane is unaffected. */
    tower.cooldown =
      stats.cooldown(tower.key) /
      (1 + boostFor(position, "cooldown") / 100) /
      sapAt(position);

    var targets = attack.shape === "single" ? [primary] : inRange;
    var aimAngle = Math.atan2(aim.y - origin.y, aim.x - origin.x);

    /* A piercing shot carries on through whatever it hits, so the
       corridor either side of the line is what matters rather
       than the distance to the tower. */
    var corridor =
      attack.shape === "pierce"
        ? ((attack.width || 10) / 2 / stats.rangePerTile) * view.size
        : 0;

    targets.forEach(function (enemy) {
      var point = enemyAt(enemy);
      var dx = point.x - origin.x;
      var dy = point.y - origin.y;
      var distance = Math.sqrt(dx * dx + dy * dy);

      /* Cones only hit what is inside the arc. */
      if (attack.shape === "cone") {
        var angle = Math.atan2(dy, dx);

        if (!stats.inArc(tower.key, aimAngle, angle)) {
          return;
        }
      }

      if (attack.shape === "pierce") {
        /* Distance from the beam line, and never behind the
           tower — the shot goes one way. */
        var along = dx * Math.cos(aimAngle) + dy * Math.sin(aimAngle);
        var across = Math.abs(-dx * Math.sin(aimAngle) + dy * Math.cos(aimAngle));

        if (along < 0 || across > corridor) {
          return;
        }
      }

      var statDistance = (distance / view.size) * stats.rangePerTile;

      hurt(
        enemy,
        stats.boosted(
          stats.damageAtDistance(tower.key, tower.level, evolution, statDistance, tower.shiny),
          boostFor(position, "damage")
        ) * damageMultiplier()
      );
    });

    recordFiring(tower, origin, aim);
  }

  /* What firing looks like, per tower.

     This used to end with "anything else is a sniper", which is
     why Quantum drew a tracer at one enemy while damaging every
     enemy around it — the beam pointed at whichever target it
     happened to aim at and told the player nothing true. What a
     shot looks like follows the attack SHAPE now, and only the
     towers with a signature of their own are named. */
  function recordFiring(tower, origin, aim) {
    if (lowGraphics) {
      return;
    }

    var attack = stats.attack(tower.key);
    var shape = attack ? attack.shape : "single";

    /* Towers whose own moving parts are the animation. The
       blender's blades, Quantum's electrons and the Fan's vanes
       all wind up while firing and coast down after, and none of
       them wants a beam pointed at one enemy on top. */
    if (SPINNERS.indexOf(tower.key) >= 0) {
      tower.spinPower = 1;
      return;
    }

    /* Anything else that hits all around itself throws a ring
       rather than pointing. */
    if (shape === "circle") {
      tower.pulse = 1;
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

    /* Sniper, shotgunner and the Clock Tower kick back and leave
       a tracer. A piercing beam is drawn out to the full range
       rather than stopping at the target, because that is what it
       actually hits. */
    tower.recoil = 1;

    var toX = aim.x;
    var toY = aim.y;

    if (shape === "pierce") {
      var evolution = evolutionFor(tower);
      var reach =
        (stats.range(tower.key, tower.level, evolution) / stats.rangePerTile) *
        view.size;
      var angle = Math.atan2(aim.y - origin.y, aim.x - origin.x);

      toX = origin.x + Math.cos(angle) * reach;
      toY = origin.y + Math.sin(angle) * reach;
    }

    shots.push({
      fromX: origin.x,
      fromY: origin.y,
      toX: toX,
      toY: toY,
      life: shape === "pierce" ? 0.2 : 0.12,
      wide: shape === "pierce"
    });
  }

  /* Coins drifting up off a farm as it pays out. */
  function spendParticles(position) {
    if (lowGraphics) {
      return;
    }

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
  /* Everyone in the run. In a solo game that is one person, and
     every payment below is written as though it might not be. */
  function eachPlayer(fn) {
    var ids = Object.keys(mp.wallets);

    if (!ids.length) {
      ids = [me()];
    }

    ids.forEach(fn);
  }

  /* Kill money goes to every player in full, not split between
     them. Divided five ways it would mean the more of you there
     are the poorer everyone gets, on a wave with five times the
     health — the opposite of what bringing friends should do. */
  function awardAll(amount) {
    if (!(amount > 0)) {
      return;
    }

    eachPlayer(function (who) {
      setWallet(who, wallet(who) + amount);
    });
  }

  function payWave() {
    /* The wave bonus is paid to each player in full for the same
       reason: it is a flat 100, and splitting it would make
       joining a party a pay cut. */
    eachPlayer(payWaveFor);
  }

  function payWaveFor(who) {
    var total = WAVE_BONUS;
    var farmed = 0;
    var earners = [];
    var mine = who;

    Object.keys(towers).forEach(function (position) {
      var tower = towers[position];

      /* Your farms pay you, and the three-paying rule is counted
         per player rather than across the board. Pooling them
         would mean whoever merges first takes the other four's
         income away — with five players there would be three
         paying farms between them instead of three each. */
      if (tower.owner !== mine) {
        return;
      }

      var income = stats.coins(tower.key, tower.level, evolutionFor(tower), tower.shiny);

      if (income > 0) {
        earners.push({ position: position, income: income });
      }
    });

    /* Shuffled before sorting, so farms tied on level are picked
       at random rather than by whichever tile came first. */
    shuffle(earners);
    earners.sort(function (a, b) {
      return b.income - a.income;
    });

    earners.slice(0, PAYING_FARMS).forEach(function (earner) {
      total += earner.income;
      farmed += earner.income;
      spendParticles(earner.position);
    });

    setWallet(who, wallet(who) + total);

    /* Only ever announced to the person being paid. The host runs
       this for everybody and would otherwise narrate four other
       people's farms across its own screen. */
    if (who !== me()) {
      return;
    }

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

      /* The ring an all round attack throws out, fading as it
         widens. */
      if (tower.pulse) {
        tower.pulse = Math.max(0, tower.pulse - PULSE_DECAY * delta);
      }

      /* A Clock Tower's hands show its charge rather than its
         shooting: the hour hand comes round once per ability, so
         the dial itself is the countdown. */
      if (tower.key === "clocktower") {
        var ability = stats.ability("clocktower");

        tower.spin = ability
          ? (timestop.charge / ability.every) * Math.PI * 24
          : 0;
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

  /* =========================================================
     Allies

     A spawner drops one onto the nearest point of the path every
     few seconds. Allies do not move: they hold that spot, stop
     whatever walks into them, and trade damage until one side
     dies.
     ========================================================= */

  function spawnAllies(position, tower, delta) {
    var definition = stats.towers[tower.key];

    if (!definition.spawnEvery) {
      return;
    }

    var evolution = evolutionFor(tower);

    tower.spawnTimer = (tower.spawnTimer || 0) - delta;

    if (tower.spawnTimer > 0) {
      return;
    }

    tower.spawnTimer = definition.spawnEvery;

    var hp = stats.allyHealth(tower.key, tower.level, evolution);

    allies.push({
      from: position,
      key: tower.key,
      hp: hp,
      maxHp: hp,
      damage: stats.allyDamage(tower.key, tower.level, evolution, tower.shiny),
      cooldown: 0,
      reload: definition.allyCooldown,
      speed: definition.allySpeed,
      /* Never scales — only a booster can widen it. */
      range: definition.allyRange,

      /* Allies march out of the base, not out of the tower that
         sent them. Progress counts tiles walked from the portal,
         so the far end of the path is the base. Where the spawner
         itself sits makes no difference to where its allies
         appear — it only decides how often. */
      progress: view.path.length - 1
    });
  }

  function allyAt(ally) {
    return pathPoint(ally.progress);
  }

  /* Allies shoot whatever is inside their fixed reach, and take
     damage from anything standing on them. */
  function fightAllies(delta) {
    allies.forEach(function (ally) {
      var here = allyAt(ally);
      var reach = (ally.range / stats.rangePerTile) * view.size;

      ally.cooldown -= delta;

      var inRange = enemies.filter(function (enemy) {
        var point = enemyAt(enemy);
        var dx = point.x - here.x;
        var dy = point.y - here.y;

        return Math.sqrt(dx * dx + dy * dy) <= reach;
      });

      if (ally.cooldown <= 0 && inRange.length) {
        inRange.sort(function (a, b) {
          return b.progress - a.progress;
        });

        hurt(inRange[0], ally.damage);
        ally.cooldown = ally.reload;
      }
    });

    /* Anything touching an ally stops and hits it, and the ally
       stops too rather than walking through it. */
    allies.forEach(function (ally) {
      ally.engaged = false;
    });

    enemies.forEach(function (enemy) {
      enemy.blocked = false;

      for (var i = 0; i < allies.length; i += 1) {
        if (Math.abs(enemy.progress - allies[i].progress) <= BLOCK_TILES) {
          enemy.blocked = true;
          allies[i].engaged = true;
          allies[i].hp -= stats.waveEnemyDps(enemy.kind, wave) * delta;
          break;
        }
      }
    });

    /* Unengaged allies march on towards the portal. */
    allies.forEach(function (ally) {
      if (!ally.engaged) {
        ally.progress -= ally.speed * delta;
      }
    });

    /* Killed, or walked into the portal and lost. */
    allies = allies.filter(function (ally) {
      return ally.hp > 0 && ally.progress > 0;
    });
  }

  function update(delta) {
    if (baseHp <= 0) {
      return;
    }

    elapsed += delta;

    /* Spawning.

       Held at MAX_ALIVE. Everything on the path is moved, drawn
       and collision checked every frame, so the frame rate falls
       away with the count — deep waves queue thousands and the
       game was running at a few frames a second. The queue is not
       thrown away, only paused: the moment something dies or
       leaks, the next one walks in. Nothing is lost, the wave
       just arrives at a rate the browser can draw. */
    if (waveActive && spawnQueue.length && enemies.length < MAX_ALIVE) {
      spawnTimer -= delta;

      if (spawnTimer <= 0) {
        spawn(spawnQueue.shift());
        spawnTimer = stats.wave.spawnGap;
      }
    }

    /* Movement, then anything that reached the base. */
    var end = view.path.length - 1;

    tickTimestop(delta);

    /* Bosses hold still with everything else while time is
       stopped — a shield recharging or a Brood shedding adds
       through a freeze would make the Clock Tower worth less
       exactly when it matters most. */
    if (!frozen()) {
      tickBosses(delta);
    }

    fightAllies(delta);

    enemies.forEach(function (enemy) {
      /* Frozen enemies do not walk. Allies keep going — the stop
         is the player's, not the board's. */
      if (enemy.blocked || frozen()) {
        return;
      }

      var point = enemyAt(enemy);
      var factor = slowAt(point);
      var push = pushAt(point, enemy);

      /* Slow and pushback multiply rather than compete, so
         standing in both is slower than either — and, because
         both are shares of movement rather than distances, the
         result can approach nothing without ever going backwards.
         That is what stops a wave lasting forever. */
      enemy.slowed = factor < 1;
      enemy.pushed = push < 1;
      enemy.progress += enemy.speed * factor * push * delta;
    });

    /* Splits are collected rather than pushed while filtering,
       because adding to the array being filtered is how you get
       pieces that never appear. */
    var split = [];

    enemies = enemies.filter(function (enemy) {
      if (enemy.hp <= 0) {
        if (enemy.boss) {
          /* Paid in proportion, so two halves of a Cleaver are
             worth what the whole was rather than doubling it. */
          awardAll(stats.bossBounty(wave) * enemy.share);
          split.push(enemy);
        } else {
          awardAll(stats.waveBounty(enemy.kind, wave));
        }

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

    split.forEach(splitBoss);

    Object.keys(towers).forEach(function (position) {
      fire(position, towers[position], delta);
      spawnAllies(position, towers[position], delta);
    });


    shots = shots.filter(function (shot) {
      shot.life -= delta;
      return shot.life > 0;
    });

    advanceEffects(delta);

    /* A wave counts once nothing is left on the path, however it
       got there. Tanking a wave with the base is a valid way to
       survive it — the cost is the health, not the credit. */
    if (waveActive && !spawnQueue.length && !enemies.length) {
      waveActive = false;
      wavesSurvived = Math.max(wavesSurvived, wave);
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

    /* Kept up whether hosting or not — the list is what decides
       who takes over, and it has to already exist at the moment
       the host goes quiet. */
    if (mp.on) {
      pingPeers(timestamp);
      considerPromotion(timestamp);
    }

    if (mp.on && !mp.host) {
      /* A guest simulates nothing. It carries the enemies it was
         last told about along their own path at their own speed,
         and every tick puts them back where the host says they
         are. Without that they would only move ten times a
         second and the whole board would stutter.

         Nothing else is guessed at — no shooting, no money, no
         health. Guessing those would mean showing a kill that
         did not happen. */
      enemies.forEach(function (enemy) {
        enemy.progress += enemy.speed * delta * speed;
      });

      advanceEffects(delta * speed);
    } else {
      /* Fixed slices, so 2x and 10x are genuinely the same game
         running faster rather than a coarser one. */
      var remaining = delta * speed;
      var steps = 0;

      while (remaining > 0 && steps < MAX_STEPS && running) {
        update(Math.min(STEP, remaining));
        remaining -= STEP;
        steps += 1;
      }

      broadcast(timestamp);
    }

    refreshHud();
    draw();

    window.requestAnimationFrame(loop);
  }

  /* The host talking. Ticks carry what moves; the full picture
     goes out every few seconds so a client that missed something
     is corrected without having to notice it had. */
  function broadcast(now) {
    if (!mp.on || !mp.host) {
      return;
    }

    if (now - mp.lastSnapshot >= SNAPSHOT_MS) {
      mp.lastSnapshot = now;
      mp.lastTick = now;
      sendSnapshot();
      return;
    }

    if (now - mp.lastTick >= TICK_MS) {
      mp.lastTick = now;
      sendTick();
    }
  }

  /* =========================================================
     Cash, base, selling
     ========================================================= */

  function isDev() {
    return Boolean(window.MRTD && window.MRTD.dev);
  }

  /* How many are playing this run. Enemy health multiplies by it,
     so it is read at spawn time rather than stored — a player
     joining or dropping changes what arrives next, not what is
     already walking. Solo is 1. */
  function players() {
    return window.MRTD.partySize ? window.MRTD.partySize() : 1;
  }

  function upgradeLevel(name) {
    return window.MRTD.upgrade ? window.MRTD.upgrade(name) : 0;
  }

  /* Permanent progression, read once when a tower is placed and
     carried on the tower itself so it survives merges. */
  function evolutionOf(name) {
    return window.MRTD.evolutionOf ? window.MRTD.evolutionOf(name) : 0;
  }

  /* The strongest boost of one kind covering a tile. Boosts never
     stack: ten Forges reaching the same tower give exactly what
     the best one alone would. */
  function boostFor(position, stat) {
    var parts = position.split(",");
    var col = Number(parts[0]);
    var row = Number(parts[1]);
    var best = 0;

    Object.keys(towers).forEach(function (at) {
      var booster = towers[at];

      if (stats.boostsWhat(booster.key).indexOf(stat) < 0) {
        return;
      }

      var from = at.split(",");
      var dx = Number(from[0]) - col;
      var dy = Number(from[1]) - row;
      var evolution = evolutionFor(booster);
      var reach =
        stats.range(booster.key, booster.level, evolution) / stats.rangePerTile;

      if (Math.sqrt(dx * dx + dy * dy) > reach) {
        return;
      }

      var strength = stats.boost(
        booster.key,
        booster.level,
        evolution,
        booster.shiny
      );

      if (strength > best) {
        best = strength;
      }
    });

    return best;
  }

  /* The strongest slow covering a point, as a speed multiplier.
     Slows do not stack — two Ice Cannons overlapping give one
     Ice Cannon's worth. */
  /* The strongest pushback covering a point, as the share of its
     pace an enemy keeps.

     Read from where the enemy is standing rather than applied
     when a Fan fires, which is what makes it an effect. The
     earlier version shoved on each shot, so two Fans on
     different cooldowns landed two shoves a second and the
     "strongest wins" rule never saw them together — it only ever
     compared shoves inside one frame. Reading position instead
     means any number of Fans is exactly as strong as the best of
     them, and firing rate has nothing to do with it. */
  function pushAt(point, enemy) {
    var factor = 1;
    /* A boss has its own weight — heavier than anything else, so
       it is shoved less, but a Fan still bites. Nothing is exempt
       from pushback. */
    var weight = enemy.boss ? stats.boss.weight : stats.weight(enemy.kind);

    Object.keys(towers).forEach(function (at) {
      var tower = towers[at];
      var pushback = stats.pushback(tower.key);

      if (!pushback) {
        return;
      }

      var parts = at.split(",");
      var centre = tileCentre(Number(parts[0]), Number(parts[1]));
      var dx = point.x - centre.x;
      var dy = point.y - centre.y;
      var reach =
        (stats.range(tower.key, tower.level, evolutionFor(tower)) /
          stats.rangePerTile) *
        view.size;
      var kept = stats.pushFactor(pushback, weight);

      if (Math.sqrt(dx * dx + dy * dy) <= reach && kept < factor) {
        factor = kept;
      }
    });

    return factor;
  }

  function slowAt(point) {
    var factor = 1;

    Object.keys(towers).forEach(function (at) {
      var tower = towers[at];
      var slow = stats.slowOf(tower.key);

      if (slow >= 1) {
        return;
      }

      var parts = at.split(",");
      var centre = tileCentre(Number(parts[0]), Number(parts[1]));
      var dx = point.x - centre.x;
      var dy = point.y - centre.y;
      var reach =
        (stats.range(tower.key, tower.level, evolutionFor(tower)) /
          stats.rangePerTile) *
        view.size;

      if (Math.sqrt(dx * dx + dy * dy) <= reach && slow < factor) {
        factor = slow;
      }
    });

    return factor;
  }

  /* Evolution is looked up per variant: a shiny Sniper is not the
     same collection entry as a plain one and carries its own. */
  function evolutionFor(tower) {
    return tower.evolution === undefined
      ? evolutionOf(stats.variantName(tower.key, tower.shiny))
      : tower.evolution;
  }

  function placementLimit() {
    return stats.placementLimit(upgradeLevel("placements"));
  }

  /* Who I am on this board. Solo runs still have an owner — the
     alternative is two code paths that have to agree about which
     towers are yours, and they would not. */
  function me() {
    return (window.MRTD.userId && window.MRTD.userId()) || "solo";
  }

  /* Towers standing that belong to a given player, or to me by
     default.

     The limit is per player, so a party of five can have five
     times the towers on one board and nobody's building is
     capped by anybody else's. Counting every tower on the board
     would mean the first player to spend locks the rest out. */
  function placed(owner) {
    var who = owner || me();
    var count = 0;

    Object.keys(towers).forEach(function (at) {
      if (towers[at].owner === who) {
        count += 1;
      }
    });

    return count;
  }

  /* =========================================================
     Money notifications

     One-off events get a passing line. Kills get nothing —
     there are far too many of them to be worth announcing.
     ========================================================= */

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


  /* Health of every boss on the path at once, as one bar. A
     Cleaver becomes three things and they are all the same fight,
     so three bars would say less than one does. */
  function refreshBossBar() {
    if (!bossBar) {
      return;
    }

    var present = enemies.filter(function (enemy) {
      return enemy.boss;
    });

    bossBar.hidden = !present.length;

    if (!present.length) {
      return;
    }

    var definition = stats.bosses[present[0].boss];
    var hp = 0;
    var max = 0;
    var healing = false;
    var immune = false;

    present.forEach(function (enemy) {
      hp += enemy.hp;
      /* Measured against one whole boss, so a Cleaver's pieces
         read as what is left of it rather than resetting the bar
         to full the moment it splits. */
      max += enemy.maxHp / enemy.share;
      healing = healing || enemy.healing;
      immune = immune || enemy.immune;
    });

    max = Math.max(max / present.length, hp);

    bossName.textContent = definition ? definition.label : "Boss";

    /* The shield window is the whole fight against a Warden, so
       what the bar has to say is how long until it flips — a
       countdown is something you can act on, the word "immune"
       on its own is not. */
    var warden = present.filter(function (enemy) {
      return stats.bosses[enemy.boss] &&
        stats.bosses[enemy.boss].ability === "shield";
    })[0];

    bossNote.textContent = healing
      ? "healing — nothing can reach it"
      : warden
        ? warden.immune
          ? "immune · drops in " + Math.ceil(warden.abilityTimer) + "s"
          : "vulnerable · " + Math.ceil(warden.abilityTimer) + "s"
        : present.length > 1
          ? present.length + " pieces"
          : "";

    bossBar.classList.toggle("is-immune", immune);
    bossFill.style.width = Math.max(0, (hp / max) * 100) + "%";
    bossHp.textContent = formatHp(hp) + " / " + formatHp(max);
  }

  function refreshHud() {
    cashDisplay.textContent = isDev() ? "∞" : String(Math.floor(cash));
    hpDisplay.textContent = String(Math.max(0, Math.round(baseHp)));
    placedDisplay.textContent = placed() + " / " + placementLimit();
    waveDisplay.textContent = String(wave);

    var minutes = Math.floor(elapsed / 60);
    var seconds = Math.floor(elapsed % 60);

    timeDisplay.textContent =
      minutes + ":" + (seconds < 10 ? "0" : "") + seconds;

    /* Everything on the path, including whatever is still queued
       to spawn this wave. */
    aliveDisplay.textContent = String(enemies.length + spawnQueue.length);

    refreshBossBar();
    refreshPlayers();

    /* The ability button: counting down the freeze, announcing
       itself ready, or charging. Hidden entirely when no Clock
       Tower is standing, since there is nothing to charge. */
    if (abilityButton) {
      var ability = clockAbility();

      abilityButton.hidden = !ability;

      if (ability) {
        abilityButton.classList.toggle("is-active", frozen());
        abilityButton.classList.toggle(
          "is-ready",
          timestop.ready && !frozen()
        );
        abilityButton.disabled = !timestop.ready || frozen();

        /* The countdown is in game seconds either way. In
           developer mode it is also being spent ten times faster,
           which is worth saying so the number is not mistaken for
           what a player would wait. */
        abilityState.textContent = frozen()
          ? Math.ceil(timestop.left) + "s"
          : timestop.ready
            ? "Ready"
            : Math.ceil(
                (ability.every - timestop.charge) /
                  (isDev() ? DEV_CHARGE_RATE : 1)
              ) + "s" + (isDev() ? " dev" : "");
      }
    }

    /* What the run is worth if it ended right now. Surviving a
       wave is enough — tanking one with the base still counts. */
    beatenDisplay.textContent = String(wavesSurvived);
    payoutDisplay.textContent = isDev()
      ? "0"
      : String(stats.runReward(wavesSurvived));
    /* Solo, leaving is only allowed once the base has fallen —
       otherwise a losing run could be walked out of and its waves
       banked anyway.

       In a party it is allowed any time, because leaving costs
       you the reward rather than saving it: the run carries on
       without you, your towers keep fighting, and end_party_run
       pays only the players still there. */
    exitButton.disabled = baseHp > 0 && !mp.on;
    exitButton.textContent = mp.on && baseHp > 0 ? "Step out" : "Leave";

    /* Skip is offered once the wave has finished spawning and
       there is still something left to kill. The two buttons do
       the same job, so only one is ever shown. */
    var canSkip = waveActive && !spawnQueue.length && enemies.length > 0;

    skipButton.hidden = !canSkip;
    startButton.hidden = canSkip;

    /* Counts down through the intermission, then starts itself. */
    jumpBox.hidden = !isDev();

    /* Speed, auto-skip and the wave jump all steer the
       simulation, and only one client is running one. A guest
       pressing these changed nothing and looked broken doing it,
       so they belong to whoever is hosting.

       Speed still shows, because a guest needs to see how fast
       the board is going even though they cannot set it. */
    var steering = isHost();

    speedButton.disabled = !steering;
    autoButton.hidden = !steering;

    if (!steering) {
      jumpBox.hidden = true;
    }
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

  /* The authoritative sale. `who` is checked against the tower
     rather than trusted, so a guest asking to sell a partner's
     tower is refused by the host rather than by their own
     browser being polite about it. */
  function hostSell(from, who) {
    var tower = towers[from];

    /* The refund goes to whoever paid, so selling something that
       is not yours would be taking their money. Dragging already
       refuses to pick up a partner's tower; this is the same rule
       where the money actually moves. */
    if (!tower || tower.owner !== who) {
      return false;
    }

    var refund = stats.sellValue(tower.key, tower.level);

    setWallet(who, wallet(who) + refund);
    delete towers[from];

    if (who === me()) {
      notifyCash(refund, "sold");
    }

    return true;
  }

  function sell(from) {
    var tower = towers[from];

    if (!tower || tower.owner !== me()) {
      return;
    }

    if (mp.on && !mp.host) {
      ask("sell", { at: from });
      return;
    }

    if (hostSell(from, me())) {
      sendBuilt();
    }

    refreshHud();
  }

  /* =========================================================
     Hotbar
     ========================================================= */

  /* The five towers equipped in the Towers tab. Falls back to the
     full list so the match is still playable before anything is
     owned. */
  /* The hotbar is the loadout, always — developer mode owns every
     tower so any five can be equipped, but it still only brings
     five into a match. */
  function loadoutKeys() {
    var equipped = window.MRTD.loadout ? window.MRTD.loadout() : [];

    if (equipped.length) {
      return equipped.slice(0, loadoutSlots());
    }

    /* Nothing equipped yet: give the opening towers rather than
       an empty hotbar. */
    return TOWER_KEYS.slice(0, loadoutSlots());
  }

  function buildHotbar() {
    hotbar.textContent = "";
    closeLevels();

    loadoutKeys().forEach(function (slotName, index) {
      /* The loadout stores variants, so the slot has to be split
         back into the tower and whether it is the shiny line. */
      var variant = stats.variantOf(slotName);
      var name = variant.key;
      var button = document.createElement("button");

      button.className = "hotbar__slot";
      button.type = "button";
      button.dataset.tower = slotName;

      if (variant.shiny) {
        button.dataset.shiny = "true";
      }

      /* The key that selects this slot, on the slot — a shortcut
         nobody knows about is not a shortcut. */
      var shortcut = document.createElement("span");
      shortcut.className = "hotbar__key";
      shortcut.textContent = String(index + 1);
      button.appendChild(shortcut);

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
      var title =
        (variant.shiny ? "Shiny " : "") + stats.towers[name].label;
      var label = document.createElement("span");
      label.className = "hotbar__name";
      label.textContent = title;
      button.appendChild(label);
      button.title = title;

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
          openLevels(slotName, button);
        }, HOLD_MS);
      });

      button.addEventListener("pointerup", function () {
        window.clearTimeout(holdTimer);

        if (held) {
          return;
        }

        select(slotName, 1);
      });

      button.addEventListener("pointerleave", function () {
        window.clearTimeout(holdTimer);
      });

      hotbar.appendChild(button);
    });
  }

  /* Takes a variant name from the hotbar and splits it, so what
     is being positioned already knows whether it is shiny. */
  function select(slotName, level) {
    var variant = stats.variantOf(slotName);
    var same =
      placing &&
      placing.key === variant.key &&
      Boolean(placing.shiny) === variant.shiny &&
      placing.level === level;

    placing = same
      ? null
      : { key: variant.key, shiny: variant.shiny, level: level };
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

  /* `slotName` is a variant. A shiny costs exactly what its normal
     twin costs, so the price comes from the base key. */
  function levelRow(slotName, level) {
    var name = stats.variantOf(slotName).key;
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
      select(slotName, level);
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
      return attack.falloffTo === undefined
        ? attack.angle + "° cone, full damage"
        : attack.angle + "° cone, falls to " +
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
    var damage = stats.damage(tower.key, tower.level, evolution, tower.shiny);
    var cooldown = stats.cooldown(tower.key);
    var reach =
      stats.range(tower.key, tower.level, evolution) / stats.rangePerTile;

    inspect.textContent = "";

    var title = document.createElement("p");
    title.className = "inspect__title";
    title.textContent =
      (tower.shiny ? "Shiny " : "") +
      definition.label + "  ·  Level " + tower.level +
      (evolution ? "  ·  Evo " + evolution : "");
    inspect.appendChild(title);

    if (tower.shiny) {
      inspect.appendChild(statLine("Shiny", stats.shinySummary(tower.key)));
    }

    if (damage > 0) {
      inspect.appendChild(statLine("Damage", String(Math.round(damage))));
      inspect.appendChild(statLine("Cooldown", cooldown + "s"));
      inspect.appendChild(
        statLine("DPS", String(Math.round(damage / cooldown)))
      );
    }

    var ally = stats.allyHealth(tower.key, tower.level, evolution);

    if (ally > 0) {
      inspect.appendChild(statLine("Ally health", formatHp(ally)));
      inspect.appendChild(
        statLine(
          "Ally damage",
          formatHp(stats.allyDamage(tower.key, tower.level, evolution, tower.shiny))
        )
      );
      inspect.appendChild(
        statLine("Spawns", "every " + definition.spawnEvery + "s")
      );
      inspect.appendChild(
        statLine("Ally reach", definition.allyRange / stats.rangePerTile + " tiles")
      );
    }

    var coins = stats.coins(tower.key, tower.level, evolution, tower.shiny);

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
      var variant = stats.variantOf(button.dataset.tower);

      button.disabled = !affordable(variant.key, 1);
      button.classList.toggle(
        "is-selected",
        Boolean(
          placing &&
            placing.key === variant.key &&
            Boolean(placing.shiny) === variant.shiny
        )
      );
    });
  }

  /* The authoritative placement. Everything that puts a tower on
     the board comes through here — this player clicking, and the
     host acting on a guest's request — so the rules are checked
     once instead of once per browser.

     `order` carries who is buying and what they are buying,
     because in a party the two are not the same person. */
  function commitPlace(order) {
    var owner = order.owner;
    var at = key(order.col, order.row);

    if (!buildable(order.col, order.row)) {
      return false;
    }

    var wanted = {
      key: order.key,
      shiny: Boolean(order.shiny),
      level: order.level,
      owner: owner
    };
    var occupant = towers[at];

    /* Buying onto a matching tower merges straight into it, so a
       bought level 4 dropped on a level 4 becomes a level 5. */
    if (occupant && !canMerge(wanted, occupant)) {
      return false;
    }

    /* Merging never breaches the limit, only new placements do,
       and the limit belongs to the buyer rather than the board. */
    if (!occupant && placed(owner) >= order.limit) {
      return false;
    }

    var price = stats.buyCost(order.key, order.level);

    if (!order.free) {
      if (price > wallet(owner)) {
        return false;
      }

      setWallet(owner, wallet(owner) - price);
    }

    towers[at] = {
      key: order.key,
      /* An occupant can only be here if canMerge allowed it, and
         that already requires the same owner — so this is always
         the buyer either way. Written out rather than assumed,
         because the day that changes this is where it breaks. */
      owner: occupant ? occupant.owner : owner,
      shiny: Boolean(order.shiny),
      level: occupant ? occupant.level + 1 : order.level,
      evolution: occupant ? evolutionFor(occupant) : order.evolution,
      cooldown: 0,
      angle: occupant ? occupant.angle || 0 : 0
    };

    return true;
  }

  function hostPlace(data) {
    if (commitPlace({
      owner: data.who,
      col: data.col,
      row: data.row,
      key: data.key,
      shiny: data.shiny,
      level: data.level,
      /* Sent by the guest, because only their browser knows what
         they own and what they have upgraded. */
      evolution: data.evolution,
      limit: data.limit,
      free: data.free
    })) {
      sendBuilt();
      refreshHud();
    }
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

    var order = {
      owner: me(),
      col: tile[0],
      row: tile[1],
      key: placing.key,
      shiny: Boolean(placing.shiny),
      level: placing.level,
      evolution: evolutionOf(stats.variantName(placing.key, placing.shiny)),
      limit: placementLimit(),
      free: isDev()
    };

    /* A guest asks; it appears when the host says so. Placing it
       locally first and correcting later would show a tower that
       might not be there, and on a shared board the correction
       is somebody else's tower already standing on the tile. */
    if (mp.on && !mp.host) {
      ask("place", order);
      placing = null;
      return;
    }

    if (commitPlace(order)) {
      sendBuilt();
    }

    placing = null;
    refreshHud();
  }

  /* =========================================================
     Input
     ========================================================= */

  /* Right click a placed tower to read everything about it.

     Laying a run of towers used to live here too, which meant
     right click did one of two unrelated things depending on
     hidden state. That job is the E key now, and right click
     while positioning simply puts the ghost down. */
  canvas.addEventListener("contextmenu", function (event) {
    event.preventDefault();

    var point = pointerPosition(event);
    var tile = tileAt(point.x, point.y);

    if (placing) {
      placing = null;
      refreshHotbar();
      draw();
      return;
    }

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

    /* Only your own move. Right click still reads anyone's stats
       — looking at a partner's build is useful, picking it up and
       dropping it somewhere is not. */
    if (!towers[at] || towers[at].owner !== me()) {
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

  /* =========================================================
     Keyboard

     Everything here is a shortcut for something the mouse can
     already do — the point is not having to travel back to the
     hotbar between placements.

       1-5  select that hotbar slot
       F    place at the pointer
       E    place at the pointer and stay armed
       Esc  put the ghost down
     ========================================================= */

  /* Drops the tower under the pointer. Keeping the ghost is what
     separates E from F: with `again` set the selection survives
     the placement, so a row of towers goes down without going
     back to the hotbar each time. */
  function placeAtPointer(again) {
    if (!placing || !pointer) {
      return;
    }

    var repeat = placing;

    place(tileAt(pointer.x, pointer.y));

    /* Stay armed only while another is actually affordable and
       there is room for it, so the ghost never lingers on a
       placement that cannot happen. */
    if (
      again &&
      !placing &&
      (isDev() || stats.buyCost(repeat.key, repeat.level) <= cash) &&
      placed() < placementLimit()
    ) {
      placing = repeat;
    }

    refreshHud();
    draw();
  }

  /* A number key belongs to whoever is typing, not to the hotbar
     — the wave jump box is a number input sitting right there. */
  function typing(target) {
    if (!target) {
      return false;
    }

    var tag = target.tagName;

    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target.isContentEditable
    );
  }

  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
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

      return;
    }

    /* Nothing below should fire off-screen, over a text field, or
       on top of a browser shortcut. */
    if (root.hidden || typing(event.target)) {
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    /* Bounded by what is actually on the hotbar rather than a
       fixed 1-5, so the sixth slot gets a key too. */
    var slot = "123456789".indexOf(event.key);

    if (slot >= 0 && slot < hotbar.children.length) {
      var button = hotbar.children[slot];

      if (button) {
        event.preventDefault();
        select(button.dataset.tower, 1);
      }

      return;
    }

    var pressed = event.key.toLowerCase();

    if (pressed === "q") {
      event.preventDefault();
      useTimestop();
      return;
    }

    if (pressed === "f" || pressed === "e") {
      if (placing) {
        event.preventDefault();
        placeAtPointer(pressed === "e");
      }
    }
  });

  abilityButton.addEventListener("click", useTimestop);

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

  /* The three highest farms pay, whatever level they are. Build as
     many as you like — a ladder of lower levels is how merges are
     staged — but the rest are stock, not income. */
  var PAYING_FARMS = 3;

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = list[i];

      list[i] = list[j];
      list[j] = swap;
    }

    return list;
  }

  /* A shiny and a normal are different towers for this purpose,
     however identical they look on the board.

     So are two players' towers. Cash and placements are both per
     player, and merging across that line would break it in the
     worst direction: a partner's level 9 is worth 256 towers, and
     anyone able to merge onto it could consume it by accident or
     on purpose. You build your own. */
  function canMerge(source, target) {
    return Boolean(
      source && target &&
      source.key === target.key &&
      source.owner === target.owner &&
      Boolean(source.shiny) === Boolean(target.shiny) &&
      source.level === target.level &&
      source.level < MAX_LEVEL
    );
  }

  function drop(from, target) {
    if (!target || !buildable(target[0], target[1])) {
      return;
    }

    var to = key(target[0], target[1]);

    if (to === from) {
      return;
    }

    if (mp.on && !mp.host) {
      ask("move", { from: from, to: to });
      return;
    }

    if (hostMove(from, to, me())) {
      sendBuilt();
    }
  }

  /* Moving, merging and swapping, all of which are the same
     gesture from the player's side. */
  function hostMove(from, to, who) {
    var tower = towers[from];

    if (!tower || tower.owner !== who || !towers[from]) {
      return false;
    }

    var occupant = towers[to];

    if (canMerge(tower, occupant)) {
      towers[to] = {
        key: tower.key,
        /* The one being dragged keeps its owner, so merging your
           own two is still yours and dragging onto a partner's
           does not hand yours over. */
        owner: tower.owner,
        shiny: Boolean(tower.shiny),
        level: tower.level + 1,
        evolution: evolutionFor(tower),
        cooldown: 0,
        angle: tower.angle || 0
      };
      delete towers[from];
      return true;
    }

    if (!occupant) {
      towers[to] = tower;
      delete towers[from];
      return true;
    }

    /* Swapping is only yours with yours. Trading places with a
       partner's tower would move something they placed. */
    if (occupant.owner !== who) {
      return false;
    }

    towers[to] = tower;
    towers[from] = occupant;
    return true;
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
    allies = [];
    spawnQueue = [];
    portraitMode = null;
    elapsed = 0;
    cash = stats.startingCashFor(upgradeLevel("starting_cash"));

    /* Everyone starts with their own purse. Seeded from the party
       so the host can pay people who have not placed anything
       yet — an empty wallets map would mean the first wave paid
       only whoever happened to build first. */
    mp.wallets = {};
    setWallet(me(), cash);

    if (mp.on && window.MRTD.party) {
      window.MRTD.party().members.forEach(function (member) {
        if (mp.wallets[member.id] === undefined) {
          mp.wallets[member.id] = cash;
        }
      });
    }
    baseHp = stats.baseHp;
    wave = 0;
    wavesSurvived = 0;
    waveActive = false;
    timestop = { charge: 0, ready: false, left: 0 };

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

    /* A party run is banked by end_party_run, which pays every
       player still present in one statement. Calling bank_run as
       well would pay this player twice — and only this player,
       which is worse than either. */
    banking = mp.on
      ? window.MRTD.endParty(wavesSurvived).then(function () {
          gameoverNote.textContent = "Banked for everyone still here";
        })
      : bankRun(wavesSurvived);
  }

  /* Credit the coins server side. The reward is recalculated in
     Postgres from the wave count, so the browser cannot name its
     own figure.

     Whatever happens is reported on the panel — a run that pays
     nothing should say why rather than look broken. */
  function bankRun(waves) {
    if (isDev()) {
      return Promise.resolve();
    }

    /* A long run can outlive the access token, so it is renewed
       before the one call that must not fail. */
    return (window.MRTD.freshen
      ? window.MRTD.freshen()
      : Promise.resolve(window.MRTD.session())
    ).then(function (session) {
      if (!session || !session.access_token) {
        gameoverNote.textContent = "Not signed in — nothing banked";
        return null;
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
    });
  }

  /* =========================================================
     Multiplayer

     One player simulates and everybody else watches and asks.
     The host runs exactly the same update() a solo player runs;
     guests do not simulate at all. That is the whole design, and
     it is chosen over everyone running the same simulation from
     the same seed because that only works while every client
     agrees forever — one divergence and two players are playing
     different games without either being told.

     Three kinds of message:

       s  snapshot   everything, on join and every few seconds
       t  tick       what changes constantly, ten times a second
       i  input      a guest asking the host to do something

     Towers are not in the tick. They change when somebody acts
     and not otherwise, so they ride the snapshot and a `built`
     event instead of being resent sixty times a minute.

     WHAT A GUEST IS TRUSTED WITH: the evolution of the tower it
     is placing, because only that player's browser knows what
     they own. A guest could claim more. It is friends-only co-op
     and the lie costs nobody else anything — rewards come from
     Postgres and are counted in waves, not towers — but it is a
     lie the host cannot currently catch.
     ========================================================= */

  var TICK_MS = 100;
  var SNAPSHOT_MS = 3000;

  /* How often each client says it is still here, and how long a
     peer stays on the list without saying so. */
  var PEER_PING_MS = 2000;
  var PEER_STALE_MS = 6000;

  /* Silence from the host before somebody else takes over. Long
     enough that a slow frame or a brief wifi stumble does not
     trigger it, short enough that a run does not sit frozen. */
  var HOST_GONE_MS = 4000;

  var mp = {
    on: false,
    host: false,
    runId: null,

    /* playerId -> match cash. The host owns this; everyone else
       has the copy from the last tick. */
    wallets: {},

    lastTick: 0,
    lastSnapshot: 0,

    /* Everyone currently on the channel, id -> when they were
       last heard from. Kept by every client, not just the host,
       because the whole point is to survive the host going
       quiet — and a list only the host maintains dies with it. */
    peers: {},
    lastPeerPing: 0,

    /* id -> username, taken from the party when the run starts.
       The channel carries ids; only the lobby knows names. */
    names: {},

    /* Who is simulating, as last heard. Tracked separately from
       mp.host because everyone needs to know it, not just the
       one it is true of. */
    hostId: null,

    /* When the host was last heard. Silence past HOST_GONE_MS is
       what triggers an election. */
    heardHost: 0,

  };

  function multiplayer() {
    return mp.on;
  }

  function isHost() {
    return !mp.on || mp.host;
  }

  /* Cash is per player. The host keeps everyone's and spends out
     of the same map, so there is one place a balance lives. */
  function wallet(who) {
    var id = who || me();

    if (mp.wallets[id] === undefined) {
      mp.wallets[id] = stats.startingCashFor(upgradeLevel("starting_cash"));
    }

    return mp.wallets[id];
  }

  function setWallet(who, amount) {
    mp.wallets[who || me()] = amount;

    if ((who || me()) === me()) {
      cash = amount;
    }
  }

  /* =========================================================
     Serialising

     Compact on purpose. A thousand enemies at ten ticks a second
     is the one message that could actually saturate a phone, so
     they travel as arrays of numbers rather than named fields.
     ========================================================= */

  function packEnemies() {
    return enemies.map(function (enemy) {
      return [
        enemy.kind,
        enemy.boss || 0,
        Math.round(enemy.hp),
        Math.round(enemy.maxHp),
        Math.round(enemy.progress * 1000) / 1000,
        enemy.share || 1,
        (enemy.slowed ? 1 : 0) |
          (enemy.pushed ? 2 : 0) |
          (enemy.immune ? 4 : 0) |
          (enemy.healing ? 8 : 0)
      ];
    });
  }

  function unpackEnemies(rows) {
    return (rows || []).map(function (row) {
      return {
        kind: row[0],
        boss: row[1] || null,
        hp: row[2],
        maxHp: row[3],
        progress: row[4],
        share: row[5],
        slowed: Boolean(row[6] & 1),
        pushed: Boolean(row[6] & 2),
        immune: Boolean(row[6] & 4),
        healing: Boolean(row[6] & 8),
        speed: row[1] ? stats.boss.speed : stats.enemies[row[0]].speed
      };
    });
  }

  function packTowers() {
    var out = {};

    Object.keys(towers).forEach(function (at) {
      var tower = towers[at];

      out[at] = [
        tower.key,
        tower.owner,
        tower.level,
        tower.evolution,
        tower.shiny ? 1 : 0,
        Math.round((tower.angle || 0) * 100) / 100
      ];
    });

    return out;
  }

  function unpackTowers(packed) {
    var out = {};

    Object.keys(packed || {}).forEach(function (at) {
      var row = packed[at];

      out[at] = {
        key: row[0],
        owner: row[1],
        level: row[2],
        evolution: row[3],
        shiny: Boolean(row[4]),
        angle: row[5],
        cooldown: 0
      };
    });

    return out;
  }

  function packAllies() {
    return allies.map(function (ally) {
      return [
        Math.round(ally.progress * 1000) / 1000,
        Math.round(ally.hp),
        Math.round(ally.maxHp)
      ];
    });
  }

  function unpackAllies(rows) {
    return (rows || []).map(function (row) {
      return { progress: row[0], hp: row[1], maxHp: row[2] };
    });
  }

  /* =========================================================
     Sending
     ========================================================= */

  function sendSnapshot() {
    window.MRTD.net.send("s", {
      speed: speed,
      towers: packTowers(),
      enemies: packEnemies(),
      allies: packAllies(),
      wave: wave,
      survived: wavesSurvived,
      baseHp: Math.round(baseHp),
      active: waveActive,
      breakLeft: Math.round(breakLeft * 10) / 10,
      queued: spawnQueue.length,
      timestop: timestop,
      wallets: mp.wallets,
      elapsed: Math.round(elapsed)
    });
  }

  function sendTick() {
    window.MRTD.net.send("t", {
      /* The host's speed setting, so guests carry enemies forward
         at the rate the board is actually running. Without it a
         guest on 1x watching a host on 10x would drag every
         enemy back a tenth of a second's travel, ten times a
         second, and the whole wave would judder. */
      speed: speed,
      enemies: packEnemies(),
      allies: packAllies(),
      baseHp: Math.round(baseHp),
      wave: wave,
      survived: wavesSurvived,
      active: waveActive,
      breakLeft: Math.round(breakLeft * 10) / 10,
      queued: spawnQueue.length,
      timestop: timestop,
      wallets: mp.wallets
    });
  }

  /* Towers move rarely, so they are announced when they change
     rather than carried by every tick. */
  function sendBuilt() {
    if (!mp.on || !mp.host) {
      return;
    }

    window.MRTD.net.send("b", { towers: packTowers(), wallets: mp.wallets });
  }

  function ask(action, detail) {
    var message = detail || {};

    message.a = action;
    message.who = me();
    window.MRTD.net.send("i", message);
  }

  /* =========================================================
     Host migration

     A run must not end because the person simulating it closed
     their laptop. The others are still playing, their towers are
     still standing, and the wave is still coming.

     So every client says "here" twice a second and keeps the
     list. If the host goes quiet for four seconds, whoever is
     first in that list by id promotes themselves and carries on
     from the last snapshot they were sent.

     Sorting by id is what makes it safe: it is the same answer
     on every browser, so exactly one client promotes itself and
     the rest simply start hearing ticks again. Picking "whoever
     noticed first" would give two hosts and two versions of the
     board.

     Up to three seconds of simulation is lost — whatever
     happened between the last snapshot and the host going. That
     is a wave slightly rewound, against a run that would
     otherwise be over.
     ========================================================= */

  function livePeers(now) {
    return Object.keys(mp.peers).filter(function (id) {
      return now - mp.peers[id] < PEER_STALE_MS;
    }).sort();
  }

  function pingPeers(now) {
    if (now - mp.lastPeerPing < PEER_PING_MS) {
      return;
    }

    mp.lastPeerPing = now;
    mp.peers[me()] = now;
    window.MRTD.net.send("p", { who: me(), host: mp.host });
  }

  function considerPromotion(now) {
    if (mp.host || !mp.heardHost) {
      return;
    }

    if (now - mp.heardHost < HOST_GONE_MS) {
      return;
    }

    var live = livePeers(now);

    /* Everyone works out the same successor from the same list,
       so only one client acts on it. */
    if (!live.length || live[0] !== me()) {
      return;
    }

    mp.host = true;
    mp.hostId = me();
    mp.heardHost = 0;
    mp.lastSnapshot = 0;
    mp.lastTick = 0;

    /* Said out loud so the others stop waiting and start taking
       ticks from here instead. */
    window.MRTD.net.send("h", { who: me() });
    sendSnapshot();
    setStatusLine("You are running the match now");
  }

  /* =========================================================
     Who is here

     Read from the same peer list the handover uses, so the strip
     and the election can never disagree about who is playing —
     if a name is on screen, that client is one that could take
     over, and when it stops saying "here" it leaves both at
     once.

     Rebuilt only when the line would actually read differently.
     This is called every frame and the names change perhaps
     twice a match. */
  var lastRoster = "";

  function nameOf(id) {
    if (id === me()) {
      return "You";
    }

    return mp.names[id] || "Player";
  }

  function refreshPlayers() {
    if (!playersStrip) {
      return;
    }

    if (!mp.on) {
      playersStrip.hidden = true;
      lastRoster = "";
      return;
    }

    var now = window.performance.now();
    var live = livePeers(now);

    /* Always includes this player. Your own ping is on the same
       clock as everyone else's, and a strip that briefly forgot
       you existed would be alarming for no reason. */
    if (live.indexOf(me()) < 0) {
      live.push(me());
      live.sort();
    }

    var roster = live.join(",") + "|" + (mp.host ? me() : "");

    if (roster === lastRoster) {
      return;
    }

    lastRoster = roster;
    playersStrip.hidden = false;
    playersStrip.textContent = "";

    live.forEach(function (id) {
      var tag = document.createElement("span");

      tag.className = "players__tag";

      if (id === me()) {
        tag.classList.add("is-me");
      }

      tag.textContent = nameOf(id);

      /* The one simulating carries a mark, because when it
         changes hands mid-run the player wants to know it was
         handed over rather than that something broke. */
      if (mp.hostId === id) {
        tag.classList.add("is-host");
        tag.title = "Running the match";
      }

      playersStrip.appendChild(tag);
    });
  }

  /* A one line note across the top of the board for things the
     player did not do and needs to know about. */
  function setStatusLine(text) {
    if (!netNote) {
      return;
    }

    netNote.textContent = text || "";
    netNote.hidden = !text;

    if (text) {
      window.clearTimeout(netNoteTimer);
      netNoteTimer = window.setTimeout(function () {
        netNote.hidden = true;
      }, 4000);
    }
  }

  /* =========================================================
     Receiving
     ========================================================= */

  function applySnapshot(data) {
    setSpeed(data.speed || 1);
    towers = unpackTowers(data.towers);
    enemies = unpackEnemies(data.enemies);
    allies = unpackAllies(data.allies);
    wave = data.wave;
    wavesSurvived = data.survived;
    baseHp = data.baseHp;
    waveActive = data.active;
    breakLeft = data.breakLeft;
    mp.wallets = data.wallets || {};
    timestop = data.timestop || timestop;
    elapsed = data.elapsed || elapsed;
    cash = wallet(me());

    refreshHud();
    draw();
  }

  function applyTick(data) {
    /* The board runs at the host's speed, so a guest adopts it
       rather than keeping its own. */
    setSpeed(data.speed || 1);

    enemies = unpackEnemies(data.enemies);
    allies = unpackAllies(data.allies);
    baseHp = data.baseHp;
    wave = data.wave;
    wavesSurvived = data.survived;
    waveActive = data.active;
    breakLeft = data.breakLeft;
    timestop = data.timestop || timestop;
    mp.wallets = data.wallets || mp.wallets;
    cash = wallet(me());

  }

  /* A guest asking for something. Everything a guest can do is
     something the host performs on their behalf, so the rules —
     can they afford it, is the tile free, is it their tower —
     are checked in one place rather than five browsers. */
  function handleInput(data) {
    if (!mp.host || !data || !data.who) {
      return;
    }

    if (data.a === "hello") {
      sendSnapshot();
      return;
    }

    if (data.a === "place") {
      hostPlace(data);
      return;
    }

    if (data.a === "sell") {
      hostSell(data.at, data.who);
      return;
    }

    if (data.a === "move") {
      hostMove(data.from, data.to, data.who);
      return;
    }

    if (data.a === "wave") {
      startWave();
      return;
    }

    if (data.a === "timestop") {
      useTimestop();
    }
  }

  function connect(runId, asHost) {
    mp.on = true;
    mp.host = Boolean(asHost);
    mp.runId = runId;
    mp.wallets = {};
    mp.lastTick = 0;
    mp.lastSnapshot = 0;
    mp.peers = {};
    mp.lastPeerPing = 0;
    mp.hostId = asHost ? me() : null;
    mp.names = {};
    lastRoster = "";

    /* Names come from the party, since the channel only ever
       carries ids. Read once at the start — someone who leaves
       the party mid-run keeps their name on the strip, which is
       what you want: they are still in the run. */
    if (window.MRTD.party) {
      window.MRTD.party().members.forEach(function (member) {
        mp.names[member.id] = member.username;
      });
    }
    /* A guest starts the clock now rather than at zero, so the
       election cannot fire before the first tick has had a chance
       to arrive. */
    mp.heardHost = asHost ? 0 : window.performance.now();

    window.MRTD.net.on("s", function (data) {
      mp.heardHost = window.performance.now();

      if (!mp.host) {
        applySnapshot(data);
      }
    });

    window.MRTD.net.on("t", function (data) {
      mp.heardHost = window.performance.now();

      if (!mp.host) {
        applyTick(data);
      }
    });

    window.MRTD.net.on("b", function (data) {
      if (!mp.host) {
        towers = unpackTowers(data.towers);
        mp.wallets = data.wallets || mp.wallets;
        cash = wallet(me());
        refreshHud();
        draw();
      }
    });

    window.MRTD.net.on("i", handleInput);

    window.MRTD.net.on("p", function (data) {
      if (!data || !data.who) {
        return;
      }

      mp.peers[data.who] = window.performance.now();

      if (data.host) {
        mp.hostId = data.who;
      }
    });

    /* Somebody else got there first. Two hosts is worse than
       none, so a client that had promoted itself stands down the
       moment it hears another claim — and by id order that can
       only be someone with a better claim than mine. */
    window.MRTD.net.on("h", function (data) {
      if (!data || !data.who || data.who === me()) {
        return;
      }

      if (mp.host && data.who < me()) {
        mp.host = false;
        setStatusLine("Someone else is running the match");
      }

      mp.hostId = data.who;
      mp.heardHost = window.performance.now();

      if (!mp.host) {
        setStatusLine(nameOf(data.who) + " is running the match now");
      }
    });

    /* Somebody leaving on purpose. The name comes off the strip
       straight away rather than after the stale timeout.

       If it was the host, backdating when it was last heard
       makes the election fire on the very next frame instead of
       after the silence timeout. Only if it was the host — doing
       it for anyone would start an election every time a player
       stepped out of a perfectly healthy run. */
    window.MRTD.net.on("g", function (data) {
      if (!data || !data.who || data.who === me()) {
        return;
      }

      delete mp.peers[data.who];
      setStatusLine(nameOf(data.who) + " stepped out");

      if (data.host || data.who === mp.hostId) {
        mp.heardHost = window.performance.now() - HOST_GONE_MS;
      }
    });

    /* The host answering a newcomer is the same message a guest
       sends on joining, so a rejoin needs no separate path. */
    window.MRTD.net.on("_open", function () {
      if (!mp.host) {
        ask("hello", {});
      }
    });

    window.MRTD.net.connect("run:" + runId);
  }

  function disconnect() {
    if (!mp.on) {
      return;
    }

    /* Anyone on the way out says so, rather than leaving the
       others to notice six seconds of silence before the name
       drops off the strip. Going quiet works too — that path
       exists for crashes — but there is no reason to be vague
       when the person leaving knows they are leaving. */
    window.MRTD.net.send("g", { who: me(), host: mp.host });

    ["s", "t", "b", "i", "p", "h", "g", "_open"].forEach(function (event) {
      window.MRTD.net.off(event);
    });

    window.MRTD.net.disconnect();
    mp.on = false;
    mp.host = false;
    mp.runId = null;
  }

  window.MRTD = window.MRTD || {};
  window.MRTD.matchIsMultiplayer = multiplayer;

  /* Is the board up. Asked by the party panel before it pulls
     anyone into a run, so a player already in one is never
     dragged into it a second time. */
  window.MRTD.matchOpen = function () {
    return !root.hidden;
  };

  /* Taken into the run without pressing anything. The leader
     starting is the decision; everyone else agreed to that when
     they joined the party, and making them press Play as well
     only means the run starts four separate times. */
  window.MRTD.enterRun = function (runId, asHost) {
    if (!root.hidden) {
      return;
    }

    connect(runId, asHost);
    window.MRTD.load("Joining the match", 1200, open);
  };

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
    /* A party run can be stepped out of while it is still going.
       A solo one cannot, or a losing run could be abandoned and
       banked as though it had been survived. */
    if (baseHp > 0 && !mp.on) {
      return;
    }

    running = false;
    gameover.hidden = true;
    root.hidden = true;
  }

  /* Play means one of three things, and which one is decided by
     what the party says rather than by a separate button:

       nothing going on   a solo run, as always
       leader, in a party start it for everyone
       already in a run   go back to the one you left

     A guest whose leader has not started yet has nothing to press
     — the run does not exist, so there is nothing to join. Their
     Play button becomes the wait. */
  function beginPlay() {
    var party = window.MRTD.party ? window.MRTD.party() : null;
    var wait = 2000 + Math.floor(Math.random() * 3000);

    /* Somewhere to go back to takes priority over starting
       anything new — the database refuses a second run anyway,
       and this makes Play do the thing that will work. */
    if (party && party.runId && !party.runPresent) {
      window.MRTD.rejoinRun().then(function (runId) {
        connect(runId, false);
        window.MRTD.load("Rejoining", wait, open);
      }).catch(function () {
        window.MRTD.load("Preparing the field", wait, open);
      });
      return;
    }

    if (party && party.runId && party.runPresent) {
      connect(party.runId, party.isLeader);
      window.MRTD.load("Preparing the field", wait, open);
      return;
    }

    if (party && party.id && party.members.length > 1 && party.isLeader) {
      window.MRTD.startParty().then(function (started) {
        connect(started.runId, true);
        window.MRTD.load("Preparing the field", wait, open);
      }).catch(function (error) {
        window.MRTD.partyProblem(error.message);
      });
      return;
    }

    window.MRTD.load("Preparing the field", wait, open);
  }

  if (playButton) {
    playButton.addEventListener("click", beginPlay);
  }

  /* The lobby is re-entered through a full reload, so a player
     coming out of a match always picks up whatever has been
     deployed since they started it — but never before the coins
     have finished banking. */
  function leave() {
    /* Walking out of a party run mid-game is a leave, not an end.
       The seat stays claimed and the towers stay standing, so
       there is something to come back to — and no reward, since
       leave_run marks this player absent and end_party_run only
       pays the ones still here.

       Not sent when the base has already fallen: the run is over
       and end_party_run has closed it. */
    if (mp.on && baseHp > 0 && window.MRTD.leaveRun) {
      window.MRTD.leaveRun();
    }

    disconnect();
    close();
    window.MRTD.load("Returning to lobby", 1400, function () {
      Promise.resolve(banking).then(function () {
        window.location.reload();
      });
    });
  }

  exitButton.addEventListener("click", leave);
  gameoverLeave.addEventListener("click", leave);
  /* A guest asks the host to start; the host starts. Wave
     timing is one thing for the whole board, so it cannot be
     five browsers each deciding. */
  startButton.addEventListener("click", function () {
    if (mp.on && !mp.host) {
      ask("wave", {});
      return;
    }

    startWave();
  });

  /* Skipping starts the next wave while stragglers are still on
     the path, and pays out as it goes. */
  skipButton.addEventListener("click", function () {
    if (mp.on && !mp.host) {
      ask("wave", {});
      return;
    }

    beginNextWave();
  });

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

  function setGraphics(low) {
    lowGraphics = Boolean(low);
    graphicsButton.textContent = "Graphics: " + (lowGraphics ? "low" : "full");
    graphicsButton.classList.toggle("is-on", lowGraphics);

    /* Anything already in flight goes now rather than finishing. */
    if (lowGraphics) {
      shots = [];
      projectiles = [];
      particles = [];
    }

    try {
      localStorage.setItem(LOW_KEY, lowGraphics ? "1" : "0");
    } catch (error) {
      /* Storage refused; the toggle still works for this session. */
    }
  }

  graphicsButton.addEventListener("click", function () {
    setGraphics(!lowGraphics);
  });

  /* Developer only: drop straight into any wave. Everything on
     the path is cleared first so the new wave arrives on its own
     rather than mixed with the old one. */
  var MAX_JUMP = 5000;

  function jumpToWave(target) {
    if (!isDev()) {
      return;
    }

    var n = Math.floor(Number(target));

    if (!n || n < 1) {
      return;
    }

    n = Math.min(n, MAX_JUMP);

    enemies = [];
    allies = [];
    spawnQueue = [];
    shots = [];
    projectiles = [];
    particles = [];
    waveActive = false;
    breakLeft = 0;
    wave = n - 1;
    wavesSurvived = Math.max(wavesSurvived, n - 1);

    startWave();
    refreshHud();
    draw();
  }

  jumpButton.addEventListener("click", function () {
    jumpToWave(jumpInput.value);
  });

  jumpInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToWave(jumpInput.value);
    }
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

  function restoreGraphics() {
    try {
      setGraphics(localStorage.getItem(LOW_KEY) === "1");
    } catch (error) {
      setGraphics(false);
    }
  }

  buildHotbar();
  setAuto(false);
  restoreGraphics();
  loadSprites();
})();
