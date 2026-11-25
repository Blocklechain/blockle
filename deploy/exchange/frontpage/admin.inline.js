"use strict";

  // Mount-relative, so this page works whether it is served at /admin/ or at a
  // path behind a proxy. An absolute /admin/api/... would break the moment the
  // mount point changes, which it already did once.
  const API = "api/";

  const $ = (id) => document.getElementById(id);
  const txt = (s) => document.createTextNode(s == null ? "—" : String(s));

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
    const r = await fetch(API + path, { credentials: "same-origin" });
    const body = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) {
      const err = new Error(body.error || ("HTTP " + r.status));
      err.status = r.status;
      throw err;
    }
    return body;
  }

  async function post(path, payload, code) {
    const r = await fetch(API + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-admin-totp": code },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) {
      const err = new Error(body.error || ("HTTP " + r.status));
      err.status = r.status;
      throw err;
    }
    return body;
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

  async function loadCustomers(offset) {
    custOffset = offset || 0;
    const tb = document.querySelector("#customers tbody");
    const r = await get("/customers?limit=25&offset=" + custOffset);
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

  async function loadMe() {
    try {
      const me = await get("me");
      $("who").textContent =
        (me.email || me.accountId) +
        (me.canAct ? "" : " — view only (no authenticator enrolled)");
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
      const status = Number(e.status) || 0;
      // 404 means the session is VALID and simply not an operator. Saying
      // "not signed in" there sends someone to sign in again, repeatedly,
      // with the same account and the same result.
      $("who").textContent =
        status === 404 ? "signed in — not an operator"
        : status === 503 ? "account service unreachable"
        : "not signed in";
      for (const el of document.querySelectorAll("details.card")) el.remove();

      const host = $("banner");
      host.textContent = "";
      const card = document.createElement("div");
      card.className = "banner ok";
      card.style.maxWidth = "520px";

      const h = document.createElement("h3");
      h.style.color = "var(--ink)";
      h.appendChild(txt(
        status === 404 ? "This account is not an operator"
        : status === 503 ? "Cannot reach the account service"
        : "Operator sign-in required"
      ));
      card.appendChild(h);

      const p = document.createElement("p");
      p.style.cssText = "margin:0 0 14px;color:var(--ink-dim);font-size:13px";
      p.appendChild(txt(
        status === 404
          ? "You are signed in, but this account is not on the operator " +
            "allowlist. Admin rights are granted to a Blockle account id — " +
            "there is no separate operator login to try."
          : status === 503
            ? "The Blockle account service is not answering, so we cannot tell " +
              "who you are and will not guess. Nothing here is available until " +
              "it is back. Detail: " + (e.message || e)
            : "The console uses your ordinary Blockle account. Sign in, and if " +
              "that account is on the operator allowlist you will land here."
      ));
      card.appendChild(p);

      if (status !== 503) {
        const a = document.createElement("a");
        a.href =
          "https://exchange.blockle.org/signin.html?as=operator&return=" +
          encodeURIComponent("https://admin.blockle.org/admin/");
        a.style.cssText =
          "display:inline-flex;align-items:center;justify-content:center;" +
          "background:var(--signal);color:#04161a;text-decoration:none;" +
          "font-weight:600;padding:10px 16px;border-radius:5px";
        a.appendChild(txt(status === 404 ? "Sign in as a different account" : "Sign in"));
        card.appendChild(a);
      }
      host.appendChild(card);
      throw e;
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
      return; // no session: the banner already says so
    }
    const custForm = document.getElementById("cust-form");
    if (custForm) {
      custForm.addEventListener("submit", (e) => {
        e.preventDefault();
        lookup(document.getElementById("cust-q").value);
      });
    }
    await Promise.all([
      loadRevenue(), loadGas(), loadCoverage(), loadActions(), loadCustomers(0),
    ]);
  })();
