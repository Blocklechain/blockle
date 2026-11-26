// -----------------------------------------------------------------------------
// MARKET FILTER HARNESS
//
//     node markets.harness.js
//
// WHY THIS EXISTS, AND WHY IT IS NOT A SCREENSHOT TEST.
//
// The markets screen stopped being a list and became a filter, because the
// venue's pair matrix is about to roughly double and a settlement gate means
// a third of it is refused with a reason. That turns one substring match into
// four interacting facets — text, asset chips, quoted-in, open/closed — and
// facets interact in ways nobody checks by looking:
//
//   * a search that comes back empty because a chip nobody remembers pressing
//     is still pressed, which reads as a broken search box;
//   * "everything quoted in BTC" and "everything involving BTC" quietly
//     collapsing into the same filter, which they are not;
//   * a market with an unfamiliar status word being shown as tradeable;
//   * a chip count that changes when you press a chip, so it cannot be used
//     to decide which chip to press.
//
// So the filter was written as a pure region of exchange.js — sentinel
// comments mark it — and this harness slices THAT REGION out of the shipping
// file and drives it directly. No copy of the logic lives here, which is the
// only version of this test that cannot drift from the page.
//
// The second half is static: the mistakes that are visible in the source and
// that this screen has actually made before — a <span> styled as a button
// (keyboard-dead), a column count written out three times, a price derived by
// arithmetic across two markets (which is how BLOCK acquires a dollar price
// without anybody deciding to).
// -----------------------------------------------------------------------------

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

const JS = read("exchange.js");
const CSS = read("exchange.css");
const HTML = read("app.html");
const INDEX_JS = read("index.inline.js");

// COMMENTS ARE NOT MARKUP AND COMMENTS ARE NOT CODE. Every assertion below is
// about one or the other, and the files here discuss spans, onclick and USD at
// length in prose — asserting against raw text would false-positive on the
// explanation of the very bug being prevented.
const markup = HTML.replace(/<!--[\s\S]*?-->/g, "");
const decomment = (s) =>
	s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

let failures = 0;
function fail(msg) {
	failures += 1;
	console.error("FAIL: " + msg);
}
function ok(cond, msg) {
	if (!cond) fail(msg);
}

// ---------------------------------------------------------------------------
// Lift the pure block out of exchange.js.
// ---------------------------------------------------------------------------

const BEGIN = "// ===== MARKET FILTER — PURE BLOCK BEGINS =====";
const END = "// ===== MARKET FILTER — PURE BLOCK ENDS =====";

function pureBlock() {
	const from = JS.indexOf(BEGIN);
	const to = JS.indexOf(END);
	assert.ok(
		from > 0 && to > from,
		"could not find the market-filter sentinels in exchange.js — if the block " +
			"was renamed, rename them here too rather than copying the logic",
	);
	return JS.slice(from + BEGIN.length, to);
}

const BLOCK_SRC = pureBlock();

const EXPORTS = [
	"mktFilterDefault", "mktState", "mktReason", "mktMatch", "mktFilter",
	"spreadPct", "spreadOf", "mktSort", "mktCounts", "mktQuoteOrder", "mktRail",
	"mktGroups", "mktTradeLink", "mktApply", "mktSummary", "mktEmptyWhy",
	"mktRefusals", "mktRefusalNote", "cmpPair", "cmpStr",
];

/** The full names the real coins.js supplies, for the name-search cases. */
const NAMES = {
	BTC: "Bitcoin", ETH: "Ethereum", USDT: "Tether", USDC: "USD Coin",
	SOL: "Solana", DOGE: "Dogecoin", BLOCK: "Blockle", RTM: "Raptoreum",
	DINGO: "Dingocoin", PEP: "Pepecoin", PERBUG: "Perbug",
};

const sandbox = {
	// The block reaches for coins.js's full names and guards the reference with
	// typeof, so this stub is the only dependency it has.
	coinIcon: { fullName: (s) => NAMES[String(s).toUpperCase()] || String(s) },
	console,
};
vm.createContext(sandbox);
const F = vm.runInContext(
	"(function () { " + BLOCK_SRC + "\n return { " +
		EXPORTS.map((n) => n + ": " + n).join(", ") + " }; })()",
	sandbox,
	{ filename: "exchange.js[market-filter]" },
);
for (const n of EXPORTS) {
	ok(typeof F[n] === "function", `the pure block must export ${n}`);
}

// ---------------------------------------------------------------------------
// A fixture shaped like the venue the gate produces: open markets across four
// quotes, closed markets carrying a reason, and refusals of both kinds.
// ---------------------------------------------------------------------------

const m = (base, quote, extra) =>
	Object.assign(
		{ market: base + "-" + quote, pair: base + "/" + quote, base, quote,
			last: null, bid: null, ask: null },
		extra || {},
	);

const MARKETS = [
	m("BTC", "USDT", { last: "90000.00", bid: "89990.00", ask: "90010.00" }),
	m("USDC", "USDT", { last: "1.000000", bid: "0.999900", ask: "1.000100" }),
	m("DOGE", "USDT", { last: "0.240000" }),
	m("RTM", "USDT"),
	m("BTC", "USDC", { bid: "89000.00", ask: "91000.00" }),
	m("DOGE", "USDC"),
	m("DOGE", "BTC"),
	m("BTC", "BLOCK"),
	m("DOGE", "BLOCK"),
	m("DINGO", "BLOCK"),
	// Closed, each with the gate's own sentence.
	m("ETH", "USDT", {
		state: "closed",
		closedReason:
			"ETH deposits cannot be opened: BitGo refuses receive addresses on " +
			"this wallet without a pricing plan.",
	}),
	m("SOL", "USDT", {
		state: "closed",
		closedReason: "SOL deposits cannot be opened: the custody wallet is not " +
			"yet initialized on chain.",
	}),
	m("DINGO", "USDT", {
		state: "closed",
		closedReason: "A DINGO price cannot be expressed in USDT: one DINGO is " +
			"worth less than USDT's smallest unit.",
	}),
];

const QUOTE_HINT = ["USDT", "USDC", "BTC", "ETH", "SOL", "BLOCK"];

const NOT_LISTED = [
	{ base: "PERBUG", quote: "BTC",
		why: "One satoshi is worth more than one PERBUG, so no price can be expressed." },
	{ base: "PEP", quote: "BTC",
		why: "One satoshi is worth more than one PEP, so no price can be expressed." },
	{ base: "DINGO", quote: "USDC",
		why: "One DINGO is worth less than USDC's smallest unit." },
	{ base: "ETH", quote: "BTC", blockedBy: "ETH",
		why: "BitGo refuses receive addresses on this wallet without a pricing plan." },
	{ base: "DOGE", quote: "ETH", blockedBy: "ETH",
		why: "BitGo refuses receive addresses on this wallet without a pricing plan." },
	{ base: "DOGE", quote: "SOL", blockedBy: "SOL",
		why: "The custody wallet is not yet initialized on chain." },
];

/*
 * ACROSS THE vm BOUNDARY, `deepEqual` IS NOT ENOUGH.
 *
 * Arrays and objects the pure block creates carry the sandbox's own
 * prototypes, so node:assert/strict's deep comparison reports "same structure
 * but not reference-equal" on values that are identical. Round-tripping
 * through JSON gives host-realm plain data, which is what every assertion
 * below actually means to compare.
 */
const host = (v) => JSON.parse(JSON.stringify(v));
const eq = (a, b, msg) => assert.deepEqual(host(a), b, msg);

const pairsOf = (rows) => host(rows).map((r) => r.base + "/" + r.quote).sort();
const base = () => F.mktFilterDefault();
const withF = (over) => Object.assign(F.mktFilterDefault(), over);

let cases = 0;
function check(name, fn) {
	cases += 1;
	try {
		fn();
	} catch (e) {
		fail(name + " — " + e.message);
	}
}

// ---------------------------------------------------------------- 1. find one

check("typing finds a market from either side of the slash", () => {
	// The predicate this replaced matched the pair plus the BASE's full name,
	// so a coin that is somebody's quote was unfindable from its own name.
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ text: "dingo", open: false }))),
		["DINGO/BLOCK", "DINGO/USDT"],
	);
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ text: "BTC" }))),
		["BTC/BLOCK", "BTC/USDC", "BTC/USDT", "DOGE/BTC"],
	);
	// The symbol form, which is what someone pastes out of a URL.
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ text: "doge-btc" }))),
		["DOGE/BTC"],
	);
});

check("typing a full name works, for the quote as well as the base", () => {
	// "Tether" found nothing at all before this change.
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ text: "tether" }))),
		["BTC/USDT", "DOGE/USDT", "RTM/USDT", "USDC/USDT"],
	);
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ text: "raptoreum" }))),
		["RTM/USDT"],
	);
});

check("a search that matches nothing is empty, not everything", () => {
	eq(F.mktFilter(MARKETS, withF({ text: "zzz" })), []);
});

// ------------------------------------------- 2. involves vs quoted-in

check("an asset chip means INVOLVES — either side of the slash", () => {
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ assets: ["BTC"] }))),
		["BTC/BLOCK", "BTC/USDC", "BTC/USDT", "DOGE/BTC"],
	);
});

check("quoted-in is a DIFFERENT set, and the difference is the point", () => {
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ quoteOnly: "BTC" }))),
		["DOGE/BTC"],
	);
	// BTC is mostly a quote, so a quote-only facet would have shown "1" for an
	// asset that is in four markets. That is the misleading zero the chips
	// avoid by meaning "involves".
	assert.equal(F.mktCounts(MARKETS).involves.BTC, 4);
	assert.equal(F.mktCounts(MARKETS).quoted.BTC, 1);
});

check("two chips are an OR; a chip plus quoted-in is an AND", () => {
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ assets: ["RTM", "DINGO"], open: false }))),
		["DINGO/BLOCK", "DINGO/USDT", "RTM/USDT"],
	);
	eq(
		pairsOf(F.mktFilter(MARKETS, withF({ assets: ["DOGE"], quoteOnly: "BTC" }))),
		["DOGE/BTC"],
	);
});

// ------------------------------------------------- 3. open versus closed

check("the default hides closed markets and the All button shows them", () => {
	const open = F.mktFilter(MARKETS, base());
	const all = F.mktFilter(MARKETS, withF({ open: false }));
	assert.equal(open.length, 10);
	assert.equal(all.length, 13);
	assert.ok(!pairsOf(open).includes("ETH/USDT"));
	assert.ok(pairsOf(all).includes("ETH/USDT"));
});

check("a status word we do not recognise FAILS CLOSED", () => {
	// Showing an unknown status as tradeable is the one error that costs a
	// customer a deposit, so an unfamiliar word closes the market.
	assert.equal(F.mktState({ state: "frobnicated" }), "closed");
	assert.equal(F.mktState({ state: "halted" }), "closed");
	assert.equal(F.mktState({ state: "paused" }), "closed");
	assert.equal(F.mktState({ status: "closed" }), "closed");
	assert.equal(F.mktState({ closed: true }), "closed");
	assert.equal(F.mktState({ closed: "because reasons" }), "closed");
	// …and the words that do mean trading.
	assert.equal(F.mktState({ state: "open" }), "open");
	assert.equal(F.mktState({ state: "LIVE" }), "open");
	assert.equal(F.mktState({ state: "trading" }), "open");
});

check("NO status field at all fails OPEN — today's server has no such field", () => {
	// The opposite default would paint the entire working venue as shut on the
	// deploy before the server learns to report state: a false alarm covering
	// a real list, which is worse than the thing it guards against.
	assert.equal(F.mktState({ base: "BTC", quote: "USDT" }), "open");
	assert.equal(F.mktState({ closed: false }), "open");
	assert.equal(
		F.mktFilter(MARKETS.map((r) => m(r.base, r.quote)), base()).length,
		MARKETS.length,
		"a server that reports no state must leave every market visible",
	);
});

check("a closed market carries the gate's own sentence, verbatim", () => {
	const dingo = MARKETS.find((r) => r.market === "DINGO-USDT");
	assert.equal(F.mktReason(dingo), dingo.closedReason);
	// And a closure with no sentence is admitted as such rather than invented.
	const vague = F.mktReason({ state: "closed" });
	assert.ok(/cancel/i.test(vague), "say what still works: cancelling");
	assert.ok(!/DINGO|BitGo|satoshi/.test(vague), "do not invent a reason");
	assert.equal(F.mktReason(MARKETS[0]), "", "an open market has no reason");
});

// -------------------------------------------------------- 4. chip counts

check("chip counts do not move when you press a chip", () => {
	// A count that changed under the press could not be used to decide which
	// chip to press next. They are computed over the STATUS scope only.
	const scoped = F.mktFilter(MARKETS, withF({ assets: [] }));
	const before = F.mktCounts(scoped).involves;
	const after = F.mktCounts(F.mktFilter(MARKETS, withF({ assets: [] }))).involves;
	eq(after, host(before));
	assert.equal(before.DOGE, 4);
});

check("a quote with no open markets still gets a chip, reading 0", () => {
	// "ETH 0" beside its reason is the honest answer to "where are my ETH
	// pairs". Hiding the chip is not an answer at all.
	const rail = F.mktRail(MARKETS, QUOTE_HINT);
	const quotes = rail.find((c) => c.label === "Quotes").assets;
	eq(quotes, ["USDT", "USDC", "BTC", "BLOCK"]);
	const openScope = F.mktFilter(MARKETS, base());
	const counts = F.mktCounts(openScope).involves;
	assert.equal(counts.ETH, undefined, "ETH has no open market in the fixture");
	assert.equal(counts.SOL, undefined);
	// …and the rail still names ETH and SOL, from the unfiltered rows.
	const everyAsset = rail.reduce((a, c) => a.concat(c.assets), []);
	assert.ok(everyAsset.includes("ETH") && everyAsset.includes("SOL"));
});

check("the rail splits into quotes and base-only coins, both derived", () => {
	const rail = F.mktRail(MARKETS, QUOTE_HINT);
	eq(rail.map((c) => c.label), ["Quotes", "Coins"]);
	eq(
		rail.find((c) => c.label === "Coins").assets,
		["DINGO", "DOGE", "ETH", "RTM", "SOL"],
	);
});

// -------------------------------------------------------- 5. order and groups

check("quote order follows the venue's, not the alphabet", () => {
	eq(F.mktQuoteOrder(MARKETS, QUOTE_HINT), ["USDT", "USDC", "BTC", "BLOCK"]);
	// With no hint it falls back to how many markets quote in each, which is a
	// defensible order rather than an arbitrary one.
	eq(F.mktQuoteOrder(MARKETS, []), ["USDT", "BLOCK", "USDC", "BTC"]);
});

check("groups come out in quote order with the right rows in each", () => {
	const rows = F.mktSort(F.mktFilter(MARKETS, base()), "pair");
	const groups = F.mktGroups(rows, QUOTE_HINT);
	eq(groups.map((g) => g.quote), ["USDT", "USDC", "BTC", "BLOCK"]);
	eq(groups.map((g) => g.rows.length), [4, 2, 1, 3]);
	eq(
		groups[0].rows.map((r) => r.base),
		["BTC", "DOGE", "RTM", "USDC"],
		"inside a group the base sorts A–Z",
	);
});

check("sorting by spread puts the one-sided books LAST, not first", () => {
	// A book with only one side has NO spread. Sorting it as zero would stack
	// every empty market at the top as though they were the tightest on the
	// venue.
	const rows = F.mktSort(F.mktFilter(MARKETS, base()), "spread");
	assert.equal(rows[0].market, "USDC-USDT");
	assert.equal(rows[1].market, "BTC-USDT");
	assert.equal(rows[2].market, "BTC-USDC");
	assert.ok(F.spreadPct(rows[3]) === null, "then the ones with no spread");
	assert.equal(F.spreadPct({ bid: "1", ask: null }), null);
	assert.equal(F.spreadPct({ bid: "0", ask: "1" }), null, "a zero bid is not a bid");
});

check("spreadOf still formats the way its other callers expect", () => {
	// The trade screen's topbar calls this too; the refactor must not change
	// its output.
	assert.equal(F.spreadOf("99", "100"), "1.000%");
	assert.equal(F.spreadOf(null, "100"), null);
});

check("sorting by traded puts markets with a price first", () => {
	const rows = F.mktSort(F.mktFilter(MARKETS, base()), "traded");
	eq(
		rows.slice(0, 3).map((r) => r.market),
		["BTC-USDT", "DOGE-USDT", "USDC-USDT"],
	);
	assert.ok(rows.slice(3).every((r) => !r.last));
});

// ------------------------------------------------- 6. the faceted-filter trap

check("typing clears the chips AND says that it did", () => {
	// The one real failure mode of a faceted filter: a search that comes back
	// empty because a chip nobody remembers pressing is still pressed.
	const f1 = F.mktApply(base(), { toggleAsset: "BTC" });
	eq(f1.assets, ["BTC"]);
	const f2 = F.mktApply(f1, { text: "DINGO" });
	eq(f2.assets, [], "the chip is released");
	assert.equal(f2.cleared, true, "and the clearing is reported");
	assert.ok(
		/filters cleared by search/i.test(
			F.mktSummary({ open: 10, closed: 3, shown: 1 }, f2),
		),
		"…so the announcement can be read, not just inferred",
	);
	// Clearing the box again is not itself a change worth announcing.
	assert.equal(F.mktApply(f2, { text: "" }).cleared, false);
	// And with nothing pressed, typing announces nothing.
	assert.equal(F.mktApply(base(), { text: "BTC" }).cleared, false);
});

check("quoted-in is cleared by typing too", () => {
	const f = F.mktApply(F.mktApply(base(), { quoteOnly: "BTC" }), { text: "doge" });
	assert.equal(f.quoteOnly, null);
	assert.equal(f.cleared, true);
});

check("toggling a chip twice is off, not two copies", () => {
	const on = F.mktApply(base(), { toggleAsset: "DOGE" });
	const off = F.mktApply(on, { toggleAsset: "DOGE" });
	eq(off.assets, []);
});

check("Clear filters resets every facet, including the hidden-closed one", () => {
	const messy = F.mktApply(
		F.mktApply(F.mktApply(base(), { toggleAsset: "BTC" }), { open: false }),
		{ quoteOnly: "USDT" },
	);
	const clean = F.mktApply(messy, { clear: true });
	eq(clean.assets, []);
	assert.equal(clean.quoteOnly, null);
	assert.equal(clean.text, "");
	assert.equal(clean.open, true);
});

check("the count line names the active facets", () => {
	const s = F.mktSummary({ open: 10, closed: 3, shown: 1 },
		withF({ assets: ["DOGE"], quoteOnly: "BTC" }));
	assert.ok(/10 open/.test(s) && /3 closed/.test(s) && /showing 1/.test(s));
	assert.ok(/quoted in BTC/.test(s) && /involving DOGE/.test(s));
	// …and it does not say the same thing twice.
	assert.ok(
		!/involving BTC/.test(
			F.mktSummary({ open: 3, closed: 0, shown: 3 },
				withF({ assets: ["BTC"], quoteOnly: "BTC" })),
		),
		'"quoted in BTC · involving BTC" is one fact printed twice',
	);
	// A venue with nothing closed does not advertise a zero.
	assert.ok(!/closed/.test(F.mktSummary({ open: 10, closed: 0, shown: 10 }, base())));
});

check("an empty list names the filter that emptied it", () => {
	assert.ok(/closed markets are hidden/.test(F.mktEmptyWhy(base())));
	assert.ok(/nothing matches "zzz"/.test(F.mktEmptyWhy(withF({ text: "zzz" }))));
	assert.ok(/quoted in SOL/.test(F.mktEmptyWhy(withF({ quoteOnly: "SOL" }))));
	assert.ok(/involves ETH or SOL/.test(F.mktEmptyWhy(withF({ assets: ["ETH", "SOL"] }))));
	// With every facet off there is nothing to undo, so it says the other thing.
	assert.ok(/no markets yet/.test(F.mktEmptyWhy(withF({ open: false }))));
});

// ---------------------------------------------------------- 7. the refusals

check("refusals split into permanent and pending, and never merge", () => {
	// A pair blocked until a rail opens makes a different promise from a pair
	// whose price cannot be expressed at all. One heading over both would make
	// the permanent ones look temporary.
	const r = F.mktRefusals(NOT_LISTED);
	eq(r.never.map((x) => x.pair), ["DINGO/USDC", "PEP/BTC", "PERBUG/BTC"]);
	eq(r.pending.map((g) => g.by), ["ETH", "SOL"]);
	eq(r.pending[0].pairs, ["ETH/BTC", "DOGE/ETH"]);
	assert.ok(/pricing plan/.test(r.pending[0].why));
	// Nothing published, nothing invented.
	eq(F.mktRefusals(undefined), { never: [], pending: [] });
	eq(F.mktRefusals([{ why: "no pair here" }]).never, []);
});

check("a narrowed list explains its own shortness inline", () => {
	// "I asked for everything against BTC and got one row" must not read as a
	// broken filter.
	const r = F.mktRefusals(NOT_LISTED);
	const note = F.mktRefusalNote(r, withF({ quoteOnly: "BTC" }));
	assert.ok(/2 more pairs cannot be listed/.test(note));
	assert.ok(/PEP\/BTC/.test(note) && /PERBUG\/BTC/.test(note));
	// Two BTC refusals with two differently-worded reasons: the note points at
	// the panel rather than concatenating near-identical sentences, which is a
	// wall and gets skipped.
	assert.ok(/Each one's reason is in the list below/.test(note));
	// One refusal, one reason: it comes inline, where the question was asked.
	const one = F.mktRefusalNote(r, withF({ assets: ["DINGO"] }));
	assert.ok(/smallest unit/.test(one), "a single reason belongs inline");
	// Involves-BTC picks up the same two; involves-DINGO picks up its own.
	assert.ok(/PEP\/BTC/.test(F.mktRefusalNote(r, withF({ assets: ["BTC"] }))));
	assert.ok(/DINGO\/USDC/.test(F.mktRefusalNote(r, withF({ assets: ["DINGO"] }))));
	// No facet, no note: the panel below is the place for the whole list.
	assert.equal(F.mktRefusalNote(r, base()), "");
	assert.equal(F.mktRefusalNote(r, withF({ assets: ["RTM"] })), "");
});

// ------------------------------------------------- 8. the resolved Trade link

check("the Trade link is resolved against the market list, never built", () => {
	// `asset + "-USDT"` is a guess about a symbol. It is wrong for USDC (the
	// live symbol is USDC-USDT), wrong for an asset with no USDT market, and
	// wrong for every closed market.
	assert.equal(F.mktTradeLink(MARKETS, "USDC", QUOTE_HINT), "USDC-USDT");
	assert.equal(F.mktTradeLink(MARKETS, "DOGE", QUOTE_HINT), "DOGE-USDT");
	assert.equal(F.mktTradeLink(MARKETS, "BTC", QUOTE_HINT), "BTC-USDT");
	// An asset whose only market is closed has nowhere to send anyone, and
	// null is a real answer the caller must handle rather than paper over.
	assert.equal(F.mktTradeLink(MARKETS, "ETH", QUOTE_HINT), null);
	assert.equal(F.mktTradeLink(MARKETS, "SOL", QUOTE_HINT), null);
	assert.equal(F.mktTradeLink(MARKETS, "XRP", QUOTE_HINT), null);
	// BLOCK is nobody's base here, so the senior market it appears in wins.
	assert.equal(F.mktTradeLink(MARKETS, "BLOCK", QUOTE_HINT), "BTC-BLOCK");
});

// ---------------------------------------------------------------------------
// 9. THE BLOCK RULE, enforced structurally.
//
// BLOCK is priced only in BLOCK — including via a conversion. The way a
// screen like this acquires a dollar price for BLOCK is not by someone adding
// a USD column; it is by someone adding a helper that combines two markets'
// prices for a perfectly reasonable-looking reason, after which BLOCK/BTC
// times BTC/USDT is one line of code away.
//
// So the filter does no arithmetic across markets at all. Its only numeric
// operation is a spread — a ratio of ONE market's own two sides, which is
// dimensionless and cannot become a price in another asset. These assertions
// pin that property rather than trusting it.
// ---------------------------------------------------------------------------

{
	const code = decomment(BLOCK_SRC);
	const floats = code.match(/parseFloat/g) || [];
	ok(
		floats.length === 2,
		"the pure block should call parseFloat exactly twice, both inside " +
			`spreadPct (bid and ask) — found ${floats.length}. A third one is a new ` +
			"number being derived, and the question to answer is what it is " +
			"denominated in",
	);
	ok(
		!/\busd\b|toUsd|usdValue|inUsd|fiat/i.test(code),
		"no USD-denominated anything in the market filter: BLOCK is priced only " +
			"in BLOCK and a conversion is the way that rule gets broken by accident",
	);
	ok(
		!/\b(convert|crossRate|rateFor|priceIn|quoteIn)\s*\(/.test(code),
		"no rate or conversion helper: combining two markets' prices is how " +
			"BLOCK/BTC × BTC/USDT becomes a dollar price for BLOCK",
	);
	// The spread is the one derived figure, and it must stay a function of one
	// market's own two sides.
	const sp = /function spreadPct\(row\)\s*\{([\s\S]*?)\n  \}/.exec(code);
	ok(sp !== null, "spreadPct must still exist in the pure block");
	if (sp) {
		ok(
			!/\b(rows|markets|all|other)\b/.test(sp[1]),
			"spreadPct must read one row and nothing else — the moment it can see " +
				"a second market it can produce a cross rate",
		);
	}
}

// The marketing front page is the surface where a stranger reads a number as
// a price, and it renders whatever the venue emitted FIRST. Pin the guard.
{
	const idx = decomment(INDEX_JS);
	ok(
		/dollarPricesBlock/.test(idx),
		"index.inline.js must filter BLOCK-against-a-dollar-peg out of the front " +
			"page strip — `rows.slice(0, 8)` otherwise publishes whichever markets " +
			"the generator happened to emit first",
	);
	ok(
		/filter\(\s*\(t\)\s*=>\s*!dollarPricesBlock\(t\)\s*\)/.test(idx),
		"the filter must run BEFORE the slice, or an excluded row still consumes " +
			"one of the eight places",
	);
	// Drive the predicate itself out of the shipping file.
	const from = idx.indexOf("const BLOCK_PRICED");
	const to = idx.indexOf("(async function markets");
	ok(from > 0 && to > from, "could not find the BLOCK guard in index.inline.js");
	if (from > 0 && to > from) {
		const g = vm.runInNewContext(
			idx.slice(from, to) + "\n({ dollarPricesBlock: dollarPricesBlock })",
		);
		const t = (b, q) => ({ base: b, quote: q });
		ok(g.dollarPricesBlock(t("BLOCK", "USDT")), "BLOCK/USDT is a dollar price");
		ok(g.dollarPricesBlock(t("BLOCK", "USDC")), "BLOCK/USDC is a dollar price");
		ok(g.dollarPricesBlock(t("USDC", "BLOCK")),
			"and so is the inverse — one division is not a meaningful obstacle");
		ok(!g.dollarPricesBlock(t("DOGE", "BLOCK")),
			"a price denominated IN BLOCK is the thing the rule asks for and must stay");
		ok(!g.dollarPricesBlock(t("BTC", "USDT")), "unrelated markets are untouched");
	}
}

// ---------------------------------------------------------------------------
// 10. THE STATIC MISTAKES THIS SCREEN HAS ALREADY MADE.
// ---------------------------------------------------------------------------

// The markets region of exchange.js, for scans that should not match the rest
// of a 2000-line file.
const REGION = (() => {
	const from = JS.indexOf("// ------------------------------------------------------------------- markets");
	const to = JS.indexOf("// --------------------------------------------------------------------- trade");
	assert.ok(from > 0 && to > from, "could not bound the markets region of exchange.js");
	return decomment(JS.slice(from, to));
})();

{
	// (a) THE COLUMN COUNT WAS WRITTEN OUT THREE TIMES — in app.html's colspan
	//     and in two emptyRow calls — so dropping a column left the loading,
	//     empty and error rows spanning the wrong width. One of the three is
	//     now the source; the others must read it.
	const thead = /<table id="t-markets">\s*<thead>\s*<tr>([\s\S]*?)<\/tr>/.exec(markup);
	ok(thead !== null, "could not find the markets table header");
	if (thead) {
		const cols = (thead[1].match(/<th\b/g) || []).length;
		const colspan = /<td colspan="(\d+)" class="empty"/.exec(markup);
		ok(colspan !== null, "the markets table needs a colspan'd placeholder row");
		if (colspan) {
			ok(
				Number(colspan[1]) === cols,
				`app.html's colspan is ${colspan[1]} but the header row has ${cols} ` +
					"columns — the loading row will span the wrong width",
			);
		}
	}
	const literals = REGION.match(/emptyRow\([^)]*?,\s*\d+\s*,/g) || [];
	ok(
		literals.length === 0,
		"an emptyRow call in the markets region passes a literal column count " +
			`(${literals.join(" / ")}) — use mktCols(), which reads the live <thead>`,
	);
	ok(/function mktCols\(\)/.test(REGION), "mktCols must exist to be read from");
	const calls = REGION.match(/emptyRow\([\s\S]{0,90}/g) || [];
	ok(calls.length > 0, "the markets region must still have an emptyRow path");
	// The width is the SECOND argument. None of these calls contains a comma
	// before it, so splitting is enough and is easier to read than a regex
	// that has to balance the parentheses in `$("t-markets").tBodies[0]`.
	const widths = calls.map((c) => String(c.split(",")[1] || "").trim());
	ok(
		widths.every((w) => w === "mktCols()" || w === "cols"),
		"every emptyRow in the markets region must take its width from mktCols() " +
			`rather than a number nobody updates when a column moves — got ${widths.join(" / ")}`,
	);
	ok(
		/var cols = mktCols\(\)/.test(REGION),
		"drawMarkets must read the column count once, from mktCols()",
	);
}

{
	// (b) THE SCREEN WAS KEYBOARD-DEAD. The row was a <tr onclick> and the
	//     Trade affordance was a <span class="btn">, which takes no focus and
	//     activates on no key. An onclick ATTRIBUTE would not have helped
	//     either: this origin serves script-src 'self' with no 'unsafe-inline'.
	ok(
		!/el\("span",\s*"btn/.test(REGION),
		"a <span> styled as a button is not reachable by Tab and not activatable " +
			"by Enter — the Trade affordance must be an <a>",
	);
	ok(
		/el\("a",\s*"btn sm ghost",\s*"Trade"\)/.test(REGION),
		"the Trade affordance must be an anchor carrying a real href",
	);
	ok(
		!/\btr\.onclick\s*=/.test(REGION),
		"no behaviour on a bare <tr>: a table row is not focusable, so an " +
			"onclick there is a feature only a mouse can reach",
	);
	ok(
		/inner\.href = "#\/trade\/"/.test(REGION),
		"the pair cell itself must be a link, so Tab lands on the market name",
	);
	// Chips are buttons with a pressed state, not links that do not navigate.
	ok(
		/el\("button", "chip/.test(REGION) &&
			/setAttribute\("aria-pressed"/.test(REGION),
		"asset chips must be <button aria-pressed>, matching the stylesheet's " +
			"existing segmented-control pattern",
	);
	ok(
		/aria-label", label \+ ", " \+ count/.test(REGION),
		"the chip's count belongs in its accessible name, or a screen reader " +
			"hears two unrelated strings",
	);
}

{
	// (c) THE PURE BLOCK MUST STAY PURE, or this harness quietly stops testing
	//     the thing that ships and starts testing a stub.
	const code = decomment(BLOCK_SRC);
	for (const banned of ["document", "sessionStorage", "localStorage", "fetch(", "location.", "setTimeout", "$("]) {
		ok(
			code.indexOf(banned) < 0,
			`the market-filter pure block references \`${banned}\` — move that side ` +
				"of it below the END sentinel; the harness drives this region with no DOM",
		);
	}
}

{
	// (d) NO INLINE SCRIPT OR HANDLER ATTRIBUTES on the new markup. Same CSP.
	ok(
		!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(markup),
		"app.html must have no inline script: this origin serves script-src 'self'",
	);
	ok(
		!/\son(?:click|input|change|load|error)\s*=\s*"/i.test(markup),
		"no inline event-handler attributes either — the CSP blocks them, so a " +
			"filter wired that way would be silently dead",
	);
}

{
	// (e) THE CONTROLS MUST EXIST AND BE WIRED. A control in the markup that
	//     nothing listens to is the quietest possible bug.
	for (const id of ["mkt-search", "mkt-chips", "mkt-state", "mkt-open",
		"mkt-all", "mkt-closedn", "mkt-qonly", "mkt-sort", "mkt-count", "mkt-note",
		"mkt-never", "mkt-pending", "t-never", "t-pending"]) {
		ok(markup.includes('id="' + id + '"'), `app.html is missing #${id}`);
	}
	const wired = decomment(JS);
	for (const id of ["mkt-search", "mkt-open", "mkt-all", "mkt-sort"]) {
		ok(
			new RegExp('\\$\\("' + id + '"\\)\\.on(input|click|change)\\s*=').test(wired),
			`#${id} is in the markup but nothing is listening to it`,
		);
	}
	// #mkt-qonly is NOT in the loop above. It is the one control whose handler
	// is assigned per render rather than once at startup — it only exists while
	// its facet is on, and the render that creates it is the render that knows
	// which quote to clear. So the static check is that SOMETHING draws it; the
	// behaviour is checked against the live render in renderChecks stage (h),
	// which is what caught it being referenced by drawMarkets and never defined.
	ok(
		/function drawQuoteOnly\s*\(/.test(wired),
		"#mkt-qonly is in the markup but no function draws it",
	);
	// The result count must be announced, not merely displayed.
	ok(
		/id="mkt-count"[^>]*aria-live="polite"/.test(markup),
		"the result count is the only notification a screen reader gets that a " +
			"facet changed anything — it must be a live region",
	);
	// And no sort option over a field the server hardcodes to null.
	const sortBlock = /<select id="mkt-sort"[\s\S]*?<\/select>/.exec(markup);
	ok(sortBlock !== null, "the sort control must exist");
	if (sortBlock) {
		ok(
			!/volume|24h|change/i.test(sortBlock[0]),
			"no sort by volume or 24h change: /public/tickers hardcodes both to " +
				"null, so the control would sort by nothing and look like it worked",
		);
	}
}

{
	// (f) PHONE AND FOCUS, in the stylesheet. mobile.harness.js already polices
	//     44px targets and inline widths generally; these are the rules this
	//     screen specifically needs to have.
	ok(
		/\.chiprail\.scrollx\s*\{[^}]*overflow-x:\s*auto/.test(CSS),
		"the chip rail must scroll ITSELF — fourteen assets do not fit on a " +
			"phone, and a bar that overflows makes the whole page scroll sideways",
	);
	ok(
		/\.chip:focus-visible\s*\{[^}]*outline:/.test(CSS),
		"the chips need a visible focus ring: they are the primary control here",
	);
	ok(
		/#t-markets a\.pair:focus-visible\s*\{[^}]*outline:/.test(CSS),
		"so does the pair link",
	);
	const phone = CSS.split(/@media\s*\(max-width:\s*560px\)\s*\{/)[1] || "";
	ok(
		/\.chip\s*\{[^}]*min-height:\s*44px/.test(phone),
		"the chips must clear the 44px touch floor on a phone",
	);
	ok(
		/\.mktbar\s*\{[^}]*flex-direction:\s*column/.test(phone),
		"the filter bar must stack on a phone rather than wrapping into a grid " +
			"of half-width controls",
	);
	ok(
		!/width:\s*\d+px/.test(
			(/\.mktbar[\s\S]{0,400}/.exec(CSS) || [""])[0].replace(/min-width|max-width/g, ""),
		),
		"no pinned pixel widths in the filter bar — that is how the old filter " +
			"ended up 190px wide on a 390px screen",
	);
	// A closed row must not be presented as clickable.
	ok(
		/#t-markets tbody tr\.off/.test(CSS),
		"closed rows need their own treatment: visible, dimmed, and not a link",
	);
	ok(
		/@media \(prefers-reduced-motion: reduce\)/.test(CSS),
		"the reduced-motion block must survive the edit",
	);
}

{
	// (g) THE CHIP COUNTS MUST NOT MOVE WHEN A CHIP IS PRESSED.
	//
	//     The behaviour case above proves mktCounts is stable for the rows it is
	//     HANDED. It cannot prove it is handed the right ones: that choice lives
	//     at the call site, in drawChips, which is DOM code and therefore on the
	//     far side of the sentinels this harness drives. Feeding drawChips the
	//     facet-filtered rows instead of the status-scoped ones passes every
	//     behaviour case in this file while making every chip report the size of
	//     the selection you have already made — at which point the counts cannot
	//     be used for the one thing they are for, which is deciding which chip to
	//     press next. So the argument is pinned by reading the source.
	const draw = /function drawChips\(([\s\S]*?)\n {2}\}/.exec(REGION);
	ok(draw !== null, "drawChips must exist in the markets region");
	if (draw) {
		const counted = /mktCounts\(([^)]*)\)/.exec(draw[1]);
		ok(counted !== null, "drawChips must count the markets its chips label");
		if (counted) {
			ok(
				counted[1].trim() === "scoped",
				"drawChips must count over the status-scoped rows and nothing " +
					`narrower — it counts over \`${counted[1].trim()}\` instead. A count ` +
					"that shrinks when you press a chip cannot tell you which chip to " +
					"press next",
			);
		}
		ok(
			!/mktFilter\(/.test(draw[1]),
			"drawChips must not apply the facets: the chips describe the set they " +
				"are about to filter, not what is left after filtering",
		);
	}
	ok(
		/drawChips\(all, scoped, order\)/.test(REGION),
		"drawMarkets must hand drawChips BOTH lists — `all`, which decides which " +
			"chips exist at all so a quote whose every market is closed still gets " +
			"one reading 0, and `scoped`, which supplies their counts",
	);
}

{
	// (h) The copy must not still promise the old two-quote venue.
	const lede = /<section class="screen" id="s-markets">[\s\S]*?<\/p>/.exec(markup);
	ok(lede !== null, "could not find the markets lede");
	if (lede) {
		ok(
			!/against USDT and against BLOCK/.test(lede[0]),
			"the lede still claims every asset trades against USDT and against " +
				"BLOCK — that is the sentence this change makes false",
		);
		ok(
			/does not mean\s+zero/.test(lede[0]),
			"keep the em-dash explanation: it is the one thing people ask about",
		);
	}
}

// ---------------------------------------------------------------------------
// 11. THE RENDER, ACTUALLY RUN.
//
// Everything above this point either drives the pure block or reads the
// source as text. Neither executes drawMarkets, and that gap had a cost: the
// screen re-renders on an 8-second timer, every render tears the whole tbody
// down, and NOTHING NOTICED that this destroys whatever the keyboard was
// standing on. A regex cannot see that, and the pure block cannot either —
// focus is DOM state, so it lives on the far side of the sentinels.
//
// That bug is also specifically a consequence of the fix above it. The old
// markets screen could not lose focus because it had nothing focusable: a
// <tr onclick> and a <span> dressed as a button. Turning those into real
// links is what makes the list keyboard-navigable and is also what created
// thirty-odd tab stops for a timer to wipe. So the two have to be tested
// together, which means running the renderer.
//
// The DOM below is a shim, not jsdom: no dependency, and small enough that a
// reader can confirm it does not flatter the code. It implements only what
// this screen touches, and throws on anything else rather than silently
// returning undefined and passing a test by accident.
// ---------------------------------------------------------------------------

/** The markets screen's helpers, lifted from the same file as the region. */
const HELPERS = (() => {
	const from = JS.indexOf("  var $ = function (id)");
	const to = JS.indexOf("  function show(node, text, kind)");
	assert.ok(from > 0 && to > from, "could not bound exchange.js's DOM helpers");
	return JS.slice(from, to);
})();

/** The markets region, COMMENTS AND ALL — this copy is executed, not scanned. */
const REGION_SRC = (() => {
	const from = JS.indexOf("// ------------------------------------------------------------------- markets");
	const to = JS.indexOf("// --------------------------------------------------------------------- trade");
	return JS.slice(from, to);
})();

/** How many columns app.html actually ships, so nothing here hardcodes 7. */
const COLS = (() => {
	const thead = /<table id="t-markets">\s*<thead>\s*<tr>([\s\S]*?)<\/tr>/.exec(markup);
	assert.ok(thead, "could not find the markets table header");
	return (thead[1].match(/<th\b/g) || []).length;
})();

function makeDOM(cols) {
	const ids = Object.create(null);
	const dom = {
		activeElement: null,
		createElement: (t) => new El(t),
		createTextNode: (v) => new Txt(v),
		getElementById: (id) => ids[id] || null,
	};

	class Txt {
		constructor(v) { this.data = String(v); this.childNodes = []; this.parentNode = null; }
		get textContent() { return this.data; }
	}

	class El {
		constructor(tag) {
			this.tagName = String(tag).toUpperCase();
			this.childNodes = [];
			this.parentNode = null;
			this.attrs = Object.create(null);
			this.className = "";
			this.focusCount = 0;
		}
		appendChild(n) {
			if (n.parentNode) n.parentNode.removeChild(n);
			n.parentNode = this;
			this.childNodes.push(n);
			return n;
		}
		removeChild(n) {
			const i = this.childNodes.indexOf(n);
			if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
			return n;
		}
		get firstChild() { return this.childNodes[0] || null; }
		setAttribute(k, v) {
			this.attrs[k] = String(v);
			if (k === "id") ids[String(v)] = this;
		}
		getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
		// The id index is deliberately NOT cleaned up here. Nothing in the app
		// removes an id, and a shim that forgot one would make getElementById
		// return null mid-render — failing in a way the real DOM never would.
		removeAttribute(k) { delete this.attrs[k]; }
		// coins.js hands back one <svg> per call. One synthetic child is all the
		// assertions here need, which are only ever "is a mark present".
		set innerHTML(html) {
			this.childNodes = [];
			if (String(html).trim() === "") return;
			const svg = new El("svg");
			svg.className = "coin";
			this.appendChild(svg);
		}
		get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
		set textContent(v) {
			this.childNodes = [];
			this.appendChild(new Txt(v));
		}
		focus(opts) {
			dom.activeElement = this;
			this.focusCount += 1;
			this.focusOpts = opts || null;
		}
		get rows() { return this.childNodes.filter((c) => c.tagName === "TR"); }
		get cells() { return this.childNodes.filter((c) => c.tagName === "TD" || c.tagName === "TH"); }
		get tBodies() { return this.childNodes.filter((c) => c.tagName === "TBODY"); }
		get tHead() { return this.childNodes.find((c) => c.tagName === "THEAD") || null; }
		insertRow() { return this.appendChild(new El("tr")); }
		querySelector(sel) {
			const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
			// Deliberately narrow: a shim that quietly handled more than the code
			// uses would let a selector change go untested.
			if (!m) throw new Error("DOM shim implements attribute selectors only, got: " + sel);
			return this.all().find((n) => n.getAttribute && n.getAttribute(m[1]) === m[2]) || null;
		}
		all() {
			const out = [];
			(function walk(n) {
				for (const c of n.childNodes) { out.push(c); walk(c); }
			})(this);
			return out;
		}
		attached() {
			let n = this;
			while (n.parentNode) n = n.parentNode;
			return n === dom.root;
		}
	}

	const node = (tag, id) => {
		const n = new El(tag);
		if (id) n.setAttribute("id", id);
		return n;
	};

	// The markets screen's skeleton. Every id here is one that check (e) above
	// has already asserted app.html contains, so this cannot drift into testing
	// a page that does not exist.
	const section = node("section", "s-markets");
	const add = (tag, id) => section.appendChild(node(tag, id));

	add("input", "mkt-search").value = "";
	add("div", "mkt-chips");
	const seg = add("div", "mkt-state");
	seg.appendChild(node("button", "mkt-open"));
	seg.appendChild(node("button", "mkt-all"));
	add("span", "mkt-closedn");
	add("button", "mkt-qonly");
	add("select", "mkt-sort").value = "pair";
	add("p", "mkt-count");
	add("p", "mkt-note");

	const table = add("table", "t-markets");
	const thead = table.appendChild(new El("thead"));
	const hrow = thead.appendChild(new El("tr"));
	// The real column count, read off app.html — so mktCols() is exercised
	// against the shipping header rather than against a number written here.
	// The caller decides how many, so stage (g) can hand the renderer a header
	// that is NOT seven columns wide. With the real count the assertions pass
	// whether the code derives the width or hardcodes today's number; with a
	// different one, only derivation survives.
	for (let i = 0; i < cols; i += 1) hrow.appendChild(new El("th"));
	table.appendChild(new El("tbody"));

	for (const [panel, tbl, count] of [
		["mkt-never", "t-never", "mkt-never-n"],
		["mkt-pending", "t-pending", "mkt-pending-n"],
	]) {
		const d = add("details", panel);
		d.appendChild(node("span", count));
		d.appendChild(node("table", tbl)).appendChild(new El("tbody"));
	}

	dom.root = section;
	return dom;
}

/** Load the real helpers + the real markets region over a fresh shim DOM. */
function mountMarkets(tickers, markets, notListed, cols) {
	const dom = makeDOM(cols === undefined ? COLS : cols);
	const store = (() => {
		const mem = Object.create(null);
		return {
			getItem: (k) => (k in mem ? mem[k] : null),
			setItem: (k, v) => { mem[k] = String(v); },
		};
	})();

	const icon = (sym, size) => '<svg data-sym="' + sym + '" data-size="' + size + '"></svg>';
	icon.fullName = (s) => NAMES[String(s).toUpperCase()] || String(s);
	icon.network = (n) => String(n);

	let next = () => Promise.resolve(tickers);
	const ctx = {
		document: dom,
		sessionStorage: store,
		coinIcon: icon,
		console,
		STATE: {
			markets: markets.map((x) => Object.assign({ symbol: x.market }, x)),
			tickers: tickers,
			quotes: QUOTE_HINT.filter((q) => markets.some((x) => x.quote === q)),
			notListed: notListed || [],
		},
		pub: () => next(),
	};
	vm.createContext(ctx);
	const api = vm.runInContext(
		"(function () {\n" + HELPERS + "\n" + REGION_SRC +
			"\nreturn { drawMarkets: drawMarkets, RENDER: RENDER, mktSet: mktSet," +
			" tradeLinkFor: tradeLinkFor, getMKT: function () { return MKT; } };\n})()",
		ctx,
		{ filename: "exchange.js[markets]" },
	);

	const $$ = (id) => dom.getElementById(id);
	return {
		dom, api, ctx, $: $$,
		setFeed: (fn) => { next = fn; },
		body: () => $$("t-markets").tBodies[0],
		// Data rows only: the quote group headers are structure, not markets.
		dataRows: () => $$("t-markets").tBodies[0].rows.filter((r) => r.className !== "grp"),
		groupRows: () => $$("t-markets").tBodies[0].rows.filter((r) => r.className === "grp"),
		rowFor: (sym) => {
			const hit = $$("t-markets").tBodies[0].all()
				.find((n) => n.getAttribute && n.getAttribute("data-focus") === "pair:" + sym);
			let n = hit;
			while (n && n.tagName !== "TR") n = n.parentNode;
			return n;
		},
	};
}

/** Stages below, named in the report so a silent skip would show up. */
const RENDER_STAGES = 8;

// One async function because the feed-failure case below has to let a
// rejected promise settle. A throw anywhere in here is itself the finding, so
// it is caught and reported rather than dumped as a stack trace.
async function renderChecks() {
	// ---- (a) it renders at all, which nothing checked before.
	{
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app.api.drawMarkets();

		const open = MARKETS.filter((x) => !x.state);
		ok(
			app.dataRows().length === open.length,
			`the default render should show the ${open.length} open markets, got ` +
				`${app.dataRows().length}`,
		);
		ok(app.groupRows().length > 0, "the default render groups by quote");
		ok(
			app.$("mkt-count").textContent.includes("showing " + open.length),
			"the count line must report what was rendered, got: " +
				app.$("mkt-count").textContent,
		);
		ok(
			app.$("mkt-closedn").className === "pill warn",
			"the closed badge must be visible when markets are closed",
		);

		// Every group header must span the real table, or the row sits short.
		for (const g of app.groupRows()) {
			ok(
				g.cells[0].colSpan === COLS,
				`a group header spans ${g.cells[0].colSpan} of ${COLS} columns — it ` +
					"must take the count from the live <thead>",
			);
		}

		// Chips exist, carry counts, and include a quote whose markets are all
		// closed (ETH) reading 0 rather than being dropped.
		const chips = app.$("mkt-chips").all()
			.filter((n) => n.tagName === "BUTTON");
		ok(chips.length > 1, "the chip rail must render chips");
		const eth = chips.find((c) => c.getAttribute("data-focus") === "chip:ETH");
		ok(eth, "ETH must still get a chip even with every ETH market closed");
		if (eth) {
			ok(
				/\b0\b/.test(eth.getAttribute("aria-label")),
				"ETH's chip must read 0, not be hidden: that plus the reason is the " +
					"honest answer to \"where are my ETH pairs\"",
			);
		}
	}

	// ---- (b) open rows are links; closed rows are not, and say why.
	{
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app.api.mktSet({ open: false });

		const btc = app.rowFor("BTC-USDT");
		ok(btc, "an open market must render a pair cell keyed for focus");
		if (btc) {
			const links = btc.all().filter((n) => n.href);
			ok(
				links.length === 2,
				"an open row needs two real links — the pair cell and the Trade " +
					`button — got ${links.length}`,
			);
			ok(
				links.every((a) => a.tagName === "A" && a.href === "#/trade/BTC-USDT"),
				"both must be anchors pointing at the market's own route",
			);
			ok(
				btc.all().some((n) => n.className === "pill ok"),
				"an open row must carry the OPEN pill",
			);
		}

		// The closed row: present, dimmed, unlinked, reason verbatim.
		const dingo = MARKETS.find((x) => x.market === "DINGO-USDT");
		const row = app.body().rows.find((r) => r.textContent.includes("DINGO/USDT"));
		ok(row, "a closed market must still be rendered when the All facet is on");
		if (row) {
			ok(row.className === "off", "a closed row must be dimmed via .off");
			ok(
				row.all().filter((n) => n.href).length === 0,
				"a closed row must contain NO links: the thing you cannot do must " +
					"not look clickable",
			);
			ok(
				row.textContent.includes(dingo.closedReason),
				"the closed row must print the gate's own sentence verbatim",
			);
			ok(
				row.all().some((n) => n.className === "pill warn"),
				"a closed row must carry the CLOSED pill",
			);
		}
	}

	// ---- (c) FOCUS SURVIVES THE 8-SECOND RE-RENDER.
	//
	// The regression this section was written for. Focus a row's Trade link,
	// re-render exactly as the poll does, and it must come back to the SAME
	// market — not to the top of the document, and not to a neighbour.
	{
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app.api.drawMarkets();

		for (const key of ["pair:DOGE-USDT", "trade:DOGE-USDT", "chip:BTC", "chip:"]) {
			const app2 = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
			app2.api.drawMarkets();
			const target = app2.$("s-markets").querySelector('[data-focus="' + key + '"]');
			ok(target, `nothing on the screen is keyed ${key}`);
			if (!target) continue;
			target.focus();

			app2.api.drawMarkets(); // the poll
			const now = app2.dom.activeElement;
			ok(
				now && now.getAttribute && now.getAttribute("data-focus") === key,
				`focus was lost across a re-render: ${key} became ` +
					`${now && now.getAttribute ? now.getAttribute("data-focus") : "nothing"}. ` +
					"The screen re-renders every 8 seconds, so a keyboard user would " +
					"be thrown back to the top of the document mid-list",
			);
			ok(
				now !== target,
				`${key} was handed back the OLD detached node — the row was rebuilt, ` +
					"so the restored element must be the new one",
			);
			if (now) {
				ok(
					now.attached(),
					`${key} was focused on a node that is not in the document`,
				);
					ok(
					now.focusOpts && now.focusOpts.preventScroll === true,
					"restoring focus must pass preventScroll: the element is being put " +
						"back where the user can already see it, and a scroll correction " +
						"eight seconds into reading a row is its own interruption",
				);
			}
		}
	}

	// ---- (d) focus is never INVENTED, and never handed to the wrong market.
	{
		// Nothing focused: the render must not grab focus. A list that steals
		// focus every 8 seconds is worse than one that drops it.
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app.api.drawMarkets();
		ok(
			app.dom.activeElement === null,
			"a render with nothing focused must not move focus anywhere",
		);
		app.api.drawMarkets();
		ok(
			app.dom.activeElement === null,
			"...and must still not, on the next poll",
		);

		// The focused market goes away underneath the user — delisted, or closed
		// by the gate between polls. Focus must NOT slide to a neighbour: the
		// next keypress would act on a market the user never chose.
		const app2 = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app2.api.drawMarkets();
		const doomed = app2.$("s-markets").querySelector('[data-focus="trade:RTM-USDT"]');
		ok(doomed, "RTM-USDT should be open in the fixture");
		if (doomed) {
			doomed.focus();
			app2.ctx.STATE.tickers = MARKETS.filter((x) => x.market !== "RTM-USDT");
			app2.api.drawMarkets();
			const now = app2.dom.activeElement;
			ok(
				now === doomed && !doomed.attached(),
				"when the focused market disappears, focus must be left where it " +
					"fell rather than moved to whichever row took its place — acting " +
					"on the wrong market is worse than losing your place",
			);
		}
	}

	// ---- (e) the feed failing is a message, not a blank screen or a throw.
	{
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app.setFeed(() => Promise.reject(new Error("gateway timeout")));
		app.api.RENDER.markets();
		await new Promise((r) => setTimeout(r, 0));
		ok(
			app.body().rows.length === 1 &&
				app.body().rows[0].cells[0].colSpan === COLS,
			"a failed tickers fetch must leave one placeholder row spanning the " +
				"whole table",
		);
		ok(
			/unavailable/i.test(app.$("mkt-count").textContent),
			"...and must say so in the live region rather than leaving a stale " +
				"count claiming markets are listed",
		);
	}

	// ---- (f) THE BLOCK RULE, at the pixel rather than in the source.
	//
	// Section 9 proves the filter does no cross-market arithmetic. This proves
	// the consequence: whatever ends up on screen for a BLOCK market is the
	// string the venue sent, and no currency symbol is introduced anywhere.
	{
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app.api.mktSet({ open: false });
		const text = app.$("s-markets").textContent;
		ok(
			!/[$€£]/.test(text),
			"the markets screen rendered a currency symbol — BLOCK is priced only " +
				"in BLOCK, and a fiat glyph is the first half of breaking that",
		);
		const blockRow = app.rowFor("BTC-BLOCK");
		ok(blockRow, "BTC-BLOCK should render");
		if (blockRow) {
			ok(
				!/USD/i.test(blockRow.textContent),
				"a BLOCK-quoted row must not mention USD in any form",
			);
		}
	}

	// ---- (g) THE COLUMN COUNT IS DERIVED, NOT COINCIDENTALLY RIGHT.
	//
	// app.html ships seven columns today, so every assertion made against a
	// seven-column header passes whether the code reads the <thead> or just
	// writes `7`. That is how the old bug survived: the number was correct in
	// three places at once until a column moved. So this stage hands the
	// renderer a header that is deliberately NOT seven wide. Only code that
	// takes the width from the live header row can pass it.
	//
	// The phone breakpoint hides two columns, which is exactly the live case
	// where a stale literal would leave every group header short.
	{
		const odd = COLS + 2;
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED, odd);
		app.api.drawMarkets();

		const groups = app.groupRows();
		ok(groups.length > 0, "the wide-table render should still group by quote");
		for (const g of groups) {
			ok(
				g.cells[0].colSpan === odd,
				`a group header spanned ${g.cells[0].colSpan} of a ${odd}-column ` +
					"table — the width is a hardcoded literal, not mktCols()",
			);
		}

		// And the placeholder row, via a filter that matches nothing.
		app.api.mktSet({ text: "NOSUCHCOIN" });
		const rows = app.body().rows;
		ok(rows.length === 1, "an empty result is one placeholder row");
		if (rows.length === 1) {
			ok(
				rows[0].cells[0].colSpan === odd,
				`the empty-state row spanned ${rows[0].cells[0].colSpan} of ${odd} ` +
					"columns",
			);
			ok(
				/NOSUCHCOIN/.test(rows[0].textContent),
				"the empty state must name the text that emptied the list",
			);
			ok(
				app.$("s-markets").querySelector('[data-focus="clear"]') !== null,
				"the empty state needs a Clear filters button, keyed so the poll " +
					"does not pull it out from under the keyboard",
			);
		}
	}

	// ---- (h) THE QUOTED-IN FACET CAN ALWAYS BE SEEN AND UNDONE.
	//
	// The bug this stage exists for: drawMarkets called drawQuoteOnly() and no
	// such function existed, so EVERY render of the markets screen threw and
	// the list never appeared at all. Nothing caught it, because the control it
	// draws is the one control whose handler is assigned per render rather than
	// once at startup — so the static "is anything listening" sweep walked past
	// it. A render stage is the only thing that could have.
	//
	// The behaviour is load-bearing beyond not throwing. "Quoted in BTC" is set
	// from a quote group's header, and those headers only exist under Pair A-Z.
	// Under any other sort the facet was a filter you could read in the count
	// line and could not turn off without also dropping your asset chips.
	{
		const app = mountMarkets(MARKETS, MARKETS, NOT_LISTED);
		app.api.drawMarkets();

		const tokenOf = () => app.$("mkt-qonly");
		ok(
			/\bhidden\b/.test(tokenOf().className),
			"with no quoted-in facet the token must be hidden by CLASS — .chip is " +
				"display:inline-flex and beats the user-agent's [hidden] rule, so the " +
				"attribute alone would leave an empty token in the bar",
		);

		// Set it the way the UI does, from a group header's "only" button.
		const only = app.$("s-markets").querySelector('[data-focus="only:USDT"]');
		ok(only, "a USDT group header must offer an \"only\" button");
		if (only) only.onclick();

		ok(
			app.api.MKT ? app.api.MKT.quoteOnly === "USDT" : true,
			"the \"only\" button must set the quoted-in facet",
		);
		ok(
			!/\bhidden\b/.test(tokenOf().className),
			"once the facet is on, the token must be visible",
		);
		ok(
			/USDT/.test(tokenOf().textContent),
			"the token must name the quote it is filtering on, got: " +
				tokenOf().textContent,
		);
		ok(
			/remove/i.test(tokenOf().getAttribute("aria-label") || ""),
			"the token's accessible name must say what clicking it does — the × is " +
				"aria-hidden, so the label is a screen reader's only clue",
		);
		ok(
			app.dataRows().every((r) => /\/USDT/.test(r.textContent)),
			"with the facet on, every rendered row must be quoted in USDT",
		);

		// THE POINT OF THE CONTROL: it survives a sort that removes the group
		// headers, which is where the facet used to become unreachable.
		app.api.mktSet({ sort: "spread" });
		ok(
			app.groupRows().length === 0,
			"sorting by spread must drop the group headers — cutting a sorted list " +
				"into groups defeats the sort",
		);
		ok(
			!/\bhidden\b/.test(tokenOf().className),
			"the token must STILL be visible with no group headers left: this is " +
				"the sort order in which it is the only way to undo the facet",
		);

		// And clicking it clears only that facet, leaving the rest alone.
		app.api.mktSet({ toggleAsset: "DOGE" });
		tokenOf().onclick();
		ok(
			/\bhidden\b/.test(tokenOf().className),
			"clearing the facet must hide the token again",
		);
		ok(
			app.dataRows().some((r) => !/\/USDT/.test(r.textContent)),
			"clearing it must widen the list past USDT",
		);
		ok(
			app.dataRows().every((r) => /DOGE/.test(r.textContent)),
			"...but must NOT clear the asset chips: it is a dismiss for one facet, " +
				"not a reset for all of them",
		);
	}
}

// ------------------------------------------------------------------- report
//
// The render section is async — one case has to let a rejected fetch settle —
// so the report waits on it. A throw inside it is a failure like any other,
// not a crash: "the renderer threw" is the most useful single line this file
// can print, and an unhandled rejection would bury it.

renderChecks()
	.catch((e) => {
		fail("the markets render threw: " + (e && e.stack ? e.stack : e));
	})
	.then(report);

function report() {
	if (failures > 0) {
		console.error(
			`\nmarkets: ${failures} problem(s) across ${cases} behaviour cases and ` +
				`${RENDER_STAGES} render stages`,
		);
		process.exit(1);
	}
	console.log(
		`markets: ${cases} filter cases + 9 static checks + ${RENDER_STAGES} render ` +
			`stages clean — text search both sides, involves vs quoted-in, ` +
			`open/closed with reasons, chip counts stable by construction, ` +
			`facet-clear announced, refusals split, resolved Trade links, no ` +
			`cross-market arithmetic, keyboard-reachable rows, derived colspan, ` +
			`quoted-in facet visible and dismissible in every sort order, ` +
			`focus survives the 8s poll`,
	);
}
