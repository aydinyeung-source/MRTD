(function () {
  "use strict";

  /* =========================================================
     Tower artwork — the plan views.

     Every tower is drawn from above, procedurally, and every one
     of these changes with the merge level: one more blade, one
     more barrel, a longer spire. That is the whole reason they
     are drawn rather than loaded — a merge has to be visible
     without reading the number in the corner.

     Split out of match.js because it is the one large part of it
     that touches almost nothing else. These functions take a
     context and some numbers and draw; they know nothing about
     the board, the enemies, or whose tower it is.

     `ctx` is module scoped and set by draw() on every call, so
     the functions below read the same way they did when they
     lived beside the canvas.
     ========================================================= */

  var ctx = null;

  /* Body and accent colour, and which plan to draw. */
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
    mint: { body: "#d9c26a", accent: "#7a6a2f", plan: "field" },
    obelisk: { body: "#1c1a24", accent: "#d9c26a", plan: "spire" },
    medic: { body: "#f2f4f3", accent: "#c9464a", plan: "cross" },
    clocktower: { body: "#2a2436", accent: "#e0c063", plan: "clock" },
    icecannon: { body: "#5b7f9c", accent: "#cfeaf7", plan: "frost" }
  };

  /* Rounded rectangles, with a fallback for browsers without
     roundRect. */
  function roundedPath(x, y, width, height, radius) {
    ctx.beginPath();

    if (ctx.roundRect) {
      ctx.roundRect(x, y, width, height, radius);
      return;
    }

    ctx.rect(x, y, width, height);
  }

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

  /* Medic: a cross, with a ring that thickens as it merges. The
     only white tower on the board, which is most of what makes
     it findable when everything around it has been stunned. */
  function planCross(token, radius, level) {
    var arm = radius * 0.34;
    var reach = radius * (0.72 + level * 0.025);

    ctx.strokeStyle = token.accent;
    ctx.lineWidth = Math.max(1, radius * (0.06 + level * 0.008));

    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.1, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = token.accent;
    ctx.fillRect(-arm / 2, -reach, arm, reach * 2);
    ctx.fillRect(-reach, -arm / 2, reach * 2, arm);
  }

  /* Obelisk: a tapered spire with a band for every couple of
     merges. Nothing moves — it is a monument, and the one tower
     on the board that had to be won rather than bought. */
  function planSpire(token, radius, level) {
    var bands = 1 + Math.floor(level / 2);

    ctx.fillStyle = token.accent;
    ctx.beginPath();
    ctx.moveTo(0, -radius * 1.25);
    ctx.lineTo(radius * 0.38, radius * 0.7);
    ctx.lineTo(-radius * 0.38, radius * 0.7);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = token.body;
    ctx.lineWidth = Math.max(1, radius * 0.07);

    for (var i = 1; i <= bands; i += 1) {
      var y = -radius * 1.25 + (i / (bands + 1)) * radius * 1.95;
      var half = radius * 0.38 * ((y + radius * 1.25) / (radius * 1.95));

      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
    }
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
    clock: planClock,
    cross: planCross,
    spire: planSpire
  };

  window.MRTD = window.MRTD || {};

  window.MRTD.art = {
    tokens: TOKENS,

    /* Draws one plan view at the origin. The caller has already
       translated and rotated; this only fills shapes. */
    draw: function (target, plan, token, radius, level, spin) {
      var fn = PLANS[plan];

      if (!fn) {
        return false;
      }

      ctx = target;
      fn(token, radius, level, spin || 0);
      return true;
    }
  };
})();
