(function () {
  "use strict";

  /* =========================================================
     Config — paste your Supabase project values here.
     Both are safe to ship in client code. Never put the
     service_role key in this file.
     ========================================================= */

  var SUPABASE_URL = "https://excleibqafwphvuwvaua.supabase.co";
  var SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4Y2xlaWJxYWZ3cGh2dXd2YXVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5OTE4NzYsImV4cCI6MjEwMDU2Nzg3Nn0.7Fq9TnkkfjYL6PIph5oYM8LopUmxbFoVozIRfyoINtI";

  /* Supabase accounts need an email address, but players sign in with
     a username only. The username is mapped to an internal address that
     is never shown and never receives mail. */
  var USERNAME_DOMAIN = "mrtd.local";

  /* Single source of truth for the build number — bump it here. */
  var VERSION = "1.0.0";

  var STORAGE_KEY = "mrtd.session";
  var DEVICE_KEY = "mrtd.device";
  var USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

  /* How often a signed in device checks it is still the current
     one, in milliseconds. */
  var SESSION_CHECK_MS = 20000;

  var sessionWatch = null;

  /* =========================================================
     Elements
     ========================================================= */

  var auth = document.getElementById("auth");
  var app = document.getElementById("app");
  var form = document.getElementById("auth-form");
  var usernameInput = document.getElementById("auth-username");
  var passwordInput = document.getElementById("auth-password");
  var confirmField = document.getElementById("auth-confirm-field");
  var confirmInput = document.getElementById("auth-confirm");
  var loginButton = document.getElementById("auth-login");
  var signupButton = document.getElementById("auth-signup");
  var message = document.getElementById("auth-message");
  var signOutButton = document.getElementById("signout");
  var devButton = document.getElementById("devmode");
  var profileName = document.querySelector(".profile-card__name");
  var version = document.getElementById("version");

  var tabs = document.querySelectorAll(".nav__tab");
  var screens = document.querySelectorAll(".screen");

  /* "login" or "signup". The buttons select the mode on the first
     press and perform it on the second. */
  var mode = "login";

  version.textContent = "v" + VERSION;

  /* =========================================================
     Username <-> internal address
     ========================================================= */

  /* Lowercasing here is what makes usernames case insensitive:
     "Aydin" and "aydin" resolve to the same account. */
  function toEmail(username) {
    return username.toLowerCase() + "@" + USERNAME_DOMAIN;
  }

  /* Display uses the capitalisation the player signed up with, which
     is kept in user metadata. The address is only a fallback. */
  function displayName(user) {
    if (user.user_metadata && user.user_metadata.username) {
      return user.user_metadata.username;
    }

    return user.email ? user.email.split("@")[0] : "";
  }

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

  function signUp(username, password) {
    return authPost("signup", {
      email: toEmail(username),
      password: password,
      data: { username: username }
    });
  }

  function logIn(username, password) {
    return authPost("token?grant_type=password", {
      email: toEmail(username),
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

  /* Supabase speaks in email terms; the player never should. */
  function readableError(error) {
    var text = error.message || "";

    if (/invalid login credentials/i.test(text)) {
      return "Wrong username or password.";
    }
    if (/already registered|already exists/i.test(text)) {
      return "That username is taken.";
    }
    if (/password/i.test(text) && /least|short/i.test(text)) {
      return "Password must be at least 6 characters.";
    }
    return text;
  }

  /* =========================================================
     One device at a time

     Logging in claims the account for this device. Any other
     device notices its token is stale and signs itself out.
     ========================================================= */

  function newDeviceToken() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }

    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var random = (Math.random() * 16) | 0;

      return (c === "x" ? random : (random & 0x3) | 0x8).toString(16);
    });
  }

  function authed(path, options) {
    var session = loadSession();
    var config = options || {};

    if (!session || !session.access_token) {
      return Promise.reject(new Error("Not logged in"));
    }

    return fetch(SUPABASE_URL + path, {
      method: config.method || "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: config.body ? JSON.stringify(config.body) : undefined
    }).then(readResponse);
  }

  function claimDevice() {
    var token = newDeviceToken();

    return authed("/rest/v1/rpc/claim_session", {
      method: "POST",
      body: { new_session: token }
    }).then(function () {
      try {
        localStorage.setItem(DEVICE_KEY, token);
      } catch (error) {
        /* Storage refused; the check below simply will not fire. */
      }

      return token;
    });
  }

  function deviceToken() {
    try {
      return localStorage.getItem(DEVICE_KEY);
    } catch (error) {
      return null;
    }
  }

  /* Signed out because the account was claimed elsewhere. */
  function evict() {
    stopSessionWatch();
    clearSession();
    form.reset();
    setMode("login");
    lock();
    setMessage("Signed out — this account was used on another device.", true);
  }

  function checkDevice() {
    var mine = deviceToken();

    if (!mine) {
      return;
    }

    authed("/rest/v1/player_sessions?select=session_id")
      .then(function (rows) {
        if (rows.length && rows[0].session_id !== mine) {
          evict();
        }
      })
      .catch(function () {
        /* Offline or expired token: leave the player alone. */
      });
  }

  function startSessionWatch() {
    stopSessionWatch();
    sessionWatch = window.setInterval(checkDevice, SESSION_CHECK_MS);
    window.addEventListener("focus", checkDevice);
  }

  function stopSessionWatch() {
    if (sessionWatch) {
      window.clearInterval(sessionWatch);
      sessionWatch = null;
    }

    window.removeEventListener("focus", checkDevice);
  }

  /* =========================================================
     Developer mode

     The button only appears for an account the database has
     flagged. Toggling it on grants unlimited cash, unlimited
     coins and every tower; toggling it off puts everything back.
     ========================================================= */

  var DEV_KEY = "mrtd.dev";
  var devEnabled = false;

  function devOn() {
    try {
      return localStorage.getItem(DEV_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function applyDev(on) {
    devEnabled = Boolean(on);
    window.MRTD.dev = devEnabled;
    devButton.textContent = "Dev mode: " + (devEnabled ? "on" : "off");
    devButton.classList.toggle("is-on", devEnabled);

    try {
      localStorage.setItem(DEV_KEY, devEnabled ? "1" : "0");
    } catch (error) {
      /* Storage refused; the toggle still works for this session. */
    }

    document.dispatchEvent(new CustomEvent("mrtd:dev"));
  }

  /* Only the flagged account ever sees the button. */
  function checkDeveloper() {
    authed("/rest/v1/profiles?select=is_dev")
      .then(function (rows) {
        var allowed = rows.length && rows[0].is_dev;

        devButton.hidden = !allowed;

        if (allowed) {
          applyDev(devOn());
        } else {
          applyDev(false);
        }
      })
      .catch(function () {
        devButton.hidden = true;
      });
  }

  devButton.addEventListener("click", function () {
    applyDev(!devEnabled);
  });

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

  function unlock(user) {
    if (user) {
      profileName.textContent = displayName(user);
    }

    auth.hidden = true;
    app.hidden = false;

    document.dispatchEvent(new CustomEvent("mrtd:unlocked"));
    checkDeveloper();
  }

  function lock() {
    auth.hidden = false;
    app.hidden = true;

    document.dispatchEvent(new CustomEvent("mrtd:locked"));
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
          unlock(renewed.user);
        });
      })
      .then(function () {
        /* Returning to a tab that was kicked while it was closed. */
        checkDevice();
        startSessionWatch();
      })
      .catch(function () {
        clearSession();
        lock();
      });
  }

  /* =========================================================
     Auth form
     ========================================================= */

  function setMessage(text, isError) {
    message.textContent = text;
    message.classList.toggle("is-error", Boolean(isError));
  }

  function setBusy(busy) {
    loginButton.disabled = busy;
    signupButton.disabled = busy;
  }

  function setMode(next) {
    mode = next;

    confirmField.hidden = next !== "signup";
    loginButton.classList.toggle("is-primary", next === "login");
    signupButton.classList.toggle("is-primary", next === "signup");
    passwordInput.autocomplete =
      next === "signup" ? "new-password" : "current-password";

    if (next !== "signup") {
      confirmInput.value = "";
    }

    setMessage("");
  }

  /* First press selects the mode, second press performs it. */
  function press(target) {
    if (mode !== target) {
      setMode(target);
      return;
    }

    submit(target === "signup");
  }

  function submit(isSignUp) {
    var username = usernameInput.value.trim();
    var password = passwordInput.value;

    if (!USERNAME_PATTERN.test(username)) {
      setMessage("Usernames are 3-20 letters, numbers or underscores.", true);
      return;
    }

    if (!password) {
      setMessage("Enter a password.", true);
      return;
    }

    if (isSignUp && password !== confirmInput.value) {
      setMessage("Passwords do not match.", true);
      return;
    }

    setBusy(true);
    setMessage(isSignUp ? "Creating account..." : "Logging in...");

    var request = isSignUp
      ? signUp(username, password)
      : logIn(username, password);

    request
      .then(function (data) {
        /* With email confirmation on, signup returns a user but no
           tokens. There is no inbox to confirm from, so it must be
           switched off in the Supabase dashboard. */
        if (!data.access_token) {
          setMessage(
            "Account created, but confirmation is required. " +
              "Turn off email confirmation in Supabase.",
            true
          );
          return;
        }

        saveSession(data);
        form.reset();
        setMode("login");
        unlock(data.user);

        /* Claiming last means any other device is kicked only once
           this one is actually in. */
        claimDevice()
          .then(startSessionWatch)
          .catch(function () {
            /* Not fatal: the player is signed in either way. */
          });
      })
      .catch(function (error) {
        setMessage(readableError(error), true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  /* Enter performs whichever mode is currently selected. */
  form.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    submit(mode === "signup");
  });

  loginButton.addEventListener("click", function () {
    press("login");
  });

  signupButton.addEventListener("click", function () {
    press("signup");
  });

  signOutButton.addEventListener("click", function () {
    var session = loadSession();

    stopSessionWatch();

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
    setMode("login");
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

  /* The only surface other scripts use: config plus the current
     session. Merged, not assigned — stats.js shares this object. */
  window.MRTD = window.MRTD || {};
  window.MRTD.url = SUPABASE_URL;
  window.MRTD.key = SUPABASE_ANON_KEY;
  window.MRTD.session = loadSession;

  setMode("login");
  restoreSession();
})();
