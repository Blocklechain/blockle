// ---------------------------------------------------------------------------
// All data comes from the public read-only API. Paths are relative so the page
// works whether it is served at a host root or behind a path prefix.
//
// EVERY FETCH FAILS SILENT AND LEAVES THE PLACEHOLDER. A front page that
// renders "0.00" when the feed is down is lying about a market; an em dash is
// honest about not knowing. Same for liquidity: showing "0 available" when we
// simply could not reach the ledger would send customers away for no reason.
// ---------------------------------------------------------------------------

const api = async (path) => {
  const r = await fetch("public/" + path, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status + "");
  return r.json();
};

// ---- markets --------------------------------------------------------------
(async function markets() {
  const tbody = document.getElementById("mrows");
  try {
    const rows = await api("tickers");
    if (!Array.isArray(rows) || rows.length === 0) return;
    tbody.innerHTML = "";
    for (const t of rows.slice(0, 8)) {
      const chg = t.change24h;
      const dir = typeof chg === "number" ? (chg >= 0 ? "up" : "down") : "";
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="pair"></td><td class="num"></td>' +
        '<td class="num ' + dir + '"></td><td class="num"></td>';
      const c = tr.querySelectorAll("td");
      // textContent throughout — these strings come off the wire.
      c[0].textContent = String(t.pair ?? "\u2014");
      // null means NO MARKET YET, which is not the same as a price of zero.
      c[1].textContent = t.last ?? "\u2014";
      c[2].textContent = typeof chg === "number"
        ? (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "\u2014";
      c[3].textContent = t.volume24h ?? "\u2014";
      tbody.appendChild(tr);
    }
  } catch { /* leave the dashes */ }
})();

// ---- withdrawal liquidity -------------------------------------------------
(async function liquidity() {
  const grid = document.getElementById("liqgrid");
  try {
    const { assets } = await api("liquidity");
    if (!Array.isArray(assets) || assets.length === 0) {
      grid.innerHTML = "";
      const d = document.createElement("div");
      d.className = "card"; d.style.cursor = "default";
      d.innerHTML = "<h3>Not trading yet</h3><p></p>";
      d.querySelector("p").textContent =
        "Withdrawal liquidity appears here once the venue is funded.";
      grid.appendChild(d);
      return;
    }
    grid.innerHTML = "";
    // Only show assets that actually have something withdrawable somewhere;
    // a wall of zeroes is noise, not transparency.
    const withAny = assets.filter(a =>
      a.networks.some(n => n.open) || a.maxSingleWithdrawal !== "0");
    const show = withAny.length > 0 ? withAny : assets.slice(0, 3);

    for (const a of show) {
      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "default";
      const h = document.createElement("h3");
      h.textContent = a.asset;
      card.appendChild(h);

      for (const n of a.networks) {
        const row = document.createElement("p");
        row.style.cssText =
          "display:flex;justify-content:space-between;gap:12px;margin:5px 0;" +
          "font-size:13px;align-items:baseline";
        const left = document.createElement("span");
        left.textContent = n.label;
        left.style.color = n.open ? "var(--ink-dim)" : "var(--ink-faint)";
        const right = document.createElement("span");
        right.style.cssText =
          "font-family:var(--mono);font-variant-numeric:tabular-nums;" +
          (n.open ? "color:var(--up)" : "color:var(--ink-faint)");
        // The available figure is a STRING from the API — never reformatted
        // as a number here, which would reintroduce the precision loss the
        // API went to trouble to avoid.
        right.textContent = n.open ? n.available : "unavailable";
        if (!n.open && n.note) left.title = n.note;
        row.appendChild(left); row.appendChild(right);
        card.appendChild(row);
      }
      grid.appendChild(card);
    }
  } catch {
    grid.innerHTML = "";
    const d = document.createElement("div");
    d.className = "card"; d.style.cursor = "default";
    d.innerHTML = "<h3>Temporarily unavailable</h3><p></p>";
    d.querySelector("p").textContent =
      "We could not read live liquidity just now. This does not affect your balance.";
    grid.appendChild(d);
  }
})();

// ---- reserves note --------------------------------------------------------
(async function reservesNote() {
  try {
    const { assets } = await api("reserves");
    if (!Array.isArray(assets) || assets.length === 0) return;
    const short = assets.filter(a => a.fullyBacked === false);
    const el = document.getElementById("reservenote");
    // Say the uncomfortable thing if it is true. A venue that only publishes
    // reserves when they look good has published nothing.
    el.textContent = short.length === 0
      ? "Every listed asset is currently fully backed."
      : "Attention: " + short.map(a => a.asset).join(", ") + " not fully backed.";
    if (short.length > 0) el.style.color = "var(--down)";
  } catch { /* leave it blank */ }
})();

// ---- withdrawal fees ------------------------------------------------------
//
// Rendered as the strings the API sent. The fee for a token chain moves with
// the gas price, so these are fetched rather than written into the page — a
// hard-coded fee table is a fee table that will be wrong.
(async function withdrawalFees() {
  const body = document.getElementById("wdfee-rows");
  if (!body) return;
  try {
    const r = await api("withdrawal-fees");
    body.textContent = "";
    // Cheapest chains first for each asset, which is also the order the
    // withdraw screen offers them in.
    const rows = r.fees.slice().sort((a, b) =>
      a.asset === b.asset
        ? (a.minimum.length - b.minimum.length) || a.minimum.localeCompare(b.minimum)
        : a.asset.localeCompare(b.asset)
    );
    for (const f of rows) {
      const tr = document.createElement("tr");
      for (const [v, align] of [
        [f.asset, "left"],
        [f.network || "native", "left"],
        [f.fee + " " + f.asset, "right"],
        [f.minimum + " " + f.asset, "right"],
      ]) {
        const td = document.createElement("td");
        td.style.cssText =
          "text-align:" + align + ";padding:6px 8px;border-top:1px solid var(--line-soft)";
        td.appendChild(document.createTextNode(v));
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    const note = document.getElementById("wdfee-note");
    if (note) note.textContent = r.note;
  } catch (e) {
    body.textContent = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.padding = "6px 8px";
    // Said plainly rather than left as a spinner. A fee table that silently
    // fails to load reads as "there are no fees".
    td.appendChild(document.createTextNode("Fee schedule unavailable: " + e.message));
    tr.appendChild(td);
    body.appendChild(tr);
  }
})();

// ---- fees -----------------------------------------------------------------
(async function fees() {
  try {
    const f = await api("fees");
    for (const el of document.querySelectorAll("[data-fee-maker]")) {
      el.textContent = f.makerPct;
    }
    for (const el of document.querySelectorAll("[data-fee-taker]")) {
      el.textContent = f.takerPct;
    }
  } catch { /* the static copy stands */ }
})();

// ---- testnet banner -------------------------------------------------------
// DEFAULTS TO VISIBLE. A missing or failed response must never be read as
// "we are licensed and live".
(async function banner() {
  try {
    const s = await api("status");
    if (s && s.live === true) document.getElementById("testnet").hidden = true;
  } catch { /* banner stays */ }
})();
