/* Blockle network-upgrade countdown banner.
 *
 * Self-contained, dependency-free. Drop-in on any non-game Blockle surface via
 *   <script src="https://blockle.org/fork-banner.js" defer></script>
 * It pins a high-visibility bar to the top of the page counting down the blocks
 * remaining until the cross-algorithm difficulty-coupling fork (block 53,000)
 * and gives action steps tailored to node operators, miners, and wallet users.
 *
 * Data comes from https://blockle.org/fork.json (CORS-enabled, refreshed each
 * minute from the live node). If it can't load, the banner still shows the
 * static upgrade notice — it never blocks the page.
 */
(function () {
  "use strict";
  if (window.__blockleForkBanner) return;
  window.__blockleForkBanner = true;

  var FORK_HEIGHT = 53000;
  var DATA_URL = "https://blockle.org/fork.json";
  var INFO_URL = "https://blockle.org/fork";

  var css = ""
    + "#blk-fork{position:fixed;top:0;left:0;right:0;z-index:2147483000;"
    + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
    + "background:linear-gradient(90deg,#1a0f00,#3a1d00);color:#ffe9c7;"
    + "border-bottom:2px solid #ff9a1f;box-shadow:0 2px 18px rgba(0,0,0,.5);}"
    + "#blk-fork *{box-sizing:border-box}"
    + "#blk-fork .row{display:flex;align-items:center;gap:14px;max-width:1100px;margin:0 auto;padding:10px 16px;flex-wrap:wrap}"
    + "#blk-fork .dot{width:10px;height:10px;border-radius:50%;background:#ff9a1f;flex:0 0 auto;animation:blkpulse 1.4s infinite}"
    + "@keyframes blkpulse{0%,100%{opacity:1}50%{opacity:.3}}"
    + "#blk-fork .hl{color:#ffb84d;font-weight:800}"
    + "#blk-fork .cd{font-variant-numeric:tabular-nums;font-weight:800;color:#fff}"
    + "#blk-fork b{color:#fff}"
    + "#blk-fork .msg{flex:1 1 320px;min-width:260px;font-size:14px;line-height:1.35}"
    + "#blk-fork .tabs{display:flex;gap:6px;flex:0 0 auto}"
    + "#blk-fork .tab{cursor:pointer;border:1px solid #74491a;background:#2a1600;color:#ffd9a0;"
    + "padding:6px 10px;border-radius:999px;font-size:12.5px;font-weight:700}"
    + "#blk-fork .tab.on{background:#ff9a1f;color:#231000;border-color:#ff9a1f}"
    + "#blk-fork .x{cursor:pointer;color:#ffce94;font-size:20px;line-height:1;padding:2px 6px;flex:0 0 auto}"
    + "#blk-fork .steps{max-width:1100px;margin:0 auto;padding:0 16px 12px;font-size:13.5px;line-height:1.5;display:none}"
    + "#blk-fork .steps.on{display:block}"
    + "#blk-fork .steps a{color:#ffb84d;font-weight:700}"
    + "#blk-fork code{background:#000;color:#9fe6b0;padding:1px 6px;border-radius:5px;font-size:12.5px}";

  var AUD = {
    node: {
      label: "I run a node",
      html:
        "<b>Upgrade your node before block " + FORK_HEIGHT + ".</b> A build without the "
        + "energy-coupled difficulty rule will reject post-fork blocks and fork off. "
        + "Pull the latest release and rebuild: <code>git pull &amp;&amp; cargo build --release</code>, "
        + "then restart your <code>blockle-node</code> service. Verify with "
        + "<code>blockle-cli getblockchaininfo</code> (look for <code>cross_algo_activation_height</code>). "
        + "<a href='" + INFO_URL + "'>Full details &rarr;</a>",
    },
    miner: {
      label: "I mine / run a pool",
      html:
        "<b>Update your miner/pool before block " + FORK_HEIGHT + ".</b> After the fork every lane's "
        + "difficulty is derived from one shared, energy-weighted base — your pool must request work "
        + "from the upgraded node (<code>getblocktemplate</code> returns the coupled bits automatically). "
        + "No address or payout changes; rewards now track real power draw, not raw hashrate. "
        + "<a href='" + INFO_URL + "'>How it works &rarr;</a>",
    },
    wallet: {
      label: "I use a wallet",
      html:
        "<b>Nothing changes for your coins.</b> Addresses, keys and balances are unaffected — this is a "
        + "mining-difficulty rule only. Just update to the latest Blockle wallet when prompted so you stay "
        + "on the upgraded network. <a href='https://blockle.org/#downloads'>Get the latest wallet &rarr;</a>",
    },
  };

  function mount() {
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    var el = document.createElement("div");
    el.id = "blk-fork";
    el.innerHTML =
      '<div class="row">'
      + '<span class="dot"></span>'
      + '<div class="msg"><span class="hl">Network upgrade</span> &middot; cross-algorithm difficulty coupling at block '
      + '<b>' + FORK_HEIGHT + '</b> &mdash; <span id="blk-fork-cd" class="cd">checking height&hellip;</span></div>'
      + '<div class="tabs">'
      + '<span class="tab" data-a="node">' + AUD.node.label + '</span>'
      + '<span class="tab" data-a="miner">' + AUD.miner.label + '</span>'
      + '<span class="tab" data-a="wallet">' + AUD.wallet.label + '</span>'
      + '</div>'
      + '<span class="x" title="Hide until next visit">&times;</span>'
      + '</div>'
      + '<div class="steps" id="blk-fork-steps"></div>';
    document.body.insertBefore(el, document.body.firstChild);

    var steps = el.querySelector("#blk-fork-steps");
    var tabs = el.querySelectorAll(".tab");
    function pad() { document.body.style.paddingTop = el.offsetHeight + "px"; }
    function pick(a) {
      tabs.forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-a") === a); });
      steps.innerHTML = AUD[a].html;
      steps.classList.add("on");
      pad();
    }
    tabs.forEach(function (t) {
      t.addEventListener("click", function () { pick(t.getAttribute("data-a")); });
    });
    el.querySelector(".x").addEventListener("click", function () {
      try { sessionStorage.setItem("blkForkHidden", "1"); } catch (e) {}
      el.remove();
      document.body.style.paddingTop = "0";
    });

    pick("wallet"); // open the audience most visitors are
    window.addEventListener("resize", pad);
    pad();

    fetchStatus();
    setInterval(fetchStatus, 60000);
  }

  function fetchStatus() {
    var cd = document.getElementById("blk-fork-cd");
    if (!cd) return;
    fetch(DATA_URL, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var act = (typeof d.active === "boolean") ? d.active : (d.height >= (d.activation_height || FORK_HEIGHT));
        if (act) { cd.innerHTML = "<b>now active</b> at block " + (d.activation_height || FORK_HEIGHT); return; }
        var rem = d.blocks_remaining;
        if (rem == null && d.height != null) rem = (d.activation_height || FORK_HEIGHT) - d.height;
        if (rem == null) { cd.textContent = "upgrade now"; return; }
        var mins = rem * 10; // ~10-min mainnet blocks
        var days = Math.floor(mins / 1440);
        var eta = days > 0 ? (" (~" + days + " day" + (days === 1 ? "" : "s") + ")") : "";
        cd.innerHTML = "<b>" + rem.toLocaleString() + "</b> blocks to go" + eta;
      })
      .catch(function () { cd.textContent = "upgrade before it lands"; });
  }

  function start() {
    try { if (sessionStorage.getItem("blkForkHidden") === "1") return; } catch (e) {}
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  }
  start();
})();
