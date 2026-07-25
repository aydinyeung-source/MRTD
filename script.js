(function () {
  "use strict";

  /* =========================================================
     Config — paste your Supabase project values here.
     Both are safe to ship in client code. Never put the
     service_role key in this file.
     ========================================================= */

  var SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
  var SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";

  /* Single source of truth for the build number — bump it here. */
  var VERSION = "1.0.0";

  var STORAGE_KEY = "mrtd.session";

  /* =========================================================
     Elements
     ========================================================= */

  var auth = document.getElementById("auth");
  var app = document.getElementById("app");
  var form = document.getElementById("auth-form");
  var modeLabel = document.getElementById("auth-mode");
  var emailInput = document.getElementById("auth-email");
  var passwordInput = document.getElementById("auth-password");
  var submitButton = document.getElementById("auth-submit");
  var toggleButton = document.getElementById("auth-toggle");
  var message = document.getElementById("auth-message");
  var signOutButton = document.getElementById("signout");
  var version = document.getElementById("version");

  var tabs = document.querySelectorAll(".nav__tab");
  var screens = document.querySelectorAll(".screen");

  var isSignUp = false;

  version.textContent = "v" + VERSION;

  /* =========================================================
     Supabase Auth — plain REST, no SDK
     ========================================================= */

  function authPost(path, body) {
    return fetch(SUPABASE_URL + "/auth/v1/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify(body)
    }).then(readResponse);
  }

  function readResponse(response) {
    return response.json().then(function (data) {
      if (!response.ok) {
        throw new Error(
          data.msg || data.error_description || data.message || "Request failed"
        );
      }
      return data;
    });
  }

  function signUp(email, password) {
    return authPost("signup", { email: email, password: password });
  }

  function logIn(email, password) {
    return authPost("token?grant_type=password", {
      email: email,
      password: password
    });
  }

  function refresh(token) {
    return authPost("token?grant_type=refresh_token", { refresh_token: token });
  }

  function getUser(accessToken) {
    return fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + accessToken
      }
    }).then(readResponse);
  }

  /* =========================================================
     Session storage
     ========================================================= */

  function saveSession(session) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (error) {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  /* =========================================================
     Gate
     ========================================================= */

  function unlock() {
    auth.hidden = true;
    app.hidden = false;
  }

  function lock() {
    auth.hidden = false;
    app.hidden = true;
  }

  /* Restore a stored session on load; refresh it if the access
     token has expired, and fall back to the login screen. */
  function restoreSession() {
    var session = loadSession();

    if (!session || !session.access_token) {
      lock();
      return;
    }

    getUser(session.access_token)
      .then(unlock)
      .catch(function () {
        return refresh(session.refresh_token).then(function (renewed) {
          saveSession(renewed);
          unlock();
        });
      })
      .catch(function () {
        clearSession();
        lock();
      });
  }

  /* =========================================================
     Auth form
     ========================================================= */

  function setMode(signUpMode) {
    isSignUp = signUpMode;
    modeLabel.textContent = isSignUp ? "Sign up" : "Log in";
    submitButton.textContent = isSignUp ? "Sign up" : "Log in";
    toggleButton.textContent = isSignUp
      ? "Already have an account? Log in"
      : "Need an account? Sign up";
    passwordInput.autocomplete = isSignUp ? "new-password" : "current-password";
    setMessage("");
  }

  function setMessage(text, isError) {
    message.textContent = text;
    message.classList.toggle("is-error", Boolean(isError));
  }

  function setBusy(busy) {
    submitButton.disabled = busy;
    toggleButton.disabled = busy;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var email = emailInput.value.trim();
    var password = passwordInput.value;

    if (!email || !password) {
      setMessage("Enter an email and password.", true);
      return;
    }

    setBusy(true);
    setMessage(isSignUp ? "Creating account..." : "Logging in...");

    var request = isSignUp ? signUp(email, password) : logIn(email, password);

    request
      .then(function (data) {
        /* With email confirmation on, signup returns a user but no
           tokens — the account is not usable until it is confirmed. */
        if (!data.access_token) {
          setMessage("Check your email to confirm your account.");
          return;
        }

        saveSession(data);
        form.reset();
        setMessage("");
        unlock();
      })
      .catch(function (error) {
        setMessage(error.message, true);
      })
      .then(function () {
        setBusy(false);
      });
  });

  toggleButton.addEventListener("click", function () {
    setMode(!isSignUp);
  });

  signOutButton.addEventListener("click", function () {
    var session = loadSession();

    /* Revoke server-side, but drop the local session either way. */
    if (session && session.access_token) {
      fetch(SUPABASE_URL + "/auth/v1/logout", {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: "Bearer " + session.access_token
        }
      }).catch(function () {});
    }

    clearSession();
    form.reset();
    setMode(false);
    lock();
  });

  /* =========================================================
     Tabs
     ========================================================= */

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

  /* =========================================================
     Start
     ========================================================= */

  setMode(false);
  restoreSession();
})();
