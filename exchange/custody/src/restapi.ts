// -----------------------------------------------------------------------------
// /rest — THE DOCUMENTED, SELF-DESCRIBING ALIAS. NOT A THIRD IMPLEMENTATION.
//
// THE DECISION, AND WHY IT WENT THIS WAY.
//
// The ask was "we need a REST API also on exchange.blockle.org/rest". The
// obvious reading is "write a REST API", and that reading is wrong here. This
// process already answers every question a REST API would answer, twice over:
//
//   * /public/*  — unauthenticated market data, GET-only, served from a SQLite
//     handle opened READ-ONLY at the driver (see publicapi.ts), so a handler
//     that tried to write would fail rather than succeed.
//   * /v1/*      — the customer surface, authenticated by the Blockle account
//     session or by a signed API key (apikeys.ts), with the money-moving and
//     credential routes locked to a browser session plus a fresh second factor.
//
// A third implementation of "what is the order book" would mean two matchers,
// two formatters and two sets of rounding decisions. This venue has already
// paid for that mistake once in a smaller form: the published order-book depth
// was computed by a different query from the matcher's, which used
// SUM(CAST(base_total AS INTEGER)) and saturated at int64, so the depth the
// front page showed was simply a different number from the book it claimed to
// describe (venue.ts, the price_key header). Two code paths for one fact do not
// drift slowly — they drift the first time one of them is edited.
//
// There is a second, sharper reason, and it is a security reason. Every
// authenticated route in this service is protected by exactly one closure
// (`caller()` / `sessionOnly()` in publicapi.ts) and, for the withdrawal rail,
// by an nginx `location =` block with its own 10r/m budget. A second handler
// for the same data is a second place that must remember all of that. The
// 2026-11-25 audit found an authenticated scanner making 139 successful faucet
// calls inside the global rate limit precisely because a route had been added
// without its own budget. A new surface is a new chance to repeat that.
//
// SO: /rest IS A NAME, A CONTRACT AND A DOCUMENT OVER THE HANDLERS THAT
// ALREADY EXIST. One handler per route, forever. The mechanics:
//
//   * This file contains NO request handling at all. It is a catalogue plus a
//     matcher plus an index document. It imports nothing from node:http, so it
//     is testable without a socket, and it cannot accidentally grow a handler.
//   * publicapi.ts consults `matchRest()` and then dispatches to the SAME code
//     the equivalent /public or /v1 route uses. For account routes it calls
//     `venueRoute` with the mount set to "/rest" instead of "/v1".
//   * THE URL IS NEVER REWRITTEN. An API-key signature covers
//     `url.pathname + url.search` as sent (apikeys.ts, `signingString`), so
//     internally rewriting /rest/balances to /v1/balances before authenticating
//     would invalidate every signature a client could possibly produce —
//     the client signs what it sends, and the server verifies what it received.
//     Only the MOUNT PREFIX LENGTH differs, which is why `venueRoute` takes a
//     mount argument rather than a rewritten URL.
//
// WHAT /rest DELIBERATELY CANNOT DO. It cannot move funds, cannot create or
// revoke a credential, cannot change a security setting, and cannot provision
// a deposit address. Those routes are not aliased, each with its reason
// recorded in NOT_IN_REST below, and because dispatch is gated on this
// catalogue, "not aliased" means "returns 404 at /rest", not "reachable if you
// guess the spelling". Two of those reasons are worth pulling up here:
//
//   1. THE WITHDRAWAL RAIL IS NGINX-LIMITED BY EXACT PATH.
//      `location = /v1/withdrawals` carries the 10r/m exmoney zone.
//      `/rest/withdrawals` would match only `location /` and inherit 600r/m —
//      an alias would therefore be a sixty-times-looser door onto the same
//      handler. That alone is disqualifying, and it generalises: NO /rest
//      ROUTE MAY ALIAS A PATH THAT NGINX RATE-LIMITS MORE TIGHTLY THAN THE
//      DEFAULT.
//
//      HOW THAT IS ENFORCED, since for a while this comment claimed a test
//      that did not exist and the alias could be added in eleven lines with a
//      green suite: `RATE_LIMITED_PATHS` below lists those exact paths,
//      `matchRest` refuses any catalogue entry that names one (so the route
//      404s even if somebody adds it), and test/restapi.test.ts parses the
//      nginx conf and fails if that list is not exactly the set of
//      tightly-limited `location =` blocks in it. Runtime refusal for the
//      route, a build failure for the drift.
//
//   2. ONE SPELLING COLLIDES, AND THE COLLISION IS NOT PAPERED OVER.
//      /public/liquidity (venue inventory per chain) and /v1/liquidity (this
//      caller's market-maker ladders) are two different things with one name,
//      which is survivable while they sit under different prefixes and is not
//      survivable under one. /rest/liquidity is the PUBLIC one. The ladder
//      routes are not aliased, because renaming them under /rest would make
//      /rest a second vocabulary — exactly the drift this whole file exists to
//      refuse.
//
// AMOUNTS. Decimal strings, never JSON numbers, everywhere, on the way in and
// on the way out. A JSON number is an IEEE double: 18-decimal token amounts
// and USDT balances above ~9e15 base units silently mangle. `null` means
// genuinely unknown (no trade yet), and is never rendered as 0.
//
// NO FIAT, ANYWHERE. The venue publishes no USD conversion for any asset, and
// for BLOCK and BLOCK-20 tokens a converted fiat price is a product-level
// prohibition, not a preference. Everything here is denominated in its own
// asset's units.
// -----------------------------------------------------------------------------

import { SCOPES, SIGNING_ALGORITHM, SKEW_MS, type Scope } from "./apikeys";

/** The mount. Everything in this file hangs off it; nothing hard-codes it. */
export const REST_MOUNT = "/rest";

/**
 * What a caller must present.
 *
 * `none` is genuinely nothing — no key, no cookie, no header. The other two
 * are the SAME authentication the equivalent /v1 route requires, named by the
 * API-key scope a programmatic caller needs. A browser session is not scoped
 * (it is a person on the site with their own second factor available), so for
 * session callers both values mean "be signed in".
 *
 * There is no third value, and in particular there is no value meaning
 * "withdraw": apikeys.ts has no such scope to grant and /rest aliases no route
 * that could use one.
 */
export type RestAuth = "none" | Scope;

export interface RestParam {
	readonly name: string;
	readonly in: "path" | "query" | "body";
	readonly required: boolean;
	/** What it is, in the units a caller must send. */
	readonly about: string;
}

export interface RestRoute {
	readonly method: "GET" | "POST";
	/** Full public path, with `{placeholders}`. e.g. `/rest/book/{market}`. */
	readonly path: string;
	/**
	 * The route this is an alias OF, published so a reader can verify the claim
	 * that there is one implementation. The tail after the prefix is identical
	 * to this route's tail, by design and by test: an alias that renames is a
	 * second vocabulary.
	 */
	readonly sameHandlerAs: string;
	/**
	 * Which dispatcher serves it. `public` is the unauthenticated GET-only
	 * block (read-only database handle); `account` is `venueRoute`.
	 *
	 * This is the field that decides where a request goes, so it is worth
	 * knowing what a mistake here would do: a `public` route misdeclared as
	 * `account` 404s in venueRoute, and an `account` route misdeclared as
	 * `public` 404s in the public block — EXCEPT for a spelling that exists on
	 * both sides, which is why the one such spelling (`liquidity`) is called
	 * out in the header and why there is a test pinning each route's surface to
	 * the handler block that actually contains it.
	 */
	readonly surface: "public" | "account";
	readonly auth: RestAuth;
	/** See STABILITY. `stable` is a promise; `provisional` is not. */
	readonly stability: "stable" | "provisional";
	readonly summary: string;
	readonly params: readonly RestParam[];
	/**
	 * A REAL response, captured from the live venue or produced by the same code
	 * path in a test — not a hand-drawn sketch.
	 *
	 * Arrays are truncated to one element and `exampleNote` says so. That is a
	 * documentation choice, not an invented payload.
	 *
	 * WHAT IS ACTUALLY TESTED, stated exactly, because the earlier version of
	 * this comment claimed "a test asserts the key sets match what the code
	 * produces" and no such test existed. test/restapi.test.ts asserts that
	 * EVERY FIELD NAME in every example appears as an emitted object key in the
	 * source that serves that route — searching the route's own handler region
	 * first and the rest of src/ second, because several of these payloads are
	 * assembled by helpers (`publish()`, `reserves()`, `fmt()`) rather than by a
	 * literal in the handler.
	 *
	 * So a field RENAMED or REMOVED fails the build, which is the way these
	 * documents actually rot. What it does NOT prove is the shape of a nested
	 * value or that a field is still populated the same way; proving that needs
	 * the handlers driven over a socket against a seeded ledger, which this
	 * suite does not do. Do not read a green test here as "the example was
	 * replayed from the live venue" — the examples were captured by hand from
	 * the live venue and the live handlers, and the test keeps their field names
	 * honest, no more.
	 */
	readonly example: unknown;
	readonly exampleNote?: string;
}

/*
 * THE EDGE RATE LIMIT, QUOTED FROM THE CONFIG THAT ENFORCES IT.
 *
 * /rest sits under nginx's `location /` on exchange.blockle.org, so it
 * inherits the global exlive zone. These numbers are duplicated here only so
 * the index can publish them; test/restapi.test.ts parses
 * deploy/exchange/nginx-exchange-live.conf — the `limit_req_zone`, the
 * `limit_req` inside the TLS server block and `limit_req_status` — and fails if
 * any of them disagrees with this object. A published limit that is not the
 * enforced limit is worse than no published limit: a client tunes to the wrong
 * number and gets throttled anyway. (The test pins the file in this repo. The
 * file on the box is only the same file once a human has copied it and reloaded
 * nginx; see the deploy notes.)
 *
 * STATUS IS 429, NOT 503, AND THAT WAS A FIX. nginx defaults limit_req to 503,
 * which says "the service is down": monitoring pages someone and a well-built
 * client backs off as though the exchange had failed. `limit_req_status 429;`
 * sits in the http context of that file, so every vhost on the box inherits
 * it. An API that documents 429 and emits 503 teaches its callers the wrong
 * retry behaviour, so this is stated in the index and tested here.
 */
export const EDGE_LIMIT = {
	conf: "deploy/exchange/nginx-exchange-live.conf",
	zone: "exlive",
	requestsPerMinute: 600,
	burst: 200,
	keyedOn: "client IP address",
	status: 429,
} as const;

/**
 * EXACT PATHS NGINX LIMITS MORE TIGHTLY THAN THE DEFAULT — THE DENY-LIST FOR
 * ALIASING, ENFORCED AT RUNTIME AND PINNED TO THE CONFIG BY A TEST.
 *
 * An nginx `location = /some/path` block matches the PATH, not the handler. So
 * a second spelling of a handler that sits behind a tight budget does not
 * inherit that budget: it falls to `location /` and gets the global 600r/m.
 * Aliasing `POST /v1/withdrawals` at `/rest/withdrawals` would therefore be a
 * SIXTY-TIMES-LOOSER DOOR onto the live withdrawal code, which is the single
 * worst thing this mount could do.
 *
 * This used to be prose: restapi.ts asserted in capitals that "there is a test
 * that reads the nginx config and enforces it", and there was no such test, so
 * the alias could be added in eleven lines with a clean build and a green
 * suite. Now there are two enforcement points, deliberately different in kind:
 *
 *   1. `matchRest` refuses any catalogue entry whose tail is one of these, so
 *      the route 404s even if somebody adds it. Runtime, no test required.
 *   2. test/restapi.test.ts parses every `location = <path>` with a non-default
 *      `limit_req zone=` out of the conf and asserts this list is exactly that
 *      set — so adding a tight location to nginx without listing it here fails
 *      the build, and listing a path that nginx no longer protects fails it too.
 *
 * `/v1/testnet-fund` is in the conf and is listed here even though the faucet
 * route no longer exists in the service: the budget is what this list mirrors,
 * and a path that comes back must come back already denied.
 */
export const RATE_LIMITED_PATHS: readonly string[] = [
	"/v1/withdrawals",
	"/v1/testnet-fund",
	"/v1/api-keys",
];

/** The per-key application limit, from apikeys.ts. Also 429. */
export const KEY_LIMIT = {
	defaultRequestsPerMinute: 120,
	minRequestsPerMinute: 1,
	maxRequestsPerMinute: 1200,
	keyedOn: "API key",
	status: 429,
	note:
		"Per key, not per account, so one runaway integration cannot starve " +
		"another of the same owner's.",
} as const;

/*
 * -----------------------------------------------------------------------------
 * THE CATALOGUE. The index is generated from this and dispatch is gated on it.
 *
 * test/restapi.test.ts enforces three things over this list, by parsing
 * publicapi.ts: every entry's handler exists on the surface the entry declares
 * (a `public` tail in the public read block, an `account` tail in venueRoute);
 * every route in publicapi.ts is either aliased here or listed in NOT_IN_REST
 * with a reason; and no entry names a path nginx limits tightly. Adding a route
 * to publicapi.ts without touching this file fails the build — which is the
 * point: an index that can go stale is an index nobody can trust twice.
 *
 * The parsing is textual, so it is worth knowing its limit: it looks for the
 * route literals these two functions actually use (`p === "/x"` and
 * `/^\/x\/...$/` regexes). A route dispatched by some new mechanism — a table,
 * a switch, a computed path — would be invisible to it and would need the test
 * taught about it. That is a real gap, written down rather than implied.
 * -----------------------------------------------------------------------------
 */
export const REST_ROUTES: readonly RestRoute[] = [
	// ---- public market data, no authentication of any kind ------------------
	{
		method: "GET",
		path: "/rest/status",
		sameHandlerAs: "/public/status",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"Is the venue live, and on which network. Both flags must be true " +
			"for `live`; a missing or unparseable config reads as testnet, never " +
			"as live.",
		params: [],
		example: {
			live: true,
			mainnetEnabled: true,
			legalReviewCompleted: true,
			network: "mainnet",
			ledgerPresent: true,
			faucetAvailable: false,
		},
	},
	{
		method: "GET",
		path: "/rest/health",
		sameHandlerAs: "/public/health",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"Liveness only. It says the HTTP process is answering; it does not " +
			"claim the ledger, the custodian or any chain is healthy. Use " +
			"/rest/status for that, and do not build a solvency check on this.",
		params: [],
		example: { ok: true },
	},
	{
		method: "GET",
		path: "/rest/fees",
		sameHandlerAs: "/public/fees",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary: "Trading fees, in basis points and as a disclosed sentence.",
		params: [],
		example: {
			makerPct: "0.20%",
			takerPct: "0.20%",
			note:
				"Each side pays a fee on what it receives, in the asset it " +
				"receives. Buy 1 BTC and the 0.20% fee is taken from the BTC you " +
				"receive, not charged separately. Fees round down, so a sub-unit " +
				"remainder stays with you.",
			makerBps: 20,
			takerBps: 20,
		},
	},
	{
		method: "GET",
		path: "/rest/withdrawal-fees",
		sameHandlerAs: "/public/withdrawal-fees",
		surface: "public",
		auth: "none",
		stability: "provisional",
		summary:
			"The withdrawal fee schedule, per asset and network. PROVISIONAL " +
			"because the numbers move: a fee is derived from a gas budget and a " +
			"live rate, so it is a quote at a moment and not a tariff. The " +
			"shape is stable; the figures are not.",
		params: [],
		example: {
			fees: [
				{
					asset: "USDT",
					network: "TRC20",
					fee: "13.6",
					minimum: "27.2",
					gasAsset: "TRX",
					available: true,
				},
				{
					asset: "BTC",
					fee: "0.00006502",
					minimum: "0.00013006",
					gasAsset: "BTC",
					available: true,
					plusBps: 2,
				},
			],
			note:
				"The fee is withheld from the amount, so you receive the amount " +
				"minus the fee. It covers the network cost of sending — which for " +
				"a token is paid in a different asset (ERC-20 USDT costs ETH) — " +
				"plus our margin. Minimums exist because below them the fee would " +
				"be most of the withdrawal; the exact fee is always shown before " +
				"you confirm.",
		},
		exampleNote:
			"`fees` is truncated to two of its rows: one network-qualified " +
			"(USDT on TRC20) and one bare single-chain asset carrying the " +
			"optional `plusBps`. `network` is absent, not null, on a " +
			"single-chain asset.",
	},
	{
		method: "GET",
		path: "/rest/markets",
		sameHandlerAs: "/public/markets",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"Every market, with the scales a client needs to format and submit. " +
			"AMOUNTS take the asset's own decimals; PRICES take `priceScale`, " +
			"which is quoteDecimals + priceDecimals. Using quoteDecimals for a " +
			"price renders it 10^priceDecimals too large and submits it that " +
			"many times too small — which is why the field is published rather " +
			"than left to be derived.",
		params: [],
		example: [
			{
				symbol: "BTC-USDT",
				base: "BTC",
				quote: "USDT",
				baseDecimals: 8,
				quoteDecimals: 6,
				priceDecimals: 0,
				priceScale: 6,
				minBase: "0.00001",
				minNotional: "5",
				state: "open",
				closed: null,
				caveat: null,
				listedAt: "2026-11-25",
			},
		],
		exampleNote: "Truncated to the first market of several.",
	},
	{
		method: "GET",
		path: "/rest/tickers",
		sameHandlerAs: "/public/tickers",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"Last, bid and ask per market. `null` means no trade or no resting " +
			"order yet — it is NOT zero, and a client that renders it as zero is " +
			"publishing a price this venue never quoted. `change24h` and " +
			"`volume24h` are null until the rollups exist; they are present as " +
			"fields so a client does not have to detect their arrival.",
		params: [],
		example: [
			{
				pair: "BTC/USDT",
				market: "BTC-USDT",
				base: "BTC",
				quote: "USDT",
				last: "50000",
				bid: null,
				ask: null,
				change24h: null,
				volume24h: null,
			},
		],
		exampleNote: "Truncated to the first market of several.",
	},
	{
		method: "GET",
		path: "/rest/book/{market}",
		sameHandlerAs: "/public/book/{market}",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"Aggregated order book for one market. An empty book is `[]`, which " +
			"is the honest answer for a market nobody is quoting.",
		params: [
			{
				name: "market",
				in: "path",
				required: true,
				about:
					"Market symbol exactly as /rest/markets spells it, e.g. " +
					"BTC-USDT. An unknown symbol is 404 `{\"error\":\"unknown " +
					"market\"}`, not an empty book.",
			},
		],
		example: { market: "BTC-USDT", bids: [], asks: [] },
	},
	{
		method: "GET",
		path: "/rest/trades/{market}",
		sameHandlerAs: "/public/trades/{market}",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary: "Recent trades for one market, newest first.",
		params: [
			{
				name: "market",
				in: "path",
				required: true,
				about: "Market symbol as spelled by /rest/markets.",
			},
		],
		example: [
			{
				price: "50000",
				base: "1",
				takerSide: "buy",
				at: "2026-11-23T23:33:20.925Z",
			},
		],
		exampleNote: "Truncated to one trade.",
	},
	{
		method: "GET",
		path: "/rest/assets",
		sameHandlerAs: "/public/assets",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"Every asset with its decimals and the networks it can arrive on. An " +
			"empty `networks` array means a single-chain asset: send NO network " +
			"when a route asks for one.",
		params: [],
		example: [
			{
				symbol: "USDT",
				decimals: 6,
				networks: [
					{ id: "TRC20", label: "Tron (TRC-20)" },
					{ id: "ERC20", label: "Ethereum (ERC-20)" },
				],
			},
		],
		exampleNote: "Truncated to the first asset, and its first two networks.",
	},
	{
		method: "GET",
		path: "/rest/liquidity",
		sameHandlerAs: "/public/liquidity",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"What the venue can actually pay out right now, per asset and " +
			"network, after subtracting withdrawals already committed. " +
			"`open:false` with a `note` is a chain that is shut and why. NOTE " +
			"THE NAME: this is the VENUE'S inventory. A caller's own " +
			"market-maker ladders are not here and are not on /rest at all — " +
			"see `notAliased`.",
		params: [],
		example: {
			assets: [
				{
					asset: "USDT",
					decimals: 6,
					networks: [
						{
							network: "TRC20",
							label: "Tron (TRC-20)",
							available: "0",
							open: false,
							note: "no liquidity on this network right now",
						},
					],
					maxSingleWithdrawal: "0",
					updatedAt: "2026-11-26T05:36:28.284Z",
				},
			],
		},
		exampleNote:
			"Truncated to the first asset and its first network. `note` is " +
			"present only on a closed network.",
	},
	{
		method: "GET",
		path: "/rest/reserves",
		sameHandlerAs: "/public/reserves",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"Per asset: what customers are owed, what is held in custody, and " +
			"whether the second covers the first. Self-reported from our own " +
			"ledger and labelled as such — calling self-reported numbers an " +
			"attestation is the overstatement that destroys the trust it was " +
			"meant to build. `fullyBacked` uses >=, so a surplus still counts.",
		params: [],
		example: {
			disclaimer:
				"Self-reported figures from our own ledger, published live. Not " +
				"an independent audit or attestation.",
			assets: [
				{
					asset: "USDT",
					owed: "0",
					held: "0",
					fullyBacked: true,
					perNetwork: [{ network: "TRC20", held: "0" }],
				},
			],
		},
		exampleNote: "Truncated to the first asset and its first network.",
	},
	{
		method: "GET",
		path: "/rest/unlisted",
		sameHandlerAs: "/public/unlisted",
		surface: "public",
		auth: "none",
		stability: "stable",
		summary:
			"The pairs that have no symbol, and why — because a refusal nobody " +
			"can read is indistinguishable from a bug. `pendingSettlement` is " +
			"blocked on a rail that is not open yet; `notListed` is a pair we " +
			"will not list.",
		params: [],
		example: {
			notListed: [],
			pendingSettlement: [
				{
					base: "ETH",
					quote: "BTC",
					why:
						"ETH deposits are not open yet. Our custodian will not issue " +
						"a per-customer Ethereum deposit address on our current plan, " +
						"and we will not hand everyone one shared address — on " +
						"Ethereum there is no memo or tag, so we could not tell whose " +
						"money had arrived. We are resolving it with the custodian.",
					blockedBy: "ETH",
				},
			],
		},
		exampleNote: "`pendingSettlement` truncated to one entry.",
	},
	{
		method: "GET",
		path: "/rest/listing-questions",
		sameHandlerAs: "/public/listing-questions",
		surface: "public",
		auth: "none",
		stability: "provisional",
		summary:
			"The listing application question set, so a form is generated from " +
			"the same list the validator reads. PROVISIONAL: questions are " +
			"added and reworded as the listing process changes. Submitting an " +
			"application is NOT on /rest — see `notAliased`.",
		params: [],
		example: {
			questions: [
				{
					key: "project",
					label: "Project name",
					hint: "",
					required: true,
					max: 120,
				},
			],
		},
		exampleNote: "Truncated to the first question of several.",
	},

	// ---- account-scoped: same authentication as the /v1 route ---------------
	{
		method: "GET",
		path: "/rest/balances",
		sameHandlerAs: "/v1/balances",
		surface: "account",
		auth: "read",
		stability: "stable",
		summary:
			"This account's balances. THREE FIGURES, NOT ONE: `available` alone " +
			"cannot explain why a visible balance will not place an order, and " +
			"`reserved` is the answer. reserved is collateral held against " +
			"resting orders, so total = reserved + available.",
		params: [],
		example: [
			{
				asset: "BTC",
				total: "0.5",
				reserved: "0.1",
				available: "0.4",
				decimals: 8,
			},
		],
		exampleNote:
			"One asset shown; the live route returns a row per tradable asset, " +
			"including zeroes.",
	},
	{
		method: "GET",
		path: "/rest/orders",
		sameHandlerAs: "/v1/orders",
		surface: "account",
		auth: "read",
		stability: "stable",
		summary: "This account's orders. `state` is open, filled or cancelled.",
		params: [],
		example: [
			{
				id: "o_3f1c9ab2d4e5f60718",
				market: "BTC-USDT",
				side: "buy",
				state: "open",
				price: "50000",
				filled: "0",
				total: "0.01",
				createdAt: "2026-11-25T18:04:11.902Z",
			},
		],
		exampleNote: "Truncated to one order.",
	},
	{
		method: "POST",
		path: "/rest/orders",
		sameHandlerAs: "/v1/orders",
		surface: "account",
		auth: "trade",
		stability: "stable",
		summary:
			"Place a limit order. It matches immediately against anything " +
			"crossing, so the response already reports fills. `price` and " +
			"`amount` are decimal strings and are REFUSED, not rounded, when " +
			"they carry more precision than the market can represent — which is " +
			"what stops an order for '0.000000001 BTC' from silently becoming a " +
			"free order for zero.",
		params: [
			{
				name: "market",
				in: "body",
				required: true,
				about: "Symbol as spelled by /rest/markets. Unknown is 404.",
			},
			{
				name: "side",
				in: "body",
				required: true,
				about: '"buy" or "sell". Anything else is refused.',
			},
			{
				name: "price",
				in: "body",
				required: true,
				about:
					"Decimal string, scaled by the market's `priceScale` — NOT by " +
					"the quote asset's decimals. See /rest/markets.",
			},
			{
				name: "amount",
				in: "body",
				required: true,
				about:
					"Decimal string of BASE units, at the base asset's decimals. " +
					"Must be at least `minBase`, and price*amount at least " +
					"`minNotional`.",
			},
		],
		example: {
			id: "o_3f1c9ab2d4e5f60718",
			state: "open",
			fills: 0,
			filled: "0",
			total: "0.01",
		},
		exampleNote:
			"`fills` is a COUNT of fills, not an array of them — the only JSON " +
			"number in this payload, and it is a count, never money.",
	},
	{
		method: "POST",
		path: "/rest/orders/{id}/cancel",
		sameHandlerAs: "/v1/orders/{id}/cancel",
		surface: "account",
		auth: "trade",
		stability: "stable",
		summary:
			"Cancel one of this account's orders and release its reserved " +
			"collateral. Cancelling an order that is already filled or already " +
			"cancelled is refused rather than reported as success, so a client " +
			"cannot conclude it freed collateral it did not free.",
		params: [
			{
				name: "id",
				in: "path",
				required: true,
				about: "Order id as returned when it was placed, e.g. o_<hex>.",
			},
		],
		example: { state: "cancelled" },
	},
	{
		method: "GET",
		path: "/rest/deposits",
		sameHandlerAs: "/v1/deposits",
		surface: "account",
		auth: "read",
		stability: "stable",
		summary:
			"This account's deposits, from the first time the custodian " +
			"mentions them — including the ones still short of their " +
			"confirmation target, which is what makes 'where is my deposit' " +
			"answerable without asking an operator. `network` is null for a " +
			"single-chain asset.",
		params: [],
		example: {
			deposits: [
				{
					asset: "USDT",
					network: "TRC20",
					amount: "100",
					txid:
						"a3f1c9ab2d4e5f607182b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5d6e7f80",
					confirmations: 19,
					outcome: "credited",
					detail: null,
					firstSeen: "2026-11-25T18:04:11.902Z",
				},
			],
		},
		exampleNote: "Truncated to one deposit.",
	},
];

/*
 * -----------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND WHY. Every route in this process that /rest does NOT
 * alias has an entry, and test/restapi.test.ts fails if a route literal exists
 * in publicapi.ts that is neither aliased above nor listed here. So the next
 * person to add a /v1 route cannot leave the question "should this be on
 * /rest?" unanswered — they must either alias it or write down why not.
 *
 * AND THE LIST IS ENFORCED, NOT JUST DOCUMENTED. `matchRest` consults it: an
 * entry here makes that route 404 under /rest even if somebody adds it to
 * REST_ROUTES. Removing a refusal to open a route is therefore a visible,
 * deliberate deletion of a written reason rather than an addition nobody
 * notices.
 *
 * This list is also PUBLISHED in the index. A caller who cannot find
 * /rest/withdrawals deserves to be told that it will never exist and where to
 * go instead, rather than being left to wonder whether they mistyped it.
 * -----------------------------------------------------------------------------
 */
export interface RestExclusion {
	readonly method: string;
	/** The route as it exists today. */
	readonly path: string;
	readonly why: string;
}

export const NOT_IN_REST: readonly RestExclusion[] = [
	{
		method: "POST",
		path: "/v1/withdrawals",
		why:
			"/rest cannot move funds. Withdrawing needs a browser session plus a " +
			"fresh single-use code from the account's authenticator, which is not " +
			"something a server-to-server caller can hold — apikeys.ts has no " +
			"withdrawal scope and never will. On top of that, nginx limits the " +
			"exact path /v1/withdrawals to 10 requests a minute; an alias at " +
			"/rest/withdrawals would match only `location /` and inherit 600, so " +
			"it would be a sixty-times-looser door onto the same handler.",
	},
	{
		method: "GET",
		path: "/v1/withdrawals",
		why:
			"Same exact-path rate-limit bucket as the POST above (an nginx " +
			"`location =` block matches the path, not the method), so aliasing " +
			"the listing would widen the money route's budget. Use the site.",
	},
	{
		method: "GET",
		path: "/v1/withdrawal-options",
		why:
			"It describes an action /rest cannot take. The unauthenticated fee " +
			"schedule is at /rest/withdrawal-fees and the per-chain payout " +
			"capacity is at /rest/liquidity; neither needs an account.",
	},
	{
		method: "GET",
		path: "/v1/withdrawal-quote",
		why:
			"Same: a priced preview of a withdrawal that can only be started on " +
			"the site. Keeping it off /rest keeps the authenticated surface as " +
			"small as the use case allows.",
	},
	{
		method: "GET",
		path: "/v1/me",
		why:
			"It answers 'who is this browser signed in as', and it authenticates " +
			"through the account session directly — an API key gets nothing from " +
			"it. A key-authenticated caller already knows which account it is " +
			"acting for, because the key names one.",
	},
	{
		method: "GET",
		path: "/v1/deposit-address",
		why:
			"A GET that PROVISIONS: the first call for a chain creates a receive " +
			"address at the custodian. That is correct for a person clicking " +
			"once and wrong for an unattended client that retries on timeout — " +
			"it would hammer a rate-limited custodian with address requests. " +
			"Deposit addresses are issued on the site; /rest/deposits reports " +
			"what arrives at them.",
	},
	{
		method: "GET",
		path: "/v1/deposit-addresses",
		why:
			"The all-chains-at-once form of the route above, with the same " +
			"provisioning side effect multiplied by the number of chains.",
	},
	{
		method: "GET",
		path: "/v1/liquidity",
		why:
			"THE ONE NAME COLLISION. /public/liquidity (venue inventory) and " +
			"/v1/liquidity (this caller's market-maker ladders) are different " +
			"things with one spelling. /rest/liquidity is the public one. " +
			"Renaming the ladder routes under /rest would make /rest a second " +
			"vocabulary rather than an alias, which is the drift the whole " +
			"design refuses.",
	},
	{
		method: "POST",
		path: "/v1/liquidity",
		why:
			"Same collision; and it opens a ladder of real resting orders, so " +
			"giving it a second spelling is exactly where two names for one " +
			"money-moving handler would cost something.",
	},
	{
		method: "GET",
		path: "/v1/liquidity/quote",
		why: "Part of the ladder feature above; it would be the only half of it on /rest.",
	},
	{
		method: "POST",
		path: "/v1/liquidity/{id}/close",
		why: "Part of the ladder feature above.",
	},
	{
		method: "GET",
		path: "/v1/allowlist",
		why:
			"A withdrawal-address allowlist is a money control. Reading it is " +
			"session-only today and stays that way; /rest aliases nothing that " +
			"an API key is forbidden from reaching, because an alias whose auth " +
			"differs from its original is the weaker second path this design " +
			"exists to avoid.",
	},
	{
		method: "POST",
		path: "/v1/allowlist",
		why:
			"Adds a destination a withdrawal may later be sent to. Session plus " +
			"authenticator, on the site, and never from a key.",
	},
	{
		method: "POST",
		path: "/v1/allowlist/remove",
		why:
			"Tightening a money control, but still a money control; it stays " +
			"beside the route that loosens it rather than drifting onto a " +
			"different surface.",
	},
	{
		method: "GET",
		path: "/v1/2fa",
		why: "Second-factor enrolment state. A security setting, session-only.",
	},
	{
		method: "POST",
		path: "/v1/2fa/begin",
		why:
			"It returns a TOTP secret, once. An endpoint that hands out " +
			"authenticator secrets is worth attacking; it has exactly one " +
			"spelling, reachable only by a signed-in person.",
	},
	{ method: "POST", path: "/v1/2fa/confirm", why: "Changes a security setting." },
	{
		method: "POST",
		path: "/v1/2fa/disable",
		why: "WEAKENS a money control. Session plus a valid code, on the site.",
	},
	{
		method: "GET",
		path: "/v1/api-keys",
		why:
			"Key management is session-only on purpose: a key that can mint keys " +
			"is a key that can escalate itself. nginx also limits this exact " +
			"path to 30 requests a minute, so an alias would widen a credential " +
			"route's budget. Manage keys on the site; use them here.",
	},
	{
		method: "POST",
		path: "/v1/api-keys",
		why: "Mints a credential. Same exact-path 30r/m bucket, same refusal.",
	},
	{
		method: "DELETE",
		path: "/v1/api-keys/{keyId}",
		why:
			"Revokes a credential. Kept beside the route that creates one — and " +
			"/rest publishes no DELETE at all.",
	},
	{
		method: "POST",
		path: "/public/listing-apply",
		why:
			"The one mutating public route. It takes a human's listing " +
			"application, with free-text answers and an email we reply to; a " +
			"programmatic alias would mostly collect spam. The question set is " +
			"readable at /rest/listing-questions and the form is on the site.",
	},
];

/*
 * -----------------------------------------------------------------------------
 * STABILITY — stated plainly, including the parts that are not promises.
 *
 * Written out here rather than in a wiki because the index serves it, so a
 * caller reads the same words the code was built against.
 * -----------------------------------------------------------------------------
 */
export const STABILITY = {
	promised: [
		"A path listed here keeps its meaning. If a field's meaning must " +
			"change, it gets a new field or the route gets a new path; a /rest " +
			"path is never silently re-pointed at different semantics.",
		"Every amount is a decimal string in its asset's own units, and `null` " +
			"means unknown rather than zero.",
		"No endpoint under /rest will ever move funds, create or revoke a " +
			"credential, or change a security setting. Dispatch is gated on the " +
			"catalogue AND the catalogue is filtered by a refusal list, so a " +
			"route that is written down as refused stays refused even if it is " +
			"also added to the catalogue by mistake.",
		"Authentication for an account-scoped route is identical to its /v1 " +
			"original — the same closure, the same scope, the same refusals. " +
			"/rest can never be the weaker way in.",
		"Every response under /rest is JSON. A 404 or a 405 here is a JSON " +
			"body, never the site's HTML error page.",
		"A write (POST) is refused with 403 if its Origin names a different " +
			"site than its Host. Call this API from its own origin, or from a " +
			"server-to-server client that sends no Origin at all.",
		"Throttling answers 429 and carries Retry-After, never 503. The " +
			"service's own 429 (the per-key limit) carries it by construction; " +
			"the edge's 429 carries it from the nginx config in this repo.",
		"No endpoint under /rest returns a fiat (USD) figure for any asset, " +
			"and none will for BLOCK or any BLOCK-20 token under any " +
			"circumstances, including by conversion.",
	],
	notPromised: [
		"FIELDS ARE ADDED WITHOUT NOTICE. Ignore fields you do not know; do " +
			"not validate responses against a closed schema.",
		"Array ORDER is not part of the contract unless a route's summary says " +
			"it is.",
		"Free-text fields — `note`, `caveat`, `why`, `detail`, `disclaimer` — " +
			"are written for people and get reworded. Never parse them; switch " +
			"on the structured fields beside them.",
		"The market and asset lists change as things are listed and delisted. " +
			"Read /rest/markets rather than hard-coding symbols.",
		"Routes marked `provisional` may change shape. Today those are the " +
			"withdrawal fee schedule and the listing question set.",
		"Fee figures, liquidity figures and reserve figures are live numbers, " +
			"not a published tariff.",
	],
	versioning:
		"/rest is not versioned separately from /v1, because it is not a " +
			"separate implementation: both mounts enter the same handlers, so " +
			"they cannot disagree about a balance or a book. That is the whole " +
			"point of the alias. What that means for you: a change to the " +
			"underlying route is a change to /rest on the same deploy, and " +
			"neither mount is a frozen snapshot of the other. If the two ever " +
			"have to diverge, the divergent surface gets a new prefix and this " +
			"paragraph gets rewritten — we will not quietly make one mount mean " +
			"something the other does not.",
	deprecation:
		"Nothing here is deprecated. If a route is withdrawn it will answer " +
			"410 with a pointer for at least 90 days before it stops answering " +
			"at all, and it will be listed in `notAliased` with the reason.",
} as const;

/*
 * -----------------------------------------------------------------------------
 * CORS — DECIDED, NOT DEFAULTED.
 *
 * The rule: PUBLIC READS ARE CROSS-ORIGIN READABLE; AUTHENTICATED RESPONSES
 * CARRY NO ACCESS-CONTROL HEADER AT ALL, and nothing on this venue answers a
 * preflight.
 *
 * Why it matters more than it looks: until this change, publicapi.ts sent
 * `Access-Control-Allow-Origin: *` on EVERY response from its JSON helper —
 * including /v1 payloads and /v1 401s, which is to say it advertised customer
 * balances as world-readable. No `Access-Control-Allow-Credentials` is ever
 * sent and nothing answers OPTIONS, so a cross-origin page could not READ
 * those replies; the label was wrong rather than the door open, and the moment
 * anything answered a preflight the wrong label would have become a real
 * cross-origin read. It is now correct by construction instead of harmless by
 * omission.
 *
 * AND THE CORRECTION THAT MATTERS MORE. An earlier version of this comment
 * argued the blanket `*` was harmless because a cross-origin request "needs a
 * preflight that would have to succeed first". THAT IS WRONG FOR WRITES, and
 * the next reader should not inherit it. A SIMPLE request needs no preflight:
 * a hostile page can POST to /rest/orders with `Content-Type: text/plain` and
 * `credentials: "include"`, the browser sends the session cookie, and the order
 * is PLACED. CORS only stops the page reading the answer.
 *
 * What actually stopped that was never in this repo: the accounts service sets
 * its session cookie SameSite=Lax, and Lax omits it from a cross-site POST. A
 * real control, in another service, named nowhere here, pinned by no test —
 * and /rest was about to add a second spelling of a mutating route on top of
 * it. So publicapi.ts now has `crossSiteWrite()`, called before it routes
 * anything, which refuses any mutating request whose Origin names a different
 * site than its Host, on every mount including /admin. That is this process's
 * own CSRF control, it does not depend on another service's cookie attributes,
 * and test/restapi.test.ts asserts both the function's behaviour and that the
 * server actually calls it.
 *
 * Consequence for integrators, stated because it is a real limitation: an
 * account-scoped /rest call CANNOT be made from browser JavaScript on another
 * origin. That is intended. API keys are for server-to-server callers, where
 * CORS does not apply at all, and a browser app that wants a customer's
 * balances should be served from this origin (nginx proxies the accounts
 * service here for the same reason) or use the customer's own session on the
 * site.
 * -----------------------------------------------------------------------------
 */
export const CORS = {
	publicRoutes:
		"Access-Control-Allow-Origin: * — market data is world-readable and " +
		"carries no credential.",
	accountRoutes:
		"No Access-Control-* header is sent. A custodial venue's authenticated " +
		"endpoints must not be callable from arbitrary origins.",
	credentials:
		"Access-Control-Allow-Credentials is never sent, on any route, so no " +
		"cross-origin request can READ a response that rode a session cookie.",
	crossSiteWrites:
		"Refused with 403. CORS does not stop a cross-site POST — a simple " +
		"request is sent without a preflight and only the reply is unreadable — " +
		"so this service checks Origin against Host on every mutating request " +
		"and refuses the mismatch itself. A client that sends no Origin header " +
		"(curl, a server-to-server integration, the mobile apps) is unaffected.",
	preflight:
		"OPTIONS is not answered — it is refused with 405 and an Allow header. " +
		"Nothing on this venue needs a preflight: same-origin browser calls do " +
		"not require one, and server-to-server callers are not subject to CORS.",
} as const;

/** What a caller gets wrong, and what it means. Published in the index. */
export const ERRORS = [
	{ status: 400, meaning: "The request is malformed, or an amount carries precision the market cannot represent. The message says which." },
	{ status: 401, meaning: "Not authenticated: no credential, a bad signature, a stale timestamp, or a replayed signature. Retrying unchanged will not help." },
	{ status: 403, meaning: "Authenticated but not permitted — typically a key without the scope the route needs. Also the answer to a cross-site write: a POST whose Origin names a different site than its Host is refused outright." },
	{ status: 404, meaning: "No such route, market, asset or order. /rest paths are exact: no trailing slash, and the index lists every one that exists. Always a JSON body on this mount — never the site's HTML 404 page." },
	{ status: 405, meaning: "Wrong method for a real path, or OPTIONS. The Allow header lists what the path accepts." },
	{ status: 413, meaning: "The request body is over the 64 KiB cap. Nothing on this surface needs a body near that size; if yours does, you are sending something this API did not ask for." },
	{ status: 429, meaning: "Rate limited — by the edge on IP, or by apikeys.ts on the key. Honour Retry-After, which is sent on every 429 and is the length of the limit window in seconds. This venue never answers 503 for rate limiting." },
	{ status: 503, meaning: "A dependency this request needed is unreachable — most often the accounts service, in which case we refuse to guess who you are rather than treating you as anonymous. NOT a rate limit." },
] as const;

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `/rest/book/{market}` -> `/^\/rest\/book\/([^/]+)$/`.
 *
 * Only a whole segment can be a placeholder, and a placeholder never spans a
 * slash. The underlying handlers validate the captured VALUE themselves, and
 * this deliberately does not duplicate those patterns: a second, looser copy of
 * a validator is how a path the catalogue accepted and the handler rejected
 * comes to return a confusing error. Here it matches the shape; there it
 * matches the value.
 *
 * THAT SPLIT HAS TO BE KEPT HONEST, AND IT WAS NOT. The /book and /trades
 * handlers in publicapi.ts matched `([A-Z0-9-]+)` while this matched
 * `([^/]+)`, so every path with a lower-case letter sat in the gap: the
 * catalogue claimed it, no handler answered it, and `/rest/book/btc-usdt` fell
 * through to the static site and returned 6 KB of HTML 404 from a JSON API —
 * while the index published `{"error":"unknown market"}` for exactly that case.
 * The handlers now claim every shape this accepts and answer `unknown market`
 * for a value they do not know, and publicapi.ts has a terminal guard so no
 * /rest path can ever reach the static file server. test/restapi.test.ts pins
 * both: every placeholder route's handler regex must be no stricter than this
 * one, and the guard must exist.
 */
function templateToRegExp(path: string): RegExp {
	const src = path
		.split("/")
		.map((seg) =>
			/^\{[A-Za-z]+\}$/.test(seg)
				? "([^/]+)"
				: seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("/");
	return new RegExp(`^${src}$`);
}

/**
 * IS THIS ROUTE ON THE REFUSAL LIST? If so it does not get compiled, no matter
 * what the catalogue says.
 *
 * NOT_IN_REST WINS OVER REST_ROUTES, AT RUNTIME, AND THAT IS A CONTROL AND NOT
 * A TIDINESS RULE.
 *
 * The refusals below are the money and credential routes. Everything that
 * stopped them being aliased used to be prose plus a review step: the file said
 * in capitals that "there is a test" enforcing it, and there was no test, so
 * adding `POST /rest/withdrawals` to the catalogue compiled clean, passed the
 * whole suite, and landed on the live withdrawal handler — through `location /`
 * at 600r/m instead of the 10r/m `location = /v1/withdrawals` budget that
 * exists to protect it. Sixty times looser, by adding eleven lines, with the
 * file telling you the build would stop you.
 *
 * So the deny-list is now consulted by the matcher. An entry in NOT_IN_REST
 * makes its route unreachable here even if someone adds it to REST_ROUTES —
 * they have to delete the refusal and its written reason to widen the surface,
 * which is a change a reviewer can see. `restRoutesDenied()` reports any such
 * collision and a test fails on it, so the mistake is loud rather than silent.
 */
export function restDeniesAlias(route: RestRoute): boolean {
	const tail = route.path.startsWith(`${REST_MOUNT}/`)
		? route.path.slice(REST_MOUNT.length)
		: route.path;
	/*
	 * THE COMPARISON IS PREFIXED BY THE ROUTE'S OWN SURFACE, AND THAT IS NOT A
	 * DETAIL — it is the `/liquidity` collision again.
	 *
	 * The first version of this function tested the tail against BOTH prefixes,
	 * which looked safer and was wrong: `/rest/liquidity` is the PUBLIC
	 * inventory route, NOT_IN_REST refuses the unrelated `/v1/liquidity`
	 * market-maker ladders under the same spelling, and so the public route was
	 * silently denied — the index advertising a route the matcher 404s. The test
	 * that asserts "the index publishes nothing the matcher will not route"
	 * caught it, which is the whole reason that test exists.
	 */
	const own = `${route.surface === "public" ? "/public" : "/v1"}${tail}`;

	// The rate-limit deny-list first: it does not depend on anybody having
	// written a refusal down, which is what makes it the backstop. `/v1${tail}`
	// is checked whatever the declared surface says, because a misdeclared
	// surface must not be a way around it — and nothing in that list shares a
	// spelling with a public route, so there is no collision to cause here.
	if (
		RATE_LIMITED_PATHS.includes(own) ||
		RATE_LIMITED_PATHS.includes(`/v1${tail}`) ||
		RATE_LIMITED_PATHS.includes(route.sameHandlerAs)
	) {
		return true;
	}
	return NOT_IN_REST.some(
		(x) =>
			x.method.toUpperCase() === route.method &&
			(x.path === route.sameHandlerAs || x.path === own),
	);
}

/**
 * Catalogue entries that collide with a published refusal. A test asserts this
 * is empty; the matcher refuses them regardless, so a non-empty result is a
 * documentation-and-intent conflict rather than an open door.
 */
export function restRoutesDenied(): readonly string[] {
	return REST_ROUTES.filter(restDeniesAlias).map(
		(r) =>
			`${r.method} ${r.path}: ${r.sameHandlerAs} is refused — either by ` +
			`NOT_IN_REST or because nginx rate-limits that exact path ` +
			`(RATE_LIMITED_PATHS). The matcher 404s it regardless, so this entry ` +
			`is published and dead. Delete one of them — and if it is the ` +
			`refusal, say why in the commit.`,
	);
}

const COMPILED: readonly { readonly route: RestRoute; readonly re: RegExp }[] =
	REST_ROUTES.filter((route) => !restDeniesAlias(route)).map((route) => ({
		route,
		re: templateToRegExp(route.path),
	}));

export type RestMatch =
	/** `/rest` itself: serve the index. */
	| { readonly kind: "index" }
	/**
	 * A real route. `tail` is the path with the mount removed — which is both
	 * the /public-block path and the /v1 path, because the alias never renames.
	 */
	| { readonly kind: "route"; readonly route: RestRoute; readonly tail: string }
	/** A real path, wrong method. `allow` is for the Allow header. */
	| { readonly kind: "method"; readonly allow: readonly string[] }
	/** Nothing of ours. */
	| { readonly kind: "unknown" };

/**
 * Route a /rest request, or refuse it.
 *
 * HEAD IS TREATED AS GET for matching, because the public block already serves
 * both and a client issuing HEAD to check a path exists should not get a 405
 * that implies the path does not.
 *
 * Returns `unknown` for anything not in the catalogue — including the money
 * routes. That is the enforcement point for "/rest cannot move funds": the
 * caller of this function dispatches ONLY on a `route` result, so an unaliased
 * spelling never reaches a handler at all.
 */
export function matchRest(pathname: string, method: string): RestMatch {
	const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();

	if (pathname === REST_MOUNT || pathname === `${REST_MOUNT}/`) {
		return m === "GET" ? { kind: "index" } : { kind: "method", allow: ["GET", "HEAD"] };
	}

	const hits = COMPILED.filter((c) => c.re.test(pathname));
	if (hits.length === 0) return { kind: "unknown" };

	const exact = hits.find((c) => c.route.method === m);
	if (exact !== undefined) {
		return {
			kind: "route",
			route: exact.route,
			tail: pathname.slice(REST_MOUNT.length),
		};
	}

	const allow = new Set<string>();
	for (const c of hits) {
		allow.add(c.route.method);
		if (c.route.method === "GET") allow.add("HEAD");
	}
	return { kind: "method", allow: [...allow] };
}

/**
 * Does every route's declared `sameHandlerAs` have the same tail as its /rest
 * path — i.e. is this an alias rather than a rename?
 *
 * Returned rather than thrown. Dispatch slices the REQUEST path and never the
 * declared one, so a bad entry here is a documentation defect, not a routing
 * hazard; a test asserts this is empty, which is where a documentation defect
 * belongs. Throwing at import would mean a typo in a comment field could stop
 * the exchange from booting.
 */
export function aliasProblems(): readonly string[] {
	const out: string[] = [];
	for (const r of REST_ROUTES) {
		if (!r.path.startsWith(`${REST_MOUNT}/`)) {
			out.push(`${r.method} ${r.path}: every route must hang off ${REST_MOUNT}/`);
			continue;
		}
		const tail = r.path.slice(REST_MOUNT.length);
		const prefix = r.surface === "public" ? "/public" : "/v1";
		if (r.sameHandlerAs !== `${prefix}${tail}`) {
			out.push(
				`${r.method} ${r.path}: declared as an alias of ${r.sameHandlerAs}, ` +
					`but an alias must keep the spelling — expected ${prefix}${tail}`,
			);
		}
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* The index                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * THE SELF-DESCRIBING INDEX, served at /rest.
 *
 * Generated from the catalogue above, never hand-maintained alongside it: a
 * route list written twice is a route list that is wrong in one place. An API
 * nobody can discover is an API nobody uses, so this includes the auth scheme
 * in full, the real rate limits, the error table, the stability statement, and
 * a genuine example response per route.
 *
 * It is pure data — no live state. `/rest/status` reports whether the venue is
 * live; this document describes what exists. Mixing the two would make a cached
 * document carry a stale liveness claim, which is the one claim that must never
 * be stale.
 */
export function restIndex(): Record<string, unknown> {
	return {
		service: "Blockle Exchange REST API",
		mount: REST_MOUNT,
		documentation: "this document",
		/*
		 * The design decision, served to callers and not only to readers of this
		 * file. Someone integrating deserves to know that /rest, /public and /v1
		 * cannot disagree, because it changes what they have to test.
		 */
		design:
			`${REST_MOUNT} is a documented, stable alias over the handlers that ` +
			"already serve /public (unauthenticated market data) and /v1 (the " +
			"customer surface). It is not a second implementation: both mounts " +
			"enter the same code, so a balance or a book cannot differ between " +
			"them, and an authenticated route cannot be weaker here than there. " +
			"Routes that move funds, manage credentials or change security " +
			"settings are deliberately absent — see notAliased.",
		amounts:
			"Every amount, price and fee is a DECIMAL STRING in its asset's own " +
			"units — never a JSON number, because a JSON number is a double and " +
			"an 18-decimal token amount does not survive one. `null` means " +
			"unknown (no trade yet, no rollup yet); it never means zero. No " +
			"endpoint returns a fiat conversion for any asset.",
		authentication: {
			public:
				"Routes with auth 'none' need no credential at all. Do not send " +
				"one; they ignore it.",
			accountScoped:
				"Either the Blockle account session (a cookie on this origin, or " +
				"an Authorization: Bearer token — what the site and the apps use) " +
				"or a signed API key (what a server-to-server caller should use). " +
				"Presenting API-key headers commits you to that path: a bad " +
				"signature is reported as a bad signature rather than silently " +
				"falling back to a cookie that happened to be present.",
			apiKey: {
				algorithm: SIGNING_ALGORITHM,
				stringToSign: "timestamp + METHOD + path + sha256hex(body)",
				headers: {
					key: "X-Blockle-Key",
					timestamp: "X-Blockle-Timestamp",
					signature: "X-Blockle-Signature",
				},
				skewMs: SKEW_MS,
				scopes: SCOPES,
				pathIsSignedAsSent:
					"Sign the path you send, including its query string — so a " +
					`${REST_MOUNT}/balances request signs ${REST_MOUNT}/balances, ` +
					"NOT /v1/balances. The server verifies what it received and " +
					"rewrites nothing.",
				replay:
					"A signature may be used once. The signature itself is the " +
					"nonce and is recorded, so re-sending a captured request fails " +
					"even inside the timestamp window.",
				cannotWithdraw: true,
				manage:
					"Create and revoke keys while signed in on the site. Key " +
					"management is not on this surface: a key that can mint keys " +
					"is a key that can escalate itself.",
			},
			secondFactor:
				"Nothing on this surface takes one, because nothing on this " +
				"surface moves money. The withdrawal rail requires a fresh " +
				"single-use code per request, on the site.",
		},
		cors: CORS,
		rateLimits: {
			edge: EDGE_LIMIT,
			perKey: KEY_LIMIT,
			status:
				"Throttling is 429 with Retry-After. It is never 503 — 503 here " +
				"means a dependency is unreachable, and conflating the two teaches " +
				"a client to back off from the wrong thing.",
		},
		errors: ERRORS,
		stability: STABILITY,
		conventions: {
			paths:
				"Exact, lower-case, no trailing slash. /rest/markets/ is 404, not " +
				"a redirect.",
			methods:
				"GET for reads (HEAD is accepted wherever GET is). POST for the " +
				"two trading routes. No PUT, PATCH or DELETE exists on this mount.",
			requestBodies:
				"JSON only, on the two POST routes, capped at 64 KiB. Amounts in " +
				"a body are decimal strings, same as in a response.",
			caching:
				"Market data carries a short Cache-Control max-age; every " +
				"account-scoped response is max-age=0. Do not cache an " +
				"authenticated response.",
		},
		routeCount: REST_ROUTES.length,
		routes: REST_ROUTES.map((r) => ({
			method: r.method,
			path: r.path,
			auth:
				r.auth === "none"
					? "none"
					: `account (API key scope '${r.auth}', or an account session)`,
			scope: r.auth === "none" ? null : r.auth,
			stability: r.stability,
			summary: r.summary,
			params: r.params,
			sameHandlerAs: r.sameHandlerAs,
			example: r.example,
			...(r.exampleNote === undefined ? {} : { exampleNote: r.exampleNote }),
		})),
		notAliased: {
			note:
				"These routes exist in this service and are NOT reachable under " +
				`${REST_MOUNT}. Dispatch is gated on the catalogue above, so each ` +
				"of these answers 404 here. The reason is given so you know not to " +
				"look for a different spelling.",
			routes: NOT_IN_REST,
		},
	};
}
