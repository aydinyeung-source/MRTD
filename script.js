(function () {
  "use strict";

  /* Single source of truth for the build number — bump it here. */
  var VERSION = "1.0.0";

  var tabs = document.querySelectorAll(".nav__tab");
  var screens = document.querySelectorAll(".screen");
  var version = document.getElementById("version");

  version.textContent = "v" + VERSION;

  /* Re-trigger the CSS entrance animation on an element that is already
     in the DOM: drop the class, force a reflow, put it back. */
  function replayEntrance(screen) {
    screen.classList.remove("is-active");
    void screen.offsetWidth;
    screen.classList.add("is-active");
  }

  function showTab(name) {
    tabs.forEach(function (tab) {
      tab.classList.toggle("is-active", tab.dataset.tab === name);
    });

    screens.forEach(function (screen) {
      if (screen.dataset.screen === name) {
        replayEntrance(screen);
      } else {
        screen.classList.remove("is-active");
      }
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      showTab(tab.dataset.tab);
    });
  });
})();
