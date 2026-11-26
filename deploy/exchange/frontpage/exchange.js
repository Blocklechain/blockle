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

  /**
   * A coin mark as a node.
   *
   * coins.js is the only HTML this file injects (rule 3 at the top), and this
   * is the one place that does it, so there is a single line to audit rather
   * than one per table that shows an asset.
   */
  function coinMark(symbol, size) {
    var host = document.createElement("span");
    host.innerHTML = coinIcon(symbol, size);
    return host.firstChild;
  }

  /** Asset cell: mark, ticker, full name. */
  function assetCell(row, symbol, network) {
    var td = document.createElement("td");
    var wrap = el("div", "asset");
    wrap.appendChild(coinMark(symbol, 22));
    var txt = el("div");
    txt.appendChild(el("div", "tk", symbol));
    txt.appendChild(el("div", "nm", network ? coinIcon.network(network) : coinIcon.fullName(symbol)));
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
    // Per-request headers, for the authenticator code a withdrawal carries.
    // A HEADER rather than the body, matching the server, so that every route
    // which needs a second factor asks for it the same way.
    if (opts.headers) {
      for (var h in opts.headers) {
        if (opts.headers[h]) init.headers[h] = opts.headers[h];
      }
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
    markets: [],       // [{symbol, base, quote, baseDecimals, quoteDecimals, minBase, state}]
    tickers: [],
    // The assets the venue quotes IN, in the order it emitted them. Derived
    // from the market list rather than written down here — see mktQuoteOrder
    // for why a written-down copy is this subsystem's recurring bug.
    quotes: [],
    // Pairs with no market at all, each carrying the venue's own reason.
    // Empty until the server publishes them, and an empty list renders
    // nothing rather than an empty panel.
    notListed: [],
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
    api: '<path d="M9.5 7.5L5 12l4.5 4.5M14.5 7.5L19 12l-4.5 4.5"/>',
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
    { id: "api", label: "API", group: null, auth: true },
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
    // The coin pages are the public, crawlable side of the venue, and someone
    // inside the app wanting to know "what else do you list, and when" should
    // not have to leave through a search engine to find them.
    [["All coins + listing queue", "/coins"],
     ["Back to blockle.org", "https://blockle.org/"],
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
  //
  // THE MARKET FILTER.
  //
  // The product argument for it lives above #/markets in app.html. What
  // matters here is the shape of the code, and there is exactly one rule:
  //
  //   EVERYTHING BETWEEN THE "PURE BLOCK" SENTINELS BELOW IS DATA IN, DATA
  //   OUT. No DOM, no fetch, no storage, no clock.
  //
  // markets.harness.js slices that region out of THIS FILE and drives it, so
  // the filter's behaviour is checked against the bytes that ship rather than
  // against a copy of them that drifts. Put DOM work on the other side of the
  // sentinels; a `document.` reference inside the block breaks the harness,
  // which is the point.
  //
  // ===== MARKET FILTER — PURE BLOCK BEGINS =====

  function mktFilterDefault() {
    return { text: "", assets: [], quoteOnly: null, open: true, sort: "pair", cleared: false };
  }

  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function cmpPair(a, b) { return cmpStr(a.base, b.base) || cmpStr(a.quote, b.quote); }

  /* The words that mean "this book is taking orders". Everything else closes
   * it — see mktState. */
  var MKT_OPEN_WORDS = { open: 1, live: 1, trading: 1 };

  /**
   * Is this market accepting orders?
   *
   * TWO DEFAULTS, AND THEY POINT OPPOSITE WAYS ON PURPOSE.
   *
   * A state word this client has never heard of FAILS CLOSED. An unrecognised
   * status is not evidence that orders are accepted, and the one error that
   * costs a customer money is presenting a market that cannot settle as
   * tradeable.
   *
   * No state field AT ALL fails OPEN, because that is the server as it stands
   * today: /public/tickers emits no status and every market it lists is live.
   * Defaulting that to "closed" would paint the entire working venue as shut
   * on the deploy before the server learns to report state — a false alarm
   * covering a real list.
   */
  function mktState(row) {
    if (!row) return "open";
    var s = row.state || row.status;
    if (typeof s === "string" && s !== "") {
      return MKT_OPEN_WORDS[s.toLowerCase()] ? "open" : "closed";
    }
    if (row.closed === true) return "closed";
    if (typeof row.closed === "string" && row.closed !== "") return "closed";
    return "open";
  }

  /**
   * The venue's own sentence about why a market is shut.
   *
   * Printed verbatim rather than mapped to our own wording: the gate that
   * refuses an order and the row that explains the refusal must say the same
   * thing, or a support conversation becomes a translation exercise. The
   * fallback is deliberately vague because inventing a specific reason would
   * be worse than admitting we were not told one.
   */
  function mktReason(row) {
    if (!row) return "";
    var r = row.closedReason || row.reason || row.why;
    if (typeof r === "string" && r !== "") return r;
    if (typeof row.closed === "string" && row.closed !== "") return row.closed;
    return mktState(row) === "closed"
      ? "Not accepting new orders. Open orders can still be cancelled."
      : "";
  }

  function mktAssetName(sym) {
    return typeof coinIcon !== "undefined" && coinIcon && coinIcon.fullName
      ? String(coinIcon.fullName(sym)).toUpperCase()
      : String(sym || "").toUpperCase();
  }

  /**
   * Text match, on BOTH sides of the slash, by ticker and by full name.
   *
   * The predicate this replaces matched the pair string plus the BASE's full
   * name, so "Tether" found nothing at all and a search for a coin that is
   * somebody's quote found only the markets where it happened to be the base.
   * "Everything with DINGO in it" has to work from either side or the search
   * box is not the thing people reach for.
   */
  function mktMatch(row, q) {
    if (!q) return true;
    var pair = String(row.pair || (row.base + "/" + row.quote)).toUpperCase();
    if (pair.indexOf(q) >= 0) return true;
    if (String(row.market || "").toUpperCase().indexOf(q) >= 0) return true;
    if (mktAssetName(row.base).indexOf(q) >= 0) return true;
    if (mktAssetName(row.quote).indexOf(q) >= 0) return true;
    return false;
  }

  /**
   * The four facets, applied in one pass.
   *
   * `quoteOnly` and `assets` are an AND, not a choice between them: "involves
   * DOGE" plus "quoted in BTC" is DOGE/BTC, which is a reasonable thing to
   * ask for and is exactly what the two controls together say.
   */
  function mktFilter(rows, f) {
    var q = String(f.text || "").trim().toUpperCase();
    var want = f.assets || [];
    return rows.filter(function (r) {
      if (f.open && mktState(r) !== "open") return false;
      if (f.quoteOnly && r.quote !== f.quoteOnly) return false;
      if (want.length && want.indexOf(r.base) < 0 && want.indexOf(r.quote) < 0) return false;
      return mktMatch(r, q);
    });
  }

  /**
   * The spread, as a number.
   *
   * Percentages are presentational, so a double is fine here and nothing
   * derived from it is ever posted back or stored (rule 1 at the top of this
   * file). Note WHAT it is: a ratio of ONE market's own two sides. It is
   * dimensionless, so it cannot turn into a price denominated in some other
   * asset — which is the property that keeps this screen on the right side of
   * the BLOCK rule. See mktCounts.
   */
  function spreadPct(row) {
    var bid = row && row.bid, ask = row && row.ask;
    if (!bid || !ask) return null;
    var b = parseFloat(bid), a = parseFloat(ask);
    if (!(b > 0) || !(a > 0)) return null;
    return ((a - b) / a) * 100;
  }

  function spreadOf(bid, ask) {
    var p = spreadPct({ bid: bid, ask: ask });
    return p === null ? null : p.toFixed(3) + "%";
  }

  /**
   * Sorting. Three orders, all of them over fields the server populates.
   *
   * There is no "by volume" and no "by 24h change" because /public/tickers
   * hardcodes both to null. A sort control over a field the server never
   * fills is a control that does nothing and looks like it did.
   */
  function mktSort(rows, how) {
    var out = rows.slice();
    if (how === "spread") {
      out.sort(function (a, b) {
        var x = spreadPct(a), y = spreadPct(b);
        // A book with only one side has NO spread, which is not a tight one.
        // Those rows go last rather than sorting as zero and pretending to be
        // the best markets on the venue.
        if (x === null && y === null) return cmpPair(a, b);
        if (x === null) return 1;
        if (y === null) return -1;
        return (x - y) || cmpPair(a, b);
      });
      return out;
    }
    if (how === "traded") {
      out.sort(function (a, b) {
        return ((b.last ? 1 : 0) - (a.last ? 1 : 0)) || cmpPair(a, b);
      });
      return out;
    }
    out.sort(cmpPair);
    return out;
  }

  /**
   * Per-asset market counts, for the chips.
   *
   * NOTE WHAT IS COUNTED AND WHAT NEVER IS. These are counts of MARKETS —
   * never a price, never a total, and never anything obtained by combining
   * one market's price with another's. That is not tidiness: BLOCK is priced
   * only in BLOCK on this venue, and a screen that starts doing arithmetic
   * ACROSS markets can produce a dollar figure for BLOCK by one
   * multiplication without anybody deciding to. There is no rate or
   * conversion helper anywhere on this screen, and markets.harness.js asserts
   * there is not.
   *
   * Counted over the STATUS-SCOPED rows and deliberately not over the asset-
   * or text-filtered ones: a count that moved when you pressed a chip could
   * not be used to decide which chip to press next.
   */
  function mktCounts(rows) {
    var involves = {}, quoted = {}, assets = [];
    rows.forEach(function (r) {
      [r.base, r.quote].forEach(function (a) {
        if (involves[a] === undefined) { involves[a] = 0; assets.push(a); }
        involves[a] += 1;
      });
      quoted[r.quote] = (quoted[r.quote] || 0) + 1;
    });
    assets.sort(cmpStr);
    return { involves: involves, quoted: quoted, assets: assets };
  }

  /**
   * Which assets are quotes, in the venue's order.
   *
   * DERIVED, NOT LISTED. An asset is a quote here because some market quotes
   * in it — there is no array of quote tickers in this file any more. The one
   * that used to be here (`a === "USDT" || a === "BLOCK"`, ordering the asset
   * pickers) was the fifth independent copy of the venue's quote list, and
   * the copies drifting apart is this subsystem's recurring bug rather than a
   * hypothetical one. `hint` carries the order /public/markets emitted, which
   * is the venue's own seniority; anything the hint does not mention falls
   * back to how many markets quote in it.
   */
  function mktQuoteOrder(rows, hint) {
    var counts = mktCounts(rows).quoted;
    var order = hint || [];
    return Object.keys(counts).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia < 0) ia = order.length;
      if (ib < 0) ib = order.length;
      return (ia - ib) || (counts[b] - counts[a]) || cmpStr(a, b);
    });
  }

  /**
   * The chip rail: two clusters, both derived.
   *
   * Quotes first, because those are the chips that answer the question people
   * arrive with, then everything that only ever appears as a base. Built from
   * ALL rows rather than the filtered ones so a quote whose every market is
   * currently closed still gets a chip reading 0 — "ETH 0" beside its reason
   * is the honest answer to "where are my ETH pairs", and hiding the chip is
   * not an answer at all.
   */
  function mktRail(allRows, order) {
    var all = mktCounts(allRows);
    var quotes = [], coins = [];
    all.assets.forEach(function (a) { (all.quoted[a] ? quotes : coins).push(a); });
    quotes.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia < 0) ia = order.length;
      if (ib < 0) ib = order.length;
      return (ia - ib) || cmpStr(a, b);
    });
    coins.sort(cmpStr);
    var out = [];
    if (quotes.length) out.push({ label: "Quotes", assets: quotes });
    if (coins.length) out.push({ label: "Coins", assets: coins });
    return out;
  }

  /** Rows cut into quote groups, in the venue's quote order. */
  function mktGroups(rows, order) {
    var byQuote = {}, qs = [];
    rows.forEach(function (r) {
      if (!byQuote[r.quote]) { byQuote[r.quote] = []; qs.push(r.quote); }
      byQuote[r.quote].push(r);
    });
    qs.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia < 0) ia = order.length;
      if (ib < 0) ib = order.length;
      return (ia - ib) || cmpStr(a, b);
    });
    return qs.map(function (q) { return { quote: q, rows: byQuote[q] }; });
  }

  /**
   * The best market to send someone to for an asset, or null if there is not
   * one.
   *
   * NULL IS A REAL ANSWER and callers must handle it. An asset can be held,
   * deposited and withdrawn while having no open market — that is the whole
   * point of a settlement gate — so "where do I trade this" sometimes has no
   * answer, and offering a button anyway lands on a 404 or on a book that
   * refuses orders. Open markets only, most senior quote first, and the
   * asset's own markets before the ones where it is somebody's quote.
   */
  function mktTradeLink(markets, asset, order) {
    var mine = (markets || []).filter(function (m) {
      return (m.base === asset || m.quote === asset) && mktState(m) === "open";
    });
    if (!mine.length) return null;
    var rank = function (m) {
      var i = (order || []).indexOf(m.quote);
      return (i < 0 ? (order || []).length : i) + (m.base === asset ? 0 : 100);
    };
    mine.sort(function (a, b) { return (rank(a) - rank(b)) || cmpStr(a.symbol, b.symbol); });
    return mine[0].symbol || (mine[0].base + "-" + mine[0].quote);
  }

  /** One change to the filter, in, one whole filter out. */
  function mktApply(f, change) {
    var next = {
      text: f.text, assets: (f.assets || []).slice(), quoteOnly: f.quoteOnly,
      open: f.open, sort: f.sort, cleared: false,
    };
    if (change.clear) {
      next.text = ""; next.assets = []; next.quoteOnly = null; next.open = true;
      return next;
    }
    if (change.text !== undefined) {
      next.text = change.text;
      /*
       * TYPING CLEARS THE FACETS, AND THE COUNT LINE SAYS SO.
       *
       * The one real failure mode of a faceted filter is a search that comes
       * back empty because a chip nobody remembers pressing is still pressed
       * — at which point the search box looks broken and the chip is the
       * thing to undo. Clearing silently would be its own trap, so the
       * clearing is announced rather than hidden; see mktSummary.
       */
      if (String(change.text).trim() !== "" && (next.assets.length || next.quoteOnly)) {
        next.assets = [];
        next.quoteOnly = null;
        next.cleared = true;
      }
    }
    if (change.toggleAsset) {
      var i = next.assets.indexOf(change.toggleAsset);
      if (i >= 0) next.assets.splice(i, 1); else next.assets.push(change.toggleAsset);
    }
    if (change.assets !== undefined) next.assets = change.assets.slice();
    if (change.quoteOnly !== undefined) next.quoteOnly = change.quoteOnly;
    if (change.open !== undefined) next.open = !!change.open;
    if (change.sort !== undefined) next.sort = change.sort;
    return next;
  }

  /**
   * The count line, which is also the screen reader's only notification that
   * anything happened. It names the active facets, so "showing 3" is never a
   * mystery, and it is the place the silent facet-clear above becomes audible.
   */
  function mktSummary(n, f) {
    var bits = [n.open + " open"];
    if (n.closed) bits.push(n.closed + " closed");
    bits.push("showing " + n.shown);
    if (f.quoteOnly) bits.push("quoted in " + f.quoteOnly);
    // "Quoted in BTC · involving BTC" says the same thing twice: an asset
    // named by the quote clause is dropped from the involves clause.
    var inv = (f.assets || []).filter(function (a) { return a !== f.quoteOnly; });
    if (inv.length) bits.push("involving " + inv.join(", "));
    if (f.cleared) bits.push("filters cleared by search");
    return bits.join(" · ");
  }

  /**
   * Why the list is empty, naming the facet that did it.
   *
   * "No market matches that" was adequate for one text box. With four facets
   * live it is a riddle, and the hidden-closed facet is the one people forget
   * they are inside — so it is named even though they never touched it.
   */
  function mktEmptyWhy(f) {
    var why = [];
    if (String(f.text || "").trim()) why.push('nothing matches "' + String(f.text).trim() + '"');
    if (f.quoteOnly) why.push("nothing here is quoted in " + f.quoteOnly);
    if (f.assets.length) why.push("nothing here involves " + f.assets.join(" or "));
    if (f.open) why.push("closed markets are hidden");
    if (!why.length) return "This venue lists no markets yet.";
    return why.join(", and ") + ".";
  }

  /**
   * The refusals, split into the two kinds that need different wording.
   *
   * A pair blocked by an asset that cannot settle YET makes a different
   * promise from a pair whose price cannot be expressed in the quote's
   * decimals at all: the first opens when a rail opens, the second never
   * will. One heading over both would make the permanent refusals look
   * temporary, which is the more expensive of the two misreadings — somebody
   * waits for a market that is never coming.
   */
  function mktRefusals(list) {
    var never = [], byAsset = {}, order = [];
    (list || []).forEach(function (r) {
      if (!r || !r.base || !r.quote) return;
      var pair = r.base + "/" + r.quote;
      var why = r.why || r.reason || r.closedReason || "";
      var by = r.blockedBy || r.pending || r.waitingOn;
      if (!by) {
        never.push({ pair: pair, base: r.base, quote: r.quote, why: why });
        return;
      }
      if (!byAsset[by]) { byAsset[by] = { by: by, why: why, pairs: [] }; order.push(by); }
      if (!byAsset[by].why && why) byAsset[by].why = why;
      byAsset[by].pairs.push(pair);
    });
    never.sort(function (a, b) { return cmpStr(a.pair, b.pair); });
    order.sort(cmpStr);
    return { never: never, pending: order.map(function (k) { return byAsset[k]; }) };
  }

  /**
   * The inline note under a narrowed list.
   *
   * Without this, "I asked for everything against BTC and got three rows"
   * reads as a broken filter rather than as decimal arithmetic. It surfaces
   * the same refusals the panel below holds, at the moment the short list
   * makes them a question, so nobody has to go opening panels to find out
   * whether the filter worked.
   */
  function mktRefusalNote(refusals, f) {
    var want = (f.assets || []).slice();
    if (f.quoteOnly && want.indexOf(f.quoteOnly) < 0) want.push(f.quoteOnly);
    if (!want.length) return "";
    var hit = refusals.never.filter(function (r) {
      return f.quoteOnly
        ? r.quote === f.quoteOnly
        : want.indexOf(r.base) >= 0 || want.indexOf(r.quote) >= 0;
    });
    if (!hit.length) return "";
    var whys = [];
    hit.forEach(function (r) { if (r.why && whys.indexOf(r.why) < 0) whys.push(r.why); });
    var label = hit.length + (hit.length === 1 ? " more pair" : " more pairs") +
      " cannot be listed: " + hit.map(function (r) { return r.pair; }).join(", ");
    /*
     * ONE REASON INLINE; THE REST STAY IN THE PANEL.
     *
     * The refusals that share a cause are worded per pair by the venue, so
     * concatenating them gives four near-identical sentences differing only
     * in a coin name. That is a wall, and a wall is skipped — which would
     * defeat the whole point of putting the explanation where the short list
     * raises the question.
     */
    if (whys.length === 1) return label + " — " + whys[0];
    if (whys.length > 1) return label + ". Each one's reason is in the list below.";
    return label + ".";
  }

  // ===== MARKET FILTER — PURE BLOCK ENDS =====

  var RENDER = {};

  /*
   * THE FILTER IS REMEMBERED FOR THE TAB, NOT PUT IN THE URL.
   *
   * route() parses `#/markets` strictly, so hanging query parameters off the
   * hash would make every screen's router care about this screen's facets.
   * sessionStorage also expires it at the right time: reopening the app
   * tomorrow to a list with three chips pressed reads as a broken market
   * list, not as a remembered preference.
   */
  var MKT_STORE = "blockle.ex.mkt.filter";

  function mktRestore() {
    var f = mktFilterDefault();
    try {
      var raw = sessionStorage.getItem(MKT_STORE);
      if (!raw) return f;
      var s = JSON.parse(raw);
      if (s && typeof s === "object") {
        if (Array.isArray(s.assets)) {
          f.assets = s.assets.filter(function (a) { return typeof a === "string"; });
        }
        if (typeof s.quoteOnly === "string") f.quoteOnly = s.quoteOnly;
        if (typeof s.open === "boolean") f.open = s.open;
        if (typeof s.sort === "string") f.sort = s.sort;
        // THE TEXT IS NOT RESTORED. A search box that comes back with words in
        // it, over a list that is consequently short, is the hardest state to
        // recognise as a filter rather than an outage.
      }
    } catch (e) { /* storage denied (private mode): the default filter is fine */ }
    return f;
  }

  function mktSave() {
    try {
      sessionStorage.setItem(MKT_STORE, JSON.stringify({
        assets: MKT.assets, quoteOnly: MKT.quoteOnly, open: MKT.open, sort: MKT.sort,
      }));
    } catch (e) { /* storage denied */ }
  }

  var MKT = mktRestore();

  /** mktTradeLink against the live market list. */
  function tradeLinkFor(asset) {
    return mktTradeLink(STATE.markets, asset, STATE.quotes);
  }

  function mktSet(change) {
    MKT = mktApply(MKT, change);
    mktSave();
    drawMarkets();
  }

  /**
   * The table's column count, read off the live header row.
   *
   * It used to be the literal 7, written out three times — in app.html's
   * colspan and in two emptyRow calls — so dropping a column left the
   * loading, empty and error rows spanning the wrong width. One of the three
   * is now the source and the other two read it.
   */
  function mktCols() {
    var head = $("t-markets").tHead;
    return (head && head.rows[0] && head.rows[0].cells.length) || 1;
  }

  /*
   * FOCUS HAS TO SURVIVE THE POLL, AND THAT IS THIS SCREEN'S PROBLEM ALONE.
   *
   * This screen re-renders on a timer — every 8 seconds, from route() — and
   * the render rebuilds the chip rail and the entire tbody from scratch.
   * Anything the keyboard was standing on is destroyed, so focus falls back
   * to <body> and the next Tab starts again from the top of the document.
   *
   * THIS GOT WORSE BY BEING FIXED, which is why it needs saying. The old
   * markets screen had nothing focusable in the table at all: the row was a
   * <tr onclick> and the Trade affordance was a <span> styled as a button. It
   * could not lose focus because it could never hold any. Turning those into
   * real links is what makes the screen usable by keyboard, and it is also
   * what created thirty-odd tab stops that a timer wipes mid-sentence. A
   * keyboard user would reach row four, lose their place, and reasonably
   * conclude the list was not navigable after all — so the two changes only
   * work as a pair.
   *
   * The identity is a `data-focus` key rather than an index, because the row
   * a user is standing on must come back even when the poll reorders the list
   * or a market closes underneath them. If the key is gone, focus is NOT
   * moved somewhere approximate: landing on a neighbouring market's Trade
   * link is worse than landing nowhere, since the next keypress would act on
   * the wrong market.
   *
   * Only one attribute carries this. The chips used to hold a second
   * `data-asset` purely so the rail could restore itself, and two identity
   * attributes on one element is how they come to disagree.
   */
  function mktFocusKey() {
    var a = document.activeElement;
    if (!a || !a.getAttribute) return null;
    return a.getAttribute("data-focus") || null;
  }

  function mktKeepFocus(key) {
    if (!key) return;
    var back = $("s-markets").querySelector('[data-focus="' + key + '"]');
    if (!back || !back.focus) return;
    // preventScroll because the element is being put back where it already
    // was: the user can see it, and a scroll correction arriving eight
    // seconds into reading a row is its own interruption. Browsers that do
    // not know the option ignore it and focus normally.
    back.focus({ preventScroll: true });
  }

  /**
   * One row per market, merging what the two public endpoints each know.
   *
   * /public/tickers carries the prices and /public/markets carries the
   * definition; status and its reason may arrive on either, so both are read
   * and whichever has an answer wins. The market list is also where `symbol`
   * lives — this used to read `m.market`, a field /public/markets does not
   * emit, and got away with it only because the symbol happens to be exactly
   * base + "-" + quote.
   */
  function mktRows() {
    var defs = {};
    STATE.markets.forEach(function (m) { defs[m.symbol] = m; });
    return STATE.tickers.map(function (t) {
      var sym = t.market || (t.base + "-" + t.quote);
      var d = defs[sym] || {};
      return {
        market: sym,
        pair: t.pair || (t.base + "/" + t.quote),
        base: t.base,
        quote: t.quote,
        last: t.last,
        bid: t.bid,
        ask: t.ask,
        state: t.state || t.status || d.state || d.status,
        closed: t.closed !== undefined ? t.closed : d.closed,
        closedReason: t.closedReason || t.reason || t.why || d.closedReason || d.reason,
      };
    });
  }

  RENDER.markets = function () {
    pub("tickers").then(function (rows) {
      STATE.tickers = Array.isArray(rows) ? rows : [];
      drawMarkets();
    }).catch(function (e) {
      emptyRow($("t-markets").tBodies[0], mktCols(), "Markets unavailable: " + e.message);
      $("mkt-count").textContent = "market data unavailable";
    });
  };

  function drawMarkets() {
    var all = mktRows();
    var cols = mktCols();
    var body = $("t-markets").tBodies[0];
    // Read before anything is torn down; handed back at every exit below.
    var focused = mktFocusKey();

    // Status scope first. The chips describe the set they are about to filter.
    var openRows = all.filter(function (r) { return mktState(r) === "open"; });
    var scoped = MKT.open ? openRows : all;
    var closedN = all.length - openRows.length;

    var order = mktQuoteOrder(all, STATE.quotes);
    drawChips(all, scoped, order);

    var rows = mktSort(mktFilter(all, MKT), MKT.sort);

    $("mkt-count").textContent =
      mktSummary({ open: openRows.length, closed: closedN, shown: rows.length }, MKT);

    var cn = $("mkt-closedn");
    cn.textContent = closedN + " closed";
    // The `hidden` CLASS, not the attribute: `.pill` sets display:inline-block
    // and wins over the user-agent's [hidden] rule, so the attribute alone
    // leaves the badge on screen.
    cn.className = closedN ? "pill warn" : "pill warn hidden";
    $("mkt-open").setAttribute("aria-pressed", MKT.open ? "true" : "false");
    $("mkt-all").setAttribute("aria-pressed", MKT.open ? "false" : "true");
    if ($("mkt-sort").value !== MKT.sort) $("mkt-sort").value = MKT.sort;
    drawQuoteOnly();

    var refusals = mktRefusals(STATE.notListed);
    drawRefusals(refusals);
    var note = mktRefusalNote(refusals, MKT);
    $("mkt-note").textContent = note;
    $("mkt-note").className = note ? "msg" : "msg hidden";

    clear(body);
    if (!rows.length) {
      emptyRow(body, cols, mktEmptyWhy(MKT));
      var td = body.rows[0].cells[0];
      td.appendChild(document.createTextNode(" "));
      var undo = el("button", "btn sm ghost", "Clear filters");
      undo.type = "button";
      undo.setAttribute("data-focus", "clear");
      undo.onclick = function () {
        $("mkt-search").value = "";
        mktSet({ clear: true });
      };
      td.appendChild(undo);
      mktKeepFocus(focused);
      return;
    }

    /*
     * GROUPED BY QUOTE, BUT ONLY WHEN THE ORDER IS ALPHABETICAL.
     *
     * Four labelled groups are readable where a flat 28 rows is not, and a
     * flat 55 once ETH and SOL open definitely is not. But sorting by spread
     * and then cutting the result into groups defeats the sort — the whole
     * point of that order is comparing across quotes — so grouping and the
     * other two orders are exclusive. No pagination either: re-rendering 55
     * rows per keystroke costs nothing, and a market list you have to page
     * through is a market list nobody scans.
     */
    if (MKT.sort === "pair") {
      mktGroups(rows, order).forEach(function (g) {
        groupRow(body, g, cols);
        g.rows.forEach(function (r) { marketRow(body, r); });
      });
    } else {
      rows.forEach(function (r) { marketRow(body, r); });
    }

    mktKeepFocus(focused);
  }

  /* Rebuilding the rail every poll would steal focus from a keyboard user
   * part-way along the chips. It is drawMarkets that hands focus back, for
   * this rail and the table together — see mktFocusKey. */
  function drawChips(all, scoped, order) {
    var rail = $("mkt-chips");
    var counts = mktCounts(scoped).involves;
    clear(rail);

    var lead = el("div", "cluster");
    lead.appendChild(chipNode("", "All", scoped.length,
      !MKT.assets.length && !MKT.quoteOnly));
    rail.appendChild(lead);

    mktRail(all, order).forEach(function (c) {
      var box = el("div", "cluster");
      box.appendChild(el("span", "lbl", c.label));
      c.assets.forEach(function (a) {
        box.appendChild(chipNode(a, a, counts[a] || 0, MKT.assets.indexOf(a) >= 0));
      });
      rail.appendChild(box);
    });
  }

  /**
   * One asset chip. A real <button> with aria-pressed, which is the control
   * the stylesheet's segmented pattern already uses, so screen readers get a
   * toggle rather than a link that does not navigate.
   */
  function chipNode(asset, label, count, on) {
    var b = el("button", "chip" + (count ? "" : " none"));
    b.type = "button";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    // The identity the poll uses to hand focus back. "chip:" with nothing
    // after it is the All chip, which is a real chip with an empty asset.
    b.setAttribute("data-focus", "chip:" + asset);
    if (asset) b.appendChild(coinMark(asset, 14));
    b.appendChild(el("span", null, label));
    b.appendChild(el("span", "c", String(count)));
    // The count joins the accessible name, so the chip is announced as
    // "BTC, 3 markets" rather than as two unrelated strings.
    b.setAttribute("aria-label", label + ", " + count + (count === 1 ? " market" : " markets"));
    b.onclick = asset
      ? function () { mktSet({ toggleAsset: asset }); }
      : function () { mktSet({ assets: [], quoteOnly: null }); };
    return b;
  }

  /**
   * The quoted-in facet, as a thing you can see and dismiss on its own.
   *
   * THIS EXISTS BECAUSE THE FACET OUTLIVES THE CONTROL THAT SETS IT.
   *
   * "Quoted in BTC" is set from a quote group's header, which is the right
   * place for it — already beside the thing it describes, so both readings of
   * a chip (involves, versus quoted in) are one click apart with no mode
   * control to explain. But those headers only exist under Pair A-Z, because
   * cutting a spread-sorted list into groups defeats the sort. So the facet
   * set under the default order survived a change of sort into a state you
   * could read in the count line and could NOT undo, short of also dropping
   * your asset chips with the All chip. A filter you cannot see is a filter
   * you cannot turn off, and a short list with no visible cause is the one
   * failure mode a faceted filter has.
   *
   * It is deliberately NOT a toggle. `aria-pressed` is pinned true in the
   * markup: the button only ever exists while the facet is on and its only
   * action is to clear it, so announcing it as a two-state control would be
   * describing an off state that is never reachable from here. The group
   * header's own "All quotes" button is the symmetric control; this is the
   * escape hatch that works in every order.
   */
  function drawQuoteOnly() {
    var b = $("mkt-qonly");
    var q = MKT.quoteOnly;
    clear(b);
    if (!q) {
      // The `hidden` CLASS rather than the attribute: `.chip` sets
      // display:inline-flex, which beats the user-agent's [hidden] rule and
      // would leave a stale, empty token sitting in the bar.
      b.className = "chip qonly hidden";
      b.removeAttribute("aria-label");
      b.onclick = null;
      return;
    }
    b.className = "chip qonly";
    b.appendChild(coinMark(q, 14));
    b.appendChild(el("span", null, "Quoted in " + q));
    // A multiplication sign, not an "x": this is a dismiss glyph and the
    // letter reads as part of the ticker next to it. It is marked
    // aria-hidden because the accessible name below already says "remove".
    var x = el("span", "x", "×");
    x.setAttribute("aria-hidden", "true");
    b.appendChild(x);
    b.setAttribute("aria-label", "Remove the quoted in " + q + " filter");
    b.setAttribute("data-focus", "qonly");
    b.onclick = function () { mktSet({ quoteOnly: null }); };
  }

  function groupRow(body, g, cols) {
    var tr = body.insertRow();
    tr.className = "grp";
    var td = document.createElement("td");
    td.colSpan = cols;
    td.appendChild(el("span", "lbl",
      g.quote + " · " + g.rows.length + (g.rows.length === 1 ? " market" : " markets")));

    /*
     * "ONLY" IS HOW "QUOTED IN X" IS REACHED.
     *
     * The chips mean INVOLVES, which is the reading people want most of the
     * time and the only one that works for an asset that is mostly somebody
     * else's quote. This is the other reading, and living on the group header
     * means it is already next to the thing it describes — so both readings
     * are one click apart with no extra mode control, and there is no
     * quote-only facet showing misleading zeros.
     */
    var mine = MKT.quoteOnly === g.quote;
    var only = el("button", "btn sm ghost", mine ? "All quotes" : "Only");
    only.type = "button";
    only.setAttribute("data-focus", "only:" + g.quote);
    only.setAttribute("aria-label", mine
      ? "Show markets in every quote again"
      : "Show only markets quoted in " + g.quote);
    only.onclick = function () { mktSet({ quoteOnly: mine ? null : g.quote }); };
    td.appendChild(only);
    tr.appendChild(td);
  }

  function marketRow(body, t) {
    var open = mktState(t) === "open";
    var tr = body.insertRow();
    if (!open) tr.className = "off";

    /*
     * THE PAIR, NOT THE BASE.
     *
     * This cell used to render the base alone, which with six quotes gives up
     * to six rows all reading "BTC", told apart only by a column five places
     * to the right.
     *
     * It is also a REAL LINK now. It was a <tr onclick> with a <span> styled
     * as a button, so the entire markets screen was unreachable by keyboard —
     * a span takes no focus and this origin's CSP (script-src 'self', no
     * unsafe-inline) blocks an onclick attribute outright. A hash href needs
     * neither script nor an exception. Closed rows get no link at all: the
     * thing you cannot do should not look clickable.
     */
    var td = document.createElement("td");
    var inner = open ? el("a", "pair") : el("div", "pair");
    if (open) {
      inner.href = "#/trade/" + t.market;
      inner.setAttribute("data-focus", "pair:" + t.market);
    }
    var wrap = el("div", "pairc");
    var marks = el("div", "marks");
    marks.appendChild(coinMark(t.base, 22));
    marks.appendChild(coinMark(t.quote, 22));
    wrap.appendChild(marks);
    var txt = el("div");
    txt.appendChild(el("div", "tk", t.base + "/" + t.quote));
    txt.appendChild(el("div", "nm", coinIcon.fullName(t.base)));
    wrap.appendChild(txt);
    inner.appendChild(wrap);
    td.appendChild(inner);
    tr.appendChild(td);

    cell(tr, t.last, "num");
    cell(tr, t.bid, "num up");
    cell(tr, t.ask, "num down");
    var sp = spreadPct(t);
    cell(tr, sp === null ? null : sp.toFixed(3) + "%", "num dim");

    // The old "Quote" column is gone: the quote is in the pair cell, and this
    // space buys the one fact a growing market list most needs to carry.
    var std = document.createElement("td");
    std.appendChild(el("span", "pill " + (open ? "ok" : "warn"), open ? "Open" : "Closed"));
    if (!open) std.appendChild(el("div", "why", mktReason(t)));
    tr.appendChild(std);

    var atd = document.createElement("td");
    if (open) {
      var a = el("a", "btn sm ghost", "Trade");
      a.href = "#/trade/" + t.market;
      a.setAttribute("data-focus", "trade:" + t.market);
      atd.appendChild(a);
    } else {
      // Cancelling is never gated, by design, so say which half still works
      // rather than leaving the cell blank and the question open.
      atd.appendChild(el("span", "lbl", "Cancels only"));
    }
    tr.appendChild(atd);
  }

  function drawRefusals(r) {
    var nb = $("t-never").tBodies[0];
    clear(nb);
    r.never.forEach(function (x) {
      var tr = nb.insertRow();
      cell(tr, x.pair);
      cell(tr, x.why, "wrap");
    });
    $("mkt-never").className = r.never.length ? "panel" : "panel hidden";
    $("mkt-never-n").textContent = r.never.length
      ? r.never.length + (r.never.length === 1 ? " pair" : " pairs") : "";

    var pb = $("t-pending").tBodies[0];
    clear(pb);
    var n = 0;
    r.pending.forEach(function (g) {
      n += g.pairs.length;
      var tr = pb.insertRow();
      cell(tr, g.by);
      cell(tr, g.pairs.join(", "), "wrap");
      cell(tr, g.why, "wrap");
    });
    $("mkt-pending").className = n ? "panel" : "panel hidden";
    $("mkt-pending-n").textContent = n ? n + (n === 1 ? " pair" : " pairs") : "";
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
        /*
         * THE LINK IS RESOLVED, NOT BUILT.
         *
         * This used to assemble `b.asset + "-USDT"` and suppress it only for
         * USDT itself. That is a guess about the symbol — it is wrong for any
         * asset whose USDT market is the other way round (USDC-USDT is the
         * live one, not USDT-USDC), wrong for an asset with no USDT market at
         * all, and wrong for every market the venue has closed. All three
         * produce a button that leads to a 404 or a book nobody can trade on.
         * Resolving it against the market list instead means the button
         * exists when, and only when, there is somewhere for it to go.
         */
        var dest = tradeLinkFor(b.asset);
        if (dest) {
          var a = document.createElement("a");
          a.className = "btn sm ghost";
          a.href = "#/trade/" + dest;
          a.appendChild(tx("Trade"));
          td.appendChild(a);
        }
        tr.appendChild(td);
      });
    });
  };

  // ------------------------------------------------------------------- deposit

  /**
   * Every deposit address for this account, loaded without being asked.
   *
   * The server provisions anything missing on an OPEN chain and reports a
   * CLOSED chain with its reason, so this renders three distinct states rather
   * than two: an address, "closed until gas", or a failure that names itself.
   * Collapsing the last two into a blank cell is what sends someone to support.
   */
  function drawDepositAddresses() {
    var body = $("t-depaddr").tBodies[0];
    priv("deposit-addresses").then(function (r) {
      var rows = r.addresses || [];
      clear(body);
      var open = 0;
      rows.forEach(function (a) {
        if (a.open) open++;
        var tr = body.insertRow();
        cell(tr, a.asset);
        cell(tr, a.network || "native");

        var addr = tr.insertCell();
        if (a.address) {
          // user-select:all so a tap selects the whole address — a
          // half-copied address is a lost deposit.
          var code = el("code", "");
          code.textContent = a.address;
          code.style.userSelect = "all";
          code.style.wordBreak = "break-all";
          addr.appendChild(code);
          if (a.memoRequired && a.memo) {
            var m = el("div", "note");
            m.textContent = "memo REQUIRED: " + a.memo;
            addr.appendChild(m);
          }
        } else {
          addr.appendChild(el("span", "dim", "—"));
        }

        var st = tr.insertCell();
        if (a.open) {
          st.appendChild(el("span", "ok", "open"));
        } else {
          // The reason, in full. It is the actionable part.
          st.appendChild(el("span", "dim", a.reason || "closed"));
        }
      });
      if (!rows.length) {
        var tr0 = body.insertRow();
        var td = tr0.insertCell();
        td.colSpan = 4;
        td.className = "empty";
        td.textContent = "No chains configured.";
      }
      $("d-all-note").textContent = open + " of " + rows.length + " chains open";
      $("d-all-foot").textContent = r.note || "";
    }).catch(function (e) {
      // NEVER an empty table on failure: that reads as "you have no addresses".
      clear(body);
      var tr = body.insertRow();
      var td = tr.insertCell();
      td.colSpan = 4;
      td.className = "empty";
      td.textContent = e.message;
      $("d-all-note").textContent = "unavailable";
    });
  }

  RENDER.deposit = function () {
    drawDepositAddresses();
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
          // A NATIVE ENTRY CARRIES NO CHAIN ID. For a single-chain asset the
          // server reports `network` as the SYMBOL — a label for the row, not
          // a chain — so sending it back produced ?asset=BTC&network=BTC,
          // which the deposit path refuses (a qualified id for a single-chain
          // coin means the caller confused it with a token). That 400'd every
          // single-chain asset, so no address could ever be issued.
          sel.appendChild(new Option(n.label, n.native ? "" : n.network));
        });
      }
      depositAddress();
    }).catch(function () {});
  }

  function depositAddress() {
    var out = $("d-out");
    clear(out);
    var asset = $("d-asset").value, net = $("d-net").value;
    // OMIT the parameter entirely for a native chain rather than sending an
    // empty one. The server maps "" to undefined, but not sending it is what
    // the contract actually means and leaves nothing to interpret.
    var q = "deposit-address?asset=" + encodeURIComponent(asset) +
      (net ? "&network=" + encodeURIComponent(net) : "");
    priv(q).then(function (r) {
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
""));
      }
    }).catch(function (e) {
      out.appendChild(el("div", "msg bad", e.message));
    });
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
    var code = ($("w-totp") ? $("w-totp").value : "").trim();
    if (!code) {
      show(msg, "Enter the 6-digit code from your authenticator app.", "bad");
      btn.disabled = false;
      return;
    }
    priv("withdrawals", {
      method: "POST",
      data: {
        asset: $("w-asset").value,
        network: $("w-net").value,
        amount: $("w-amount").value.trim(),
        address: $("w-addr").value.trim(),
        requestId: reqId(),
      },
      headers: { "x-blockle-totp": code },
    }).then(function (r) {
      show(msg, "Requested " + r.amount + " " + r.asset + " over " +
        (r.network || "its native chain") + ". Fee " + r.fee +
        ", you receive " + r.youReceive + ".", "ok");
      $("w-amount").value = "";
      // The code is now SPENT server-side. Leaving it on screen invites a
      // retry that can only fail with a confusing "already used".
      if ($("w-totp")) $("w-totp").value = "";
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

  // ----------------------------------------------------------------- API keys
  //
  // THIS SCREEN HANDS OUT A CREDENTIAL, so it is the one screen where the
  // 8-second poll has to be held off: a refresh that redraws while the secret
  // is on screen would take it away before it had been copied, and it cannot be
  // shown again. `API_BUSY` is that hold.

  var API_BUSY = false;
  var API_LANG = "node";

  // ------------------------------------------------------------ second factor
  //
  // A withdrawal needs a current code. This panel is the only way to enrol one,
  // and it mirrors the server's rules rather than reimplementing them: the
  // secret arms nothing until a code is confirmed, and replacing or removing a
  // live authenticator needs a code from the existing one.

  var TF_BUSY = false;              // a secret is on screen; do not re-render

  function tfShow(which) {
    ["tf-off", "tf-setup", "tf-on"].forEach(function (id) {
      $(id).classList.toggle("hidden", id !== which);
    });
  }

  function tfRender() {
    if (TF_BUSY) return;
    priv("2fa").then(function (r) {
      $("tf-state").textContent = r.enrolled ? "on" : "not set up";
      tfShow(r.enrolled ? "tf-on" : "tf-off");
    }).catch(function (e) {
      // Never imply it is ON when we could not find out.
      $("tf-state").textContent = "unavailable — " + e.message;
      tfShow("tf-off");
    });
  }

  function tfBegin(currentCode) {
    hide($("tf-msg"));
    priv("2fa/begin", {
      method: "POST",
      data: currentCode ? { currentCode: currentCode } : {},
    }).then(function (r) {
      TF_BUSY = true;
      $("tf-secret").textContent = r.secret;
      $("tf-code").value = "";
      $("tf-state").textContent = "finish setting up";
      tfShow("tf-setup");
    }).catch(function (e) { show($("tf-msg"), e.message, "bad"); });
  }

  function tfConfirm() {
    var code = $("tf-code").value.trim();
    if (!code) { show($("tf-msg"), "Enter the code from your app.", "bad"); return; }
    priv("2fa/confirm", { method: "POST", data: { code: code } })
      .then(function () {
        TF_BUSY = false;
        // The secret must not linger on screen once it is armed.
        $("tf-secret").textContent = "";
        $("tf-code").value = "";
        show($("tf-msg"), "Authenticator is on. Withdrawals will ask for a code.", "ok");
        tfRender();
      })
      .catch(function (e) { show($("tf-msg"), e.message, "bad"); });
  }

  function tfDisable() {
    var code = $("tf-cur").value.trim();
    if (!code) { show($("tf-msg"), "Enter a current code to turn it off.", "bad"); return; }
    priv("2fa/disable", { method: "POST", data: { code: code } })
      .then(function () {
        $("tf-cur").value = "";
        show($("tf-msg"),
          "Authenticator removed. You will not be able to withdraw until you " +
          "set one up again.", "ok");
        tfRender();
      })
      .catch(function (e) { show($("tf-msg"), e.message, "bad"); });
  }

  RENDER.api = function () {
    $("api-base").textContent = location.origin + "/v1";
    tfRender();
    drawApiSample();
    drawApiEndpoints();
    if (API_BUSY) return;             // a form or a secret is on screen
    priv("api-keys").then(function (r) {
      var body = $("t-apikeys").tBodies[0];
      clear(body);
      var live = 0;
      (r.keys || []).forEach(function (k) {
        var tr = body.insertRow();
        cell(tr, k.label);
        var id = cell(tr, k.keyId);
        id.className = "mono";
        cell(tr, k.scopes.join(" + "));
        cell(tr, String(k.ratePerMin) + "/min", "num");
        // "never" is the useful word here: an unused key is one to revoke.
        cell(tr, k.revokedAt ? "revoked" : (k.lastUsedAt ? when(k.lastUsedAt) : "never"));
        var td = cell(tr, "");
        if (k.revokedAt) {
          tr.style.opacity = ".55";
        } else {
          live += 1;
          var b = el("button", "btn sm danger", "Revoke");
          b.onclick = function () { revokeKey(k); };
          td.appendChild(b);
        }
      });
      if (!(r.keys || []).length) {
        emptyRow(body, 6, "No keys yet. Create one to trade from your own code.");
      }
      badge("api", live);
      $("api-note").textContent = r.signing && r.signing.cannotWithdraw
        ? "read and trade only — withdrawals are not available to any key"
        : "";
    }).catch(function (e) {
      emptyRow($("t-apikeys").tBodies[0], 6, e.message);
    });
  };

  /** A timestamp as something human. Exact date once it is not today. */
  function when(iso) {
    var t = Date.parse(iso);
    if (!t) return iso;
    var mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    if (mins < 24 * 60) return Math.floor(mins / 60) + "h ago";
    return new Date(t).toLocaleDateString();
  }

  function apiForm(on) {
    API_BUSY = on;
    $("api-form").classList.toggle("hidden", !on);
    hide($("api-msg"));
    if (on) $("api-label").focus();
  }

  function createKey() {
    var label = $("api-label").value.trim();
    var msg = $("api-msg");
    if (!label) { show(msg, "Give the key a label so you know what it is.", "bad"); return; }
    var btn = $("api-create");
    btn.disabled = true;
    hide(msg);
    priv("api-keys", {
      method: "POST",
      data: {
        label: label,
        scopes: $("api-scopes").value.split(","),
        ratePerMin: parseInt($("api-rate").value, 10) || 120,
      },
    }).then(function (r) {
      $("api-form").classList.add("hidden");
      $("api-label").value = "";
      // SHOWN ONCE. API_BUSY stays true until dismissed, so no poll can wipe it.
      API_BUSY = true;
      $("api-new-id").textContent = r.keyId;
      $("api-new-secret").textContent = r.secret;
      $("api-secret").classList.remove("hidden");
      drawApiSample(r.keyId, r.secret);
    }).catch(function (e) {
      show(msg, e.message, "bad");
    }).then(function () { btn.disabled = false; });
  }

  function secretDone() {
    // Wiped from the DOM as well as hidden: leaving it in the page for the rest
    // of the session serves nobody.
    $("api-new-secret").textContent = "—";
    $("api-new-id").textContent = "—";
    $("api-secret").classList.add("hidden");
    API_BUSY = false;
    drawApiSample();
    RENDER.api();
  }

  function revokeKey(k) {
    // No confirm() dialog — revoking is the safe direction, and a key that
    // should not have been revoked is replaced in ten seconds. The irreversible
    // thing would be leaving a leaked key alive while reading a modal.
    var row = { label: k.label, id: k.keyId };
    priv("api-keys/" + encodeURIComponent(k.keyId), { method: "DELETE" })
      .then(function () { RENDER.api(); })
      .catch(function (e) {
        emptyRow($("t-apikeys").tBodies[0], 6,
          "Could not revoke " + row.label + ": " + e.message);
      });
  }

  /**
   * The worked example, in three languages.
   *
   * Filled with the real key id and secret right after creation, because a
   * sample someone has to edit is a sample they get wrong — and the first thing
   * they would get wrong is the hash of an empty body.
   */
  function drawApiSample(keyId, secret) {
    var id = keyId || "YOUR_KEY_ID";
    var sec = secret || "YOUR_SECRET";
    var base = location.origin;
    var samples = {
      node:
        "// Node 18+, no dependencies.\n" +
        "import { createHmac, createHash } from \"node:crypto\";\n\n" +
        "const BASE = \"" + base + "\";\n" +
        "const KEY = \"" + id + "\";\n" +
        "const SECRET = \"" + sec + "\";\n\n" +
        "async function call(method, path, body) {\n" +
        "  const raw = body === undefined ? \"\" : JSON.stringify(body);\n" +
        "  const ts = String(Date.now());\n" +
        "  const digest = createHash(\"sha256\").update(raw).digest(\"hex\");\n" +
        "  const sig = createHmac(\"sha256\", SECRET)\n" +
        "    .update(ts + method.toUpperCase() + path + digest)\n" +
        "    .digest(\"hex\");\n" +
        "  const res = await fetch(BASE + path, {\n" +
        "    method,\n" +
        "    headers: {\n" +
        "      \"content-type\": \"application/json\",\n" +
        "      \"X-Blockle-Key\": KEY,\n" +
        "      \"X-Blockle-Timestamp\": ts,\n" +
        "      \"X-Blockle-Signature\": sig,\n" +
        "    },\n" +
        "    // SEND THE SAME BYTES YOU SIGNED. Re-serialising here would change\n" +
        "    // key order or spacing and the signature would not match.\n" +
        "    body: raw === \"\" ? undefined : raw,\n" +
        "  });\n" +
        "  if (!res.ok) throw new Error((await res.json()).error);\n" +
        "  return res.json();\n" +
        "}\n\n" +
        "console.log(await call(\"GET\", \"/v1/balances\"));\n" +
        "console.log(await call(\"POST\", \"/v1/orders\", {\n" +
        "  market: \"BTC-USDT\", side: \"buy\", price: \"60000.00\", amount: \"0.001\",\n" +
        "}));",
      python:
        "# Python 3, requests.\n" +
        "import hashlib, hmac, json, time, requests\n\n" +
        "BASE = \"" + base + "\"\n" +
        "KEY = \"" + id + "\"\n" +
        "SECRET = \"" + sec + "\"\n\n" +
        "def call(method, path, body=None):\n" +
        "    raw = \"\" if body is None else json.dumps(body, separators=(\",\", \":\"))\n" +
        "    ts = str(int(time.time() * 1000))\n" +
        "    digest = hashlib.sha256(raw.encode()).hexdigest()\n" +
        "    sig = hmac.new(SECRET.encode(),\n" +
        "                   (ts + method.upper() + path + digest).encode(),\n" +
        "                   hashlib.sha256).hexdigest()\n" +
        "    r = requests.request(method, BASE + path,\n" +
        "        headers={\"content-type\": \"application/json\",\n" +
        "                 \"X-Blockle-Key\": KEY,\n" +
        "                 \"X-Blockle-Timestamp\": ts,\n" +
        "                 \"X-Blockle-Signature\": sig},\n" +
        "        # the exact bytes that were signed\n" +
        "        data=raw.encode() if raw else None, timeout=20)\n" +
        "    r.raise_for_status()\n" +
        "    return r.json()\n\n" +
        "print(call(\"GET\", \"/v1/balances\"))\n" +
        "print(call(\"POST\", \"/v1/orders\", {\n" +
        "    \"market\": \"BTC-USDT\", \"side\": \"buy\",\n" +
        "    \"price\": \"60000.00\", \"amount\": \"0.001\"}))",
      curl:
        "# One signed GET. bash + openssl.\n" +
        "KEY=" + id + "\n" +
        "SECRET=" + sec + "\n" +
        "PATH_=/v1/balances\n" +
        "TS=$(( $(date +%s) * 1000 ))\n" +
        "# sha256 of an EMPTY body — still part of the string to sign.\n" +
        "DIGEST=$(printf '' | openssl dgst -sha256 -hex | awk '{print $NF}')\n" +
        "SIG=$(printf '%s' \"$TS\"GET\"$PATH_$DIGEST\" \\\n" +
        "      | openssl dgst -sha256 -hmac \"$SECRET\" -hex | awk '{print $NF}')\n" +
        "curl -s " + base + "$PATH_ \\\n" +
        "  -H \"X-Blockle-Key: $KEY\" \\\n" +
        "  -H \"X-Blockle-Timestamp: $TS\" \\\n" +
        "  -H \"X-Blockle-Signature: $SIG\"",
    };
    var text = samples[API_LANG] || samples.node;
    // ONLY TOUCH THE DOM IF THE TEXT CHANGED. This screen re-renders every few
    // seconds, and reassigning textContent collapses a selection — so copying
    // the sample by hand would fail on the poll tick.
    if ($("api-sample").textContent !== text) $("api-sample").textContent = text;
    Array.prototype.forEach.call($("api-tabs").children, function (b) {
      b.classList.toggle("on", b.getAttribute("data-lang") === API_LANG);
    });
  }

  var API_ENDPOINTS = [
    ["GET", "/v1/balances", "read", "total, reserved and available per asset"],
    ["GET", "/v1/orders", "read", "your open and recent orders"],
    ["GET", "/v1/deposits", "read", "credited and in-flight deposits"],
    ["GET", "/v1/deposit-address?asset=BTC", "read", "your deposit address for an asset"],
    ["POST", "/v1/orders", "trade", "place a limit order"],
    ["POST", "/v1/orders/{id}/cancel", "trade", "cancel one of your orders"],
    ["POST", "/v1/liquidity", "trade", "open a maker ladder"],
    ["GET", "/public/tickers", "nothing", "last, bid, ask per market — unsigned"],
    ["POST", "/v1/withdrawals", "not available to keys",
      "withdrawals need your session and second factor, on the site"],
  ];

  function drawApiEndpoints() {
    var body = $("t-apiendpoints").tBodies[0];
    if (body.rows.length) return;  // static
    API_ENDPOINTS.forEach(function (r) {
      var tr = body.insertRow();
      cell(tr, r[0]).className = "mono";
      cell(tr, r[1]).className = "mono";
      var need = cell(tr, r[2]);
      if (r[2].indexOf("not available") === 0) need.className = "down";
      cell(tr, r[3]);
    });
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

      /*
       * SIGN OUT, HERE.
       *
       * There was no way out of the venue short of clearing cookies — which
       * matters more here than on most sites: this is the screen someone
       * reaches on a shared or borrowed machine, and leaving a session that
       * can place orders behind them is a real cost.
       *
       * It ends the session at the ACCOUNTS SERVICE, not just in this tab.
       * Dropping the cookie locally would leave the session valid for anyone
       * who still had it.
       */
      var out = el("button", "btn danger block", "Sign out");
      out.style.marginTop = "8px";
      out.onclick = function () {
        out.disabled = true;
        out.textContent = "Signing out…";
        api("account/api/logout", { method: "POST", data: {} })
          .catch(function () {
            // A failed call must not strand someone signed in. The cookie may
            // already be gone, or the service may be unreachable; either way
            // the next screen decides, and it checks with the server.
            return null;
          })
          .then(function () {
            SIGNED_IN = false;
            location.href = "signin.html";
          });
      };
      body.appendChild(out);
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

  /*
   * THE RAIL: LABELS OR ICONS.
   *
   * Exactly one of two classes is always on the body, chosen here rather
   * than defaulted in CSS — a third "unset" state is the thing that makes
   * responsive navigation confusing to reason about when the stylesheet and
   * the script disagree.
   *
   * The default follows the screen: labels on a desktop, icons on a phone.
   * A deliberate choice is remembered, because someone who collapses the
   * rail for chart room wants it collapsed next time too. The phone's drawer
   * is NOT remembered — it overlays the content, so starting a session with
   * it open would hide the thing you came for.
   */
  var NARROW = window.matchMedia("(max-width: 900px)");
  var NAV_KEY = "blk_nav";

  function navDefault() {
    return NARROW.matches ? "icons" : "labels";
  }

  function setNav(mode, remember) {
    var icons = mode === "icons";
    document.body.classList.toggle("nav-icons", icons);
    document.body.classList.toggle("nav-labels", !icons);

    var btn = $("navtoggle");
    if (btn) btn.setAttribute("aria-expanded", String(!icons));
    // The scrim only means anything while the rail is floating over the work
    // area, which is the narrow + labels combination.
    var scrim = $("scrim");
    if (scrim) scrim.hidden = !(NARROW.matches && !icons);

    if (remember) {
      try {
        // Only a desktop choice persists; see above.
        if (NARROW.matches) localStorage.removeItem(NAV_KEY);
        else localStorage.setItem(NAV_KEY, mode);
      } catch (e) {
        // Private browsing. The class is already applied; losing the
        // preference is not worth failing the click over.
      }
    }
  }

  function navInit() {
    var stored = null;
    try { stored = localStorage.getItem(NAV_KEY); } catch (e) { stored = null; }
    setNav(!NARROW.matches && (stored === "icons" || stored === "labels")
      ? stored : navDefault(), false);

    var toggle = function () {
      setNav(document.body.classList.contains("nav-icons") ? "labels" : "icons", true);
    };
    var btn = $("navtoggle");
    if (btn) btn.onclick = toggle;
    var scrim = $("scrim");
    if (scrim) scrim.onclick = function () { setNav("icons", false); };

    // Picking a destination closes the drawer: leaving it open over the
    // screen you just asked for would mean two taps for every move.
    $("rail").addEventListener("click", function (e) {
      if (NARROW.matches && e.target.closest("a")) setNav("icons", false);
    });

    // Rotating a phone, or dragging a window across the breakpoint, should
    // land on that size's sensible default rather than keeping a state that
    // only made sense at the old width.
    var onChange = function () { setNav(navDefault(), false); };
    if (NARROW.addEventListener) NARROW.addEventListener("change", onChange);
    else if (NARROW.addListener) NARROW.addListener(onChange);
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
    // Handlers are assigned here rather than in the markup because this origin
    // serves script-src 'self' with no 'unsafe-inline': an onclick attribute
    // would be silently dead.
    $("mkt-search").oninput = function () { mktSet({ text: $("mkt-search").value }); };
    $("mkt-open").onclick = function () { mktSet({ open: true }); };
    $("mkt-all").onclick = function () { mktSet({ open: false }); };
    $("mkt-sort").onchange = function () { mktSet({ sort: $("mkt-sort").value }); };
    $("side-buy").onclick = function () { setSide("buy"); };
    $("side-sell").onclick = function () { setSide("sell"); };
    $("t-price").oninput = function () { ticketTotals(marketDef()); };
    $("t-amount").oninput = function () { ticketTotals(marketDef()); };
    $("t-submit").onclick = submitOrder;

    $("d-asset").onchange = depositNets;
    $("d-net").onchange = depositAddress;

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

    $("tf-begin").onclick = function () { tfBegin(null); };
    $("tf-confirm").onclick = tfConfirm;
    $("tf-replace").onclick = function () {
      var code = $("tf-cur").value.trim();
      if (!code) {
        show($("tf-msg"), "Enter a current code to replace it.", "bad");
        return;
      }
      $("tf-cur").value = "";
      tfBegin(code);
    };
    $("tf-disable").onclick = tfDisable;

    $("api-new").onclick = function () { apiForm(true); };
    $("api-cancel").onclick = function () { apiForm(false); };
    $("api-create").onclick = createKey;
    $("api-done").onclick = secretDone;
    $("api-copy").onclick = function () {
        var t = $("api-new-secret").textContent;
        var btn = $("api-copy");
        // Feedback on the button rather than a toast: the eye is already here.
        var done = function (ok) {
            btn.textContent = ok ? "Copied" : "Select it and copy manually";
            setTimeout(function () { btn.textContent = "Copy secret"; }, 2500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(t).then(function () { done(true); },
                                                  function () { done(false); });
        } else {
            done(false);
        }
    };
    Array.prototype.forEach.call($("api-tabs").children, function (b) {
        b.onclick = function () {
            API_LANG = b.getAttribute("data-lang");
            // Keep whatever is on screen: if the secret panel is up, the sample
            // still carries the real key.
            var id = $("api-new-id").textContent;
            var sec = $("api-new-secret").textContent;
            if (id && id !== "\u2014") drawApiSample(id, sec); else drawApiSample();
        };
    });
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
    navInit();
    wire();

    // THE BANNER FAILS CLOSED. Anything other than an explicit "live" leaves
    // the testnet badge up, so a failed status call cannot present an
    // unlicensed venue as open for business.
    pub("status").then(function (st) {
      if (st.live === true) {
        var e = $("env");
        e.textContent = "LIVE";
        e.className = "env live";
        // The topbar copy carries the same word. Only one of the two is
        // visible at a given width, but a stale "TESTNET" on the hidden one
        // would surface the moment someone resized.
        var te = $("tb-env");
        if (te) { te.textContent = "LIVE"; te.className = "v up"; }
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

    pub("markets").then(function (payload) {
      /*
       * TWO SHAPES, ONE READER.
       *
       * /public/markets answers with a bare array today. A settlement-gated
       * venue has a second thing to say — the pairs it will NOT list, and why
       * — which does not fit in an array of markets, so the endpoint may
       * answer with an object instead. Accepting both means the page works
       * before and after that change, in either order, with no flag day.
       */
      var rows = Array.isArray(payload) ? payload : ((payload && payload.markets) || []);
      STATE.notListed = (payload && Array.isArray(payload.notListed)) ? payload.notListed : [];

      STATE.markets = rows.map(function (m) {
        return {
          // `symbol` is the field this endpoint actually emits. The previous
          // version read `m.market` — which belongs to /public/tickers — and
          // got away with it only because the fallback happens to reproduce
          // the symbol exactly. It would stop being true the day a symbol is
          // not base + "-" + quote.
          symbol: m.symbol || m.market || (m.base + "-" + m.quote),
          base: m.base,
          quote: m.quote,
          // Already on the wire and previously thrown away. Decimals and the
          // minimum order size are what a correctly formatted price needs.
          baseDecimals: m.baseDecimals,
          quoteDecimals: m.quoteDecimals,
          minBase: m.minBase,
          state: m.state || m.status,
          closed: m.closed,
          closedReason: m.closedReason || m.reason,
        };
      });

      /*
       * THE QUOTE ORDER COMES FROM THE VENUE, NOT FROM HERE.
       *
       * This used to be `a === "USDT" || a === "BLOCK"` — a fifth independent
       * copy of the venue's quote list, after venue.ts, listed.ts,
       * publicapi.ts and the gas-rate floor table. An asset is a quote
       * because some market quotes in it, and the order is the order the
       * venue emitted, which is its own seniority. Nothing to keep in step.
       */
      STATE.quotes = [];
      STATE.markets.forEach(function (m) {
        if (STATE.quotes.indexOf(m.quote) < 0) STATE.quotes.push(m.quote);
      });

      // Quote assets first in every asset picker, then the rest alphabetically
      // — the pickers are for deposit and withdraw, where the quotes are what
      // most people arrive holding.
      var seen = {};
      var rest = [];
      STATE.markets.forEach(function (m) {
        [m.base, m.quote].forEach(function (a) {
          if (seen[a]) return;
          seen[a] = true;
          if (STATE.quotes.indexOf(a) < 0) rest.push(a);
        });
      });
      STATE.assets = STATE.quotes.concat(rest.sort());
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
