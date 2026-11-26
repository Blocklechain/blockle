// -----------------------------------------------------------------------------
// COIN PAGE GENERATOR — one static page per listed coin, plus the index,
// sitemap and robots.txt.
//
// WHY THESE PAGES EXIST.
//
// A miner with a wallet full of a small proof-of-work coin searches for the
// coin's name and the word "exchange", and finds either nothing or a dead
// listing from 2021. That search is the entire acquisition channel for a venue
// like this one, and it is won with a real page per coin — a server-rendered
// one, because the app is a JavaScript shell and a crawler reading it finds an
// empty div.
//
// WHAT MAKES THIS HONEST RATHER THAN SPAM.
//
// The temptation with programmatic pages is to generate "Buy RTM — best RTM
// exchange" for every ticker in existence, which is both a lie and, these days,
// a ranking liability. Four rules keep this on the right side:
//
//  1. THE HEADLINE COMES FROM THE STATUS. A planned coin's page says the market
//     is not open yet, in the title, in the H1, and in the first sentence.
//     There is no code path that produces "trade X now" for a coin with no
//     market — see `headline()`.
//  2. UNCONFIRMED FACTS ARE OMITTED, NOT HEDGED. A spec with
//     `confirmed: false` is not printed. "Probably GhostRider" is worse than
//     silence.
//  3. NO PRICES, NO MARKET CAPS, NO VOLUME. We do not have reliable figures for
//     these coins and a stale number on a static page is a false claim with a
//     long half-life. The pages carry what does not rot: what the chain is, how
//     it is mined, and what we will do with it.
//  4. EVERY PAGE IS DIFFERENT where it matters, because the pitch is written by
//     hand per coin. The template is shared; the substance is not.
//
// WHAT GOES IN THE STRUCTURED DATA.
//
// JSON-LD, but only types that are true: the exchange is an Organization, each
// page is a WebPage with a BreadcrumbList. NOT `Product` with an `offers`
// block, which is the obvious trick and would be asserting a price and
// availability we do not have. A fabricated offer is exactly the kind of thing
// that gets a domain demoted, and it would be a lie regardless.
// -----------------------------------------------------------------------------

import {
	LISTED,
	QUOTES,
	marketsFor,
	type Fact,
	type ListedCoin,
	type ListingStatus,
} from "./listed";

export const SITE = "https://exchange.blockle.org";

/**
 * JSON for a `<script type="application/ld+json">` block.
 *
 * NOT plain JSON.stringify. Inside a script element the HTML parser is still
 * looking for `</script`, so a `<` anywhere in the data can end the block
 * early and the rest of the JSON becomes markup. That is both a broken page
 * and an injection point.
 *
 * Caught by a test that put `<script>alert("x")</script>` in a coin's name and
 * found it intact in the output. The registry is operator-written today, but
 * the listing form is public and names flow from it, so this is escaped at the
 * boundary rather than trusted upstream.
 *
 * `\u003c` and friends are valid JSON escapes and parse back to the same
 * string, so nothing is lost.
 */
export function jsonLdScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		// U+2028/9 are line terminators to a JavaScript parser but not to JSON.
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/** HTML-escape. Everything interpolated into a page goes through this. */
export function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * THE ASSETS A LIVE COIN CAN ACTUALLY BE SOLD INTO, most senior first.
 *
 * Derived from the venue's open markets rather than from a quote list, because
 * these pages publish links. `marketsFor` returns real symbols in the venue's
 * own orientation, so this reads the counterparty off each one instead of
 * assuming the coin is the base — which it is not for every pair (the live
 * symbol for BLOCK against USDC is `USDC-BLOCK`).
 */
function counterparts(coin: ListedCoin): readonly string[] {
	return marketsFor(coin).map((sym) => {
		const i = sym.indexOf("-");
		const base = sym.slice(0, i);
		return base === coin.symbol ? sym.slice(i + 1) : base;
	});
}

/** "A", "A and B", "A, B and C" — written out, because this is prose. */
function andList(xs: readonly string[]): string {
	if (xs.length === 0) return "";
	if (xs.length === 1) return xs[0]!;
	return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]!}`;
}

/**
 * THE ONE FUNCTION THAT DECIDES WHAT A PAGE CLAIMS.
 *
 * Everything else is layout. If a page ever reads as though a market is open
 * when it is not, the bug is here, and nowhere else.
 *
 * THE QUOTE LIST IS NO LONGER A SENTENCE SOMEBODY TYPED. Every "trades against
 * USDT and against BLOCK" in this file was written when those were the only two
 * quotes, and each one became a false claim the day a third was added — while
 * still reading perfectly. They are generated from the venue's open markets
 * now, so the copy cannot disagree with the market table.
 */
export function headline(coin: ListedCoin): {
	readonly title: string;
	readonly h1: string;
	readonly lede: string;
	readonly cta: { readonly label: string; readonly href: string };
	/** For the index badge and the page's own status line. */
	readonly statusLine: string;
} {
	/*
	 * THE CTA POINTS AT THE SENIOR OPEN MARKET, whichever one that is.
	 *
	 * It used to be hardcoded to `${symbol}-USDT`. That is still the answer for
	 * every coin in the registry today, and it is no longer an answer this file
	 * is entitled to assume: a coin whose USDT market is closed, or which is
	 * written the other way round, would get a button linking to a market the
	 * venue answers 404 for — on the page a miner lands on.
	 */
	const senior = marketsFor(coin)[0];
	const pair = senior === undefined ? undefined : senior.replace("-", "/");
	switch (coin.status) {
		case "live":
			return {
				title: `Trade ${coin.symbol} — buy and sell ${coin.name} | Blockle Exchange`,
				h1: `Trade ${coin.name} (${coin.symbol})`,
				lede:
					`${coin.symbol} trades against ${andList(counterparts(coin))} on ` +
					"Blockle Exchange. Deposit from your miner or your wallet, sell into " +
					`${pair ?? "the market"}, and withdraw.`,
				cta:
					senior === undefined
						// A "live" coin with no open market should be impossible —
						// canGoLive refuses the promotion. If it happens anyway, the
						// page sends people to the market list rather than to a 404.
						? { label: "Open the exchange", href: `${SITE}/app.html#/markets` }
						: { label: `Trade ${pair!}`, href: `${SITE}/app.html#/trade/${senior}` },
				statusLine: "Market open",
			};
		case "integrating":
			return {
				title: `${coin.name} (${coin.symbol}) listing in progress | Blockle Exchange`,
				h1: `${coin.name} (${coin.symbol}) is being listed`,
				lede:
					`We are integrating ${coin.name}. The node is syncing and custody is ` +
					"being wired up; deposits are NOT open yet, so please do not send " +
					`${coin.symbol} to this exchange until this page says the market is open.`,
				// Not the trade screen. Sending someone to a market that does not
				// exist is how a deposit goes somewhere nobody can credit it.
				cta: { label: "Follow the listing", href: `${SITE}/app.html#/listing` },
				statusLine: "Integration in progress — deposits closed",
			};
		case "planned":
		default:
			return {
				title: `${coin.name} (${coin.symbol}) — planned listing | Blockle Exchange`,
				h1: `${coin.name} (${coin.symbol}) on Blockle Exchange`,
				lede:
					`${coin.name} is on our listing list and is not tradeable here yet. ` +
					"There are no deposit addresses for it, and we are not asking you " +
					"to send anything. This page explains what we intend to do and how " +
					"to push it up the queue.",
				cta: { label: "Ask us to prioritise it", href: `${SITE}/app.html#/listing` },
				statusLine: "Planned — not yet tradeable",
			};
	}
}

const badgeClass = (s: ListingStatus): string =>
	s === "live" ? "ok" : s === "integrating" ? "warn" : "idle";

/** A confirmed fact as a spec row, or nothing at all. */
function specRow(label: string, fact: Fact | undefined): string {
	// RULE 2. An unconfirmed fact does not get printed — not even with a
	// qualifier. Nobody is served by "GhostRider (unverified)" on a page that
	// is meant to be the reliable one.
	if (fact === undefined || !fact.confirmed) return "";
	return (
		`        <div class="spec"><dt>${esc(label)}</dt>` +
		`<dd>${esc(fact.value)}</dd></div>\n`
	);
}

const CSS = `
:root{
  --bg:#070a0f;--panel:#0d1219;--line:#1e2735;--line-soft:#161d27;
  --ink:#e9eef6;--ink-dim:#93a0b6;--ink-faint:#5e6b80;
  --signal:#35d6e8;--signal-ink:#04171b;--ok:#2fd48a;--warn:#f5a524;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 var(--sans);
  -webkit-font-smoothing:antialiased}
a{color:var(--signal)}
.wrap{max-width:860px;margin:0 auto;padding:0 20px 72px}
header.top{border-bottom:1px solid var(--line);margin-bottom:34px}
header.top .wrap{display:flex;align-items:center;gap:12px;padding:14px 20px}
header.top img{width:26px;height:26px;border-radius:6px}
header.top b{font-size:15px;letter-spacing:.01em}
header.top nav{margin-left:auto;display:flex;gap:18px;font-size:13.5px}
header.top nav a{color:var(--ink-dim);text-decoration:none}
header.top nav a:hover{color:var(--ink)}
.crumb{font-size:12.5px;color:var(--ink-faint);margin:0 0 14px}
.crumb a{color:var(--ink-faint)}
h1{font-size:30px;line-height:1.2;margin:0 0 6px;letter-spacing:-.012em;text-wrap:balance}
.sub{color:var(--ink-dim);font-size:15px;margin:0 0 20px;max-width:62ch}
.badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;
  border:1px solid var(--line);border-radius:999px;padding:4px 11px;color:var(--ink-dim);
  margin-bottom:16px}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ink-faint)}
.badge.ok{color:var(--ok);border-color:rgba(47,212,138,.35)}
.badge.ok::before{background:var(--ok)}
.badge.warn{color:var(--warn);border-color:rgba(245,165,36,.35)}
.badge.warn::before{background:var(--warn)}
.cta{display:inline-block;background:var(--signal);color:var(--signal-ink);
  font:600 14px var(--sans);padding:11px 20px;border-radius:7px;text-decoration:none}
.cta.quiet{background:none;color:var(--ink);border:1px solid var(--line)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:22px 0 34px}
section{border-top:1px solid var(--line-soft);padding-top:26px;margin-top:30px}
h2{font-size:13px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-dim);
  margin:0 0 14px;font-weight:600}
dl.specs{margin:0;display:grid;gap:1px;background:var(--line-soft);
  border:1px solid var(--line-soft);border-radius:8px;overflow:hidden}
.spec{display:flex;justify-content:space-between;gap:16px;background:var(--panel);
  padding:11px 14px}
.spec dt{color:var(--ink-dim);font-size:13.5px;margin:0}
.spec dd{margin:0;font-family:var(--mono);font-size:13px;text-align:right}
.titlerow{display:flex;align-items:center;gap:13px;margin-bottom:6px}
.titlerow h1{margin:0}
.mark{flex:none;display:inline-flex;line-height:0}
.mark svg{border-radius:50%}
table.coins td .mark{vertical-align:middle;margin-right:9px}
.pairs{display:flex;gap:8px;flex-wrap:wrap}
.pair{font-family:var(--mono);font-size:13px;border:1px solid var(--line);
  border-radius:6px;padding:7px 12px;color:var(--ink);text-decoration:none}
.pair.off{color:var(--ink-faint);border-style:dashed}
p{max-width:68ch}
.note{font-size:13px;color:var(--ink-faint);border-left:2px solid var(--line);
  padding-left:12px;margin:18px 0}
ul.steps{padding-left:18px;color:var(--ink-dim);max-width:66ch}
ul.steps li{margin:7px 0}
ul.steps b{color:var(--ink);font-weight:600}
table.coins{width:100%;border-collapse:collapse;font-size:14px}
table.coins th{text-align:left;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-faint);font-weight:600;padding:0 10px 9px;border-bottom:1px solid var(--line)}
table.coins td{padding:11px 10px;border-bottom:1px solid var(--line-soft)}
table.coins tr:last-child td{border-bottom:0}
table.coins a{text-decoration:none;font-weight:600}
table.coins .sym{font-family:var(--mono);font-size:12.5px;color:var(--ink-dim)}
footer{border-top:1px solid var(--line);margin-top:48px;padding-top:20px;
  font-size:12.5px;color:var(--ink-faint)}
footer a{color:var(--ink-faint);margin-right:16px}
@media (max-width:620px){
  h1{font-size:25px}
  .spec{flex-direction:column;gap:3px}
  .spec dd{text-align:left}
  header.top nav{display:none}
}
`.trim();

function shell(args: {
	title: string;
	description: string;
	canonical: string;
	jsonLd: unknown[];
	body: string;
}): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(args.title)}</title>
<meta name="description" content="${esc(args.description)}" />
<link rel="canonical" href="${esc(args.canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(args.title)}" />
<meta property="og:description" content="${esc(args.description)}" />
<meta property="og:url" content="${esc(args.canonical)}" />
<meta property="og:site_name" content="Blockle Exchange" />
<meta name="twitter:card" content="summary" />
<link rel="icon" href="/logo.png" />
<style>${CSS}</style>
<script type="application/ld+json">${jsonLdScript(args.jsonLd)}</script>
</head>
<body>
<header class="top"><div class="wrap">
  <img src="/logo.png" alt="" width="26" height="26" />
  <b>Blockle Exchange</b>
  <nav>
    <a href="/coins">Coins</a>
    <a href="/app.html#/markets">Markets</a>
    <a href="/app.html#/listing">List a coin</a>
    <a href="/app.html#/api">API</a>
  </nav>
</div></header>
<div class="wrap">
${args.body}
<script src="/coins.js"></script>
<script>
  /* The marks are decoration added after the fact: the page is complete
     without this, so a blocked or slow script costs an icon, not content. */
  (function () {
    if (typeof window.coinIcon !== "function") return;
    var nodes = document.querySelectorAll(".mark[data-coin]");
    for (var i = 0; i < nodes.length; i++) {
      var big = !nodes[i].classList.contains("sm");
      nodes[i].innerHTML = window.coinIcon(nodes[i].getAttribute("data-coin"), big ? 40 : 20);
    }
  })();
</script>
<footer>
  <a href="/coins">All coins</a>
  <a href="/app.html">Exchange</a>
  <a href="https://blockle.org/">blockle.org</a>
  <a href="https://blockle.org/terms">Terms</a>
  <p style="margin:14px 0 0;max-width:68ch">
    Blockle Exchange is operated by Alienbeing LLC. Nothing on this page is
    investment advice, and no price, volume or market-capitalisation figure is
    quoted here — only what the chain is and how we handle it.
  </p>
</footer>
</div>
</body>
</html>
`;
}

const org = {
	"@type": "Organization",
	name: "Blockle Exchange",
	url: SITE,
	parentOrganization: { "@type": "Organization", name: "Alienbeing LLC" },
};

/** One coin page. */
export function coinPage(coin: ListedCoin): string {
	const h = headline(coin);
	const live = coin.status === "live";

	/*
	 * Pairs are shown either way — a miner wants to know what it WILL trade
	 * against — but only an open market is a link.
	 *
	 * The two cases come from different places on purpose. A live coin's chips
	 * are REAL SYMBOLS from the venue, so the href resolves and the orientation
	 * is the venue's own. A not-yet-live coin has no symbols, so its chips are
	 * composed from the quote list and are plain text; composing hrefs for them
	 * was how this file could publish a link to `BTC-ETH`.
	 */
	const pairs = (
		live
			? marketsFor(coin).map(
					(sym) =>
						`<a class="pair" href="/app.html#/trade/${esc(sym)}">` +
						`${esc(sym.replace("-", "/"))}</a>`,
				)
			: QUOTES.filter((q) => q !== coin.symbol).map(
					(q) =>
						`<span class="pair off">${esc(coin.symbol)}/${esc(q)} — not open</span>`,
				)
	).join("\n          ");

	const specs =
		specRow("Algorithm", coin.algorithm) +
		specRow("Block time", coin.blockTime) +
		(coin.decimals === undefined
			? ""
			: `        <div class="spec"><dt>Decimal places</dt><dd>${coin.decimals}</dd></div>\n`) +
		(live && coin.confirmations !== undefined
			? `        <div class="spec"><dt>Deposit confirmations</dt>` +
				`<dd>${coin.confirmations}</dd></div>\n`
			: "");

	const venues =
		coin.knownVenues === undefined
			? ""
			: `      <p class="note">
        As of ${esc(coin.knownVenues.asOf)} we counted ${coin.knownVenues.count}
        other ${coin.knownVenues.count === 1 ? "venue" : "venues"} carrying
        ${esc(coin.symbol)}. That is the reason it is on this list: the mining
        is healthy and the places to sell are not. We are not claiming to be
        the only one.
      </p>\n`;

	const howItWorks = live
		? `      <ul class="steps">
        <li><b>Deposit.</b> Your account gets an address that belongs only to
          you, so a payout straight from a pool is credited to you without a
          memo or a support ticket.</li>
        <li><b>Sell.</b> ${esc(coin.symbol)} trades against
          ${esc(andList(counterparts(coin)))}. Limit orders only — you set the
          price.</li>
        <li><b>Withdraw.</b> The fee is the chain cost plus a margin, quoted
          before you confirm, and withdrawals are blocked rather than
          part-paid if the chain fee cannot be covered.</li>
      </ul>`
		: `      <ul class="steps">
        <li><b>Nothing to deposit yet.</b> There is no ${esc(coin.symbol)}
          address on this exchange, and anything sent in its direction cannot
          be credited. We would rather say that plainly than collect deposits
          we cannot account for.</li>
        <li><b>What we are waiting on.</b> A synced node we run ourselves,
          confirmed decimals and confirmation depth, and a reconciliation
          that balances. Until all four hold, this page stays as it is.</li>
        <li><b>How to speed it up.</b> The listing form reaches a person. A
          pool operator or project maintainer asking for it moves it up the
          queue faster than anything else.</li>
      </ul>`;

	const body = `  <p class="crumb"><a href="/coins">Coins</a> &rsaquo; ${esc(coin.name)}</p>
  <span class="badge ${badgeClass(coin.status)}">${esc(h.statusLine)}</span>
  <div class="titlerow">
    <!-- Filled from coins.js, which is where every coin mark in the product
         lives. Drawing it again here would be a second copy to keep in step,
         and the mark is decoration: the page reads correctly without it, which
         is what matters for the crawler that will not run this. -->
    <span class="mark" data-coin="${esc(coin.symbol)}"></span>
    <h1>${esc(h.h1)}</h1>
  </div>
  <p class="sub">${esc(h.lede)}</p>
  <div class="row">
    <a class="cta" href="${esc(h.cta.href)}">${esc(h.cta.label)}</a>
    ${coin.homepage === undefined ? "" : `<a class="cta quiet" href="${esc(coin.homepage)}" rel="nofollow noopener">${esc(coin.name)} project site</a>`}
  </div>

  <section>
    <h2>Why ${esc(coin.symbol)}</h2>
    <p>${esc(coin.pitch)}</p>
${venues}  </section>

${specs === "" ? "" : `  <section>
    <h2>The chain</h2>
    <dl class="specs">
${specs}    </dl>
    <p class="note">
      Only details we have checked are listed. Where a figure is missing it is
      because nobody here has confirmed it against the chain, and a plausible
      guess on a reference page is worse than a gap.
    </p>
  </section>

`}  <section>
    <h2>Markets</h2>
    <div class="pairs">
          ${pairs}
    </div>
    <p class="note">
      Every coin here trades against every quote this venue can actually settle
      — today ${esc(andList(QUOTES))}. A quote whose deposits or withdrawals we
      cannot open does not get a market, because a market that cannot settle is
      worse than one that does not exist.
    </p>
  </section>

  <section>
    <h2>How selling ${esc(coin.symbol)} here works</h2>
${howItWorks}
  </section>
`;

	return shell({
		title: h.title,
		description: h.lede,
		canonical: `${SITE}/trade/${coin.slug}`,
		jsonLd: [
			{
				"@context": "https://schema.org",
				"@type": "WebPage",
				name: h.h1,
				description: h.lede,
				url: `${SITE}/trade/${coin.slug}`,
				isPartOf: { "@type": "WebSite", name: "Blockle Exchange", url: SITE },
				publisher: org,
			},
			{
				"@context": "https://schema.org",
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: "Coins", item: `${SITE}/coins` },
					{
						"@type": "ListItem",
						position: 2,
						name: `${coin.name} (${coin.symbol})`,
						item: `${SITE}/trade/${coin.slug}`,
					},
				],
			},
		],
		body,
	});
}

/** The index. The page that should rank for "small pow coin exchange". */
export function indexPage(): string {
	const rows = LISTED.map((c) => {
		const h = headline(c);
		return `      <tr>
        <td><span class="mark sm" data-coin="${esc(c.symbol)}"></span>
            <a href="/trade/${esc(c.slug)}">${esc(c.name)}</a>
            <span class="sym">${esc(c.symbol)}</span></td>
        <td>${c.algorithm !== undefined && c.algorithm.confirmed ? esc(c.algorithm.value) : "—"}</td>
        <td><span class="badge ${badgeClass(c.status)}">${esc(h.statusLine)}</span></td>
      </tr>`;
	}).join("\n");

	const body = `  <h1>Coins on Blockle Exchange</h1>
  <p class="sub">
    We list proof-of-work coins that people actually mine and can barely sell —
    the ones a hobbyist finds on a pool and then discovers have two thin
    markets anywhere. Every live coin trades against ${esc(andList(QUOTES))}.
  </p>
  <div class="row">
    <a class="cta" href="/app.html#/markets">Open the exchange</a>
    <a class="cta quiet" href="/app.html#/listing">List your coin</a>
  </div>

  <section>
    <h2>The list</h2>
    <table class="coins">
      <thead><tr><th>Coin</th><th>Algorithm</th><th>Status</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <p class="note">
      "Planned" means exactly that: no deposits, no market, nothing to send.
      Each coin's page says where it stands. We would rather publish the queue
      than imply a market that is not open.
    </p>
  </section>

  <section>
    <h2>Why a venue for these</h2>
    <p>
      A coin can have a healthy network, a dozen pools and a few thousand
      miners, and still have nowhere to sell — because listing fees are written
      for projects with a treasury, and these chains mostly do not have one. So
      the mining carries on and the coin accumulates in wallets.
    </p>
    <p>
      Listing here costs a conversation, not a fee that has to be funded. In
      exchange we are strict about the part that actually goes wrong: we run the
      node ourselves, we reconcile what customers are owed against what we hold
      on every pass, and we halt withdrawals on a shortfall rather than paying
      the fastest few people out of everyone else's coins.
    </p>
  </section>
`;

	return shell({
		title: "Small proof-of-work coin exchange — trade mined coins | Blockle Exchange",
		description:
			"Blockle Exchange lists proof-of-work coins with real miners and almost " +
			`nowhere to sell. Every live coin trades against ${QUOTES.join(", ")}. ` +
			"See which coins are live and which are still being integrated.",
		canonical: `${SITE}/coins`,
		jsonLd: [
			{
				"@context": "https://schema.org",
				"@type": "CollectionPage",
				name: "Coins on Blockle Exchange",
				url: `${SITE}/coins`,
				publisher: org,
				// An ItemList of pages is true. An ItemList of Products with
				// offers would not be — see the header.
				mainEntity: {
					"@type": "ItemList",
					numberOfItems: LISTED.length,
					itemListElement: LISTED.map((c, i) => ({
						"@type": "ListItem",
						position: i + 1,
						name: `${c.name} (${c.symbol})`,
						url: `${SITE}/trade/${c.slug}`,
					})),
				},
			},
		],
		body,
	});
}

/**
 * The 404 page.
 *
 * Served with a 404 status, which matters: a "soft 404" that returns 200 gets
 * indexed as a real page and then competes with the real ones. Its job is to
 * get someone who followed a stale coin link to the list of coins that exist.
 */
export function notFoundPage(): string {
	return shell({
		title: "Page not found | Blockle Exchange",
		description:
			"That page is not here. The coin list has every asset on Blockle " +
			"Exchange and the status of each one.",
		canonical: `${SITE}/coins`,
		jsonLd: [],
		body: `  <h1>That page is not here</h1>
  <p class="sub">
    Most likely a coin link that has changed, or a page that never existed.
    Slugs here are meant to be permanent, so if a link from somewhere else
    brought you here we would like to know.
  </p>
  <div class="row">
    <a class="cta" href="/coins">All coins and their status</a>
    <a class="cta quiet" href="/app.html">Open the exchange</a>
  </div>
`,
	});
}

/**
 * sitemap.xml.
 *
 * `lastmod` is passed in rather than taken from the clock, because a sitemap
 * regenerated nightly with a fresh date on unchanged pages is a sitemap that
 * teaches a crawler to ignore the field.
 */
export function sitemap(lastmod: string): string {
	const urls = [
		{ loc: `${SITE}/`, priority: "1.0" },
		{ loc: `${SITE}/coins`, priority: "0.9" },
		...LISTED.map((c) => ({ loc: `${SITE}/trade/${c.slug}`, priority: "0.8" })),
	];
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
	.map(
		(u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>${u.priority}</priority>
  </url>`,
	)
	.join("\n")}
</urlset>
`;
}

/**
 * robots.txt.
 *
 * The app and the API are disallowed on purpose: `/app.html` is a JavaScript
 * shell with nothing in it for a crawler, and letting it be indexed splits
 * every coin's relevance between a real page and an empty one.
 */
export function robots(): string {
	return `User-agent: *
Allow: /
Disallow: /v1/
Disallow: /public/
Disallow: /admin.html
Disallow: /signin.html

Sitemap: ${SITE}/sitemap.xml
`;
}

/** Everything to write, as path -> contents. The CLI does the writing. */
export function generate(lastmod: string): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	out.set("coins/index.html", indexPage());
	// NOT in the sitemap, deliberately — a 404 page is not content.
	out.set("404.html", notFoundPage());
	for (const c of LISTED) {
		// A DIRECTORY PER SLUG, so the URL has no extension and never has to
		// change — a .html suffix is a decision about hosting leaking into a
		// link somebody else has already shared.
		out.set(`trade/${c.slug}/index.html`, coinPage(c));
	}
	out.set("sitemap.xml", sitemap(lastmod));
	out.set("robots.txt", robots());
	return out;
}
