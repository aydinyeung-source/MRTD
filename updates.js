(function () {
  "use strict";

  /* =========================================================
     Update log.

     Entries are added only when an update is worth telling
     players about — not on every version bump. Newest first.

     To add one, put an object at the TOP of the list:

       { version: "1.30.0", date: "2026-08-01", title: "...",
         notes: ["...", "..."] }
     ========================================================= */

  var UPDATES = [];

  var panel = document.getElementById("updates");

  if (!panel) {
    return;
  }

  var openButton = document.getElementById("updates-open");
  var closeButton = document.getElementById("updates-close");
  var host = document.getElementById("updates-list");

  function render() {
    host.textContent = "";

    if (!UPDATES.length) {
      var empty = document.createElement("p");

      empty.className = "friends__empty";
      empty.textContent = "Nothing logged yet.";
      host.appendChild(empty);
      return;
    }

    UPDATES.forEach(function (entry) {
      var section = document.createElement("section");

      section.className = "handbook__section";

      var heading = document.createElement("h3");
      heading.textContent = entry.title;
      section.appendChild(heading);

      var stamp = document.createElement("p");
      stamp.className = "updates__stamp";
      stamp.textContent = "v" + entry.version + " · " + entry.date;
      section.appendChild(stamp);

      entry.notes.forEach(function (note) {
        var line = document.createElement("p");

        line.textContent = note;
        section.appendChild(line);
      });

      host.appendChild(section);
    });
  }

  openButton.addEventListener("click", function () {
    panel.hidden = false;
  });

  closeButton.addEventListener("click", function () {
    panel.hidden = true;
  });

  panel.addEventListener("click", function (event) {
    if (event.target === panel) {
      panel.hidden = true;
    }
  });

  render();
})();
