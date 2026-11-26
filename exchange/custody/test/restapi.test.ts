// -----------------------------------------------------------------------------
// /rest TESTS — THE ONES THE FILE CLAIMED IT ALREADY HAD.
//
// src/restapi.ts shipped with five load-bearing claims written into it as
// design guarantees, in capitals, including one that is a security control:
//
//   1. "NO /rest ROUTE MAY ALIAS A PATH THAT NGINX RATE-LIMITS MORE TIGHTLY
//      THAN THE DEFAULT. There is a test that reads the nginx config and
//      enforces it, so adding such an alias fails the build."
//   2. "a test reads deploy/exchange/nginx-exchange-live.conf and fails if
//      [EDGE_LIMIT] disagrees."
//   3. "a test asserts the key sets match what the code produces so this
//      cannot rot into fiction."
//   4. "a test fails if a route exists in publicapi.ts that is neither aliased
//      above nor listed here."
//   5. `aliasProblems()` — "a test asserts this is empty."
//
// None of them existed. The file had zero tests. The consequence was not
// theoretical: adding eleven lines to REST_ROUTES for POST /rest/withdrawals
// compiled clean, passed the entire suite, and routed into the live withdrawal
// handler — through nginx's `location /` at 600r/m instead of the 10r/m
// `location = /v1/withdrawals` budget that exists to protect it. Sixty times
// looser, while the file told the engineer doing it that the build would stop
// them.
//
// These are those tests, plus the three behaviours the published contract got
// wrong: Retry-After promised and never sent, a 404 shape documented and not
// produced, and HTML served from a JSON route.
//
// HOW THEY WORK, AND THE LIMIT OF IT. Several of these parse publicapi.ts as
// TEXT. That is a real limitation and it is deliberate rather than lazy:
// `start()` binds a socket, opens SQLite read-only, reads a config gate and
// pins an outbound IP, so driving the real handlers needs a fixture this suite
// does not have. Text parsing catches the failure mode that actually happens —
// a route or a field renamed on one side of the contract — and it would miss a
// route dispatched by some new mechanism (a table, a switch, a computed path).
// If dispatch ever stops being `p === "/x"` and `/^\/x\/...$/`, these tests
// must be taught about it, and `handlerRegions()` is where.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	CORS,
	EDGE_LIMIT,
	ERRORS,
	KEY_LIMIT,
	NOT_IN_REST,
	RATE_LIMITED_PATHS,
	REST_MOUNT,
	REST_ROUTES,
	STABILITY,
	aliasProblems,
	matchRest,
	restDeniesAlias,
	restIndex,
	restRoutesDenied,
	type RestRoute,
} from "../src/restapi";
import {
	RETRY_AFTER_SECONDS,
	crossSiteWrite,
	responseHeaders,
} from "../src/publicapi";
import { SCOPES } from "../src/apikeys";

// dist/test -> dist -> custody
const CUSTODY = join(__dirname, "../..");
// dist/test -> dist -> custody -> exchange -> repo root
const REPO = join(__dirname, "../../../..");
const PUBLICAPI = join(CUSTODY, "src/publicapi.ts");
const NGINX = join(REPO, "deploy/exchange/nginx-exchange-live.conf");

const SRC = readFileSync(PUBLICAPI, "utf8");
const CONF = readFileSync(NGINX, "utf8");

/* -------------------------------------------------------------------------- */
/* Reading the two dispatchers out of publicapi.ts                            */
/* -------------------------------------------------------------------------- */

/**
 * The two regions of publicapi.ts that route a request, isolated so a test can
 * say "this tail is served by THAT block" rather than "that string appears
 * somewhere in the file" — which is the difference between pinning a route's
 * surface and pinning nothing.
 */
function handlerRegions(): { readonly account: string; readonly public: string } {
	const accountStart = SRC.indexOf("const p = url.pathname.slice(mount.length);");
	assert.ok(
		accountStart > 0,
		"venueRoute no longer starts by slicing the mount off the path — these " +
			"tests find the account dispatcher by that line",
	);
	// venueRoute's last statement before its catch. Searching FORWARD from the
	// slice finds venueRoute's own 404 and not the public block's, because
	// venueRoute is defined before start() in this file.
	const accountEnd = SRC.indexOf(
		'json(res, 404, { error: "not found" });',
		accountStart,
	);
	assert.ok(accountEnd > accountStart, "venueRoute's terminal 404 moved");

	const publicStart = SRC.indexOf("restPublicPath ?? (url.pathname.replace(");
	assert.ok(publicStart > 0, "the public block's path resolution moved");
	const publicEnd = SRC.indexOf("if (restPublicPath !== undefined) {", publicStart);
	assert.ok(
		publicEnd > publicStart,
		"the /rest terminal guard is missing from the public block — without it " +
			"a catalogued /rest path falls through to serveStatic and answers HTML",
	);

	return {
		account: SRC.slice(accountStart, accountEnd),
		public: SRC.slice(publicStart, publicEnd),
	};
}

const REGION = handlerRegions();

/** `{anything}` -> `{}`, so a placeholder's NAME is not part of a comparison. */
function normalise(path: string): string {
	return path.replace(/\{[^}]*\}/g, "{}");
}

/** Every `method path` a region dispatches, as written in the source. */
function dispatched(region: string, prefix: "/public" | "/v1"): Set<string> {
	const out = new Set<string>();

	for (const m of region.matchAll(/p === "([^"]+)"/g)) {
		const after = region.slice(m.index + m[0].length, m.index + m[0].length + 60);
		const meth = /req\.method === "([A-Z]+)"/.exec(after);
		// The public block sits behind a GET/HEAD-only gate, so a route there
		// with no method test is a GET.
		out.add(`${meth?.[1] ?? "GET"} ${prefix}${m[1]!}`);
	}

	// `/^\/orders\/([^/]+)\/cancel$/.exec(p)` -> `POST /v1/orders/{}/cancel`
	for (const m of region.matchAll(/\/\^((?:\\\/|[^\n])+?)\$\/\.exec\(p\)/g)) {
		const tail = m[1]!.replace(/\\\//g, "/").replace(/\([^)]*\)/g, "{}");
		const after = region.slice(m.index + m[0].length, m.index + m[0].length + 160);
		const meth = /req\.method === "([A-Z]+)"/.exec(after);
		out.add(`${meth?.[1] ?? "GET"} ${prefix}${tail}`);
	}

	return out;
}

const DISPATCHED = new Set<string>([
	...dispatched(REGION.account, "/v1"),
	...dispatched(REGION.public, "/public"),
	// The one mutating public route, matched on the full pathname rather than
	// the stripped tail, so the patterns above do not see it.
	...[...SRC.matchAll(/url\.pathname === "(\/public\/[^"]+)"/g)].map(
		(m) => `POST ${m[1]!}`,
	),
]);

/** The regex literal a placeholder route MUST have, built from the catalogue. */
function expectedHandlerRegex(route: RestRoute): string {
	const tail = route.path.slice(REST_MOUNT.length);
	const src = tail
		.split("/")
		.map((seg) => (/^\{[A-Za-z]+\}$/.test(seg) ? "([^/]+)" : seg))
		.join("\\/");
	return `/^${src}$/`;
}

/* -------------------------------------------------------------------------- */
/* 1. THE RATE-LIMIT DENY-LIST — the claim that was a security control        */
/* -------------------------------------------------------------------------- */

test("RATE_LIMITED_PATHS is exactly nginx's set of tightly-limited exact paths", () => {
	// Every `location = /path { ... limit_req zone=X ... }` where X is not the
	// global zone. Those are the budgets an alias would escape.
	const found = new Set<string>();
	for (const m of CONF.matchAll(
		/location\s+=\s+(\/[^\s{]*)\s*\{([^}]*)\}/g,
	)) {
		const path = m[1]!;
		const body = m[2]!;
		const zone = /limit_req\s+zone=([A-Za-z0-9_]+)/.exec(body);
		if (zone === null) continue;
		if (zone[1] === EDGE_LIMIT.zone) continue; // the default budget
		found.add(path);
	}

	assert.ok(found.size > 0, "parsed no tight location blocks out of the conf");
	assert.deepEqual(
		[...found].sort(),
		[...RATE_LIMITED_PATHS].sort(),
		"nginx and restapi.ts disagree about which exact paths carry a tighter " +
			"budget. Adding a `location =` with its own limit_req means adding " +
			"that path to RATE_LIMITED_PATHS, or /rest may alias it and escape " +
			"the budget — nginx matches the PATH, not the handler.",
	);
});

test("no catalogue route aliases a tightly rate-limited path", () => {
	for (const r of REST_ROUTES) {
		const tail = r.path.slice(REST_MOUNT.length);
		for (const limited of RATE_LIMITED_PATHS) {
			assert.notEqual(
				`/v1${tail}`,
				limited,
				`${r.method} ${r.path} aliases ${limited}, which nginx limits by ` +
					`exact path. The alias would inherit the global budget instead.`,
			);
			assert.notEqual(r.sameHandlerAs, limited);
		}
	}
});

test("THE DRIFT CASE: adding POST /rest/withdrawals is refused at runtime", () => {
	// The exact edit that used to compile clean and pass the whole suite.
	const sneaked: RestRoute = {
		method: "POST",
		path: "/rest/withdrawals",
		sameHandlerAs: "/v1/withdrawals",
		surface: "account",
		auth: "read",
		stability: "stable",
		summary: "looks plausible in a diff",
		params: [],
		example: {},
	};
	assert.equal(
		restDeniesAlias(sneaked),
		true,
		"the matcher must refuse a withdrawal alias even if someone adds it to " +
			"REST_ROUTES — this is the sixty-times-looser door onto the money " +
			"route, and prose did not stop it",
	);

	// And the money routes are not reachable by their real spelling today.
	assert.deepEqual(matchRest("/rest/withdrawals", "POST"), { kind: "unknown" });
	assert.deepEqual(matchRest("/rest/withdrawals", "GET"), { kind: "unknown" });
	assert.deepEqual(matchRest("/rest/api-keys", "POST"), { kind: "unknown" });
	assert.deepEqual(matchRest("/rest/testnet-fund", "POST"), { kind: "unknown" });
});

/**
 * Tails that exist on BOTH surfaces, so refusing one side cannot mean 404ing
 * the other. Today that is `/liquidity`: `/public/liquidity` is venue
 * inventory per chain and `/v1/liquidity` is the caller's own market-maker
 * ladders, and `/rest/liquidity` is deliberately the public one (restapi.ts's
 * header, point 2).
 *
 * It is a pinned list rather than an inline special case because a SECOND
 * collision must be argued for the way that one was, not absorbed silently by
 * a test that already tolerates collisions.
 */
const SPELLING_COLLISIONS: readonly string[] = ["/liquidity"];

test("every published refusal is unreachable under /rest", () => {
	const collided: string[] = [];
	for (const x of NOT_IN_REST) {
		const tail = x.path.replace(/^\/(v1|public)/, "");
		const m = matchRest(`${REST_MOUNT}${tail}`, x.method);
		if (m.kind !== "route") continue;

		// The spelling routes. That is acceptable ONLY when what it reaches is a
		// different handler on the other surface; it is never acceptable for it
		// to reach the very handler the refusal names. This is the assertion
		// that matters — "is the refused HANDLER reachable", not "is the refused
		// SPELLING matchable" — and the distinction is the whole /liquidity
		// case. Checking the spelling instead would force /rest to 404 a public
		// route it advertises, which restDeniesAlias's comment records as the
		// bug that the index-vs-matcher test caught.
		assert.notEqual(
			m.route.sameHandlerAs,
			x.path,
			`${x.method} ${REST_MOUNT}${tail} reaches ${x.path}, which is listed ` +
				`as refused: ${x.why.slice(0, 80)}…`,
		);
		assert.ok(
			SPELLING_COLLISIONS.includes(tail),
			`${REST_MOUNT}${tail} routes to ${m.route.sameHandlerAs} while ` +
				`${x.path} is refused under the same spelling. One tail meaning two ` +
				`things under one mount is the ambiguity /rest exists to refuse: ` +
				`either stop aliasing it, or add it to SPELLING_COLLISIONS and ` +
				`explain it in restapi.ts's header the way /liquidity is.`,
		);
		collided.push(tail);
	}

	// A tolerated collision that no longer collides is a stale exemption
	// waiting for a rename to land underneath it, so the list is exact.
	assert.deepEqual(
		[...new Set(collided)].sort(),
		[...SPELLING_COLLISIONS].sort(),
		"SPELLING_COLLISIONS no longer describes this mount",
	);
});

test("nothing is both published and refused", () => {
	assert.deepEqual(restRoutesDenied(), []);
	assert.deepEqual(aliasProblems(), []);
});

test("no catalogue route points at the admin surface", () => {
	for (const r of REST_ROUTES) {
		assert.ok(
			!r.sameHandlerAs.startsWith("/admin"),
			`${r.path} aliases ${r.sameHandlerAs}: the operator console is not ` +
				`part of this mount, and the treasury view behind it shows every ` +
				`customer's balance`,
		);
	}
});

/* -------------------------------------------------------------------------- */
/* 2. THE PUBLISHED EDGE LIMIT MATCHES THE CONFIG THAT ENFORCES IT           */
/* -------------------------------------------------------------------------- */

test("EDGE_LIMIT matches the nginx conf it quotes", () => {
	const zone = new RegExp(
		`limit_req_zone\\s+\\$binary_remote_addr\\s+zone=${EDGE_LIMIT.zone}:\\d+m\\s+rate=(\\d+)r/m;`,
	).exec(CONF);
	assert.ok(zone !== null, `no limit_req_zone for ${EDGE_LIMIT.zone} in the conf`);
	assert.equal(
		Number(zone[1]),
		EDGE_LIMIT.requestsPerMinute,
		"the index would publish a rate the edge does not enforce",
	);

	const applied = new RegExp(
		`limit_req\\s+zone=${EDGE_LIMIT.zone}\\s+burst=(\\d+)`,
	).exec(CONF);
	assert.ok(applied !== null, "the global zone is declared but never applied");
	assert.equal(Number(applied[1]), EDGE_LIMIT.burst);

	assert.match(
		CONF,
		/limit_req_status\s+429;/,
		"without this nginx throttles with 503, which tells a client the venue " +
			"is down and makes monitoring page someone",
	);
	assert.equal(EDGE_LIMIT.status, 429);
	assert.equal(KEY_LIMIT.status, 429);
	assert.equal(EDGE_LIMIT.conf, "deploy/exchange/nginx-exchange-live.conf");
});

/* -------------------------------------------------------------------------- */
/* 3. RETRY-AFTER — PROMISED THREE TIMES, PREVIOUSLY SENT NOWHERE            */
/* -------------------------------------------------------------------------- */

test("every 429 this service writes carries Retry-After", () => {
	const h = responseHeaders(429, 10, 0, "world");
	assert.equal(
		h["Retry-After"],
		String(RETRY_AFTER_SECONDS),
		"the /rest index tells callers to honour Retry-After on a 429",
	);
	// Not on anything else: a Retry-After on a 200 is noise, and on a 503 it
	// would be a promise about a dependency we do not control.
	assert.equal(responseHeaders(200, 10, 2, "world")["Retry-After"], undefined);
	assert.equal(responseHeaders(503, 10, 0, "world")["Retry-After"], undefined);
	assert.equal(RETRY_AFTER_SECONDS, 60);
});

test("a throttled cross-origin reader can still see the 429", () => {
	// Public market data is world-readable; a 429 with no ACAO reaches browser
	// JavaScript as an opaque network error, so the client cannot tell "slow
	// down" from "that host is gone" and retries straight back into the limit.
	const h = responseHeaders(429, 10, 0, "world");
	assert.equal(h["Access-Control-Allow-Origin"], "*");
	assert.equal(h["Content-Type"], "application/json; charset=utf-8");
});

test("an account-scoped response carries no CORS header, throttled or not", () => {
	for (const code of [200, 401, 429]) {
		const h = responseHeaders(code, 10, 0, "same-origin");
		assert.equal(
			h["Access-Control-Allow-Origin"],
			undefined,
			`a ${code} on an account route must not advertise itself as ` +
				`world-readable — that is a customer's balance`,
		);
	}
	assert.match(CORS.accountRoutes, /No Access-Control-\* header is sent/);
});

test("the edge's own 429 is JSON with Retry-After, not nginx's HTML page", () => {
	// limit_req_status gets the STATUS right and leaves the body and headers as
	// nginx's stock HTML with no Retry-After at all, which is what the live
	// edge was actually serving while the index promised otherwise.
	const block = /error_page\s+429\s+=\s+@(\w+);/.exec(CONF);
	assert.ok(block !== null, "nginx's 429 is not intercepted, so it is HTML");
	const named = new RegExp(`location\\s+@${block[1]!}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(
		CONF,
	);
	assert.ok(named !== null, `location @${block[1]!} is missing`);
	const body = named[1]!;
	assert.match(body, /default_type\s+application\/json;/);
	assert.match(body, /add_header\s+Retry-After\s+(\d+)\s+always;/);
	assert.match(body, /add_header\s+Access-Control-Allow-Origin\s+"\*"\s+always;/);
	assert.match(body, /return\s+429\s+'\{"error":"rate limited"/);

	const secs = Number(/add_header\s+Retry-After\s+(\d+)/.exec(body)![1]);
	assert.equal(
		secs,
		RETRY_AFTER_SECONDS,
		"the edge and the service must quote the same wait, or a client that " +
			"hits both layers learns two different numbers",
	);
});

test("the error table documents every status a caller can actually get", () => {
	const statuses = new Set<number>(ERRORS.map((e) => e.status as number));
	for (const s of [400, 401, 403, 404, 405, 413, 429, 503]) {
		assert.ok(statuses.has(s), `${s} is reachable and undocumented`);
	}
	// 413 is thrown by rawBodyOf on the body cap and used to be missing.
	assert.match(SRC, /throw new VenueError\("request body too large", 413\)/);
});

/* -------------------------------------------------------------------------- */
/* 4. CSRF — THE CONTROL THAT WAS DESCRIBED AND NOT CALLED                   */
/* -------------------------------------------------------------------------- */

test("crossSiteWrite refuses a mutating request from another site", () => {
	const H = "exchange.blockle.org";
	// A hostile page. No preflight is involved: a simple POST is sent, and
	// CORS only stops the page READING the reply — the order still happens.
	assert.equal(crossSiteWrite("POST", "https://evil.example", H), true);
	assert.equal(crossSiteWrite("POST", "http://evil.example:8080", H), true);
	// A sandboxed frame sends the literal "null".
	assert.equal(crossSiteWrite("POST", "null", H), true);
	// Its own page.
	assert.equal(crossSiteWrite("POST", `https://${H}`, H), false);
	assert.equal(crossSiteWrite("POST", `https://${H}`, H.toUpperCase()), false);
	// Non-browser callers send no Origin, and CSRF does not happen to them.
	assert.equal(crossSiteWrite("POST", undefined, H), false);
	assert.equal(crossSiteWrite("POST", "", H), false);
	// Reads are not writes.
	assert.equal(crossSiteWrite("GET", "https://evil.example", H), false);
	assert.equal(crossSiteWrite("HEAD", "https://evil.example", H), false);
	assert.equal(crossSiteWrite("OPTIONS", "https://evil.example", H), false);
	// An Origin with no Host to compare it against is refused, not allowed.
	assert.equal(crossSiteWrite("POST", "https://evil.example", undefined), true);
});

test("the server calls crossSiteWrite before it routes anything", () => {
	const gate = SRC.indexOf("crossSiteWrite(\n");
	const admin = SRC.indexOf("if (await adminRoute(");
	const v1 = SRC.indexOf('url.pathname.startsWith("/v1/")');
	const rest = SRC.indexOf("const m = matchRest(");
	assert.ok(
		gate > 0,
		"crossSiteWrite is defined but never called — which is how it shipped: " +
			"the comment claimed it refused cross-site writes and the only real " +
			"control was another service's SameSite=Lax cookie",
	);
	assert.ok(gate < admin, "the admin console authenticates by cookie too");
	assert.ok(gate < v1 && gate < rest, "the gate must precede every mount");
	assert.match(CORS.crossSiteWrites, /Refused with 403/);
});

/* -------------------------------------------------------------------------- */
/* 5. THE CATALOGUE MATCHES THE HANDLERS — BOTH DIRECTIONS                   */
/* -------------------------------------------------------------------------- */

test("every catalogue route has a handler, on the surface it declares", () => {
	for (const r of REST_ROUTES) {
		const tail = r.path.slice(REST_MOUNT.length);
		const region = r.surface === "public" ? REGION.public : REGION.account;
		const other = r.surface === "public" ? REGION.account : REGION.public;

		if (/\{/.test(tail)) {
			const want = expectedHandlerRegex(r);
			assert.ok(
				region.includes(`${want}.exec(p)`),
				`${r.method} ${r.path}: the ${r.surface} dispatcher must match it ` +
					`with exactly ${want} — a STRICTER handler pattern leaves paths ` +
					`the catalogue accepts and no handler claims, which is how ` +
					`/rest/book/btc-usdt came to return the HTML 404 page`,
			);
			continue;
		}

		assert.ok(
			region.includes(`p === "${tail}"`),
			`${r.method} ${r.path} declares surface '${r.surface}' but that ` +
				`dispatcher does not serve ${tail}`,
		);
		// `liquidity` exists on both sides with different meanings, so the
		// exclusivity check below would fail on it by design. The catalogue
		// publishes the public one; NOT_IN_REST explains the other.
		if (tail !== "/liquidity") {
			assert.ok(
				!other.includes(`p === "${tail}"`),
				`${tail} exists on BOTH dispatchers. That is survivable under two ` +
					`prefixes and not under one; if it is deliberate it belongs in ` +
					`the header comment beside /liquidity`,
			);
		}
	}
});

test("every route in publicapi.ts is either aliased or refused, with a reason", () => {
	const aliased = new Set(
		REST_ROUTES.map(
			(r) =>
				`${r.method} ${normalise(
					(r.surface === "public" ? "/public" : "/v1") +
						r.path.slice(REST_MOUNT.length),
				)}`,
		),
	);
	const refused = new Set(
		NOT_IN_REST.map((x) => `${x.method.toUpperCase()} ${normalise(x.path)}`),
	);

	const unanswered: string[] = [];
	for (const d of DISPATCHED) {
		const key = normalise(d);
		if (aliased.has(key) || refused.has(key)) continue;
		unanswered.push(d);
	}
	assert.deepEqual(
		unanswered,
		[],
		"these routes exist in publicapi.ts and restapi.ts says nothing about " +
			"them. Alias them in REST_ROUTES or list them in NOT_IN_REST with the " +
			"reason — the question 'should this be on /rest?' must not be left " +
			"open, because the default answer is whatever the matcher happens to do",
	);
});

test("HEAD on a real /rest path is not a 405, and an unaliased one is not a 404 by accident", () => {
	assert.equal(matchRest("/rest", "GET").kind, "index");
	assert.equal(matchRest("/rest/", "GET").kind, "index");
	assert.equal(matchRest("/rest/markets", "HEAD").kind, "route");
	assert.equal(matchRest("/rest/markets", "GET").kind, "route");

	const wrong = matchRest("/rest/markets", "POST");
	assert.equal(wrong.kind, "method");
	assert.deepEqual(
		wrong.kind === "method" ? [...wrong.allow].sort() : [],
		["GET", "HEAD"],
		"a 405 without an Allow header leaves the caller guessing",
	);

	// The index says paths are exact, so they must be.
	assert.equal(matchRest("/rest/markets/", "GET").kind, "unknown");
	assert.equal(matchRest("/rest/MARKETS", "GET").kind, "unknown");
	assert.equal(matchRest("/rest/nope", "GET").kind, "unknown");
	// No DELETE anywhere on this mount, as the conventions claim.
	for (const r of REST_ROUTES) assert.notEqual(r.method as string, "DELETE");
});

test("a path parameter reaches its handler, and the index's error shape is the one produced", () => {
	// The catalogue matches a path's SHAPE; the handler validates the VALUE.
	const m = matchRest("/rest/book/btc-usdt", "GET");
	assert.equal(m.kind, "route");
	assert.equal(m.kind === "route" ? m.tail : "", "/book/btc-usdt");

	// And the handler that receives that tail answers the DOCUMENTED error for
	// a symbol it does not know, rather than falling past every route into the
	// static site. Both halves are asserted because the bug was the gap
	// between them.
	assert.ok(
		REGION.public.includes('/^\\/book\\/([^/]+)$/.exec(p)'),
		"the /book handler must claim every shape the catalogue accepts",
	);
	assert.ok(
		REGION.public.includes('json(res, 404, { error: "unknown market" })'),
		"the index documents 404 {\"error\":\"unknown market\"} for an unknown " +
			"symbol; that is the body the handler must produce",
	);
	const doc = REST_ROUTES.find((r) => r.path === "/rest/book/{market}")!;
	assert.match(
		doc.params[0]!.about,
		/unknown market/,
		"the published parameter note must describe the error the code emits",
	);
});

test("no /rest path can fall through to the static site", () => {
	// THE GENERAL STALENESS FAILURE. If a /public handler is renamed, its
	// /rest entry keeps matching the catalogue and the request continues past
	// every route. Before this guard it reached serveStatic and then the HTML
	// 404 page, so a JSON API answered text/html with 6 KB of marketing copy —
	// and /rest went on publishing an example response for a route that no
	// longer existed, with nothing failing anywhere.
	const guard = SRC.indexOf("if (restPublicPath !== undefined) {");
	const staticServe = SRC.indexOf("if (await serveStatic(req, res, url.pathname))");
	const htmlFallback = SRC.indexOf('await serveStatic(req, res, "/404.html", 404)');
	assert.ok(guard > 0, "the terminal /rest guard is gone");
	assert.ok(
		guard < staticServe && guard < htmlFallback,
		"the guard must come BEFORE the static file server and the HTML 404, or " +
			"a /rest path can still be answered with a web page",
	);
	assert.ok(
		STABILITY.promised.some((p) => /never the site's HTML error page/.test(p)),
		"this is published as a promise, so it needs a test",
	);
});

/* -------------------------------------------------------------------------- */
/* 6. THE INDEX IS SELF-DESCRIBING AND NOT FICTION                           */
/* -------------------------------------------------------------------------- */

/** Every field NAME in a captured example, nested objects and arrays included. */
function fieldNames(v: unknown, into = new Set<string>()): Set<string> {
	if (Array.isArray(v)) {
		for (const x of v) fieldNames(x, into);
	} else if (v !== null && typeof v === "object") {
		for (const [k, x] of Object.entries(v)) {
			into.add(k);
			fieldNames(x, into);
		}
	}
	return into;
}

const ALL_SRC = readdirSync(join(CUSTODY, "src"))
	.filter((f) => f.endsWith(".ts"))
	.map((f) => readFileSync(join(CUSTODY, "src", f), "utf8"))
	.join("\n");

test("every field in every example is a field some code actually emits", () => {
	/*
	 * WHAT THIS PROVES, EXACTLY. A documented field that is renamed or deleted
	 * fails here — which is how these documents rot. It does NOT prove the
	 * nested shape of a value or that the field is still populated the same
	 * way; that needs the handlers driven over a socket against a seeded
	 * ledger, which this suite does not do. The route's own dispatcher is
	 * searched first and the rest of src/ second, because several payloads are
	 * assembled by helpers (`publish()`, `reserves()`, `fmt()`) rather than by
	 * a literal in the handler.
	 */
	const missing: string[] = [];
	for (const r of REST_ROUTES) {
		const region = r.surface === "public" ? REGION.public : REGION.account;
		for (const key of fieldNames(r.example)) {
			const emitted = new RegExp(`(^|[^A-Za-z0-9_])${key}\\s*:`, "m");
			if (emitted.test(region) || emitted.test(ALL_SRC)) continue;
			missing.push(`${r.path} -> ${key}`);
		}
	}
	assert.deepEqual(
		missing,
		[],
		"the index publishes these fields and nothing in src/ emits them. Either " +
			"the example was never real or the field was renamed — in both cases " +
			"the published example is now a lie a caller will code against",
	);
});

test("the index publishes nothing the matcher will not route", () => {
	const idx = restIndex();
	const routes = idx["routes"] as readonly { method: string; path: string }[];
	assert.equal(idx["routeCount"], routes.length);
	assert.equal(idx["mount"], REST_MOUNT);
	for (const r of routes) {
		// A placeholder is filled with something legal before matching.
		const probe = r.path.replace(/\{[^}]*\}/g, "X");
		assert.equal(
			matchRest(probe, r.method).kind,
			"route",
			`${r.method} ${r.path} is advertised and does not route`,
		);
	}
});

test("every route documents itself: auth, summary, params, example", () => {
	for (const r of REST_ROUTES) {
		assert.ok(r.summary.length > 20, `${r.path}: no real summary`);
		assert.notEqual(r.example, undefined, `${r.path}: no example response`);
		assert.ok(
			r.path.startsWith(`${REST_MOUNT}/`),
			`${r.path} does not hang off the mount`,
		);
		for (const seg of r.path.slice(REST_MOUNT.length).split("/")) {
			if (!/^\{([A-Za-z]+)\}$/.test(seg)) continue;
			const name = seg.slice(1, -1);
			assert.ok(
				r.params.some((p) => p.name === name && p.in === "path" && p.required),
				`${r.path}: the ${name} placeholder is undocumented`,
			);
		}
		for (const p of r.params) assert.ok(p.about.length > 10, `${r.path}/${p.name}`);
	}
});

test("public routes need no credential and account routes name a real scope", () => {
	for (const r of REST_ROUTES) {
		if (r.surface === "public") {
			assert.equal(
				r.auth,
				"none",
				`${r.path} is on the unauthenticated dispatcher and claims auth ` +
					`'${r.auth}' — the index would tell a caller to send a credential ` +
					`the handler ignores`,
			);
			assert.equal(
				r.method,
				"GET",
				`${r.path} is a POST on the read-only public block; it would 405`,
			);
			continue;
		}
		assert.notEqual(
			r.auth,
			"none",
			`${r.path} is account-scoped. /rest must never be a weaker path to ` +
				`the same data than /v1.`,
		);
		assert.ok(
			(SCOPES as readonly string[]).includes(r.auth),
			`${r.path}: '${r.auth}' is not a scope apikeys.ts can grant`,
		);
	}
});

test("the account mount is the SAME handler, with only the prefix length changed", () => {
	// Not a second implementation: one handler, two mounts, and the URL is
	// never rewritten because an API-key signature covers the path as sent.
	assert.match(SRC, /mount: "\/v1" \| "\/rest" = "\/v1"/);
	assert.match(SRC, /const p = url\.pathname\.slice\(mount\.length\);/);
	assert.ok(
		SRC.includes("\t\t\t\t\t\t\tREST_MOUNT,\n"),
		"the /rest dispatch must pass REST_MOUNT into venueRoute",
	);
	assert.equal(
		(SRC.match(/path: url\.pathname \+ \(url\.search === "" \? "" : url\.search\)/g) ?? [])
			.length,
		1,
		"there must be exactly one place the signed path is computed",
	);
});

test("no example and no published text carries a fiat figure", () => {
	// Product rule, not a preference: no USD conversion for any asset, and
	// never for BLOCK or a BLOCK-20 token under any circumstances.
	const banned = /^(usd|usdValue|usdPrice|priceUsd|fiat|fiatValue|usdEquivalent)$/i;
	for (const r of REST_ROUTES) {
		for (const key of fieldNames(r.example)) {
			assert.ok(!banned.test(key), `${r.path} publishes a fiat field '${key}'`);
		}
		assert.doesNotMatch(
			JSON.stringify(r.example),
			/\$\s?\d/,
			`${r.path}'s example renders a dollar amount`,
		);
	}
	assert.ok(
		STABILITY.promised.some((p) => /fiat \(USD\)/.test(p)),
		"the no-fiat rule must stay published, not just obeyed",
	);
});

test("stability says what is promised AND what is not", () => {
	assert.ok(STABILITY.promised.length >= 5);
	assert.ok(STABILITY.notPromised.length >= 5);
	assert.match(STABILITY.versioning, /not versioned separately from \/v1/);
	assert.match(STABILITY.deprecation, /410/);
	// The promises that now have tests above must stay worded as promises, so
	// deleting the test and the promise together is a visible change.
	assert.ok(STABILITY.promised.some((p) => /Retry-After/.test(p)));
	assert.ok(STABILITY.promised.some((p) => /403 if its Origin/.test(p)));
	for (const r of REST_ROUTES) {
		assert.ok(
			r.stability === "stable" || r.stability === "provisional",
			`${r.path}: unknown stability`,
		);
	}
});
