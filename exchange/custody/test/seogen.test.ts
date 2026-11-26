// -----------------------------------------------------------------------------
// COIN PAGE TESTS.
//
// These pages are the public face of the venue and they are generated, which
// means one bad template produces a hundred bad claims. So the tests are almost
// entirely about WHAT A PAGE IS ALLOWED TO SAY:
//
//   * a coin with no market must not have a page that reads like it has one;
//   * an unconfirmed fact must not appear at all;
//   * no page may quote a price, a volume or a market cap;
//   * the structured data must not assert an offer that does not exist.
//
// The last one matters beyond honesty: a Product/offers block with invented
// availability is the single fastest way to get a domain demoted.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { LISTED, marketsFor, type ListedCoin } from "../src/listed";
import {
	SITE,
	coinPage,
	esc,
	generate,
	headline,
	indexPage,
	notFoundPage,
	robots,
	sitemap,
} from "../src/seogen";

const base: ListedCoin = {
	symbol: "RTM",
	name: "Raptoreum",
	slug: "raptoreum-rtm",
	status: "planned",
	custody: "bitcoin-rpc",
	decimals: 8,
	confirmations: 20,
	homepage: "https://raptoreum.com/",
	algorithm: { value: "GhostRider", confirmed: true, source: "docs" },
	blockTime: { value: "2 minutes", confirmed: false, source: "a forum post" },
	pitch: "One of the few coins a plain CPU still mines competitively today.",
	knownVenues: { count: 2, asOf: "2026-11" },
};
const as = (status: ListedCoin["status"]): ListedCoin => ({ ...base, status });

// ------------------------------------------------------- the claim, by status

test("A PLANNED COIN'S PAGE NEVER READS AS TRADEABLE", () => {
	const html = coinPage(as("planned"));
	// Not in the title...
	assert.ok(!/<title>Trade RTM/.test(html), "the title must not say trade");
	// ...not in the body...
	assert.ok(!/\bbuy and sell\b/i.test(html));
	// ...and it says so positively rather than just omitting the claim.
	assert.match(html, /not tradeable here yet/);
	assert.match(html, /no deposit addresses for it/);
	assert.match(html, /not asking you to send anything/);
	// The call to action goes to the listing form, NOT to a market that does
	// not exist.
	assert.ok(!/#\/trade\/RTM-USDT/.test(html), "must not link to a closed market");
	assert.match(html, /#\/listing/);
});

test("AN INTEGRATING COIN WARNS AGAINST DEPOSITING", () => {
	// This is the dangerous middle state: the coin is clearly coming, so
	// somebody sends early.
	const html = coinPage(as("integrating"));
	assert.match(html, /deposits are NOT open yet/);
	assert.match(html, /do not send RTM to this exchange until/);
	assert.ok(!/#\/trade\/RTM-USDT/.test(html));
	assert.match(html, /Integration in progress — deposits closed/);
});

test("a live coin's page is the only one that invites a trade", () => {
	const html = coinPage(as("live"));
	assert.match(html, /<title>Trade RTM — buy and sell Raptoreum/);
	assert.match(html, /app\.html#\/trade\/RTM-USDT/);
	assert.match(html, /Market open/);
	// AND THE CLOSED-MARKET MARKER IS GONE. Matched on the marker's own markup
	// rather than on the words "not open", which this page now contains in
	// prose ("a quote whose deposits we canNOT OPEN does not get a market") —
	// a substring match that read as a strict check and had become a false
	// positive on a page that was perfectly correct.
	assert.ok(!/class="pair off"/.test(html), "a live coin has no unopened-pair chips");
	assert.ok(!/— not open/.test(html));
	// Every pair chip on a live page is a link to a symbol the venue has.
	for (const sym of marketsFor(as("live"))) {
		assert.ok(
			html.includes(`/app.html#/trade/${sym}"`),
			`${sym} should be linked from the live page`,
		);
	}
});

test("the headline function is the single decision point", () => {
	// If a page ever misrepresents a market, this is where to look. Stated as a
	// test so the invariant is written down somewhere executable.
	for (const status of ["planned", "integrating"] as const) {
		const h = headline(as(status));
		assert.ok(!/^Trade /.test(h.h1), `${status} h1`);
		assert.ok(!h.cta.href.includes("/trade/"), `${status} cta`);
	}
	assert.match(headline(as("live")).cta.href, /#\/trade\//);
});

// ------------------------------------------------------------ facts and specs

test("AN UNCONFIRMED FACT IS OMITTED, NOT HEDGED", () => {
	// "2 minutes (unverified)" on the reference page is worse than silence.
	const html = coinPage(as("live"));
	assert.match(html, /GhostRider/, "the confirmed fact is published");
	assert.ok(!/2 minutes/.test(html), "the unconfirmed one is not published at all");
	assert.ok(!/unverified|probably|approximately/i.test(html));
});

test("a coin with no confirmed facts gets no spec table rather than an empty one", () => {
	// Everything publishable removed, confirmations included — a live coin's
	// confirmation depth IS a spec row, so leaving it set would (correctly)
	// produce a table and the premise of this test would be wrong.
	const bare = coinPage({
		...as("live"),
		algorithm: undefined,
		blockTime: undefined,
		decimals: undefined,
		confirmations: undefined,
	});
	assert.ok(!/The chain<\/h2>/.test(bare));
	// But the page is still substantive.
	assert.match(bare, /Why RTM/);
	assert.match(bare, /How selling RTM here works/);
});

test("confirmation depth is published only once it is real", () => {
	assert.ok(!/Deposit confirmations/.test(coinPage(as("planned"))));
	assert.match(coinPage(as("live")), /Deposit confirmations<\/dt><dd>20/);
});

test("NO PAGE QUOTES A PRICE, A VOLUME OR A MARKET CAP", () => {
	// We do not have reliable figures for these coins, and a stale number on a
	// static page is a false claim with a long half-life.
	for (const c of LISTED) {
		const html = coinPage(c);
		for (const banned of [
			/\$\s?\d/,
			/\bUSD\s?\d/,
			/market cap(?!italisation figure)/i,
			/\b24h volume\b/i,
			/\bprice is\b/i,
			/\ball-time high\b/i,
		]) {
			assert.ok(!banned.test(html), `${c.symbol} must not match ${banned}`);
		}
	}
});

test("the venue count is dated and does not claim exclusivity", () => {
	const html = coinPage(as("planned"));
	// The template wraps prose across lines, so these match across whitespace
	// rather than assuming the line breaks stay where they are today.
	const flat = html.replace(/\s+/g, " ");
	assert.match(flat, /As of 2026-11 we counted 2 other venues carrying RTM/);
	assert.match(flat, /We are not claiming to be the only one/);
});

// ------------------------------------------------------------ structured data

test("THE JSON-LD ASSERTS NO OFFER, NO PRICE AND NO AVAILABILITY", () => {
	for (const c of LISTED) {
		const html = coinPage(c);
		const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
			.map((m) => JSON.parse(m[1]!) as unknown);
		assert.ok(blocks.length > 0, `${c.symbol} has structured data`);
		const text = JSON.stringify(blocks);
		for (const banned of ["Offer", "price", "availability", "Product"]) {
			assert.ok(!text.includes(banned), `${c.symbol} JSON-LD must not contain ${banned}`);
		}
		// And what it does say is the truth: a page, and where it sits.
		assert.match(text, /"WebPage"/);
		assert.match(text, /"BreadcrumbList"/);
	}
});

test("every page declares a canonical url that matches its slug", () => {
	for (const c of LISTED) {
		assert.ok(
			coinPage(c).includes(`<link rel="canonical" href="${SITE}/trade/${c.slug}" />`),
			c.symbol,
		);
	}
});

test("the index lists every coin and links to each page", () => {
	const html = indexPage();
	for (const c of LISTED) {
		assert.ok(html.includes(`/trade/${c.slug}`), `${c.symbol} is linked`);
		assert.ok(html.includes(esc(c.name)), `${c.symbol} is named`);
	}
	// And it is honest about the queue rather than presenting it as a catalogue.
	assert.match(html, /"Planned" means exactly that: no deposits, no market/);
});

// ----------------------------------------------------------------- mechanics

test("interpolated text is escaped", () => {
	const nasty = coinPage({
		...base,
		name: 'Raptoreum <script>alert("x")</script>',
		pitch: "A coin with <b>markup</b> & an ampersand in its description, at length.",
	});
	assert.ok(!/<script>alert/.test(nasty));
	assert.match(nasty, /&lt;script&gt;/);
	assert.match(nasty, /&lt;b&gt;markup&lt;\/b&gt; &amp; an ampersand/);
});

test("the project link does not pass authority to a site we do not control", () => {
	assert.match(coinPage(base), /rel="nofollow noopener"/);
});

test("the sitemap carries every page and the date it was given", () => {
	const xml = sitemap("2026-11-24");
	assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
	assert.ok(xml.includes(`<loc>${SITE}/coins</loc>`));
	for (const c of LISTED) {
		assert.ok(xml.includes(`<loc>${SITE}/trade/${c.slug}</loc>`), c.symbol);
	}
	assert.equal((xml.match(/<lastmod>2026-11-24<\/lastmod>/g) ?? []).length, LISTED.length + 2);
	// No date other than the one supplied — the clock must not leak in.
	assert.equal((xml.match(/<lastmod>/g) ?? []).length, LISTED.length + 2);
});

test("robots keeps the empty JavaScript shell out of the index", () => {
	// Indexing /app.html splits every coin's relevance between a real page and
	// a div.
	const r = robots();
	assert.match(r, /Disallow: \/v1\//);
	assert.match(r, /Disallow: \/signin\.html/);
	assert.match(r, /Disallow: \/admin\.html/);
	assert.match(r, new RegExp(`Sitemap: ${SITE}/sitemap\\.xml`));
});

test("generate writes extensionless urls, one directory per slug", () => {
	const files = generate("2026-11-24");
	assert.ok(files.has("coins/index.html"));
	assert.ok(files.has("sitemap.xml"));
	assert.ok(files.has("robots.txt"));
	for (const c of LISTED) {
		// A .html suffix is a hosting decision leaking into a link someone else
		// has already shared.
		assert.ok(files.has(`trade/${c.slug}/index.html`), c.symbol);
	}
	assert.equal(files.size, LISTED.length + 4);
	assert.ok(files.has("404.html"));
});

test("the 404 page exists, points at the coin list, and is NOT in the sitemap", () => {
	// A 404 page in a sitemap is a page you asked a crawler to index and then
	// told it does not exist.
	const html = notFoundPage();
	assert.match(html, /That page is not here/);
	assert.match(html, /href="\/coins"/);
	assert.ok(!sitemap("2026-11-24").includes("404"));
});

test("every generated page is a complete document", () => {
	for (const [path, body] of generate("2026-11-24")) {
		if (!path.endsWith(".html")) continue;
		assert.match(body, /^<!doctype html>/, path);
		assert.match(body, /<meta name="viewport"/, path);
		assert.match(body, /<\/html>\s*$/, path);
		// A description is what shows up under the link in a result.
		assert.match(body, /<meta name="description" content="[^"]{60,}"/, path);
		assert.ok(!/undefined|NaN|\[object Object\]/.test(body), `${path} has a template leak`);
	}
});

test("titles are distinct and within a sensible length", () => {
	const titles = new Set<string>();
	for (const c of LISTED) {
		const t = /<title>(.*?)<\/title>/.exec(coinPage(c))![1]!;
		// Duplicate titles across generated pages are the classic doorway-page
		// signal, and they are also useless to a reader.
		assert.ok(!titles.has(t), `duplicate title: ${t}`);
		titles.add(t);
		assert.ok(t.length <= 75, `${c.symbol} title is ${t.length} chars: ${t}`);
	}
});
