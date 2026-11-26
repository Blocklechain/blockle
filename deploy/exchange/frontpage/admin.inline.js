"use strict";

  /*
   * "THIS SCRIPT RAN" IS ITS OWN FACT, AND IT IS ASSERTED FIRST.
   *
   * admin.html carries a CSS-only watchdog that reveals a boot-failure banner
   * a few seconds after load unless the document is marked `booted`. Setting
   * the class here — before anything that could throw — is what distinguishes
   * "the console's code never ran" from "the console ran and something inside
   * it failed". The two need different advice, and for a whole evening the
   * page could give neither: admin.inline.js was being served from a mount
   * that had no such file, 404ed, and the operator saw the static placeholder
   * "checking session…" for as long as they were willing to wait.
   *
   * CSS, not an inline <script> and not an onerror= attribute, because this
   * origin's CSP is `script-src 'self'` — both of those are blocked, and a
   * watchdog that the CSP blocks is a watchdog that is not there.
   */
  document.documentElement.classList.add("booted");

  // Mount-relative, so this page works whether it is served at /admin/ or at a
  // path behind a proxy. An absolute /admin/api/... would break the moment the
  // mount point changes, which it already did once.
  const API = "api/";

  /*
   * NO REQUEST WAITS FOREVER.
   *
   * Every fetch on this page is given a deadline. A hung TCP connection to
   * the API, or an nginx that accepted the connection and then sat on it,
   * otherwise leaves the awaiting `loadMe()` suspended with no timer, no
   * rejection and no way out — which renders as a permanent "checking
   * session…" that is indistinguishable from the 404 above.
   *
   * The budget is deliberately longer than the server's own: blockleauth.ts
   * gives the accounts service 8s and then answers 503. A client deadline
   * below that would pre-empt the server's much more specific diagnosis and
   * report "no response" where the server was about to say "account service
   * unreachable". 15s leaves room for that answer plus a slow link.
   */
  const GET_TIMEOUT_MS = 15_000;
  // Mutations are slower by nature — they touch a chain — and they are also
  // the ones where giving up early is most confusing, because the action may
  // have been taken. nginx cuts the proxy at 30s, so time out just after it.
  const POST_TIMEOUT_MS = 32_000;

  const $ = (id) => document.getElementById(id);
  const txt = (s) => document.createTextNode(s == null ? "—" : String(s));

  /**
   * One JSON request under one deadline, with a readable reason when it
   * expires.
   *
   * THE DEADLINE COVERS THE BODY, NOT JUST THE HEADERS. A server that sends
   * a status line and then stalls mid-body leaves `response.json()` awaiting
   * forever, and a timer that was cleared the moment the headers landed would
   * not save us from it — so the fetch and the parse live inside the same
   * AbortController scope.
   *
   * AbortError's own message is "The operation was aborted", which tells an
   * operator mid-incident nothing at all. It is replaced with the fact that
   * matters: what did not answer, and for how long we waited.
   */
  /**
   * `api/` + the endpoint, joined with EXACTLY ONE slash.
   *
   * Call sites spell the endpoint both ways — `get("revenue")` and
   * `get("/customers?…")` — and the naive concatenation turned the second into
   * `api//customers`, i.e. `/admin/api//customers`. The router does
   * `url.pathname.slice("/admin/api".length)` and compares the result to
   * `"/customers"`; it gets `"//customers"`, matches nothing, and 404s. The
   * customers panel and the lookup form have been riding on nginx's
   * `merge_slashes` (on by default) silently repairing the URL before the
   * service ever saw it — so they would die the moment anyone reached the
   * console through a proxy that did not, or through the port directly.
   *
   * Normalising here rather than at the seven call sites: one chokepoint can
   * be tested, and a future `get("/thing")` cannot reintroduce it.
   */
  function endpoint(path) {
    return API + String(path).replace(/^\/+/, "");
  }

  async function requestJson(path, init, ms, what) {
    const ac = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; ac.abort(); }, ms);
    try {
      const r = await fetch(endpoint(path), { ...init, signal: ac.signal });
      /*
       * READ THE BODY AS TEXT, THEN PARSE. Not `r.json().catch(...)`.
       *
       * The obvious spelling — `await r.json().catch(() => ({ error:
       * r.statusText }))` — defeats the deadline it sits inside. When the body
       * stalls and the controller aborts, `r.json()` rejects with AbortError
       * and that `.catch` turns it into a perfectly ordinary-looking
       * `{error: "OK"}` body on a 200 response. The page then renders a
       * signed-in operator with no email instead of reporting a timeout. The
       * harness caught exactly this.
       *
       * `r.text()` lets the abort propagate; only a genuine parse failure —
       * an nginx error page, a gateway's HTML — falls back to the status text.
       */
      const raw = await r.text();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { error: r.statusText };
      }
      if (body === null || typeof body !== "object") body = { error: r.statusText };
      if (!r.ok) {
        const err = new Error(body.error || ("HTTP " + r.status));
        err.status = r.status;
        throw err;
      }
      return body;
    } catch (e) {
      if (expired) {
        const err = new Error(
          `${what} did not respond within ${Math.round(ms / 1000)}s`,
        );
        err.status = 504;
        throw err;
      }
      // Already one of ours (a real HTTP status): pass it through untouched.
      if (e && typeof e.status === "number") throw e;
      // A genuine transport failure: DNS, TLS, offline, or a CSP connect-src
      // refusal. "Failed to fetch" on its own has sent people to the wrong
      // layer more than once.
      const err = new Error(
        `could not reach ${what} (${(e && e.message) || "network error"})`,
      );
      err.status = 0;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function cell(row, value, cls) {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    td.appendChild(txt(value));
    row.appendChild(td);
    return td;
  }

  function pill(row, label, kind) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.className = "pill " + kind;
    span.appendChild(txt(label));
    td.appendChild(span);
    row.appendChild(td);
  }

  /**
   * THE STATUS TRAVELS WITH THE ERROR.
   *
   * This threw a bare Error, so `e.status` was always undefined downstream and
   * the landing page fell through to its generic branch — telling a signed-in
   * operator "not signed in" when the truth was "signed in, but this account
   * is not on the allowlist". The three cases the page carefully distinguishes
   * (401 / 404 / 503) were unreachable because the one thing that tells them
   * apart was being dropped here.
   */
  async function get(path) {
    return requestJson(
      path,
      { credentials: "same-origin" },
      GET_TIMEOUT_MS,
      "the exchange admin API",
    );
  }

  async function post(path, payload, code) {
    return requestJson(
      path,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-admin-totp": code },
        body: JSON.stringify(payload),
      },
      POST_TIMEOUT_MS,
      "the exchange admin API",
    );
  }

  /** A request id so a double-submit is one action, not two. */
  function requestId() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function setBanner(report) {
    const host = $("banner");
    host.textContent = "";
    const div = document.createElement("div");
    const warnings = report.warnings || [];
    if (report.reconciles && warnings.length === 0) {
      div.className = "banner ok";
      const h = document.createElement("h3");
      h.appendChild(txt("Books reconcile"));
      div.appendChild(h);
      const p = document.createElement("ul");
      const li = document.createElement("li");
      li.appendChild(txt(
        "Every fee-account posting is classified, and the classified postings " +
        "sum exactly to the fee balances."
      ));
      p.appendChild(li);
      div.appendChild(p);
    } else {
      // A WARNING OUTRANKS A FIGURE. If the arithmetic did not check out, that
      // is the most important thing on the page.
      div.className = "banner";
      const h = document.createElement("h3");
      h.appendChild(txt(
        report.reconciles
          ? "Read these before quoting any figure"
          : "THE PROFIT FIGURES BELOW ARE NOT VERIFIED"
      ));
      div.appendChild(h);
      const ul = document.createElement("ul");
      for (const w of warnings) {
        const li = document.createElement("li");
        li.appendChild(txt(w));
        ul.appendChild(li);
      }
      div.appendChild(ul);
    }
    host.appendChild(div);
  }

  function isNegative(s) {
    return typeof s === "string" && s.trim().startsWith("-");
  }

  function renderTotals(total, reconciles) {
    const host = $("totals");
    host.textContent = "";
    const items = [
      ["Net profit", total.netProfit, true],
      ["Trading fees", total.tradingFees, false],
      ["Withdrawal fees", total.withdrawalFees, false],
      ["Gas spent", total.gasSpent, false],
    ];
    for (const [k, v, emphasise] of items) {
      const box = document.createElement("div");
      box.className = "figure";
      const kk = document.createElement("div");
      kk.className = "k";
      kk.appendChild(txt(k));
      const vv = document.createElement("div");
      vv.className = "v" + (emphasise ? (isNegative(v) ? " bad" : " good") : "");
      // The string the API sent, verbatim. No parseFloat on this page.
      vv.appendChild(txt(v + " " + total.currency));
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.appendChild(txt(reconciles ? "estimate" : "estimate — unverified"));
      box.append(kk, vv, sub);
      host.appendChild(box);
    }
  }

  async function loadRevenue() {
    const body = $("revenue").tBodies[0];
    try {
      const r = await get("revenue");
      setBanner(r);
      renderTotals(r.total, r.reconciles);
      $("caveat").textContent = r.total.caveat;
      $("profit-note").textContent =
        r.assets.length + (r.assets.length === 1 ? " asset" : " assets");

      body.textContent = "";
      if (r.assets.length === 0) {
        const tr = body.insertRow();
        cell(tr, "No fees have been earned yet.").colSpan = 6;
        return;
      }
      for (const a of r.assets) {
        const tr = body.insertRow();
        if (a.loss) tr.className = "loss";
        cell(tr, a.asset);
        cell(tr, a.tradingFees, "num");
        cell(tr, a.withdrawalFees, "num");
        cell(tr, a.gasSpent, "num");
        cell(tr, a.netProfit, "num").style.color =
          a.loss ? "var(--down)" : "var(--up)";
        cell(tr, a.balance, "num");
      }
    } catch (e) {
      body.textContent = "";
      const tr = body.insertRow();
      cell(tr, String(e.message || e)).colSpan = 6;
    }
  }

  async function loadGas() {
    const body = $("gas").tBodies[0];
    try {
      const r = await get("gas");
      body.textContent = "";
      let dry = 0;
      for (const p of r.positions) {
        const tr = body.insertRow();
        if (!p.healthy) { tr.className = "loss"; dry++; }
        cell(tr, p.chain);
        cell(tr, p.gasAsset);
        cell(tr, p.float, "num");
        cell(tr, p.custody, "num");
        cell(tr, p.perWithdrawal, "num");
        cell(tr, p.floor, "num");
        cell(tr, p.runway, "num");
        pill(tr, p.healthy ? "paying" : "paused", p.healthy ? "ok" : "bad");
      }
      $("gas-note").textContent =
        dry === 0 ? "all chains paying" : dry + " paused";
    } catch (e) {
      body.textContent = "";
      const tr = body.insertRow();
      cell(tr, String(e.message || e)).colSpan = 8;
    }
  }

  async function loadCoverage() {
    const body = $("coverage").tBodies[0];
    try {
      const r = await get("fee-coverage");
      body.textContent = "";
      for (const c of r.chains) {
        const tr = body.insertRow();
        if (!c.covered) tr.className = "loss";
        cell(tr, c.chain);
        cell(tr, c.gasCost, "num");
        cell(tr, c.gasAllowance, "num");
        cell(tr, c.margin, "num");
        cell(tr, c.fee, "num");
        cell(tr, c.headroom, "num");
        cell(tr, c.rate === "—" ? c.rateSource : c.rate + " (" + c.rateSource + ")");
        pill(
          tr,
          c.subsidised ? "subsidised" : c.covered ? "covered" : "losing",
          c.subsidised ? "warn" : c.covered ? "ok" : "bad"
        );
      }
      $("cov-note").textContent =
        r.uncovered.length === 0
          ? "every chain covers its gas"
          : r.uncovered.join(", ") + " not covered";
      $("trading-fees").textContent =
        "Trading: " + r.tradingFees.makerPct + " maker, " +
        r.tradingFees.takerPct + " taker. " + r.tradingFees.note;
    } catch (e) {
      body.textContent = "";
      const tr = body.insertRow();
      cell(tr, String(e.message || e)).colSpan = 8;
    }
  }

  /*
   * THE CUSTOMER DIRECTORY.
   *
   * Paged rather than "all of them": this table grows with the venue, and a
   * screen that quietly stops being usable at ten thousand rows is a screen
   * nobody trusts during an incident.
   */
  let custOffset = 0;

  function balancesCell(balances) {
    if (!balances.length) return "—";
    return balances.map((b) => b.amount + " " + b.asset).join(", ");
  }

  /*
   * THE ONE LOADER THAT HAD NO ERROR PATH.
   *
   * Every other load* function wraps its request; this one awaited bare. Two
   * consequences, both of them the bug this whole change is about: the
   * customers table kept its "loading…" row forever, and the rejection
   * escaped into the boot `Promise.all` as an unhandled rejection that took
   * the siblings' results with it. Also reached from the Previous/Next
   * buttons, where a bare rejection is simply a dead click.
   */
  async function loadCustomers(offset) {
    custOffset = offset || 0;
    const tb = document.querySelector("#customers tbody");
    let r;
    try {
      r = await get("/customers?limit=25&offset=" + custOffset);
    } catch (e) {
      tb.textContent = "";
      const tr = tb.insertRow();
      const td = tr.insertCell();
      td.colSpan = 5;
      td.appendChild(txt("Could not load customers: " + String((e && e.message) || e)));
      return;
    }
    tb.textContent = "";
    if (!r.customers.length) {
      const tr = tb.insertRow();
      const td = tr.insertCell();
      td.colSpan = 5;
      td.appendChild(txt(custOffset ? "No more." : "No customers yet."));
    }
    for (const c of r.customers) {
      const tr = tb.insertRow();
      const id = tr.insertCell();
      const link = document.createElement("a");
      link.href = "#";
      link.className = "mono";
      link.appendChild(txt(c.accountId));
      link.addEventListener("click", (e) => { e.preventDefault(); lookup(c.accountId); });
      id.appendChild(link);
      tr.insertCell().appendChild(txt(balancesCell(c.balances)));
      const a = tr.insertCell(); a.className = "num"; a.appendChild(txt(String(c.depositAddresses)));
      const w = tr.insertCell(); w.className = "num";
      w.appendChild(txt(c.withdrawals.pending
        ? c.withdrawals.total + " (" + c.withdrawals.pending + " pending)"
        : String(c.withdrawals.total)));
      tr.insertCell().appendChild(txt(c.lastActivity ? c.lastActivity.slice(0, 19).replace("T", " ") : "—"));
    }
    const more = document.getElementById("cust-more");
    more.textContent = "";
    const shown = Math.min(custOffset + 25, r.total);
    const note = document.createElement("span");
    note.className = "note";
    note.appendChild(txt(r.total ? (custOffset + 1) + "–" + shown + " of " + r.total + "  " : ""));
    more.appendChild(note);
    if (custOffset > 0) {
      const b = document.createElement("button");
      b.appendChild(txt("Previous"));
      b.addEventListener("click", () => loadCustomers(Math.max(0, custOffset - 25)));
      more.appendChild(b);
    }
    if (shown < r.total) {
      const b = document.createElement("button");
      b.appendChild(txt("Next"));
      b.addEventListener("click", () => loadCustomers(custOffset + 25));
      more.appendChild(b);
    }
  }

  /** One customer, in full. */
  async function lookup(q) {
    const out = document.getElementById("cust-out");
    out.textContent = "";
    if (!String(q || "").trim()) return;
    let r;
    try {
      r = await get("/customer-lookup?q=" + encodeURIComponent(q));
    } catch (e) {
      out.className = "out bad";
      out.appendChild(txt(e.message || String(e)));
      return;
    }
    if (!r.detail) {
      // NO FUZZY FALLBACK. A near-miss that resolved to someone else would
      // put one person's balances under another's question.
      out.className = "out";
      out.appendChild(txt("Nothing matches " + JSON.stringify(r.query) +
        " exactly — account ids, addresses and references are matched in full."));
      return;
    }
    const d = r.detail;
    out.className = "out";
    const h = document.createElement("div");
    h.innerHTML = "";
    const line = (label, value) => {
      const p = document.createElement("div");
      const b = document.createElement("b");
      b.appendChild(txt(label + ": "));
      p.appendChild(b);
      p.appendChild(txt(value));
      return p;
    };
    h.appendChild(line("Account", d.accountId + "  (matched by " + r.matchedBy + ")"));
    h.appendChild(line("Balances", balancesCell(d.balances)));
    h.appendChild(line("Last activity", d.lastActivity || "never"));
    out.appendChild(h);

    const section = (title, rows, cols, cells) => {
      if (!rows.length) return;
      const t = document.createElement("div");
      t.className = "note";
      t.style.marginTop = "10px";
      t.appendChild(txt(title));
      out.appendChild(t);
      const tbl = document.createElement("table");
      const thead = tbl.createTHead().insertRow();
      for (const c of cols) { const th = document.createElement("th"); th.appendChild(txt(c)); thead.appendChild(th); }
      const body = tbl.createTBody();
      for (const row of rows) {
        const tr = body.insertRow();
        for (const v of cells(row)) tr.insertCell().appendChild(txt(v));
      }
      const wrap = document.createElement("div");
      wrap.className = "scroll";
      wrap.appendChild(tbl);
      out.appendChild(wrap);
    };

    section("Deposit addresses", d.addresses,
      ["Asset", "Network", "Address", "Memo", "Issued"],
      (a) => [a.asset, a.network || "native", a.address, a.memo || "—", a.createdAt.slice(0, 10)]);
    section("Withdrawals", d.recentWithdrawals,
      ["#", "Asset", "Net", "State", "To", "Reference", "When"],
      (w) => [String(w.id), w.asset + (w.network ? "." + w.network : ""), w.net, w.state,
              w.address, w.providerRef || "—", w.requestedAt.slice(0, 19).replace("T", " ")]);
    section("Recent ledger activity", d.recentEntries,
      ["When", "Reason", "Asset", "Delta"],
      (e) => [e.at.slice(0, 19).replace("T", " "), e.reason, e.asset, e.delta]);
  }

  async function loadActions() {
    const body = $("actions").tBodies[0];
    try {
      const r = await get("actions");
      body.textContent = "";
      if (r.actions.length === 0) {
        const tr = body.insertRow();
        cell(tr, "Nothing has been done here yet.").colSpan = 5;
        return;
      }
      for (const a of r.actions) {
        const tr = body.insertRow();
        cell(tr, a.at);
        cell(tr, a.actor);
        cell(tr, a.action);
        cell(tr, a.detail);
        cell(tr, a.outcome);
      }
    } catch (e) {
      body.textContent = "";
      const tr = body.insertRow();
      cell(tr, String(e.message || e)).colSpan = 5;
    }
  }

  /**
   * WHAT WENT WRONG, IN THE OPERATOR'S WORDS.
   *
   * One place that turns a status into the three things the landing page has
   * to say, so a status nobody enumerated still produces a specific sentence
   * instead of falling through to "not signed in" — which is a lie for every
   * status except 401, and was being told for all of them.
   */
  function diagnose(status, message) {
    switch (status) {
      case 401:
        return {
          who: "not signed in",
          title: "Operator sign-in required",
          detail:
            "The console uses your ordinary Blockle account. Sign in, and if " +
            "that account is on the operator allowlist you will land here.",
          offerSignin: true,
        };
      // 404 means the session is VALID and simply not an operator. Saying
      // "not signed in" there sends someone to sign in again, repeatedly,
      // with the same account and the same result.
      case 404:
        return {
          who: "signed in — not an operator",
          title: "This account is not an operator",
          detail:
            "You are signed in, but this account is not on the operator " +
            "allowlist. Admin rights are granted to a Blockle account id — " +
            "there is no separate operator login to try.",
          offerSignin: true,
        };
      case 503:
        return {
          who: "account service unreachable",
          title: "Cannot reach the account service",
          detail:
            "The Blockle account service is not answering, so we cannot tell " +
            "who you are and will not guess. Nothing here is available until " +
            "it is back. Detail: " + message,
          offerSignin: false,
        };
      // The admin API accepted nothing, or accepted and then stalled. This is
      // the case that used to be a spinner: there was no timeout, so there was
      // no status, so there was no message.
      case 504:
        return {
          who: "admin API timed out",
          title: "The admin API did not answer",
          detail:
            "The request for your operator identity was given a deadline and " +
            "missed it. The service may be wedged rather than down — check " +
            "`systemctl status exchange-public-api` and " +
            "`journalctl -u exchange-public-api -n 50` on the box. " +
            "Detail: " + message,
          offerSignin: false,
        };
      case 0:
        return {
          who: "admin API unreachable",
          title: "Could not reach the admin API at all",
          detail:
            "The request failed before any response arrived — the host is " +
            "down, the network is gone, or this page's Content-Security-Policy " +
            "refused the connection. Detail: " + message,
          offerSignin: false,
        };
      default:
        return {
          who: `session check failed (HTTP ${status})`,
          title: `The session check failed (HTTP ${status})`,
          detail:
            "This is not a status the console knows how to interpret, which " +
            "usually means something between the browser and the service " +
            "answered instead of the service. Detail: " + message,
          offerSignin: status >= 400 && status < 500,
        };
    }
  }

  async function loadMe() {
    // NOT "checking session…" — that is the placeholder this whole exercise is
    // about. If every branch below somehow fails to write something, the
    // `finally` writes this, and it is at least true.
    let settled = false;
    try {
      const me = await get("me");
      $("who").textContent =
        (me.email || me.accountId) +
        (me.canAct ? "" : " — view only (no authenticator enrolled)");
      settled = true;
      if (!me.canAct) {
        for (const b of document.querySelectorAll("form.act button")) {
          b.disabled = true;
          b.title = "Enrol an authenticator to act";
        }
      }
    } catch (e) {
      /*
       * A LANDING PAGE, NOT AN ERROR.
       *
       * This used to render "not signed in as an operator / No operator
       * session / Detail: not found" over an otherwise empty console, which is
       * both ugly and unhelpful: "not found" is the deliberate response to a
       * valid session that is not on the allowlist (confirming the endpoint
       * exists is information), so the one message covered three different
       * situations and told you what to do about none of them.
       *
       * Now it offers the sign-in, and distinguishes the cases it can.
       */
      // `|| 0` would turn a real 0 into 0 anyway, but an ABSENT status must
      // not silently become "unreachable" — a thrown TypeError from the code
      // above is a bug in the console, not a network event, so it keeps a
      // status of its own and lands in the default branch.
      const status = typeof e.status === "number" ? e.status : -1;
      const d = diagnose(status, String((e && e.message) || e));

      $("who").textContent = d.who;
      settled = true;
      for (const el of document.querySelectorAll("details.card")) el.remove();

      const host = $("banner");
      host.textContent = "";
      const card = document.createElement("div");
      card.className = "banner ok";
      card.style.maxWidth = "520px";

      const h = document.createElement("h3");
      h.style.color = "var(--ink)";
      h.appendChild(txt(d.title));
      card.appendChild(h);

      const p = document.createElement("p");
      p.style.cssText = "margin:0 0 14px;color:var(--ink-dim);font-size:13px";
      p.appendChild(txt(d.detail));
      card.appendChild(p);

      if (d.offerSignin) {
        const a = document.createElement("a");
        // RETURN TO THIS PAGE, not to a hardcoded hostname. The old link sent
        // the operator to admin.blockle.org/admin/, which now 301s back to
        // this origin — a redirect chain through the one host whose cookie
        // scope caused the original problem.
        a.href =
          "https://exchange.blockle.org/signin.html?as=operator&return=" +
          encodeURIComponent(location.href);
        a.style.cssText =
          "display:inline-flex;align-items:center;justify-content:center;" +
          "background:var(--signal);color:#04161a;text-decoration:none;" +
          "font-weight:600;padding:10px 16px;border-radius:5px";
        a.appendChild(txt(status === 404 ? "Sign in as a different account" : "Sign in"));
        card.appendChild(a);
      }

      // A FAILURE IS WORTH RETRYING WITHOUT A RELOAD, and for the transport
      // failures it is the only sensible next move.
      if (!d.offerSignin) {
        const again = document.createElement("button");
        again.type = "button";
        again.textContent = "Try again";
        again.style.cssText =
          "background:var(--signal);color:#04161a;border:0;font-weight:600;" +
          "padding:10px 16px;border-radius:5px;cursor:pointer";
        again.addEventListener("click", () => { location.reload(); });
        card.appendChild(again);
      }

      host.appendChild(card);
      throw e;
    } finally {
      /*
       * THE LOADING STATE IS CLEARED HERE, UNCONDITIONALLY.
       *
       * Every branch above already writes `who`, so this should never fire —
       * which is exactly why it exists. "checking session…" is the string an
       * operator stared at for an evening, and no future edit to the branches
       * above gets to leave it on screen. If something throws between the
       * await and the assignment, this is what speaks.
       */
      if (!settled) {
        $("who").textContent = "session check did not complete";
      }
    }
  }

  function wireAction(formId, outId, path, collect, after) {
    $(formId).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const out = $(outId);
      const button = ev.target.querySelector("button");
      const { payload, code, codeField } = collect();
      if (!code) {
        out.className = "out bad";
        out.textContent = "A current authenticator code is required.";
        return;
      }
      button.disabled = true;
      out.className = "out";
      out.textContent = "working…";
      try {
        const r = await post(path, { ...payload, requestId: requestId() }, code);
        out.className = "out ok";
        out.textContent = r.note ? "Done. " + r.note : "Done.";
        // The code is single-use, so clear it rather than leaving a dead code
        // in the field for someone to retry with.
        $(codeField).value = "";
        await after();
      } catch (e) {
        out.className = "out bad";
        out.textContent = String(e.message || e);
      } finally {
        button.disabled = false;
      }
    });
  }

  wireAction("sweep-form", "sweep-out", "sweep", () => ({
    payload: {
      asset: $("sw-asset").value.trim().toUpperCase(),
      amount: $("sw-amount").value.trim(),
    },
    code: $("sw-code").value.trim(),
    codeField: "sw-code",
  }), async () => { await Promise.all([loadRevenue(), loadGas(), loadActions()]); });

  wireAction("fund-form", "fund-out", "fund-gas", () => ({
    payload: {
      gasAsset: $("fg-asset").value,
      amount: $("fg-amount").value.trim(),
    },
    code: $("fg-code").value.trim(),
    codeField: "fg-code",
  }), async () => { await Promise.all([loadGas(), loadRevenue(), loadActions()]); });

  (async () => {
    try {
      await loadMe();
    } catch {
      return; // no session: the banner already says why, specifically
    }
    const custForm = document.getElementById("cust-form");
    if (custForm) {
      custForm.addEventListener("submit", (e) => {
        e.preventDefault();
        lookup(document.getElementById("cust-q").value);
      });
    }
    /*
     * allSettled, NOT all.
     *
     * These five panels are independent: a chain whose balance call is timing
     * out must not blank the revenue figures beside it. `Promise.all` rejects
     * on the first failure, abandoning the other four mid-render and raising
     * an unhandled rejection — so one sick panel used to be able to leave
     * four healthy ones showing "loading…". Each loader renders its own error
     * in its own card; this just makes sure every one of them gets to run.
     */
    await Promise.allSettled([
      loadRevenue(), loadGas(), loadCoverage(), loadActions(), loadCustomers(0),
    ]);
  })();
