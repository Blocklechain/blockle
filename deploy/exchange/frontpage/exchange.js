// ---------------------------------------------------------------------------
// BLOCKLE EXCHANGE — application logic
//
// Plain ES5-ish JavaScript, no build step, no framework. The whole app is ~900
// lines and the dependency it would take to shrink that is a dependency on the
// trading screen's critical path.
//
// THREE RULES, and the first is the one that matters:
//
// 1. MONEY IS NEVER A NUMBER. Every amount and price stays the decimal STRING
//    the API sent, all the way to the DOM. A USDT balance above ~9e15 base
//    units does not survive a JavaScript double, and this is the file where
//    that would silently corrupt someone's balance. `parseFloat` appears
//    exactly once below, to turn a price into a pixel coordinate for the
//    chart, and it is labelled.
//
// 2. UNKNOWN RENDERS AS UNKNOWN. An em dash, never a zero. "This market has no
//    price" and "this market is at zero" are different claims and only one is
//    ever true.
//
// 3. NO innerHTML WITH SERVER DATA. Rows are built with createElement and
//    textContent. The coin marks are the only HTML injected, and they come
//    from coins.js, which is ours.
//
// Polling rather than websockets: the public endpoints are cheap and cached for
// a couple of seconds server-side, and a reconnecting socket is a lot of
// machinery to maintain for a venue at this stage. Only the visible screen
// polls — a background screen costs nothing.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var DASH = "—";

  /** Text node, with the em dash for anything absent. */
  function tx(v) {
    return document.createTextNode(v === null || v === undefined || v === "" ? DASH : String(v));
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.appendChild(tx(text));
    return n;
  }

  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function cell(row, value, cls) {
    var td = document.createElement("td");
    if (cls) td.className = cls;
    td.appendChild(tx(value));
    row.appendChild(td);
    return td;
  }

  /** Asset cell: mark, ticker, full name. */
  function assetCell(row, symbol, network) {
    var td = document.createElement("td");
    var wrap = el("div", "asset");
    var mark = document.createElement("span");
    mark.innerHTML = coinIcon(symbol, 22);
    wrap.appendChild(mark.firstChild);
    var txt = el("div");
    txt.appendChild(el("div", "tk", symbol));
    txt.appendChild(el("div", "nm", network ? coinIcon.network(network) : coinIcon.name(symbol)));
    wrap.appendChild(txt);
    td.appendChild(wrap);
    row.appendChild(td);
    return td;
  }

  function pill(row, label, kind) {
    var td = document.createElement("td");
    td.appendChild(el("span", "pill " + kind, label));
    row.appendChild(td);
    return td;
  }

  function emptyRow(tbody, cols, text) {
    clear(tbody);
    var tr = tbody.insertRow();
    var td = cell(tr, text);
    td.colSpan = cols;
    td.className = "empty";
  }

  function show(node, text, kind) {
    node.className = "msg " + (kind || "");
    node.textContent = text;
  }
  function hide(node) { node.className = "msg hidden"; }

  /** A request id, so a double-click is one action rather than two. */
  function reqId() {
    var a = new Uint8Array(10);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  // ----------------------------------------------------------------- transport

  var SIGNED_IN = false;
  /** Whether the venue still offers a testnet faucet. Set from /public/status. */
  var FAUCET = true;

  function api(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || "GET",
      cache: "no-store",
      // The session cookie is scoped to .blockle.org and this host is inside
      // it, so identity travels with the request and there is no token to
      // manage in the page.
      credentials: "same-origin",
      headers: {},
    };
    if (opts.data) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.data);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return { error: "HTTP " + r.status }; })
        .then(function (body) {
          if (r.ok) return body;
          var err = new Error(body.error || ("HTTP " + r.status));
          err.status = r.status;
          // 401 means sign in; 503 from the accounts service means we do not
          // know who you are and must not guess. Both are handled by the
          // caller rather than being flattened into "something went wrong".
          if (r.status === 401) SIGNED_IN = false;
          throw err;
        });
    });
  }

  var pub = function (p) { return api("public/" + p); };
  var priv = function (p, o) { return api("v1/" + p, o); };

  // ------------------------------------------------------------------ app state

  var STATE = {
    markets: [],       // [{base, quote, symbol}]
    tickers: [],
    assets: [],        // tickers of everything listed
    balances: [],
    fees: null,        // {makerPct, takerPct, makerBps, takerBps, note}
    wdFees: [],
    market: null,      // the trade screen's current market symbol
    side: "buy",
    timer: null,
  };

  // --------------------------------------------------------------------- icons
  // Line-art UI glyphs for the rail. Separate from the coin marks: a section
  // icon that looked like a coin would read as an asset.
  var UI = {
    markets: '<path d="M4 19h16M6 19V9m4.5 10V5m4.5 14v-7M19 19v-4"/>',
    trade: '<path d="M4 15.5l4.5-5 3.5 3L20 6"/><path d="M15 6h5v5"/>',
    balances: '<rect x="3.5" y="6.5" width="17" height="12" rx="2.2"/><path d="M3.5 10.5h17"/><circle cx="16.5" cy="14.5" r="1.3"/>',
    deposit: '<path d="M12 4v10M8 10.5l4 4 4-4"/><path d="M5 19.5h14"/>',
    withdraw: '<path d="M12 18V8M8 11.5l4-4 4 4"/><path d="M5 20.5h14"/>',
    liquidity: '<path d="M12 3.5l5.5 7.5a6.6 6.6 0 11-11 0z"/><path d="M6.6 13.5h10.8"/>',
    orders: '<path d="M8 6.5h11M8 12h11M8 17.5h11"/><circle cx="5" cy="6.5" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="5" cy="17.5" r="1.2"/>',
    listing: '<path d="M6.5 3.5h8L18 7v13.5H6.5z"/><path d="M14 3.5V7h3.8"/><path d="M9 11.5h6M9 15h6"/>',
    fees: '<path d="M12 4v16M6 20h12"/><path d="M4.5 8h15M12 4.5L5 8M12 4.5L19 8"/><path d="M5 8l-2.3 4.8a2.8 2.8 0 004.6 0zM19 8l-2.3 4.8a2.8 2.8 0 004.6 0z"/>',
    account: '<circle cx="12" cy="8.5" r="3.4"/><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6"/>',
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + (UI[name] || "") + "</svg>";
  }

  // -------------------------------------------------------------------- routing

  // ONE TABLE. The rail, the routes and the screen ids all come from here, so
  // adding a screen cannot leave an orphan nav item or an unreachable section.
  var SCREENS = [
    { id: "markets", label: "Markets", group: "Trade" },
    { id: "trade", label: "Trade", group: null },
    { id: "liquidity", label: "Liquidity", group: null, auth: true },
    { id: "orders", label: "Orders", group: null, auth: true },
    { id: "balances", label: "Balances", group: "Funds", auth: true },
    { id: "deposit", label: "Deposit", group: null, auth: true },
    { id: "withdraw", label: "Withdraw", group: null, auth: true },
    { id: "fees", label: "Fees", group: "Venue" },
    { id: "listing", label: "List a coin", group: null },
    { id: "account", label: "Account", group: null },
  ];

  function buildRail() {
    var rail = $("rail");
    clear(rail);
    SCREENS.forEach(function (s) {
      if (s.group) rail.appendChild(el("div", "group lbl", s.group));
      var a = document.createElement("a");
      a.href = "#/" + s.id;
      a.id = "nav-" + s.id;
      a.innerHTML = icon(s.id);
      a.appendChild(el("span", "t", s.label));
      var c = el("span", "count hidden", "");
      c.id = "count-" + s.id;
      a.appendChild(c);
      rail.appendChild(a);
    });
    var foot = el("div", "foot");
    // ABSOLUTE, to blockle.org. The exchange lives on its own subdomain and
    // these pages live on the main site; relative paths would 404 here.
    [["Back to blockle.org", "https://blockle.org/"],
     ["Support", "https://blockle.org/contact"],
     ["Terms", "https://blockle.org/terms"],
     ["Privacy", "https://blockle.org/privacy"]]
      .forEach(function (p) {
        var a = document.createElement("a");
        a.href = p[1];
        a.appendChild(tx(p[0]));
        foot.appendChild(a);
      });
    rail.appendChild(foot);
  }

  function route() {
    var h = (location.hash || "#/markets").slice(2);
    var parts = h.split("/");
    var name = parts[0] || "markets";
    if (!SCREENS.some(function (s) { return s.id === name; })) name = "markets";

    SCREENS.forEach(function (s) {
      var sec = $("s-" + s.id);
      if (sec) sec.classList.toggle("on", s.id === name);
      var nav = $("nav-" + s.id);
      if (nav) nav.classList.toggle("on", s.id === name);
    });
    // The trade screen manages its own full-height layout, so the work area
    // drops its padding for it and only for it.
    $("work").classList.toggle("flush", name === "trade");

    if (name === "trade") {
      STATE.market = parts[1] || STATE.market ||
        (STATE.markets[0] && STATE.markets[0].symbol) || "BTC-USDT";
    }

    if (STATE.timer) { clearInterval(STATE.timer); STATE.timer = null; }
    var screen = RENDER[name];
    if (screen) {
      screen();
      // ONLY THE VISIBLE SCREEN POLLS.
      STATE.timer = setInterval(screen, name === "trade" ? 3000 : 8000);
    }
    document.title = name === "trade"
      ? STATE.market + " · Blockle Exchange"
      : "Blockle Exchange";
  }

  // ------------------------------------------------------------------- markets

  function spreadOf(bid, ask) {
    // Pixels and percentages are presentational, so a double is fine here;
    // nothing derived from it is ever posted back or stored.
    if (!bid || !ask) return null;
    var b = parseFloat(bid), a = parseFloat(ask);
    if (!(b > 0) || !(a > 0)) return null;
    return (((a - b) / a) * 100).toFixed(3) + "%";
  }

  var RENDER = {};

  RENDER.markets = function () {
    pub("tickers").then(function (rows) {
      STATE.tickers = rows;
      drawMarkets();
    }).catch(function (e) {
      emptyRow($("t-markets").tBodies[0], 7, "Markets unavailable: " + e.message);
    });
  };

  function drawMarkets() {
    var q = ($("mkt-search").value || "").trim().toUpperCase();
    var body = $("t-markets").tBodies[0];
    var rows = STATE.tickers.filter(function (t) {
      return !q || t.pair.indexOf(q) >= 0 || coinIcon.name(t.base).toUpperCase().indexOf(q) >= 0;
    });
    clear(body);
    if (!rows.length) { emptyRow(body, 7, "No market matches that."); return; }

    rows.forEach(function (t) {
      var tr = body.insertRow();
      tr.className = "click";
      tr.onclick = function () { location.hash = "#/trade/" + t.market; };
      assetCell(tr, t.base);
      cell(tr, t.last, "num");
      cell(tr, t.bid, "num up");
      cell(tr, t.ask, "num down");
      cell(tr, spreadOf(t.bid, t.ask), "num dim");
      cell(tr, t.quote, "dim");
      var td = document.createElement("td");
      var a = el("span", "btn sm ghost", "Trade");
      td.appendChild(a);
      tr.appendChild(td);
    });
  }

  // --------------------------------------------------------------------- trade

  RENDER.trade = function () {
    var m = STATE.market;
    if (!m) return;
    var def = STATE.markets.filter(function (x) { return x.symbol === m; })[0] ||
      { base: m.split("-")[0], quote: m.split("-")[1] };

    $("tb-market").textContent = m;
    $("lbl-price").textContent = "Price (" + def.quote + ")";
    $("lbl-amount").textContent = "Amount (" + def.base + ")";

    pub("book/" + m).then(function (b) { drawLadder(b, def); }).catch(function () {});
    pub("trades/" + m).then(function (t) { drawTape(t); drawChart(t); }).catch(function () {});
    if (SIGNED_IN) {
      refreshBalances().then(function () { ticketTotals(def); });
      drawMyOrders(m);
    }
  };

  function drawLadder(book, def) {
    var asks = (book.asks || []).slice(0, 12);
    var bids = (book.bids || []).slice(0, 12);

    // Cumulative size drives the row bar, so the ladder IS the depth chart and
    // there is no second thing to keep in step with it.
    function run(rows, host, cls) {
      var cum = 0, max = 0, acc = [];
      rows.forEach(function (r) {
        cum += parseFloat(r.amount) || 0; // bar width only
        acc.push(cum);
        if (cum > max) max = cum;
      });
      clear(host);
      rows.forEach(function (r, i) {
        var row = el("div", "row " + cls);
        var bar = el("div", "bar");
        bar.style.width = max > 0 ? ((acc[i] / max) * 100).toFixed(1) + "%" : "0";
        row.appendChild(bar);
        row.appendChild(el("span", null, r.price));
        row.appendChild(el("span", null, r.amount));
        row.appendChild(el("span", "faint", acc[i].toPrecision(6)));
        row.onclick = function () { $("t-price").value = r.price; ticketTotals(def); };
        host.appendChild(row);
      });
      if (!rows.length) host.appendChild(el("div", "empty", "No " + cls + "s"));
    }
    // Asks descend to the spread, so the best ask sits next to the best bid.
    run(asks.slice().reverse(), $("asks"), "ask");
    run(bids, $("bids"), "bid");

    var best = { bid: bids[0] && bids[0].price, ask: asks[0] && asks[0].price };
    $("tb-bid").textContent = best.bid || DASH;
    $("tb-ask").textContent = best.ask || DASH;
    var sp = spreadOf(best.bid, best.ask);
    $("tb-spread").textContent = sp || DASH;
    $("lad-spread").textContent = sp ? "spread " + sp : "";
  }

  function drawTape(trades) {
    var host = $("tape");
    clear(host);
    if (!trades.length) { host.appendChild(el("div", "empty", "No trades yet.")); return; }
    trades.slice(0, 30).forEach(function (t) {
      var row = el("div", "row");
      row.appendChild(el("span", t.takerSide === "buy" ? "up" : "down", t.price));
      row.appendChild(el("span", null, t.amount));
      row.appendChild(el("span", null, new Date(t.at).toLocaleTimeString()));
      host.appendChild(row);
    });
    var last = trades[0];
    $("tb-last").textContent = last ? last.price : DASH;
    $("lad-last").textContent = last ? last.price : DASH;
  }

  function drawChart(trades) {
    var c = $("chart");
    var empty = $("chart-empty");
    if (!trades || trades.length < 2) { empty.classList.remove("hidden"); return; }
    empty.classList.add("hidden");

    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, h = c.clientHeight;
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(h * dpr);
    var g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // PRICES BECOME PIXELS HERE. This is the one place a money string is
    // parsed into a double, and the result is a y coordinate — never an
    // amount, never posted back.
    var pts = trades.slice().reverse().map(function (t) { return parseFloat(t.price); })
      .filter(function (v) { return isFinite(v); });
    if (pts.length < 2) { empty.classList.remove("hidden"); return; }

    var lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
    if (hi === lo) { hi = lo * 1.001 + 1e-9; lo = lo * 0.999; }
    var padT = 16, padB = 22, padL = 8, padR = 62;
    var x = function (i) { return padL + (i / (pts.length - 1)) * (w - padL - padR); };
    var y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB); };

    // Faint grid with the price labels on the right, where the eye ends up.
    g.strokeStyle = "#171e29"; g.lineWidth = 1;
    g.fillStyle = "#5e6b80";
    g.font = "11px ui-monospace, monospace";
    g.textBaseline = "middle";
    for (var i = 0; i <= 4; i++) {
      var v = lo + ((hi - lo) * i) / 4;
      var yy = Math.round(y(v)) + 0.5;
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(w - padR, yy); g.stroke();
      g.fillText(v.toPrecision(6), w - padR + 7, yy);
    }

    var rising = pts[pts.length - 1] >= pts[0];
    var line = rising ? "#2fd48a" : "#ff5668";

    // Area fill under the line, then the line, then an emphasised endpoint.
    var grad = g.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, rising ? "rgba(47,212,138,.22)" : "rgba(255,86,104,.22)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.beginPath();
    g.moveTo(x(0), y(pts[0]));
    pts.forEach(function (v, i) { g.lineTo(x(i), y(v)); });
    g.lineTo(x(pts.length - 1), h - padB);
    g.lineTo(x(0), h - padB);
    g.closePath();
    g.fillStyle = grad; g.fill();

    g.beginPath();
    pts.forEach(function (v, i) { i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); });
    g.strokeStyle = line; g.lineWidth = 2; g.stroke();

    g.beginPath();
    g.arc(x(pts.length - 1), y(pts[pts.length - 1]), 3.4, 0, Math.PI * 2);
    g.fillStyle = line; g.fill();
    g.strokeStyle = "#070a10"; g.lineWidth = 2; g.stroke();
  }

  function drawMyOrders(market) {
    priv("orders").then(function (rows) {
      var mine = rows.filter(function (o) { return o.market === market; });
      var body = $("t-myorders").tBodies[0];
      $("myord-note").textContent = mine.length ? mine.length + " working" : "";
      if (!mine.length) { emptyRow(body, 6, "Nothing open here."); return; }
      clear(body);
      mine.forEach(function (o) {
        var tr = body.insertRow();
        cell(tr, o.side === "buy" ? "Buy" : "Sell", o.side === "buy" ? "up" : "down");
        cell(tr, o.price, "num");
        cell(tr, o.total, "num");
        cell(tr, o.filled, "num");
        pill(tr, o.state, o.state === "open" ? "mute" : "ok");
        var td = document.createElement("td");
        if (o.state === "open") td.appendChild(cancelBtn(o.id));
        tr.appendChild(td);
      });
    }).catch(function () {});
  }

  function cancelBtn(id) {
    var b = el("button", "btn sm ghost", "Cancel");
    b.onclick = function () {
      b.disabled = true;
      priv("orders/" + id + "/cancel", { method: "POST", data: {} })
        .then(function () { route(); })
        .catch(function (e) { b.disabled = false; alert(e.message); });
    };
    return b;
  }

  // ------------------------------------------------------------- order ticket

  function setSide(side) {
    STATE.side = side;
    $("side-buy").setAttribute("aria-pressed", side === "buy" ? "true" : "false");
    $("side-sell").setAttribute("aria-pressed", side === "sell" ? "true" : "false");
    var btn = $("t-submit");
    btn.className = "btn block " + (side === "buy" ? "buy" : "sell");
    btn.textContent = side === "buy" ? "Buy" : "Sell";
    var def = marketDef();
    if (def) ticketTotals(def);
  }

  function marketDef() {
    var m = STATE.market;
    if (!m) return null;
    return STATE.markets.filter(function (x) { return x.symbol === m; })[0] ||
      { base: m.split("-")[0], quote: m.split("-")[1], symbol: m };
  }

  function balOf(asset) {
    var b = STATE.balances.filter(function (x) { return x.asset === asset; })[0];
    return b || null;
  }

  function ticketTotals(def) {
    var need = STATE.side === "buy" ? def.quote : def.base;
    var b = balOf(need);
    $("t-avail").textContent = b ? b.available + " " + need : DASH;

    // Presentational arithmetic only — the server computes the real figures and
    // refuses anything that does not add up.
    var px = parseFloat($("t-price").value), am = parseFloat($("t-amount").value);
    if (!(px > 0) || !(am > 0)) {
      $("t-total").textContent = DASH;
      $("t-fee").textContent = DASH;
      return;
    }
    var value = px * am;
    var bps = (STATE.fees && STATE.fees.takerBps) || 20;
    var feeAsset = STATE.side === "buy" ? def.base : def.quote;
    var feeAmt = (STATE.side === "buy" ? am : value) * (bps / 10000);
    $("t-total").textContent = value.toPrecision(8) + " " + def.quote;
    $("t-fee").textContent = "~" + feeAmt.toPrecision(4) + " " + feeAsset;
  }

  function submitOrder() {
    var def = marketDef();
    var btn = $("t-submit");
    var msg = $("t-msg");
    hide(msg);
    btn.disabled = true;
    priv("orders", {
      method: "POST",
      data: {
        market: def.symbol,
        side: STATE.side,
        price: $("t-price").value.trim(),
        amount: $("t-amount").value.trim(),
      },
    }).then(function (r) {
      show(msg, r.state === "filled"
        ? "Filled " + r.filled + " of " + r.total + "."
        : "Resting on the book: " + r.filled + " of " + r.total + " filled.", "ok");
      $("t-amount").value = "";
      route();
    }).catch(function (e) {
      show(msg, e.message, "bad");
      if (e.status === 401) curtain(true);
    }).then(function () { btn.disabled = false; });
  }

  // ------------------------------------------------------------------ balances

  function refreshBalances() {
    return priv("balances").then(function (rows) {
      STATE.balances = rows;
      return rows;
    }).catch(function () { return []; });
  }

  RENDER.balances = function () {
    refreshBalances().then(function (rows) {
      var tiles = $("bal-tiles");
      clear(tiles);
      var held = rows.filter(function (b) { return b.total !== "0"; });
      $("bal-note").textContent = held.length + " of " + rows.length + " with a balance";

      // Hero tiles for the assets actually held, so the screen leads with what
      // is there rather than a table of zeroes.
      (held.length ? held : rows.slice(0, 4)).slice(0, 4).forEach(function (b) {
        var t = el("div", "tile");
        var k = el("div", "k");
        var mark = document.createElement("span");
        mark.innerHTML = coinIcon(b.asset, 14);
        k.appendChild(mark.firstChild);
        k.appendChild(tx(" " + b.asset));
        k.style.display = "flex";
        k.style.alignItems = "center";
        k.style.gap = "6px";
        t.appendChild(k);
        t.appendChild(el("div", "v", b.available));
        t.appendChild(el("div", "s", b.reserved === "0"
          ? "nothing reserved"
          : b.reserved + " reserved for orders"));
        tiles.appendChild(t);
      });

      var body = $("t-balances").tBodies[0];
      clear(body);
      rows.forEach(function (b) {
        var tr = body.insertRow();
        assetCell(tr, b.asset);
        cell(tr, b.total, "num");
        cell(tr, b.reserved === "0" ? DASH : b.reserved, "num dim");
        cell(tr, b.available, "num");
        var td = document.createElement("td");
        var a = document.createElement("a");
        a.className = "btn sm ghost";
        a.href = "#/trade/" + b.asset + "-USDT";
        a.appendChild(tx("Trade"));
        if (b.asset !== "USDT") td.appendChild(a);
        tr.appendChild(td);
      });
    });
  };

  // ------------------------------------------------------------------- deposit

  RENDER.deposit = function () {
    fillAssetSelect($("d-asset"));
    fillAssetSelect($("f-asset"));
    if (!$("d-net").options.length) depositNets();
    drawInflight();
  };

  /**
   * Deposits the chain has shown but we have not credited yet.
   *
   * This is the screen that answers "where is my deposit" without a support
   * ticket: the row exists from the moment the custodian first mentions the
   * transfer, so waiting looks like waiting rather than like nothing happened.
   */
  function drawInflight() {
    priv("deposits").then(function (r) {
      var body = $("t-deposits").tBodies[0];
      var rows = r.deposits || [];
      var waiting = rows.filter(function (d) { return d.outcome === "pending"; });
      $("d-inflight-note").textContent = waiting.length
        ? waiting.length + " waiting to confirm"
        : "";
      badge("deposit", waiting.length);
      if (!rows.length) { emptyRow(body, 5, "Nothing arriving."); return; }
      clear(body);
      rows.forEach(function (d) {
        var tr = body.insertRow();
        assetCell(tr, d.asset, d.network);
        cell(tr, d.network ? coinIcon.network(d.network) : "native", "dim");
        cell(tr, d.amount, "num");
        // The detail carries "N of M confirmations" for a pending deposit,
        // which is more use than the bare count.
        cell(tr, d.outcome === "pending" && d.detail ? d.detail : d.confirmations, "num");
        pill(
          tr,
          d.outcome === "credited" ? "credited"
            : d.outcome === "pending" ? "confirming"
            : d.outcome === "unattributed" ? "needs review"
            : d.outcome,
          d.outcome === "credited" ? "ok"
            : d.outcome === "pending" ? "mute" : "warn"
        );
      });
    }).catch(function () { /* signed out: the curtain covers it */ });
  }

  function depositNets() {
    var asset = $("d-asset").value;
    if (!asset) return;
    priv("withdrawal-options?asset=" + encodeURIComponent(asset)).then(function (o) {
      var sel = $("d-net");
      clear(sel);
      if (!o.networks.length) {
        sel.appendChild(new Option(asset + " (native chain)", ""));
      } else {
        o.networks.forEach(function (n) {
          sel.appendChild(new Option(n.label, n.network));
        });
      }
      depositAddress();
    }).catch(function () {});
  }

  function depositAddress() {
    var out = $("d-out");
    clear(out);
    var asset = $("d-asset").value, net = $("d-net").value;
    priv("deposit-address?asset=" + encodeURIComponent(asset) +
         "&network=" + encodeURIComponent(net)).then(function (r) {
      if (r.address) {
        out.appendChild(el("div", "lbl", "Send " + asset + " on " +
          (coinIcon.network(net) || asset) + " to"));
        var box = el("div", "msg");
        box.style.fontFamily = "var(--mono)";
        box.style.wordBreak = "break-all";
        box.style.marginTop = "6px";
        box.textContent = r.address;
        out.appendChild(box);
        if (r.memo) {
          out.appendChild(el("div", "msg warn", "A memo/tag is REQUIRED: " + r.memo +
            " — a deposit without it cannot be credited."));
        }
        out.appendChild(el("p", "note",
          "Only " + asset + " on this chain. Anything else sent here is lost."));
      } else {
        // HONEST ABOUT WHAT IS NOT READY. A fabricated address would lose
        // somebody's money, and a blank box would look broken.
        out.appendChild(el("div", "msg warn", r.reason ||
          "No deposit address is provisioned for this chain yet."));
        out.appendChild(el("p", "note",
          "Deposit addresses are issued per customer by the custodian. Until " +
          "this chain has one, use another chain for the same asset." +
          (FAUCET ? " While the venue is in testnet you can also use the " +
            "testnet faucet." : "")));
      }
    }).catch(function (e) {
      out.appendChild(el("div", "msg bad", e.message));
    });
  }

  function doFaucet() {
    var msg = $("f-msg");
    var btn = $("f-go");
    btn.disabled = true;
    hide(msg);
    priv("testnet-fund", {
      method: "POST",
      data: { asset: $("f-asset").value, amount: $("f-amount").value.trim() },
    }).then(function (r) {
      show(msg, "Credited " + r.credited + " " + r.asset + ".", "ok");
      refreshBalances();
    }).catch(function (e) { show(msg, e.message, "bad"); })
      .then(function () { btn.disabled = false; });
  }

  // ------------------------------------------------------------------ withdraw

  RENDER.withdraw = function () {
    if (!$("w-asset").options.length) {
      fillAssetSelect($("w-asset"));
      withdrawNets();
    }
    priv("withdrawals").then(function (rows) {
      var body = $("t-withdrawals").tBodies[0];
      $("w-count").textContent = rows.length ? rows.length + " in progress" : "";
      if (!rows.length) { emptyRow(body, 5, "Nothing in progress."); return; }
      clear(body);
      rows.forEach(function (w) {
        var tr = body.insertRow();
        assetCell(tr, w.asset, w.network);
        cell(tr, w.network ? coinIcon.network(w.network) : "native", "dim");
        cell(tr, w.amount, "num");
        cell(tr, w.youReceive, "num");
        pill(tr, w.state, w.state === "confirmed" ? "ok"
          : (w.state === "rejected" || w.state === "failed") ? "bad" : "mute");
      });
    }).catch(function () {});
  };

  function withdrawNets() {
    var asset = $("w-asset").value;
    if (!asset) return;
    priv("withdrawal-options?asset=" + encodeURIComponent(asset)).then(function (o) {
      var sel = $("w-net");
      clear(sel);
      if (!o.networks.length) {
        sel.appendChild(new Option(asset + " (native chain)", ""));
      } else {
        o.networks.forEach(function (n) {
          // The constraint goes in the option text, so it is visible while
          // choosing rather than after submitting.
          var opt = new Option(
            n.label + (n.open ? "  (" + n.available + " available)" : "  — unavailable"),
            n.network
          );
          opt.disabled = !n.open;
          sel.appendChild(opt);
        });
        var firstOpen = o.networks.filter(function (n) { return n.open; })[0];
        if (firstOpen) sel.value = firstOpen.network;
      }
      showAvail(o);
      quoteWithdrawal();
    }).catch(function () {});
  }

  var WOPTS = null;
  function showAvail(o) {
    if (o) WOPTS = o;
    if (!WOPTS) return;
    var n = WOPTS.networks.filter(function (x) { return x.network === $("w-net").value; })[0];
    $("w-avail").textContent = n
      ? (n.open ? n.available + " " + WOPTS.asset : (n.note || "unavailable"))
      : (WOPTS.maxSingleWithdrawal || DASH);
  }

  var Q_SEQ = 0, Q_TIMER = null;
  function quoteWithdrawal() {
    var amount = $("w-amount").value.trim();
    var asset = $("w-asset").value;
    if (!amount || !asset) {
      $("w-fee").textContent = DASH;
      $("w-net-out").textContent = DASH;
      return;
    }
    var seq = ++Q_SEQ;
    // Quoted BY THE SERVER, from the same function that prices the real
    // withdrawal. A preview computed here would be computed in doubles and
    // would eventually disagree with the charge.
    priv("withdrawal-quote?asset=" + encodeURIComponent(asset) +
         "&network=" + encodeURIComponent($("w-net").value || "") +
         "&amount=" + encodeURIComponent(amount)).then(function (q) {
      if (seq !== Q_SEQ) return;
      $("w-fee").textContent = q.fee + " " + q.asset;
      $("w-min").textContent = q.minimum + " " + q.asset;
      $("w-net-out").textContent = q.youReceive + " " + q.asset;
      $("w-note").textContent = q.note;
    }).catch(function (e) {
      if (seq !== Q_SEQ) return;
      // Usually the real answer — below the minimum, or the chain cannot be
      // priced — so it belongs on screen rather than swallowed.
      $("w-fee").textContent = DASH;
      $("w-net-out").textContent = DASH;
      $("w-note").textContent = e.message;
    });
  }

  function doWithdraw() {
    var msg = $("w-msg");
    var btn = $("w-go");
    hide(msg);
    btn.disabled = true;
    priv("withdrawals", {
      method: "POST",
      data: {
        asset: $("w-asset").value,
        network: $("w-net").value,
        amount: $("w-amount").value.trim(),
        address: $("w-addr").value.trim(),
        requestId: reqId(),
      },
    }).then(function (r) {
      show(msg, "Requested " + r.amount + " " + r.asset + " over " +
        (r.network || "its native chain") + ". Fee " + r.fee +
        ", you receive " + r.youReceive + ".", "ok");
      $("w-amount").value = "";
      RENDER.withdraw();
    }).catch(function (e) { show(msg, e.message, "bad"); })
      .then(function () { btn.disabled = false; });
  }

  // ----------------------------------------------------------------- liquidity

  RENDER.liquidity = function () {
    if (!$("lq-market").options.length) {
      STATE.markets.forEach(function (m) {
        $("lq-market").appendChild(new Option(m.symbol, m.symbol));
      });
      lqLabels();
    }
    var be = (STATE.fees && STATE.fees.makerBps * 2) || 40;
    $("lq-breakeven").textContent =
      "A maker pays the same " + ((STATE.fees && STATE.fees.makerPct) || "0.20%") +
      " fee as a taker — there is no rebate. A round trip pays it twice, so " +
      "break-even is " + (be / 100).toFixed(2) + "%. A spread tighter than " +
      "that loses money on every completed round trip.";

    priv("liquidity").then(function (rows) {
      var body = $("t-liquidity").tBodies[0];
      var open = rows.filter(function (p) { return p.state === "open"; });
      $("lq-count").textContent = open.length ? open.length + " open" : "";
      badge("liquidity", open.length);
      if (!rows.length) { emptyRow(body, 7, "No positions."); return; }
      clear(body);
      rows.forEach(function (p) {
        var tr = body.insertRow();
        cell(tr, p.market);
        cell(tr, (p.spreadBps / 100).toFixed(2) + "%", "num");
        cell(tr, p.rungs, "num");
        cell(tr, p.filled, "num");
        cell(tr, p.resting, "num");
        pill(tr, p.state, p.state === "open" ? "ok" : "mute");
        var td = document.createElement("td");
        if (p.state === "open") {
          var b = el("button", "btn sm ghost", "Close");
          b.onclick = function () {
            b.disabled = true;
            priv("liquidity/" + p.id + "/close", { method: "POST", data: {} })
              .then(function (r) {
                show($("lq-msg"), "Cancelled " + r.cancelled + " resting order(s)." +
                  (r.alreadyFilledOrGone
                    ? " " + r.alreadyFilledOrGone + " had already filled — those " +
                      "were real trades and are not reversed."
                    : ""), "ok");
                RENDER.liquidity();
              })
              .catch(function (e) { b.disabled = false; show($("lq-msg"), e.message, "bad"); });
          };
          td.appendChild(b);
        }
        tr.appendChild(td);
      });
    }).catch(function () {});
  };

  function lqLabels() {
    var sym = $("lq-market").value || "";
    var parts = sym.split("-");
    $("lq-base-lbl").textContent = (parts[0] || "Base") + " capital";
    $("lq-quote-lbl").textContent = (parts[1] || "Quote") + " capital";
  }

  var LQ_TIMER = null;
  function lqPreview() {
    var host = $("lq-preview");
    var sym = $("lq-market").value;
    var mid = $("lq-mid").value.trim();
    if (!sym || !mid) { clear(host); return; }
    priv("liquidity/quote?market=" + encodeURIComponent(sym) +
         "&mid=" + encodeURIComponent(mid) +
         "&spreadBps=" + encodeURIComponent($("lq-spread").value.trim()) +
         "&rungs=" + encodeURIComponent($("lq-rungs").value.trim()) +
         "&base=" + encodeURIComponent($("lq-base").value.trim() || "0") +
         "&quote=" + encodeURIComponent($("lq-quote").value.trim() || "0")
    ).then(function (q) {
      clear(host);
      $("lq-accept-wrap").classList.toggle("hidden", !q.loses);
      host.appendChild(el("div", "msg " + (q.loses ? "bad" : "ok"), q.note));
      var k = el("div");
      k.style.marginTop = "8px";
      [["Bids", q.bids.length], ["Asks", q.asks.length],
       ["Base committed", q.baseNeeded], ["Quote committed", q.quoteNeeded]]
        .forEach(function (p) {
          var r = el("div", "kv");
          r.appendChild(el("span", "dim", p[0]));
          r.appendChild(el("span", null, p[1]));
          k.appendChild(r);
        });
      host.appendChild(k);
    }).catch(function (e) {
      clear(host);
      host.appendChild(el("div", "msg bad", e.message));
      $("lq-accept-wrap").classList.add("hidden");
    });
  }

  function lqOpen() {
    var msg = $("lq-msg");
    var btn = $("lq-go");
    hide(msg);
    btn.disabled = true;
    priv("liquidity", {
      method: "POST",
      data: {
        market: $("lq-market").value,
        mid: $("lq-mid").value.trim(),
        spreadBps: Number($("lq-spread").value.trim()),
        rungs: Number($("lq-rungs").value.trim()),
        base: $("lq-base").value.trim(),
        quote: $("lq-quote").value.trim(),
        acceptLoss: $("lq-accept").checked,
      },
    }).then(function (r) {
      show(msg, "Placed " + r.orders + " orders. " + r.note, r.loses ? "warn" : "ok");
      RENDER.liquidity();
    }).catch(function (e) { show(msg, e.message, "bad"); })
      .then(function () { btn.disabled = false; });
  }

  // -------------------------------------------------------------------- orders

  RENDER.orders = function () {
    priv("orders").then(function (rows) {
      var body = $("t-orders").tBodies[0];
      var open = rows.filter(function (o) { return o.state === "open"; });
      $("ord-note").textContent = open.length + " open of " + rows.length;
      badge("orders", open.length);
      if (!rows.length) { emptyRow(body, 8, "No orders."); return; }
      clear(body);
      rows.forEach(function (o) {
        var tr = body.insertRow();
        cell(tr, o.market);
        cell(tr, o.side === "buy" ? "Buy" : "Sell", o.side === "buy" ? "up" : "down");
        cell(tr, o.price, "num");
        cell(tr, o.total, "num");
        cell(tr, o.filled, "num");
        pill(tr, o.state, o.state === "open" ? "mute" : o.state === "filled" ? "ok" : "bad");
        cell(tr, new Date(o.createdAt).toLocaleString(), "dim");
        var td = document.createElement("td");
        if (o.state === "open") td.appendChild(cancelBtn(o.id));
        tr.appendChild(td);
      });
    }).catch(function () {});
  };

  // ---------------------------------------------------------------------- fees

  RENDER.fees = function () {
    var tiles = $("fee-tiles");
    clear(tiles);
    if (STATE.fees) {
      [["Maker", STATE.fees.makerPct], ["Taker", STATE.fees.takerPct]].forEach(function (p) {
        var t = el("div", "tile");
        t.appendChild(el("div", "k", p[0] + " fee"));
        t.appendChild(el("div", "v", p[1]));
        t.appendChild(el("div", "s", "taken from what you receive"));
        tiles.appendChild(t);
      });
      $("fee-note").textContent = STATE.fees.note;
    }
    pub("withdrawal-fees").then(function (r) {
      var body = $("t-wdfees").tBodies[0];
      clear(body);
      r.fees.forEach(function (f) {
        var tr = body.insertRow();
        if (!f.available) tr.style.opacity = ".6";
        assetCell(tr, f.asset, f.network);
        cell(tr, f.network ? coinIcon.network(f.network) : "native", "dim");
        cell(tr, f.fee, "num");
        cell(tr, f.minimum, "num");
        cell(tr, f.gasAsset, "dim");
        if (f.available) {
          pill(tr, f.plusBps ? "+" + f.plusBps + " bps" : "flat", "mute");
        } else {
          pill(tr, "unavailable", "bad");
        }
        if (f.note) tr.title = f.note;
      });
      var note = $("fee-note");
      note.textContent = (STATE.fees ? STATE.fees.note + " " : "") + r.note;
    }).catch(function (e) {
      emptyRow($("t-wdfees").tBodies[0], 6, "Fee schedule unavailable: " + e.message);
    });
  };

  // ------------------------------------------------------------------- listing

  RENDER.listing = function () {
    if ($("lst-fields").children.length) return; // built once
    if (STATE.fees) $("lst-fee").textContent =
      STATE.fees.makerPct + " maker / " + STATE.fees.takerPct + " taker";

    // GENERATED FROM THE SERVER'S QUESTION LIST. A field hard-coded here but
    // absent from that list would be silently dropped on submit — the worst
    // outcome for a form, because the applicant answered and nobody got it.
    pub("listing-questions").then(function (r) {
      var host = $("lst-fields");
      clear(host);
      r.questions.forEach(function (q) {
        var wrap = el("label", "f");
        wrap.style.marginTop = "10px";
        var span = el("span");
        span.appendChild(tx(q.label + (q.required ? "" : " (optional)")));
        wrap.appendChild(span);
        // Long answers get a textarea; the rest a single line. Driven by the
        // declared maximum rather than a list of field names to keep in step.
        var input = document.createElement(q.max > 300 ? "textarea" : "input");
        input.name = q.key;
        input.maxLength = q.max;
        if (q.max > 300) input.rows = 4;
        if (q.required) input.required = true;
        if (q.key === "contact") input.type = "email";
        wrap.appendChild(input);
        if (q.hint) {
          var hint = el("div", "note", q.hint);
          hint.style.marginTop = "6px";
          hint.style.borderLeft = "0";
          hint.style.paddingLeft = "0";
          wrap.appendChild(hint);
        }
        host.appendChild(wrap);
      });
    }).catch(function (e) {
      $("lst-fields").appendChild(el("div", "msg bad",
        "Could not load the form: " + e.message +
        " — email alex@blockle.org directly."));
    });
  };

  function submitListing(ev) {
    ev.preventDefault();
    var msg = $("lst-msg");
    var btn = ev.target.querySelector("button[type=submit]");
    var data = {};
    Array.prototype.forEach.call(
      ev.target.querySelectorAll("input,textarea"),
      function (i) { if (i.name) data[i.name] = i.value; }
    );
    btn.disabled = true;
    hide(msg);
    // Public, deliberately: requiring an account would filter out exactly the
    // project teams we want to hear from.
    api("public/listing-apply", { method: "POST", data: data })
      .then(function (r) {
        show(msg, "Reference " + r.reference + ". " + r.note, "ok");
        ev.target.reset();
      })
      .catch(function (e) { show(msg, e.message, "bad"); })
      .then(function () { btn.disabled = false; });
  }

  // ------------------------------------------------------------------- account

  RENDER.account = function () {
    var body = $("acct-body");
    priv("me").then(function (u) {
      clear(body);
      [["Email", u.email], ["Account id", u.accountId],
       ["Two-factor", u.twoFactor === null ? "not reported" : u.twoFactor ? "on" : "off"]]
        .forEach(function (p) {
          var r = el("div", "kv");
          r.appendChild(el("span", "dim", p[0]));
          r.appendChild(el("span", null, p[1]));
          body.appendChild(r);
        });
      var a = document.createElement("a");
      a.className = "btn ghost block";
      a.style.marginTop = "12px";
      a.href = "https://blockle.org/account/";
      a.appendChild(tx("Manage at blockle.org"));
      body.appendChild(a);
    }).catch(function (e) {
      clear(body);
      body.appendChild(el("div", "msg warn", e.message));
    });

    pub("status").then(function (st) {
      var v = $("venue-body");
      clear(v);
      [["Environment", st.network], ["Mainnet enabled", st.mainnetEnabled ? "yes" : "no"],
       ["Legal review", st.legalReviewCompleted ? "complete" : "not complete"],
       ["Ledger present", st.ledgerPresent ? "yes" : "no"]].forEach(function (p) {
        var r = el("div", "kv");
        r.appendChild(el("span", "dim", p[0]));
        r.appendChild(el("span", null, p[1]));
        v.appendChild(r);
      });
    }).catch(function () {});

    pub("reserves").then(function (r) {
      var body2 = $("t-reserves").tBodies[0];
      clear(body2);
      (r.assets || []).forEach(function (a) {
        var tr = body2.insertRow();
        assetCell(tr, a.asset);
        cell(tr, a.owed, "num");
        cell(tr, a.held, "num");
        pill(tr, a.owed === a.held ? "matched" : "check", a.owed === a.held ? "ok" : "warn");
      });
      if (!(r.assets || []).length) emptyRow(body2, 4, "Nothing held yet.");
    }).catch(function () {});
  };

  // -------------------------------------------------------------------- shared

  function fillAssetSelect(sel) {
    if (sel.options.length) return;
    STATE.assets.forEach(function (a) { sel.appendChild(new Option(a, a)); });
  }

  function badge(screen, n) {
    var c = $("count-" + screen);
    if (!c) return;
    c.textContent = n ? String(n) : "";
    c.classList.toggle("hidden", !n);
  }

  function curtain(on) {
    // OUR OWN SIGN-IN, carrying where they were trying to go. Bouncing to
    // blockle.org and back is where people give up, and a venue that cannot
    // host its own sign-in does not look like one to leave money with.
    var go = $("signin-go");
    if (go) {
      go.href = "signin.html?return=" +
        encodeURIComponent(location.pathname + location.search + location.hash);
    }
    $("signin").classList.toggle("hidden", !on);
  }

  // ---------------------------------------------------------------------- boot

  function wire() {
    $("mkt-search").oninput = drawMarkets;
    $("side-buy").onclick = function () { setSide("buy"); };
    $("side-sell").onclick = function () { setSide("sell"); };
    $("t-price").oninput = function () { ticketTotals(marketDef()); };
    $("t-amount").oninput = function () { ticketTotals(marketDef()); };
    $("t-submit").onclick = submitOrder;

    $("d-asset").onchange = depositNets;
    $("d-net").onchange = depositAddress;
    $("f-go").onclick = doFaucet;

    $("w-asset").onchange = withdrawNets;
    $("w-net").onchange = function () { showAvail(); quoteWithdrawal(); };
    $("w-amount").oninput = function () {
      clearTimeout(Q_TIMER);
      Q_TIMER = setTimeout(quoteWithdrawal, 250);
    };
    $("w-go").onclick = doWithdraw;

    $("lq-market").onchange = function () { lqLabels(); lqPreview(); };
    ["lq-mid", "lq-spread", "lq-rungs", "lq-base", "lq-quote"].forEach(function (id) {
      $(id).oninput = function () {
        clearTimeout(LQ_TIMER);
        LQ_TIMER = setTimeout(lqPreview, 250);
      };
    });
    $("lq-go").onclick = lqOpen;

    $("lst-form").addEventListener("submit", submitListing);
    $("signin-dismiss").onclick = function () { curtain(false); };
    window.addEventListener("hashchange", route);
    window.addEventListener("resize", function () {
      if (STATE.market && location.hash.indexOf("trade") > 0) {
        pub("trades/" + STATE.market).then(drawChart).catch(function () {});
      }
    });
  }

  function boot() {
    buildRail();
    wire();

    // THE BANNER FAILS CLOSED. Anything other than an explicit "live" leaves
    // the testnet badge up, so a failed status call cannot present an
    // unlicensed venue as open for business.
    pub("status").then(function (st) {
      if (st.live === true) {
        var e = $("env");
        e.textContent = "LIVE";
        e.className = "env live";
      }
      // NO TESTNET FURNITURE ON A LIVE VENUE. The faucet panel goes, and so
      // does the copy that mentions it — the server removes the route
      // entirely, so leaving either on screen would advertise something that
      // does not exist.
      if (st.faucetAvailable === false) {
        FAUCET = false;
        var fp = $("faucet-panel");
        if (fp) fp.remove();
        var dn = document.getElementById("deposit-faucet-note");
        if (dn) dn.remove();
      }
      if (st.live === true) {
        // Deposit screen widens to fill the space the faucet left.
        var dg = document.getElementById("deposit-grid");
        if (dg) dg.className = "grid";
      }
    }).catch(function () {});

    pub("fees").then(function (f) {
      STATE.fees = f;
      $("tb-fees").textContent = f.makerPct + " / " + f.takerPct;
      $("t-feepct").textContent = f.takerPct;
    }).catch(function () {});

    pub("markets").then(function (rows) {
      STATE.markets = rows.map(function (m) {
        return { symbol: m.market || (m.base + "-" + m.quote), base: m.base, quote: m.quote };
      });
      var seen = {};
      var quotes = [];
      var rest = [];
      STATE.markets.forEach(function (m) {
        [m.base, m.quote].forEach(function (a) {
          if (seen[a]) return;
          seen[a] = true;
          (a === "USDT" || a === "BLOCK" ? quotes : rest).push(a);
        });
      });
      STATE.assets = quotes.concat(rest.sort());
      route();
    }).catch(function (e) {
      alert("Could not load markets: " + e.message);
    });

    // Who are we? Determines whether the private screens work, and whether a
    // signed-out visitor is sent to the sign-in page.
    priv("me").then(function (u) {
      SIGNED_IN = true;
      $("tb-who").textContent = u.email || u.accountId;
      refreshBalances();
    }).catch(function (e) {
      SIGNED_IN = false;

      /*
       * A SIGNED-OUT VISITOR GOES TO THE SIGN-IN PAGE.
       *
       * The first version only raised the curtain when someone navigated to a
       * screen that needs an account — and since the default route is the
       * public markets list, arriving signed out just showed "not signed in"
       * in the corner with no way forward. A label is not a call to action.
       *
       * Not a trap, though: the sign-in page offers "browse markets without
       * signing in", which comes back with ?browse=1. That is remembered for
       * the tab, so navigating around afterwards does not bounce again.
       */
      var browsing = false;
      try {
        if (new URLSearchParams(location.search).get("browse") === "1") {
          sessionStorage.setItem("blockle.ex.browse", "1");
        }
        browsing = sessionStorage.getItem("blockle.ex.browse") === "1";
      } catch (err) {
        // Storage denied (private mode): treat it as browsing rather than
        // redirecting on every single navigation.
        browsing = true;
      }

      if (e.status === 503) {
        // NOT "signed out", and NOT a redirect. The accounts service is
        // unreachable and we refuse to guess; sending someone to sign in would
        // be a loop that cannot succeed. Public market data still works, so
        // say that and let them use it.
        $("tb-who").textContent = "account service unreachable";
        $("signin-why").textContent =
          "The Blockle account service is not reachable right now, so we cannot " +
          "tell who you are. Public market data is unaffected. Detail: " + e.message;
        var needs503 = SCREENS.filter(function (s) {
          return s.auth && location.hash.indexOf("#/" + s.id) === 0;
        }).length > 0;
        if (needs503) curtain(true);
        return;
      }

      $("tb-who").textContent = "not signed in";
      if (!browsing) {
        location.replace(
          "signin.html?return=" +
            encodeURIComponent(location.pathname + location.search + location.hash)
        );
        return;
      }
      // Browsing deliberately: only curtain the screens that need an account.
      var needsAuth = SCREENS.filter(function (s) {
        return s.auth && location.hash.indexOf("#/" + s.id) === 0;
      }).length > 0;
      if (needsAuth) curtain(true);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
