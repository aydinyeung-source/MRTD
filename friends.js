(function () {
  "use strict";

  /* =========================================================
     Friends and trading.

     Friendships are plain table rows — the policies already
     restrict them to the two people involved. Trades are not:
     moving copies between collections has to happen server side,
     so every step is a function call.

     An accepted trade waits five seconds before it settles, and
     either side can pull out during that time.
     ========================================================= */

  var HOLD_SECONDS = 5;

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

  var names = {};
  var poll = null;

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
        "Content-Type": "application/json",
        Prefer: config.prefer || ""
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

  function setStatus(text, isError) {
    status.textContent = text || "";
    status.classList.toggle("is-error", Boolean(isError));
  }

  function me() {
    return window.MRTD.userId();
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);

    node.className = className || "";

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  }

  function button(label, handler) {
    var node = element("button", "friends__button", label);

    node.type = "button";
    node.addEventListener("click", handler);

    return node;
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

    api("/rest/v1/profiles?select=id,username&username=ilike." + encodeURIComponent(wanted))
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

  function respond(requester, accept) {
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
    listHost.textContent = "";

    var mine = me();

    if (!rows.length) {
      listHost.appendChild(
        element("p", "friends__empty", "Nobody yet. Add someone by username.")
      );
      return;
    }

    rows.forEach(function (row) {
      var other = row.requester_id === mine ? row.addressee_id : row.requester_id;
      var line = element("div", "friends__line");
      var incoming = row.status === "pending" && row.addressee_id === mine;

      line.appendChild(
        element("span", "friends__name", names[other] || "player")
      );

      if (row.status === "accepted") {
        line.appendChild(element("span", "friends__tag", "friend"));
        line.appendChild(button("Trade", function () {
          offerTo(other);
        }));
        line.appendChild(button("Remove", function () {
          unfriend(other);
        }));
      } else if (incoming) {
        line.appendChild(element("span", "friends__tag", "wants to add you"));
        line.appendChild(button("Accept", function () {
          respond(other, true);
        }));
        line.appendChild(button("Decline", function () {
          respond(other, false);
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
     Trading
     ========================================================= */

  function towerOptions(select) {
    Object.keys(window.MRTD.stats.towers).forEach(function (name) {
      var option = document.createElement("option");

      option.value = name;
      option.textContent = window.MRTD.stats.towers[name].label;
      select.appendChild(option);
    });
  }

  /* A small form appended under the friend you picked. */
  function offerTo(other) {
    var form = element("div", "friends__offer");

    var give = document.createElement("select");
    give.className = "admin__input";
    towerOptions(give);

    var giveCount = document.createElement("input");
    giveCount.className = "admin__input";
    giveCount.type = "number";
    giveCount.value = "1";
    giveCount.min = "1";

    var want = document.createElement("select");
    want.className = "admin__input";
    towerOptions(want);

    var wantCount = document.createElement("input");
    wantCount.className = "admin__input";
    wantCount.type = "number";
    wantCount.value = "1";
    wantCount.min = "1";

    form.appendChild(element("span", "friends__tag", "you give"));
    form.appendChild(giveCount);
    form.appendChild(give);
    form.appendChild(element("span", "friends__tag", "for"));
    form.appendChild(wantCount);
    form.appendChild(want);

    form.appendChild(button("Offer", function () {
      api("/rest/v1/rpc/propose_trade", {
        method: "POST",
        body: {
          p_to: other,
          p_offer_key: give.value,
          p_offer_copies: Number(giveCount.value),
          p_want_key: want.value,
          p_want_copies: Number(wantCount.value)
        }
      })
        .then(function () {
          setStatus("Offer sent.");
          form.remove();
          return refresh();
        })
        .catch(function (error) {
          setStatus(error.message, true);
        });
    }));

    listHost.appendChild(form);
  }

  function label(name) {
    var tower = window.MRTD.stats.towers[name];

    return tower ? tower.label : name;
  }

  function renderTrades(rows) {
    tradeHost.textContent = "";

    var mine = me();
    var live = rows.filter(function (row) {
      return row.status === "pending" || row.status === "accepted";
    });

    if (!live.length) {
      tradeHost.appendChild(element("p", "friends__empty", "No open trades."));
      return;
    }

    live.forEach(function (row) {
      var outgoing = row.from_player === mine;
      var line = element("div", "friends__line");

      line.appendChild(
        element(
          "span",
          "friends__name",
          (outgoing ? "You give " : "You give ") +
            (outgoing ? row.offer_copies + "× " + label(row.offer_key)
                      : row.want_copies + "× " + label(row.want_key)) +
            " for " +
            (outgoing ? row.want_copies + "× " + label(row.want_key)
                      : row.offer_copies + "× " + label(row.offer_key))
        )
      );

      if (row.status === "accepted") {
        var left = Math.max(
          0,
          HOLD_SECONDS -
            Math.floor((Date.now() - new Date(row.accepted_at).getTime()) / 1000)
        );

        line.appendChild(
          element("span", "friends__tag", left ? "settles in " + left + "s" : "settling")
        );

        line.appendChild(button("Withdraw", function () {
          api("/rest/v1/rpc/cancel_trade", { method: "POST", body: { p_id: row.id } })
            .then(function () {
              setStatus("Withdrawn.");
              return refresh();
            })
            .catch(function (error) {
              setStatus(error.message, true);
            });
        }));

        if (!left) {
          settle(row.id);
        }
      } else if (outgoing) {
        line.appendChild(element("span", "friends__tag", "waiting"));
        line.appendChild(button("Cancel", function () {
          api("/rest/v1/rpc/cancel_trade", { method: "POST", body: { p_id: row.id } })
            .then(refresh)
            .catch(function (error) {
              setStatus(error.message, true);
            });
        }));
      } else {
        line.appendChild(element("span", "friends__tag", "offered to you"));
        line.appendChild(button("Accept", function () {
          api("/rest/v1/rpc/accept_trade", { method: "POST", body: { p_id: row.id } })
            .then(function () {
              setStatus("Accepted — five seconds to withdraw.");
              return refresh();
            })
            .catch(function (error) {
              setStatus(error.message, true);
            });
        }));
        line.appendChild(button("Decline", function () {
          api("/rest/v1/rpc/cancel_trade", { method: "POST", body: { p_id: row.id } })
            .then(refresh)
            .catch(function (error) {
              setStatus(error.message, true);
            });
        }));
      }

      tradeHost.appendChild(line);
    });
  }

  /* Either side may call this; the server refuses until the hold
     has run out, and does nothing if it already settled. */
  function settle(id) {
    api("/rest/v1/rpc/settle_trade", { method: "POST", body: { p_id: id } })
      .then(function () {
        setStatus("Trade complete.");

        if (window.MRTD.refreshLoadout) {
          window.MRTD.refreshLoadout();
        }

        return refresh();
      })
      .catch(function () {
        /* Usually just "still within the window" — try again next poll. */
      });
  }

  /* =========================================================
     Loading
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
      api("/rest/v1/trades?select=*&order=created_at.desc&limit=20"),
      api("/rest/v1/profiles?select=id,username")
    ])
      .then(function (results) {
        names = {};
        results[2].forEach(function (row) {
          names[row.id] = row.username;
        });

        renderFriends(results[0]);
        renderTrades(results[1]);
      })
      .catch(function (error) {
        setStatus(error.message, true);
      });
  }

  /* =========================================================
     Incoming trade popup

     Runs whether or not the Friends panel is open, so an offer
     is never missed. Once accepted it becomes the countdown, so
     the withdrawal window is available from the same place.
     ========================================================= */

  var popup = document.getElementById("traderequest");
  var popupText = document.getElementById("traderequest-text");
  var popupActions = document.getElementById("traderequest-actions");

  var watching = null;
  var watchPoll = null;
  var countdown = null;

  function hidePopup() {
    popup.hidden = true;
    watching = null;

    if (countdown) {
      window.clearInterval(countdown);
      countdown = null;
    }
  }

  function popupButton(host, label, handler) {
    var node = document.createElement("button");

    node.className = "traderequest__button";
    node.type = "button";
    node.textContent = label;
    node.addEventListener("click", handler);
    host.appendChild(node);

    return node;
  }

  function showRequest(trade) {
    watching = trade.id;

    popupText.textContent =
      "Player " + (names[trade.from_player] || "someone") +
      " requested to trade with you!  They give " +
      trade.offer_copies + "× " + label(trade.offer_key) +
      " for your " + trade.want_copies + "× " + label(trade.want_key);

    popupActions.textContent = "";

    popupButton(popupActions, "Yes", function () {
      api("/rest/v1/rpc/accept_trade", { method: "POST", body: { p_id: trade.id } })
        .then(function () {
          startHold(trade);
        })
        .catch(function (error) {
          popupText.textContent = error.message;
        });
    });

    popupButton(popupActions, "No", function () {
      api("/rest/v1/rpc/cancel_trade", { method: "POST", body: { p_id: trade.id } })
        .catch(function () {})
        .then(hidePopup);
    });

    popup.hidden = false;
  }

  /* The five seconds either side has to pull out. */
  function startHold(trade) {
    var left = HOLD_SECONDS;

    popupActions.textContent = "";

    var withdraw = popupButton(popupActions, "Withdraw", function () {
      api("/rest/v1/rpc/cancel_trade", { method: "POST", body: { p_id: trade.id } })
        .catch(function () {})
        .then(hidePopup);
    });

    function tick() {
      popupText.textContent = "Trade settles in " + left + "s";

      if (left <= 0) {
        window.clearInterval(countdown);
        countdown = null;
        withdraw.disabled = true;

        settle(trade.id);
        popupText.textContent = "Trade complete.";
        window.setTimeout(hidePopup, 1600);
        return;
      }

      left -= 1;
    }

    tick();
    countdown = window.setInterval(tick, 1000);
  }

  /* Only looks for offers waiting on this player. */
  function watchForTrades() {
    var mine = me();

    if (!mine || watching) {
      return;
    }

    api(
      "/rest/v1/trades?select=*&to_player=eq." + mine +
        "&status=eq.pending&order=created_at.desc&limit=1"
    )
      .then(function (rows) {
        if (!rows.length) {
          return null;
        }

        var trade = rows[0];

        if (names[trade.from_player]) {
          showRequest(trade);
          return null;
        }

        /* Learn the sender's name before announcing them. */
        return api("/rest/v1/profiles?select=id,username&id=eq." + trade.from_player)
          .then(function (people) {
            if (people.length) {
              names[people[0].id] = people[0].username;
            }

            showRequest(trade);
          });
      })
      .catch(function () {
        /* Offline or signed out; try again next tick. */
      });
  }

  document.addEventListener("mrtd:unlocked", function () {
    if (watchPoll) {
      window.clearInterval(watchPoll);
    }

    watchForTrades();
    watchPoll = window.setInterval(watchForTrades, 5000);
  });

  document.addEventListener("mrtd:locked", function () {
    if (watchPoll) {
      window.clearInterval(watchPoll);
      watchPoll = null;
    }

    hidePopup();
  });

  openButton.addEventListener("click", function () {
    panel.hidden = false;
    setStatus("");
    refresh();
    poll = window.setInterval(refresh, 2000);
  });

  function close() {
    panel.hidden = true;

    if (poll) {
      window.clearInterval(poll);
      poll = null;
    }
  }

  closeButton.addEventListener("click", close);

  panel.addEventListener("click", function (event) {
    if (event.target === panel) {
      close();
    }
  });

  addButton.addEventListener("click", addFriend);

  searchInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      addFriend();
    }
  });
})();
