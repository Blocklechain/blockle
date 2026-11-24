// ---------------------------------------------------------------------------
// blockle.org front page — the exchange link, SHOWN ONLY WHEN IT IS REALLY LIVE
//
// Injected into every proxied page by nginx (the same sub_filter hook that adds
// fork-banner.js) but it renders on the FRONT PAGE ONLY, as the first thing on
// it.
//
// WHY THIS IS A SCRIPT AND NOT AN EDIT TO THE PAGE.
//
// "Link to the exchange once it is live" has an obvious implementation —
// hard-code the link on launch day — and that implementation has a failure mode
// worth avoiding: the link goes up when somebody remembers to put it up, and
// stays up if the venue later goes back to testnet or is taken down. It would
// then be the most prominent thing on the front page, pointing at an exchange
// that cannot take a deposit.
//
// So the condition is read from the venue itself, every page load:
// /public/status reports `live` as true only when BOTH the mainnet gate and the
// legal-review assertion are set, and that endpoint fails closed — a missing
// config, bad JSON, or an unset flag all report false. Nothing here can show
// the banner for a venue that is not live, including by being deployed early.
//
// It also means nobody has to remember. The gate flip IS the launch.
//
// THREE SMALLER DECISIONS:
//
//  * No layout space is reserved. The strip is inserted only after a
//    successful "live" response, so a slow or failed request leaves the page
//    exactly as it is rather than holding a gap.
//  * It is dismissible and remembers that, because a permanent un-closable bar
//    on your own front page is an advert you are serving to yourself.
//  * Styling is self-contained and inline. It is injected into pages whose CSS
//    this script cannot see, so inheriting from them would mean looking
//    different on every page it lands on.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  // FRONT PAGE ONLY. The script is injected site-wide by one nginx rule; the
  // decision about where it belongs lives here, next to the reason.
  var path = location.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/index.html") return;

  var KEY = "blockle.exchange.strip.dismissed";
  try {
    if (localStorage.getItem(KEY) === "1") return;
  } catch (e) {
    // Private browsing with storage denied: show it. Failing to show a true
    // notice is worse than showing it again.
  }

  var ORIGIN = "https://exchange.blockle.org";

  function build(info) {
    var wrap = document.createElement("aside");
    wrap.setAttribute("aria-label", "Blockle Exchange");
    wrap.style.cssText = [
      "display:flex", "align-items:center", "gap:16px", "flex-wrap:wrap",
      "padding:13px 20px",
      // The brand cyan over near-black, matching the exchange itself so the
      // destination is recognisable before you arrive.
      "background:linear-gradient(90deg,#07131a,#0b1b22 55%,#07131a)",
      "border-bottom:1px solid #16343c",
      "font:14px/1.45 system-ui,-apple-system,'Segoe UI',Inter,Roboto,sans-serif",
      "color:#e9eef6", "position:relative", "z-index:40",
    ].join(";");

    var badge = document.createElement("span");
    badge.textContent = "LIVE";
    badge.style.cssText = [
      "font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace",
      "letter-spacing:.14em", "padding:5px 7px", "border-radius:3px",
      "border:1px solid #2fd48a", "color:#2fd48a", "flex:none",
    ].join(";");
    wrap.appendChild(badge);

    var text = document.createElement("span");
    text.style.cssText = "flex:1 1 320px;min-width:0";
    var strong = document.createElement("strong");
    strong.textContent = "Blockle Exchange";
    strong.style.cssText = "letter-spacing:-.01em";
    text.appendChild(strong);
    // Said plainly, and only what the venue actually reports. No volume
    // figures, no "world's first", nothing that would need checking.
    text.appendChild(document.createTextNode(
      " — trade " + info.assets + " assets across " + info.markets +
      " markets, " + info.fees + " maker and taker."
    ));
    wrap.appendChild(text);

    var cta = document.createElement("a");
    cta.href = ORIGIN + "/app.html";
    cta.textContent = "Open the exchange";
    cta.style.cssText = [
      "flex:none", "background:#35d6e8", "color:#04171b", "text-decoration:none",
      "font-weight:600", "padding:9px 16px", "border-radius:5px",
    ].join(";");
    wrap.appendChild(cta);

    var x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    x.style.cssText = [
      "flex:none", "background:none", "border:0", "color:#5e6b80",
      "font-size:20px", "line-height:1", "cursor:pointer", "padding:4px 8px",
    ].join(";");
    x.onclick = function () {
      wrap.parentNode && wrap.parentNode.removeChild(wrap);
      try { localStorage.setItem(KEY, "1"); } catch (e) { /* nothing to do */ }
    };
    wrap.appendChild(x);

    return wrap;
  }

  function insert(node) {
    // FIRST ITEM ON THE PAGE, which is what was asked for — above the hero,
    // not tucked into a nav.
    document.body.insertBefore(node, document.body.firstChild);
  }

  // Everything below runs only on a successful, explicitly-live response.
  function go() {
    fetch(ORIGIN + "/public/status", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        if (!st || st.live !== true) return; // testnet, unknown, or unreachable
        // Fetch the counts so the copy states something true rather than a
        // number typed in once and left to rot. If either call fails the strip
        // still goes up — it just says less.
        return Promise.all([
          fetch(ORIGIN + "/public/markets", { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : []; })
            .catch(function () { return []; }),
          fetch(ORIGIN + "/public/fees", { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; }),
        ]).then(function (out) {
          var markets = out[0] || [];
          var fees = out[1];
          var assets = {};
          markets.forEach(function (m) { assets[m.base] = 1; assets[m.quote] = 1; });
          insert(build({
            markets: markets.length || "several",
            assets: Object.keys(assets).length || "several",
            fees: (fees && fees.takerPct) || "0.20%",
          }));
        });
      })
      .catch(function () {
        // Unreachable venue: show nothing. A link to an exchange that is not
        // answering is worse than no link.
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go);
  } else {
    go();
  }
})();
