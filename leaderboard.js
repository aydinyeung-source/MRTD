(function () {
  "use strict";

  /* =========================================================
     Leaderboards.

     Three views:

       Weekly   the top 50 runs of this week, and the only way
                to earn an Obelisk
       Friends  your list, by level or by best wave
       Global   everybody, same two orderings

     The week settles itself. Opening this panel asks the
     database to pay out last week if it has not been paid
     already, which means no scheduled job and no dependency on
     anybody's machine being awake at midnight on Sunday. The
     database decides whether it is owed; this only asks.
     ========================================================= */

  var panel = document.getElementById("leaders");
  var openButton = document.getElementById("leaders-open");
  var closeButton = document.getElementById("leaders-close");
  var listHost = document.getElementById("leaders-list");
  var status = document.getElementById("leaders-status");
  var resetLine = document.getElementById("leaders-reset");
  var scopeButtons = document.querySelectorAll("[data-scope]");
  var sortRow = document.getElementById("leaders-sort");
  var sortButtons = document.querySelectorAll("[data-sort]");

  if (!panel) {
    return;
  }

  var scope = "weekly";
  var sort = "wave";

  /* =========================================================
     Supabase
     ========================================================= */

  function api(path, options) {
    var session = window.MRTD.session();
    var config = options || {};

    if (!session || !session.access_token) {
      return Promise.reject(new Error("Not logged in."));
    }

    return fetch(window.MRTD.url + path, {
      method: config.method || "GET",
      headers: {
        apikey: window.MRTD.key,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: config.body ? JSON.stringify(config.body) : undefined
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          throw new Error(data.message || data.msg || "Request failed");
        }
        return data;
      });
    });
  }

  function rpc(name, body) {
    return api("/rest/v1/rpc/" + name, { method: "POST", body: body || {} });
  }

  /* =========================================================
     Formatting
     ========================================================= */

  function element(tag, className, text) {
    var node = document.createElement(tag);

    node.className = className || "";

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  }

  /* Game time, which is not wall clock time — a run at 10x took
     a tenth as long to sit through. Shown as the game measures
     it, because that is what the board ranks. */
  function clock(seconds) {
    var total = Math.max(0, Math.round(seconds || 0));
    var minutes = Math.floor(total / 60);
    var rest = total % 60;

    if (minutes < 60) {
      return minutes + ":" + (rest < 10 ? "0" : "") + rest;
    }

    var hours = Math.floor(minutes / 60);

    return hours + "h " + (minutes % 60) + "m";
  }

  /* How long until the Obelisks go out. Weeks start Monday, the
     same boundary date_trunc uses in Postgres. */
  function untilReset() {
    var now = new Date();
    var day = (now.getUTCDay() + 6) % 7;
    var next = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - day + 7
    );
    var left = Math.max(0, next - now.getTime());
    var days = Math.floor(left / 86400000);
    var hours = Math.floor((left % 86400000) / 3600000);

    return days + "d " + hours + "h";
  }

  /* =========================================================
     Rendering
     ========================================================= */

  function row(place, name, right, mine) {
    var line = element("div", "leaders__row");

    if (mine) {
      line.classList.add("is-me");
    }

    /* The top three carry it in the number itself, since that is
       where the Obelisks are actually worth something. */
    if (place <= 3) {
      line.classList.add("is-podium");
    }

    line.appendChild(element("span", "leaders__place", "#" + place));
    line.appendChild(element("span", "leaders__name", name));
    line.appendChild(element("span", "leaders__score", right));

    return line;
  }

  function renderWeekly(rows) {
    listHost.textContent = "";

    if (!rows.length) {
      listHost.appendChild(
        element("p", "leaders__empty", "No runs yet this week. Be first.")
      );
      return;
    }

    rows.forEach(function (entry) {
      listHost.appendChild(
        row(
          entry.place,
          entry.username,
          "wave " + entry.wave + "  ·  " + clock(entry.seconds),
          entry.is_me
        )
      );
    });
  }

  function renderAll(rows) {
    listHost.textContent = "";

    if (!rows.length) {
      listHost.appendChild(
        element(
          "p",
          "leaders__empty",
          scope === "friends"
            ? "Nobody on your list has finished a run yet."
            : "No runs recorded yet."
        )
      );
      return;
    }

    rows.forEach(function (entry) {
      listHost.appendChild(
        row(
          entry.place,
          entry.username,
          sort === "level"
            ? "level " + entry.level + "  ·  " + entry.xp + " xp"
            : "wave " + entry.wave + "  ·  " + clock(entry.seconds),
          entry.is_me
        )
      );
    });
  }

  function markButtons() {
    Array.prototype.forEach.call(scopeButtons, function (button) {
      button.classList.toggle("is-on", button.dataset.scope === scope);
    });

    Array.prototype.forEach.call(sortButtons, function (button) {
      button.classList.toggle("is-on", button.dataset.sort === sort);
    });

    /* Sorting only means something on the all-time boards. The
       weekly one is ranked by the run, and a run has no level. */
    sortRow.hidden = scope === "weekly";
    resetLine.hidden = scope !== "weekly";
  }

  function load() {
    markButtons();
    status.textContent = "";
    resetLine.textContent = "Obelisks handed out in " + untilReset();

    var asking = scope === "weekly"
      ? rpc("board_weekly").then(renderWeekly)
      : rpc("board_all", {
          p_sort: sort,
          p_friends: scope === "friends"
        }).then(renderAll);

    return asking.catch(function (error) {
      status.textContent = error.message;
    });
  }

  /* =========================================================
     Panel
     ========================================================= */

  Array.prototype.forEach.call(scopeButtons, function (button) {
    button.addEventListener("click", function () {
      scope = button.dataset.scope;
      load();
    });
  });

  Array.prototype.forEach.call(sortButtons, function (button) {
    button.addEventListener("click", function () {
      sort = button.dataset.sort;
      load();
    });
  });

  openButton.addEventListener("click", function () {
    panel.hidden = false;
    listHost.textContent = "";
    status.textContent = "Loading...";

    /* Asked before reading, so a board opened in a new week shows
       the new week AND has already paid out the old one. The
       database ignores it if the week is already settled, so
       calling it on every open costs one cheap query. */
    rpc("settle_week")
      .catch(function () {
        /* An unsettled week is not a reason to refuse to show a
           board. It will settle on somebody else's open. */
      })
      .then(load);
  });

  closeButton.addEventListener("click", function () {
    panel.hidden = true;
  });

  panel.addEventListener("click", function (event) {
    if (event.target === panel) {
      panel.hidden = true;
    }
  });

  document.addEventListener("mrtd:locked", function () {
    panel.hidden = true;
    listHost.textContent = "";
  });

  window.MRTD = window.MRTD || {};

  /* Filed by the match when a run ends. Fire and forget — a run
     that banked its coins should not be held up by its score. */
  window.MRTD.recordRun = function (wave, seconds) {
    if (!wave || wave < 1) {
      return Promise.resolve();
    }

    return rpc("record_run", {
      p_wave: Math.round(wave),
      p_seconds: Math.round(seconds || 0)
    }).catch(function (error) {
      if (window.console) {
        window.console.error("MRTD: record_run failed", error.message);
      }
    });
  };
})();
