(function () {
  "use strict";

  /* =========================================================
     Friends and live trading.

     Friendships are plain table rows — the policies already
     restrict them to the two people involved.

     A trade is a session both players edit at once: request,
     accept, put cards in and take them out freely, both lock,
     then a five second hold before it settles. Any edit clears
     both locks, so the deal cannot change after someone agrees
     to it.
     ========================================================= */

  var HOLD_SECONDS = 5;
  var POLL_MS = 1500;

  var panel = document.getElementById("friends");

  if (!panel) {
    return;
  }

  var openButton = document.getElementById("friends-open");
  var closeButton = document.getElementById("friends-close");
  var searchInput = document.getElementById("friends-search");
  var addButton = document.getElementById("friends-add");
  var listHost = document.getElementById("friends-list");
  var tradeHost = document.getElementById("friends-trades");
  var status = document.getElementById("friends-status");

  var popup = document.getElementById("traderequest");
  var popupText = document.getElementById("traderequest-text");
  var popupActions = document.getElementById("traderequest-actions");

  var windowEl = document.getElementById("tradewindow");
  var whoLabel = document.getElementById("trade-who");
  var mineHost = document.getElementById("trade-mine");
  var theirsHost = document.getElementById("trade-theirs");
  var mineLock = document.getElementById("trade-mine-lock");
  var theirsLock = document.getElementById("trade-theirs-lock");
  var towerSelect = document.getElementById("trade-tower");
  var countInput = document.getElementById("trade-count");
  var putButton = document.getElementById("trade-put");
  var lockButton = document.getElementById("trade-lock");
  var cancelButton = document.getElementById("trade-cancel");
  var tradeStatus = document.getElementById("trade-status");

  var names = {};
  var panelPoll = null;
  var watchPoll = null;

  /* The trade currently on screen. */
  var active = null;
  var invited = null;

  /* =========================================================
     Plumbing
     ========================================================= */

  function api(path, options) {
    var session = window.MRTD.session();
    var config = options || {};

    if (!session || !session.access_token) {
      return Promise.reject(new Error("Not logged in"));
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
      if (response.status === 204) {
        return null;
      }

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

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  function me() {
    return window.MRTD.userId();
  }

  function label(name) {
    var tower = window.MRTD.stats.towers[name];

    return tower ? tower.label : name;
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);

    node.className = className || "";

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  }

  function button(text, handler) {
    var node = element("button", "friends__button", text);

    node.type = "button";
    node.addEventListener("click", handler);

    return node;
  }

  function learnNames() {
    return api("/rest/v1/profiles?select=id,username").then(function (rows) {
      rows.forEach(function (row) {
        names[row.id] = row.username;
      });
    });
  }

  /* =========================================================
     Friends
     ========================================================= */

  function addFriend() {
    var wanted = searchInput.value.trim();

    if (!wanted) {
      return;
    }

    setStatus("Looking...");

    api(
      "/rest/v1/profiles?select=id,username&username=ilike." +
        encodeURIComponent(wanted)
    )
      .then(function (rows) {
        if (!rows.length) {
          throw new Error("No player called " + wanted + ".");
        }

        if (rows[0].id === me()) {
          throw new Error("That is you.");
        }

        return api("/rest/v1/friendships", {
          method: "POST",
          body: { requester_id: me(), addressee_id: rows[0].id }
        }).then(function () {
          setStatus("Request sent to " + rows[0].username + ".");
          searchInput.value = "";
          return refresh();
        });
      })
      .catch(function (error) {
        setStatus(
          /duplicate/i.test(error.message)
            ? "You have already asked them."
            : error.message,
          true
        );
      });
  }

  function respondFriend(requester, accept) {
    var path =
      "/rest/v1/friendships?requester_id=eq." + requester +
      "&addressee_id=eq." + me();

    if (!accept) {
      return api(path, { method: "DELETE" }).then(refresh);
    }

    return api(path, { method: "PATCH", body: { status: "accepted" } })
      .then(refresh);
  }

  function unfriend(other) {
    var mine = me();

    return api(
      "/rest/v1/friendships?or=(and(requester_id.eq." + mine +
        ",addressee_id.eq." + other + "),and(requester_id.eq." + other +
        ",addressee_id.eq." + mine + "))",
      { method: "DELETE" }
    ).then(refresh);
  }

  function renderFriends(rows) {
    var mine = me();

    listHost.textContent = "";

    if (!rows.length) {
      listHost.appendChild(
        element("p", "friends__empty", "Nobody yet. Add someone by username.")
      );
      return;
    }

    rows.forEach(function (row) {
      var other =
        row.requester_id === mine ? row.addressee_id : row.requester_id;
      var line = element("div", "friends__line");
      var incoming = row.status === "pending" && row.addressee_id === mine;

      line.appendChild(element("span", "friends__name", names[other] || "player"));

      if (row.status === "accepted") {
        line.appendChild(element("span", "friends__tag", "friend"));
        line.appendChild(button("Trade", function () {
          startTrade(other);
        }));
        line.appendChild(button("Remove", function () {
          unfriend(other);
        }));
      } else if (incoming) {
        line.appendChild(element("span", "friends__tag", "wants to add you"));
        line.appendChild(button("Accept", function () {
          respondFriend(other, true);
        }));
        line.appendChild(button("Decline", function () {
          respondFriend(other, false);
        }));
      } else {
        line.appendChild(element("span", "friends__tag", "asked"));
        line.appendChild(button("Cancel", function () {
          unfriend(other);
        }));
      }

      listHost.appendChild(line);
    });
  }

  /* =========================================================
     Starting a trade
     ========================================================= */

  function startTrade(other) {
    rpc("request_trade", { p_to: other })
      .then(function () {
        setStatus("Waiting for " + (names[other] || "them") + " to accept...");
      })
      .catch(function (error) {
        setStatus(error.message, true);
      });
  }

  function showInvite(trade) {
    invited = trade.id;

    popupText.textContent =
      "Player " + (names[trade.player_a] || "someone") +
      " requested to trade with you!";

    popupActions.textContent = "";

    var yes = element("button", "traderequest__button", "Yes");
    yes.type = "button";
    yes.addEventListener("click", function () {
      rpc("respond_trade", { p_id: trade.id, p_accept: true })
        .catch(function (error) {
          popupText.textContent = error.message;
        })
        .then(hideInvite);
    });

    var no = element("button", "traderequest__button", "No");
    no.type = "button";
    no.addEventListener("click", function () {
      rpc("respond_trade", { p_id: trade.id, p_accept: false })
        .catch(function () {})
        .then(hideInvite);
    });

    popupActions.appendChild(yes);
    popupActions.appendChild(no);
    popup.hidden = false;
  }

  function hideInvite() {
    popup.hidden = true;
    invited = null;
  }

  /* =========================================================
     The live trade window
     ========================================================= */

  function fillTowerSelect() {
    if (towerSelect.children.length) {
      return;
    }

    Object.keys(window.MRTD.stats.towers).forEach(function (name) {
      var option = document.createElement("option");

      option.value = name;
      option.textContent = window.MRTD.stats.towers[name].label;
      towerSelect.appendChild(option);
    });
  }

  function renderSide(host, items, editable) {
    host.textContent = "";

    if (!items.length) {
      host.appendChild(element("p", "friends__empty", "Nothing yet."));
      return;
    }

    items.forEach(function (item) {
      var line = element("div", "friends__line");

      line.appendChild(
        element("span", "friends__name", item.copies + "× " + label(item.tower_key))
      );

      if (editable) {
        line.appendChild(button("Take back", function () {
          rpc("set_trade_item", {
            p_id: active.id,
            p_tower: item.tower_key,
            p_copies: 0
          }).catch(function (error) {
            tradeStatus.textContent = error.message;
          });
        }));
      }

      host.appendChild(line);
    });
  }

  function renderTrade(trade, items) {
    var mine = me();
    var other = trade.player_a === mine ? trade.player_b : trade.player_a;
    var iAmA = trade.player_a === mine;
    var myLock = iAmA ? trade.a_locked : trade.b_locked;
    var theirLock = iAmA ? trade.b_locked : trade.a_locked;

    whoLabel.textContent = names[other] || "player";

    renderSide(
      mineHost,
      items.filter(function (item) {
        return item.player_id === mine;
      }),
      !myLock
    );

    renderSide(
      theirsHost,
      items.filter(function (item) {
        return item.player_id !== mine;
      }),
      false
    );

    mineLock.textContent = myLock ? "· locked" : "";
    theirsLock.textContent = theirLock ? "· locked" : "";

    lockButton.textContent = myLock ? "Unlock" : "Lock in";
    putButton.disabled = myLock;

    if (trade.status === "locked" && trade.locked_at) {
      var left = Math.max(
        0,
        HOLD_SECONDS -
          Math.floor((Date.now() - new Date(trade.locked_at).getTime()) / 1000)
      );

      tradeStatus.textContent = left
        ? "Both locked — settling in " + left + "s. Unlock to pull out."
        : "Settling...";

      if (!left) {
        rpc("settle_trade", { p_id: trade.id })
          .then(function () {
            tradeStatus.textContent = "Trade complete.";

            if (window.MRTD.refreshLoadout) {
              window.MRTD.refreshLoadout();
            }

            window.setTimeout(closeTrade, 1400);
          })
          .catch(function () {
            /* Not yet, or the other side beat us to it. */
          });
      }
    } else {
      tradeStatus.textContent = theirLock
        ? "They have locked in."
        : "Put cards in, then lock when you are happy.";
    }
  }

  function openTrade(trade) {
    active = trade;
    fillTowerSelect();
    windowEl.hidden = false;
    hideInvite();
  }

  function closeTrade() {
    active = null;
    windowEl.hidden = true;
  }

  putButton.addEventListener("click", function () {
    if (!active) {
      return;
    }

    rpc("set_trade_item", {
      p_id: active.id,
      p_tower: towerSelect.value,
      p_copies: Number(countInput.value)
    }).catch(function (error) {
      tradeStatus.textContent = error.message;
    });
  });

  lockButton.addEventListener("click", function () {
    if (!active) {
      return;
    }

    var mine = me();
    var iAmA = active.player_a === mine;
    var myLock = iAmA ? active.a_locked : active.b_locked;

    rpc("lock_trade", { p_id: active.id, p_locked: !myLock }).catch(function (error) {
      tradeStatus.textContent = error.message;
    });
  });

  cancelButton.addEventListener("click", function () {
    if (!active) {
      return;
    }

    rpc("cancel_trade", { p_id: active.id })
      .catch(function () {})
      .then(closeTrade);
  });

  /* =========================================================
     Watching

     One poll drives everything: the invitation popup, opening
     the window when the other side accepts, and the live state
     of a trade in progress.
     ========================================================= */

  function watch() {
    var mine = me();

    if (!mine) {
      return;
    }

    api(
      "/rest/v1/trades?select=*&status=in.(requested,open,locked)" +
        "&order=created_at.desc&limit=1"
    )
      .then(function (rows) {
        if (!rows.length) {
          if (active) {
            closeTrade();
          }

          hideInvite();
          return null;
        }

        var trade = rows[0];

        if (!names[trade.player_a] || !names[trade.player_b]) {
          return learnNames().then(function () {
            return trade;
          });
        }

        return trade;
      })
      .then(function (trade) {
        if (!trade) {
          return null;
        }

        /* An invitation waiting on this player. */
        if (trade.status === "requested") {
          if (trade.player_b === me() && invited !== trade.id) {
            showInvite(trade);
          }

          return null;
        }

        active = trade;

        if (windowEl.hidden) {
          openTrade(trade);
        }

        return api("/rest/v1/trade_items?select=*&trade_id=eq." + trade.id).then(
          function (items) {
            renderTrade(trade, items);
          }
        );
      })
      .catch(function () {
        /* Offline or signed out; the next tick will retry. */
      });
  }

  /* =========================================================
     The Friends panel
     ========================================================= */

  function refresh() {
    var mine = me();

    if (!mine) {
      return Promise.resolve();
    }

    return Promise.all([
      api(
        "/rest/v1/friendships?select=requester_id,addressee_id,status&or=" +
          "(requester_id.eq." + mine + ",addressee_id.eq." + mine + ")"
      ),
      learnNames()
    ])
      .then(function (results) {
        renderFriends(results[0]);
        tradeHost.textContent = "";
        tradeHost.appendChild(
          element(
            "p",
            "friends__empty",
            "Press Trade on a friend to open a live trade window."
          )
        );
      })
      .catch(function (error) {
        setStatus(error.message, true);
      });
  }

  openButton.addEventListener("click", function () {
    panel.hidden = false;
    setStatus("");
    refresh();
    panelPoll = window.setInterval(refresh, 3000);
  });

  function closePanel() {
    panel.hidden = true;

    if (panelPoll) {
      window.clearInterval(panelPoll);
      panelPoll = null;
    }
  }

  closeButton.addEventListener("click", closePanel);

  panel.addEventListener("click", function (event) {
    if (event.target === panel) {
      closePanel();
    }
  });

  addButton.addEventListener("click", addFriend);

  searchInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      addFriend();
    }
  });

  document.addEventListener("mrtd:unlocked", function () {
    if (watchPoll) {
      window.clearInterval(watchPoll);
    }

    learnNames().then(watch);
    watchPoll = window.setInterval(watch, POLL_MS);
  });

  document.addEventListener("mrtd:locked", function () {
    if (watchPoll) {
      window.clearInterval(watchPoll);
      watchPoll = null;
    }

    hideInvite();
    closeTrade();
    closePanel();
  });
})();
