// -----------------------------------------------------------------------------
// PUBLIC READ-ONLY API — the data behind the front page.
//
// Everything here is unauthenticated and world-readable, which is the whole
// point: a venue nobody has heard of asking for custody of your money should
// publish what it holds, per chain, without making you sign up first.
//
// FOUR RULES, each of which exists because the opposite is a lie a front page
// can tell:
//
// 1. NO ENDPOINT CAN MUTATE ANYTHING. GET only, no ledger writes, no auth to
//    escalate. The process opens the ledger database READ-ONLY at the SQLite
//    level, so a bug here cannot write even if someone later adds a handler
//    that tries.
//
// 2. AMOUNTS ARE DECIMAL STRINGS, NEVER JSON NUMBERS. A JSON number is a
//    double; a USDT balance above ~9e15 base units silently mangles. That is
//    the precise defect found in TradeXPro's PHP helpers, and it would be
//    absurd to reproduce it on the way out.
//
// 3. UNKNOWN IS REPORTED AS UNKNOWN. No prices exist until trading starts, so
//    /public/tickers returns listed markets with null prices rather than
//    zeroes or invented numbers. The front page renders those as em dashes.
//    A fabricated price on an exchange front page is the single most
//    dishonest thing it could display.
//
// 4. THE TESTNET FLAG DEFAULTS TO "NOT LIVE". /public/status reports
//    mainnetEnabled only when it is genuinely true; a missing config, a parse
//    failure, or an unset flag all read as testnet. The front page shows its
//    banner unless told otherwise, so a failure here cannot accidentally
//    present an unlicensed venue as open for business.
//
// NOTE ON DISCLOSURE: per-chain inventory is a treasury fact and is published.
// Customer balances, addresses and identities are not, and no handler here has
// access to a query that would return them.
// -----------------------------------------------------------------------------

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";

import { format, parse } from "./amount";
import { ASSETS, assertCustodyId, assetDef, settlementAsset } from "./assets";
import {
	MARKETS as VENUE_MARKETS,
	NOT_LISTED,
	PENDING_SETTLEMENT,
	QUOTE_SENIORITY,
	Venue,
	VenueError,
	market as marketDef,
	priceScale,
	quoteFor,
} from "./venue";
import { MarketMaker, quote as mmQuote } from "./mm";
import { Deposits, describeDeposit, listDepositAddresses } from "./deposits";
import { BitGoDeposits } from "./bitgodeposits";
import { BitGoHoldings } from "./bitgo";
import { BlockAddressPool } from "./blockaddresspool";
import { SolAddressPool } from "./soladdresspool";
import { SolConsolidation } from "./solconsolidation";
import {
	assertSolRailBlockedUnlessProven,
	assertSolRailUsesPool,
	solRailFromEnv,
	solRailReadiness,
} from "./solrail";
import { Customers } from "./customers";
import { bumpDeclared, readDeclared } from "./declaredtreasury";
import { depositsFor } from "./depositwatcher";
import { nodeAdapters, nodeDepositAddress } from "./custodyrouting";
import { ApiKeyError, ApiKeys, KEY_RATE_WINDOW_MS, SCOPES, SIGNING_ALGORITHM, SKEW_MS, type Scope } from "./apikeys";
import { Listings, QUESTIONS, sendmailMailer } from "./listings";
import { REST_MOUNT, matchRest, restIndex } from "./restapi";
import { Withdrawals, type Policy as WdPolicy } from "./withdrawals";
import { UserTotp, TwoFactorError } from "./usertotp";
import { canPay } from "./liquidity";
import { pinAndVerify } from "./ipv4";
import { DEFAULT_FEES, disclose } from "./fees";
import { Ledger } from "./ledger";
import { LIVE_GAS_COSTS, type GasGateDeps, checkGas } from "./gasgate";
import { AuthError, BlockleAuth } from "./blockleauth";
import {
	SCHEMA as ADMIN_SCHEMA,
	adminRoute,
	allowlistFrom,
	totpSecretsFrom,
	type AdminDeps,
} from "./adminapi";
import { BookRates, GAS_PRICE_FLOOR, StaticRates, type RateSource } from "./gasrates";
import {
	LIVE_FEES,
	discloseWithdrawalFees,
	quoteWithdrawal,
	type GasPricing,
} from "./withdrawalfees";
import {
	NOTHING_HALTED,
	assetLiquidity,
	publish,
	reserves,
	type CommitmentSource,
	type HaltSource,
} from "./liquidity";
import { reconcilerStateFrom } from "./treasury";

const PORT = Number(process.env.PUBLIC_API_PORT ?? 3100);
const HOST = process.env.PUBLIC_API_HOST ?? "127.0.0.1";
const DB_PATH = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";
const STATIC_DIR = process.env.PUBLIC_STATIC_DIR ?? "";
const CONFIG_PATH = process.env.EXCHANGE_CONFIG ?? "/etc/blockle/exchange.json";
/** Must match the reconciler's: they are the two halves of one agreement. */
/*
 * WITHDRAWALS MUST GO TO A PRE-APPROVED ADDRESS.
 *
 * Turned on by the 2026-11-25 audit, which found this false alongside
 * autoApprove:true and an empty approvalThreshold — so a stolen session could
 * send to an arbitrary address with no human and no second factor in the way.
 *
 * It only works paired with the 24h cooling-off period in withdrawals.ts: an
 * allowlist an attacker can add to and immediately draw from has cost them one
 * extra request. Adding an address needs the authenticator; removing one does
 * not, because removal only narrows what can be paid.
 */
const WD_REQUIRE_ALLOWLIST = true;

const TREASURY_FILE =
	process.env.TESTNET_TREASURY ?? "/etc/blockle/testnet-treasury.json";

/**
 * Assets offered to customers, DERIVED FROM THE MARKETS.
 *
 * Hand-maintained alongside the venue's market table, this list drifted: it
 * named eight assets while the venue traded six markets, so the front page
 * offered assets with nowhere to trade them and omitted ones it listed. An
 * asset is offered if and only if there is a market in it.
 */
const LISTED: readonly string[] = (() => {
	const seen = new Set<string>();
	for (const m of VENUE_MARKETS) {
		seen.add(m.base);
		seen.add(m.quote);
	}
	/*
	 * Quotes first — they are what people deposit to trade with — then the rest
	 * alphabetically, so the order is stable as assets are added.
	 *
	 * FROM QUOTE_SENIORITY, WHICH IS THE ONLY COPY OF THIS LIST. The literal
	 * `["USDT", "BLOCK"]` survived the quote expansion here, and because the
	 * asset SET is derived from VENUE_MARKETS the drift was invisible: nothing
	 * was missing, BTC/ETH/SOL/USDC just fell through to the alphabetical tail
	 * and sorted in among DINGO and PERBUG. So the asset pickers put the four
	 * biggest quotes behind the smallest coins on the venue, which is precisely
	 * the kind of harmless-looking sixth copy of a list that settlement.ts's
	 * header exists to argue against.
	 */
	const quotes: readonly string[] = QUOTE_SENIORITY.filter((q) => seen.has(q));
	const rest = [...seen].filter((a) => !quotes.includes(a)).sort();
	return [...quotes, ...rest];
})();

/** Markets, as pairs. The venue's own table; no second copy to drift. */
const MARKETS: readonly { base: string; quote: string }[] = VENUE_MARKETS.map(
	(m) => ({ base: m.base, quote: m.quote }),
);

const fmt = (b: bigint, d: number): string => format(b, { symbol: "", decimals: d });

interface GateConfig {
	mainnetEnabled: boolean;
	legalReviewCompleted: boolean;
}

/**
 * Read the live-or-not gate.
 *
 * FAILS CLOSED in every direction: a missing file, unreadable file, bad JSON,
 * or either flag absent all produce `false`. The only way to report "live" is
 * for both flags to be explicitly `true` in a file a human wrote.
 */
function gate(): GateConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
		const o = raw as Record<string, unknown>;
		return {
			mainnetEnabled: o.mainnetEnabled === true,
			legalReviewCompleted:
				(o.legalReview as Record<string, unknown> | undefined)?.completed === true,
		};
	} catch {
		return { mainnetEnabled: false, legalReviewCompleted: false };
	}
}

/**
 * Pending per-network commitments.
 *
 * Reads the withdrawal table if it exists. On a fresh install it does not, and
 * returning an empty map is correct — nothing is committed because nothing has
 * been requested. It must NOT throw, or the liquidity endpoint dies on day one.
 */
function commitmentsFrom(db: Database.Database): CommitmentSource {
	return {
		committedByNetwork(symbol: string): Map<string, bigint> {
			const out = new Map<string, bigint>();
			try {
				const rows = db
					.prepare(
						`SELECT network, amount FROM withdrawal
						  WHERE asset = ? AND state NOT IN
						        ('confirmed','rejected','failed')`,
					)
					.all(symbol) as { network: string | null; amount: string }[];
				for (const r of rows) {
					const id = r.network === null ? symbol : `${symbol}.${r.network}`;
					out.set(id, (out.get(id) ?? 0n) + BigInt(r.amount));
				}
			} catch (e) {
				// DISTINGUISH "no table yet" FROM "the query is broken".
				//
				// The previous version swallowed everything, and that hid a real
				// bug: the withdrawal table had no `network` column, so this threw
				// "no such column" on every call and silently reported ZERO
				// committed units. Liquidity then OVER-REPORTED availability — the
				// exact promising-the-same-coins-twice failure this design exists
				// to prevent, masked by a catch-all.
				//
				// An absent table is legitimate on a fresh install. Anything else
				// is a bug and must be loud.
				const msg = e instanceof Error ? e.message : String(e);
				if (!/no such table/i.test(msg)) {
					console.error(
						`committedByNetwork(${symbol}) FAILED: ${msg} — liquidity is ` +
							`OVER-REPORTING availability until this is fixed.`,
					);
				}
			}
			return out;
		},
	};
}

/** Assets halted by the reconciler. Read from a file the reconcile job writes. */
function haltsFrom(): HaltSource {
	const path = process.env.HALT_FILE ?? "/run/blockle/exchange-halts.json";
	try {
		const o = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
		return {
			halted: (s) => typeof o[s] === "string",
			reason: (s) => o[s] ?? "",
		};
	} catch {
		return NOTHING_HALTED;
	}
}

/*
 * WHO MAY READ THIS RESPONSE FROM ANOTHER ORIGIN.
 *
 * `world` sends `Access-Control-Allow-Origin: *`; `same-origin` sends no
 * Access-Control header at all. The parameter exists because this helper used
 * to send `*` UNCONDITIONALLY — on /v1 payloads, and on /v1 401s, which means
 * it was advertising customer balances as world-readable.
 *
 * WHAT THAT HEADER DID AND DID NOT PROTECT — CORRECTED.
 *
 * An earlier version of this comment claimed the blanket `*` was harmless
 * because a cross-origin browser request "could not attach a cookie ... each of
 * those needs a preflight". That reasoning is WRONG and it should not be
 * trusted by the next reader. A SIMPLE request needs no preflight at all: a
 * hostile page can
 *
 *     fetch("https://exchange.blockle.org/v1/orders", {
 *       method: "POST", credentials: "include",
 *       headers: { "Content-Type": "text/plain" }, body: "{...}" })
 *
 * and the browser sends it WITH the session cookie. CORS only stops the page
 * from READING the reply; the order would already have been placed. So the
 * missing ACAO header protects a read and protects nothing about a write.
 *
 * What actually stopped that write was never in this file: the accounts
 * service sets its session cookie SameSite=Lax (services/accounts/src/http.js,
 * `setCookie` default, used for SESSION_COOKIE in server.js), and Lax omits the
 * cookie from a cross-site POST. That is a real control, but it lived in a
 * different service, was named nowhere here, and no test pinned it — so adding
 * a second spelling of a mutating route (/rest/orders) rested on an attribute
 * this repo does not own.
 *
 * It no longer does: `crossSiteWrite()` below refuses any mutating request
 * whose Origin names a different site than its Host, in THIS process, for every
 * mount. The CORS labelling here is still correct and still worth keeping —
 * authenticated responses say nothing about cross-origin access and nothing
 * answers OPTIONS — but it is the read half of the problem, not the whole of it.
 */
export type Readers = "world" | "same-origin";

/**
 * HOW LONG A THROTTLED CALLER SHOULD WAIT, IN SECONDS.
 *
 * Derived from the per-key window in apikeys.ts rather than typed again here:
 * the limit is "N requests in a rolling 60s window", so the longest a caller
 * can need to wait for capacity is that window. Publishing a number that is not
 * the enforced one teaches a client to retry too early, which is how a
 * rate-limited client becomes a rate-limiting loop.
 */
export const RETRY_AFTER_SECONDS = Math.ceil(KEY_RATE_WINDOW_MS / 1000);

/**
 * THE HEADER SET FOR EVERY JSON RESPONSE THIS PROCESS WRITES.
 *
 * Split out of `jsonResponse` for one reason: it is the only way to TEST the
 * promises the /rest index publishes. The index says "rate limiting answers 429
 * with Retry-After, never 503" and "authenticated responses carry no
 * Access-Control header"; both are properties of this function, and both now
 * have a test (test/restapi.test.ts) that calls it directly.
 *
 * RETRY-AFTER IS ADDED BY CODE, NOT BY THE CALLER, AND THAT IS THE FIX.
 *
 * Before this, Retry-After was promised three times in restapi.ts and sent
 * nowhere: the helper wrote a fixed five-header set and every 429 in the
 * process — the per-key limit in apikeys.ts and the per-IP listing limit in
 * listings.ts — went out bare. A client built against the published contract
 * had nothing to honour, and a client that backs off only when told to backed
 * off not at all. Doing it here rather than at each call site means the next
 * 429 added to this service carries it without anybody remembering to, which is
 * the only version of this that stays true.
 *
 * A caller may still override it (`extra`) if it ever knows a better number;
 * the window length is the ceiling, not a guess.
 */
export function responseHeaders(
	code: number,
	bytes: number,
	maxAge: number,
	readers: Readers,
	extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
	return {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(bytes),
		"Cache-Control": `public, max-age=${maxAge}`,
		"X-Content-Type-Options": "nosniff",
		// Public market data is world-readable by design — publishing what the
		// venue holds without making anyone sign up first is the whole point of
		// the /public surface, and a page on another origin must be able to read
		// it. Account-scoped responses pass "same-origin" and get no such header.
		//
		// NOTE THAT THIS APPLIES TO A 429 TOO, on a world-readable route: a
		// cross-origin reader of /rest/markets that gets a throttle with no ACAO
		// sees an opaque network error, so it cannot tell "slow down" from "that
		// host is gone" and retries into the limit.
		...(readers === "world" ? { "Access-Control-Allow-Origin": "*" } : {}),
		...(code === 429 ? { "Retry-After": String(RETRY_AFTER_SECONDS) } : {}),
		...extra,
	};
}

function jsonResponse(
	res: ServerResponse,
	code: number,
	body: unknown,
	maxAge = 2,
	readers: Readers = "world",
	extra: Readonly<Record<string, string>> = {},
): void {
	const s = JSON.stringify(body);
	res.writeHead(code, responseHeaders(code, Buffer.byteLength(s), maxAge, readers, extra));
	res.end(s);
}

/**
 * Is this a mutating request from a DIFFERENT SITE than the one it is addressed
 * to? If so it is refused, and that is this service's own CSRF control.
 *
 * WHY THIS EXISTS. Every mutating route here is authenticated by a cookie the
 * browser attaches automatically. CORS does not stop a cross-site POST — a
 * simple request (text/plain, no custom headers) is sent without a preflight
 * and the reply is merely unreadable, so the side effect happens anyway. Until
 * this function, the only thing standing between a hostile page and
 * `POST /v1/orders` with a victim's session was the SameSite=Lax attribute set
 * by a different service in a different directory.
 *
 * THE RULE, and why it does not break anything:
 *   * No Origin header -> ALLOWED. Non-browser callers (the Flutter app, curl,
 *     an API-key integration, the payout runner) send none, and CSRF is not a
 *     thing that happens to them.
 *   * Origin host == Host header host -> ALLOWED. That is the site's own page;
 *     the front page, the sign-in page and the operator console are all served
 *     from the host they post to, and nginx passes `Host $host` through.
 *   * Anything else, including the literal "null" a sandboxed frame sends ->
 *     REFUSED with 403.
 *
 * Deliberately keyed on the HOST HEADER and not on a configured hostname:
 * exchange.blockle.org and admin.blockle.org both proxy to this process, and a
 * hard-coded name would have broken one of them or needed a list to rot.
 */
export function crossSiteWrite(
	method: string | undefined,
	origin: string | undefined,
	host: string | undefined,
): boolean {
	const m = (method ?? "GET").toUpperCase();
	if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
	if (origin === undefined || origin.trim() === "") return false;
	if (host === undefined || host.trim() === "") return true;
	let originHost: string;
	try {
		// `new URL("null")` throws, which is the answer we want for a sandboxed
		// frame: it is not this site, so it may not write here.
		originHost = new URL(origin.trim()).host.toLowerCase();
	} catch {
		return true;
	}
	return originHost !== host.trim().toLowerCase();
}

/**
 * THE PUBLIC FORM. Market data, the /rest index, and the static-path 404s.
 *
 * Kept as the bare name `json` so the ~thirty existing public call sites did
 * not have to be touched to add the distinction — but note that `venueRoute`
 * SHADOWS this name with the account-scoped form, on purpose. See the comment
 * there: inside that function the safe variant has to be the one you get by
 * default, because that is where a route added next year will be written.
 */
function json(res: ServerResponse, code: number, body: unknown, maxAge = 2): void {
	jsonResponse(res, code, body, maxAge, "world");
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
	// The coin pages and their sitemap. A sitemap served as octet-stream is a
	// sitemap a crawler ignores.
	".xml": "application/xml; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

/*
 * SINGLE-PAGE MOUNTS: A URL DIRECTORY THAT IS NOT A REAL DIRECTORY.
 *
 * The operator console is published at `/admin/` but its files are deployed
 * FLAT into the static root — there is no `admin/` directory on disk. The
 * mapping used to be a single special case for the document itself
 * (`/admin/` -> `/admin.html`) and nothing else, which is exactly the bug
 * this map exists to prevent:
 *
 *   admin.html says `<script src="admin.inline.js">`, the browser resolves
 *   that against the mount to `/admin/admin.inline.js`, and that resolved to
 *   `<STATIC_DIR>/admin/admin.inline.js` — a path that has never existed. The
 *   document returned 200 and its only script returned 404, so the console
 *   rendered its markup, ran no code, and sat on the static placeholder
 *   "checking session…" forever. Nothing was logged, because nothing failed
 *   server-side: a missing file is a correct 404.
 *
 * So a mount now covers the WHOLE subtree, not just its index. Any asset
 * requested under the mount also gets tried at the static root, which is
 * where a flat deploy actually puts it. Add a mount here and its assets work;
 * that is the property that was missing.
 *
 * The trailing slash in the key matters: the console fetches its API at the
 * RELATIVE path `api/`, so serving the page at `/admin` without the slash
 * would resolve that to `/api/` at the root.
 */
const PAGE_MOUNTS: Readonly<Record<string, string>> = {
	"/admin/": "/admin.html",
};

/**
 * The on-disk paths a URL may be served from, in priority order.
 *
 * Pure and exported so the mount rules are testable without a filesystem: the
 * bug above was a routing mistake, and a routing mistake is only provable at
 * the level that does the routing.
 */
export function staticCandidates(urlPath: string): readonly string[] {
	if (urlPath === "/") return ["/index.html"];

	for (const [mount, page] of Object.entries(PAGE_MOUNTS)) {
		// `/admin` and `/admin/` both mean the console's document.
		if (urlPath === mount || `${urlPath}/` === mount) return [page];
		if (!urlPath.startsWith(mount)) continue;
		const asset = urlPath.slice(mount.length);
		// Literal path first, so a real subdirectory still wins if one is ever
		// added; the flat-root fallback second. Traversal is not a concern
		// here — every candidate is normalised and containment-checked by the
		// caller before it is touched.
		return [urlPath, `/${asset}`];
	}

	/*
	 * EXTENSIONLESS URLS FOR THE COIN PAGES.
	 *
	 * `/coins` and `/trade/raptoreum-rtm` are the published, canonical links,
	 * so they have to resolve without a suffix — a `.html` on a link somebody
	 * has shared is a hosting decision that can never be taken back. They are
	 * generated as `<path>/index.html`, which is the one directory-index
	 * convention this serves, and ONLY for a path with no extension: anything
	 * that looks like a file must 404 rather than quietly becoming a directory
	 * lookup.
	 */
	return extname(urlPath) === ""
		? [urlPath, `${urlPath.replace(/\/$/, "")}/index.html`]
		: [urlPath];
}

async function serveStatic(
	req: IncomingMessage,
	res: ServerResponse,
	urlPath: string,
	status = 200,
): Promise<boolean> {
	if (STATIC_DIR === "") return false;
	const candidates = staticCandidates(urlPath);
	let file = "";
	for (const candidate of candidates) {
		const rel = normalize(candidate).replace(
			/^(\.\.[/\\])+/,
			"",
		);
		const path = join(STATIC_DIR, rel);
		// Containment check, not just normalize — this is what stops traversal.
		if (!path.startsWith(STATIC_DIR)) return false;
		if (!existsSync(path)) continue;
		if (!statSync(path).isFile()) continue;
		file = path;
		break;
	}
	if (file === "") return false;
	const st = statSync(file);

	/*
	 * CODE REVALIDATES; PICTURES DO NOT.
	 *
	 * This used to serve every non-HTML asset with `max-age=3600`, and that
	 * caused a real hour-long outage of its own: a broken coins.js was fixed,
	 * deployed, and verified by curl — and the browser kept running the old
	 * copy, because it had been told it could. Worse, the HTML is `no-cache`,
	 * so a reload can pair NEW markup with an HOUR-OLD script, which is a
	 * combination nobody tested.
	 *
	 * So the app's code — js, css, and the generated html — must be
	 * revalidated. With a validator that costs a 304 and a round trip, not a
	 * re-download. Images and the logo keep the long cache: they change when
	 * they are renamed.
	 */
	const ext = extname(file);
	const code = ext === ".html" || ext === ".js" || ext === ".css" || ext === ".xml";
	// Size and mtime together. Not a content hash — this has to be cheap on
	// every request, and the pair changes on any edit a deploy can make.
	const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
	const lastModified = st.mtime.toUTCString();

	const inm = req.headers["if-none-match"];
	const ims = req.headers["if-modified-since"];
	if (inm === etag || (inm === undefined && ims === lastModified)) {
		// 304 CARRIES NO BODY. Content-Length here would be a protocol error.
		res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
		res.end();
		return true;
	}

	res.writeHead(status, {
		"Content-Type": MIME[ext] ?? "application/octet-stream",
		"Content-Length": st.size,
		"Cache-Control": code ? "no-cache" : "public, max-age=3600",
		ETag: etag,
		"Last-Modified": lastModified,
		"X-Content-Type-Options": "nosniff",
	});
	try {
		await pipeline(createReadStream(file), res);
	} catch (e) {
		// A CLIENT THAT GOES AWAY MID-DOWNLOAD IS NOT AN ERROR. Browsers
		// abandon requests constantly — navigating away, reloading, cancelling
		// a stylesheet. Letting that propagate made every one of them a 500
		// attempt on a committed response, and so a process exit.
		const code = (e as { code?: string }).code;
		if (code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "EPIPE" && code !== "ECONNRESET") {
			console.error(`serving ${urlPath}: ${e instanceof Error ? e.message : String(e)}`);
		}
		res.destroy();
	}
	return true;
}

/** One header, or undefined. Node gives arrays for repeats; take the first. */
function header(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	const s = Array.isArray(v) ? v[0] : v;
	if (s === undefined) return undefined;
	const t = s.trim();
	return t === "" ? undefined : t;
}

/**
 * Read the body AS BYTES, with a hard cap so a huge POST cannot exhaust memory.
 *
 * Separate from parsing because AN API SIGNATURE COVERS THE EXACT BYTES. Parse
 * then re-serialise and the hash changes — key order, spacing, number
 * formatting — so every signed POST would fail for reasons the client could
 * not see. The raw string is what gets hashed and what gets parsed.
 */
async function rawBodyOf(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
	const chunks: Buffer[] = [];
	let n = 0;
	for await (const c of req) {
		n += (c as Buffer).length;
		if (n > limit) throw new VenueError("request body too large", 413);
		chunks.push(c as Buffer);
	}
	return n === 0 ? "" : Buffer.concat(chunks).toString("utf8");
}

/** Parse a body already read by `rawBodyOf`. An empty body is an empty object. */
function parseBody(raw: string): Record<string, unknown> {
	if (raw.trim() === "") return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			throw new VenueError("body must be a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch (e) {
		if (e instanceof VenueError) throw e;
		throw new VenueError("body is not valid JSON");
	}
}

/** Read and parse in one step, for routes that do not verify a signature. */
async function body(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
	return parseBody(await rawBodyOf(req, limit));
}

const str = (o: Record<string, unknown>, k: string): string => {
	const v = o[k];
	if (typeof v !== "string" || v.trim() === "") {
		throw new VenueError(`${k} is required`);
	}
	return v;
};

/**
 * THE TRADING SURFACE. The only part of this process that writes.
 *
 * Amounts arrive as DECIMAL STRINGS and are parsed with amount.ts, which
 * REFUSES precision it cannot represent rather than rounding. So an order for
 * "0.000000001 BTC" is rejected with an explanation instead of silently
 * becoming zero — the failure mode that would otherwise let someone place a
 * free order.
 */
async function venueRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	venue: Venue,
	ledger: Ledger,
	wd: Withdrawals,
	auth: BlockleAuth,
	liquidityOf: (symbol: string) => ReturnType<typeof assetLiquidity>,
	feeTable: typeof LIVE_FEES,
	gasPricing: GasPricing,
	mm: MarketMaker,
	deposits: Deposits,
	wdbForReads: Database.Database,
	provisionAddress:
		| ((userId: string, asset: string, network: string | undefined) => Promise<void>)
		| undefined,
	apiKeys: ApiKeys,
	userTotp: UserTotp,
	/**
	 * Can this chain pay its own gas right now?
	 *
	 * Injected rather than imported so this function does not need the gas
	 * schema. Absent means "do not gate on gas", which is the old behaviour and
	 * is what the tests use.
	 */
	gasReadyFor:
		| ((asset: string, network: string | undefined) =>
			{ ok: true } | { ok: false; reason: string })
		| undefined,
	/**
	 * THE MOUNT THIS REQUEST ARRIVED ON — "/v1", or "/rest" for the documented
	 * alias (restapi.ts). Only its LENGTH is used, to find the route tail.
	 *
	 * Why a mount and not a rewritten URL. An API-key signature covers
	 * `url.pathname + url.search` exactly as sent (apikeys.ts), so rewriting
	 * /rest/balances to /v1/balances before authenticating would invalidate
	 * every signature a client could possibly produce: the client signs what it
	 * sends and the server verifies what it received. Rewriting the URL here
	 * would have made every key-authenticated /rest call a 401 with a message
	 * about a bad signature — a failure that looks like a client bug and is not
	 * one. So the URL object is untouched and only the prefix length varies.
	 */
	mount: "/v1" | "/rest" = "/v1",
): Promise<void> {
	const p = url.pathname.slice(mount.length);

	/*
	 * EVERY RESPONSE FROM THIS FUNCTION IS ACCOUNT-SCOPED, SO NONE OF THEM
	 * CARRIES A CORS HEADER — AND `json` IS SHADOWED HERE TO MAKE THAT THE
	 * DEFAULT RATHER THAN A THING TO REMEMBER.
	 *
	 * Deliberately the same name as the module-level helper. A route added to
	 * this 800-line function tomorrow will write `json(res, 200, …)` without
	 * thinking about it, and it must get the variant that does NOT advertise a
	 * customer's balances as world-readable. Naming it something else would
	 * mean the safe call needed to be chosen, and the unsafe one would be one
	 * autocompletion away.
	 *
	 * This covers the catch block at the bottom too, which matters: a 401 body
	 * marked `Access-Control-Allow-Origin: *` is how a cross-origin probe
	 * learns an endpoint exists and what it is called.
	 */
	const json = (
		r: ServerResponse,
		code: number,
		b: unknown,
		maxAge = 2,
	): void => jsonResponse(r, code, b, maxAge, "same-origin");

	/*
	 * IDENTITY IS THE BLOCKLE ACCOUNT, NOT A VENUE ACCOUNT.
	 *
	 * The venue grew its own register/login/sessions, and it worked, and it was
	 * wrong: two account systems on one brand means two places to reset a
	 * password, two 2FA enrolments, and an account that holds your BLOCK which
	 * is not the account that trades it. Those endpoints are gone. The session
	 * cookie is scoped to .blockle.org, which this host is inside, so the
	 * browser sends it with no extra work and this service forwards it to the
	 * accounts service and believes the answer.
	 *
	 * An unreachable accounts service is a 503, never an anonymous session —
	 * see blockleauth.ts.
	 */
	const cached = new Map<string, string>();

	/*
	 * READ ONCE, BEFORE ANYTHING ELSE. A signature covers the exact bytes, and
	 * the stream can only be consumed once, so the raw body is captured here
	 * and the routes parse that string instead of re-reading the request.
	 */
	const rawBody = await rawBodyOf(req);

	/**
	 * Who is calling: a browser session, or a signed API key.
	 *
	 * `need` is the scope a KEY must hold. A browser session is not scoped —
	 * it is a person on the site with their own second factor available — so
	 * the parameter only constrains programmatic callers.
	 *
	 * SESSION FIRST, because that is the common case and costs one cached
	 * lookup. A request carrying API-key headers is treated as an API request
	 * outright rather than falling back to the session: a bot whose signature
	 * is wrong must see the signature error, not silently succeed because a
	 * cookie happened to be present.
	 */
	const caller = async (need: Scope = "read"): Promise<string> => {
		const keyId = header(req, "x-blockle-key");
		if (keyId !== undefined) {
			const signature = header(req, "x-blockle-signature");
			const timestamp = header(req, "x-blockle-timestamp");
			if (signature === undefined || timestamp === undefined) {
				throw new ApiKeyError(
					"an API request needs X-Blockle-Key, X-Blockle-Timestamp and " +
						"X-Blockle-Signature",
				);
			}
			const r = apiKeys.authenticate({
				keyId,
				signature,
				timestamp,
				method: req.method ?? "GET",
				// THE PATH AS SIGNED INCLUDES THE QUERY STRING, because the query
				// is part of what the request does — a signature over the path
				// alone could be moved onto a different market or amount.
				path: url.pathname + (url.search === "" ? "" : url.search),
				body: rawBody,
				need,
			});
			return r.userId;
		}
		const cookie = req.headers.cookie ?? "";
		// The native apps send the accounts session as a Bearer token, because a
		// SameSite=Lax cookie does not ride a cross-site fetch from a phone.
		const authz = header(req, "authorization") ?? "";
		// Cache per CREDENTIAL, not per cookie: keying on the cookie alone would
		// let two bearer callers with no cookie share one entry and resolve to
		// each other's account.
		const ck = `${cookie}\u0000${authz}`;
		const hit = cached.get(ck);
		if (hit !== undefined) return hit;
		const u = await auth.whoami(cookie, authz);
		cached.set(ck, u.id);
		return u.id;
	};
	const me = async (): Promise<string> => caller("read");

	/**
	 * A BROWSER SESSION, AND NOTHING ELSE. For the routes an API key must never
	 * reach: withdrawals, and creating or revoking keys.
	 *
	 * Key management is on this list because a key that can mint keys is a key
	 * that can escalate itself — the scope list would stop it granting
	 * withdrawal, but it could still hand out trading access that the owner
	 * never sees in their key list until they look.
	 */
	const sessionOnly = async (what: string): Promise<string> => {
		if (header(req, "x-blockle-key") !== undefined) {
			throw new ApiKeyError(
				`an API key cannot ${what}. Sign in at exchange.blockle.org and do ` +
					"this from the site; API keys are limited to reading and trading " +
					"on purpose, so a leaked key cannot move money or create more keys.",
				403,
			);
		}
		const u = await auth.whoami(
			req.headers.cookie ?? "",
			header(req, "authorization") ?? "",
		);
		return u.id;
	};

	try {
		if (p === "/me" && req.method === "GET") {
			const u = await auth.whoami(
				req.headers.cookie ?? "",
				header(req, "authorization") ?? "",
			);
			json(res, 200, {
				accountId: u.id,
				email: u.email ?? null,
				twoFactor: u.twoFactor ?? null,
			}, 0);
			return;
		}

		if (p === "/balances" && req.method === "GET") {
			const who = await me();
			json(res, 200, venue.balances(who).map((b) => ({
				asset: b.asset,
				// THREE FIGURES, NOT ONE. "available" alone cannot explain why a
				// visible balance will not place an order; "reserved" is the
				// answer, and the balances screen shows it beside the total.
				total: fmt(b.total, b.decimals),
				reserved: fmt(b.reserved, b.decimals),
				available: fmt(b.available, b.decimals),
				decimals: b.decimals,
			})), 0);
			return;
		}

		// DEPOSIT ADDRESS. Returns an address or an explanation, never a guess —
		// a deposit to a wrong address is unrecoverable by anyone. See
		// deposits.ts.
		/*
		 * EVERY DEPOSIT ADDRESS AT ONCE, PROVISIONED ON SIGHT.
		 *
		 * The single-asset route below is still there and still the one the
		 * deposit screen uses when someone picks a chain. This exists because a
		 * customer should not have to discover that their account HAS a Bitcoin
		 * address by hunting for the right dropdown: the account page asks once
		 * and shows them all.
		 *
		 * THREE THINGS IT WILL NOT DO:
		 *
		 *   - It will not skip a closed chain silently. A chain whose gas float
		 *     is empty comes back with `address: null` and the reason, because
		 *     "no address shown" and "this chain is shut" look identical on a
		 *     screen and only one of them is worth waiting out.
		 *   - It will not let one chain's failure empty the list. Each entry is
		 *     resolved independently; a BitGo timeout on Solana must not hide
		 *     the Bitcoin address that already exists.
		 *   - It will not invent an address. Provisioning that throws leaves
		 *     `address: null` with the error, exactly like the single route —
		 *     showing an address we are not certain of is the one outcome that
		 *     loses money irrecoverably.
		 */
		if (p === "/deposit-addresses" && req.method === "GET") {
			const who = await me();
			const addresses = await listDepositAddresses({
				deposits,
				userId: who,
				assets: LISTED,
				networksFor: (asset) => assetDef(asset).networks.map((n) => n.id),
				...(gasReadyFor === undefined ? {} : { gasReady: gasReadyFor }),
				...(provisionAddress === undefined
					? {}
					: { provision: (asset, net) => provisionAddress(who, asset, net) }),
				onError: (asset, net, error) => {
					console.error(
						`deposit-addresses ${who} ${asset}${net === undefined ? "" : "." + net}: ${error}`,
					);
				},
			});
			json(res, 200, {
				addresses,
				note:
					"One address per chain, issued to this account and reused forever. " +
					"Send only the named asset on the named chain: a transfer on the " +
					"wrong chain cannot be recovered by anyone.",
			}, 0);
			return;
		}

		if (p === "/deposit-address" && req.method === "GET") {
			const who = await me();
			const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
			const netRaw = url.searchParams.get("network");
			const net = netRaw === null || netRaw === "" ? undefined : netRaw;

			/*
			 * ISSUED ON DEMAND, ONCE.
			 *
			 * A receive address on the pooled wallet, created the first time
			 * this customer asks for this chain and then reused forever —
			 * `Deposits.provision` refuses to replace an existing one, so a
			 * reload or a double-click cannot orphan coins already on their way
			 * to the old address.
			 *
			 * If provisioning fails we fall through to `describeDeposit`, which
			 * explains that no address exists and names a chain that works.
			 * Showing an address we are not certain of is the one outcome that
			 * loses money irrecoverably, so a failure here is a refusal, never
			 * a guess.
			 */
			/*
			 * A CHAIN THAT CANNOT PAY ITS GAS DOES NOT TAKE DEPOSITS.
			 *
			 * The withdrawal side has always refused when the gas float is
			 * empty, which protects the venue from accepting a payout it cannot
			 * send. On its own that is only half the control: issuing a deposit
			 * address for the same chain invites a customer to hand over coins
			 * that then cannot leave. The money is not lost, but it is STRANDED,
			 * and "we are holding your USDT and cannot return it until we fund
			 * an ETH float" is not a position to put a customer in.
			 *
			 * So deposits close with withdrawals, per chain, automatically. That
			 * is what lets the venue open before every gas float is funded: the
			 * gasless chains are simply shut, and they open by themselves the
			 * moment a float arrives.
			 *
			 * An EXISTING address is still returned — someone who already
			 * deposited must be able to see where their coins went.
			 */
			if (gasReadyFor !== undefined && deposits.addressFor(who, asset, net) === undefined) {
				const g = gasReadyFor(asset, net);
				if (!g.ok) {
					json(res, 200, {
						asset,
						network: net ?? null,
						address: null,
						reason:
							`${asset}${net === undefined ? "" : ` on ${net}`} deposits are ` +
							`closed until we can pay that chain's network fee. ${g.reason} ` +
							"We will not hold coins we cannot send back. Another chain for " +
							"the same asset may be open.",
					}, 0);
					return;
				}
			}

			if (
				provisionAddress !== undefined &&
				deposits.addressFor(who, asset, net) === undefined
			) {
				try {
					await provisionAddress(who, asset, net);
				} catch (e) {
					console.error(
						`deposit address for ${who} ${asset}${net === undefined ? "" : "." + net}: ` +
							`${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}

			json(res, 200, describeDeposit(deposits, who, asset, net), 0);
			return;
		}

		// A customer's deposits in flight. This is what makes "where is my
		// deposit" answerable without an operator: a transfer appears here from
		// the first time the custodian mentions it, with how many
		// confirmations it still needs.
		if (p === "/deposits" && req.method === "GET") {
			const who = await me();
			json(res, 200, { deposits: depositsFor(wdbForReads, who) }, 0);
			return;
		}

		/*
		 * THE TESTNET FAUCET IS GONE.
		 *
		 * Removed on the way to mainnet (2026-11-25). It credited CUSTODY as well
		 * as the customer — it has to, or the ledger's invariant fails — so every
		 * click created a liability backed by coins no custodian held. On this box
		 * an authenticated scanner called it 139 times and minted 1,390,000,000,000
		 * base units of USDT the venue did not have; those were reversed with
		 * CORRECTION entries, and the route that made them possible is now deleted
		 * rather than merely gated.
		 *
		 * `Venue.testnetCredit` survives for the test suite, which uses it to fund
		 * accounts, and keeps its own refusals (mainnet gate, live custodian, and
		 * the declared-treasury ceiling). Nothing reachable over HTTP calls it.
		 */

		if (p === "/orders" && req.method === "POST") {
			const who = await caller("trade");
			const b = parseBody(rawBody);
			const m = VENUE_MARKETS.find((x) => x.symbol === str(b, "market"));
			if (m === undefined) throw new VenueError("unknown market", 404);
			const side = str(b, "side");
			if (side !== "buy" && side !== "sell") {
				throw new VenueError('side must be "buy" or "sell"');
			}
			const bd = assetDef(m.base).decimals;
			// A PRICE SCALES BY priceScale(m), NOT BY THE QUOTE'S DECIMALS. On a
			// market with priceDecimals the two differ, and using the quote's
			// alone would place this order at 10^priceDecimals times the wrong
			// price without raising anything. See priceScale.
			const ps = priceScale(m);
			const r = venue.placeOrder({
				accountId: who,
				market: m.symbol,
				side,
				price: parse(str(b, "price"), { symbol: m.quote, decimals: ps }),
				baseAmount: parse(str(b, "amount"), { symbol: m.base, decimals: bd }),
			});
			json(res, 200, {
				id: r.order.id,
				state: r.order.state,
				fills: r.fills,
				filled: fmt(r.order.baseFilled, bd),
				total: fmt(r.order.baseTotal, bd),
			}, 0);
			return;
		}

		if (p === "/orders" && req.method === "GET") {
			const who = await me();
			json(res, 200, venue.myOrders(who).map((o) => {
				const m = VENUE_MARKETS.find((x) => x.symbol === o.market)!;
				const bd = assetDef(m.base).decimals;
				return {
					id: o.id, market: o.market, side: o.side, state: o.state,
					price: fmt(o.price, priceScale(m)),
					filled: fmt(o.baseFilled, bd),
					total: fmt(o.baseTotal, bd),
					createdAt: o.createdAt,
				};
			}), 0);
			return;
		}

		// ---- withdrawals --------------------------------------------------
		//
		// GET returns the NETWORK CHOICES WITH LIVE AVAILABILITY, because the
		// honest moment to tell someone a chain cannot pay them is before they
		// pick it, not after they commit.
		if (p === "/withdrawal-options" && req.method === "GET") {
			await me();
			const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
			const def = assetDef(asset);
			const liq = liquidityOf(asset);
			json(res, 200, {
				asset,
				decimals: def.decimals,
				networks: liq.networks.map((n) => ({
					network: n.network,
					// A CALLER THAT SEES THIS MUST SEND NO NETWORK. See the field's
					// comment in liquidity.ts: `network` is a label for a
					// single-chain asset, not a chain id, and passing it back is
					// what broke deposit-address issuance for every such asset.
					native: n.native,
					label: n.label,
					available: fmt(n.available, def.decimals),
					open: n.open,
					...(n.closedReason !== undefined ? { note: n.closedReason } : {}),
				})),
				maxSingleWithdrawal: fmt(liq.maxSingleWithdrawal, def.decimals),
			}, 0);
			return;
		}

		// QUOTE BEFORE COMMITTING. The ticket needs the exact fee, the exact
		// net, and the rate it was priced at — computed by the SAME function
		// that prices the real withdrawal, because a preview computed by
		// different code is a preview that will eventually disagree.
		if (p === "/withdrawal-quote" && req.method === "GET") {
			await me();
			const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
			const def = assetDef(asset);
			const network = url.searchParams.get("network");
			const amount = parse(url.searchParams.get("amount") ?? "0", {
				symbol: asset,
				decimals: def.decimals,
			});
			const q = quoteWithdrawal({
				asset,
				network: network === null || network === "" ? undefined : network,
				amount,
				table: feeTable,
				pricing: gasPricing,
			});
			json(res, 200, {
				asset: q.asset,
				network: q.network ?? null,
				amount: q.display.amount,
				fee: q.display.fee,
				youReceive: q.display.net,
				minimum: q.display.minimum,
				gasAsset: q.gasAsset,
				note: q.display.note,
				...(q.rateUsed === undefined
					? {}
					: { pricedAt: q.rateUsed.price, priceSource: q.rateUsed.source }),
			}, 0);
			return;
		}

		if (p === "/withdrawals" && req.method === "POST") {
			// A KEY CANNOT REACH THIS ROUTE AT ALL. apikeys.ts has no withdrawal
			// scope to grant, so `who()` would already refuse; this is the second
			// lock, on the route itself, because the consequence of one mistake
			// here is a stolen key emptying an account. Moving money needs the
			// person, their session and their second factor.
			const who = await sessionOnly("withdraw");
			/*
			 * A SECOND FACTOR, ON THIS REQUEST.
			 *
			 * Not session-level: one code must not buy a window in which an
			 * unattended session can keep withdrawing. Same rule the admin console
			 * has always applied to its own mutations, and the header — rather than
			 * the body — so that it is required identically by any route added
			 * later. See usertotp.ts for why "not enrolled" is a refusal.
			 */
			userTotp.requireCode(who, header(req, "x-blockle-totp"), "a withdrawal");
			const b = parseBody(rawBody);
			const asset = str(b, "asset").toUpperCase();
			const def = assetDef(asset);
			const amount = parse(str(b, "amount"), { symbol: asset, decimals: def.decimals });
			const network = typeof b.network === "string" && b.network !== ""
				? b.network
				: undefined;

			const w = wd.request({
				userId: who,
				asset,
				...(network !== undefined ? { network } : {}),
				amount,
				address: str(b, "address"),
				// Keyed on the customer's own request so a double-click is one
				// withdrawal rather than two.
				idempotencyKey: str(b, "requestId"),
				// THE LIQUIDITY GATE. Checked before the debit, so a chain that
				// cannot pay refuses up front instead of stranding funds in
				// INFLIGHT while someone works out why.
				checkLiquidity: (a, net, amt) => {
					const r = canPay(liquidityOf(a), net ?? a, amt);
					return r.ok ? { ok: true } : { ok: false, reason: r.reason };
				},
			});
			json(res, 200, {
				id: w.id,
				state: w.state,
				asset: w.asset,
				network: w.network ?? null,
				amount: fmt(w.amount, def.decimals),
				fee: fmt(w.fee, def.decimals),
				youReceive: fmt(w.net, def.decimals),
				address: w.address,
			}, 0);
			return;
		}

		if (p === "/withdrawals" && req.method === "GET") {
			const who = await me();
			json(res, 200, wd.pending()
				.filter((w) => w.userId === who)
				.map((w) => ({
					id: w.id, asset: w.asset, network: w.network ?? null,
					amount: fmt(w.amount, assetDef(w.asset).decimals),
					fee: fmt(w.fee, assetDef(w.asset).decimals),
					youReceive: fmt(w.net, assetDef(w.asset).decimals),
					address: w.address, state: w.state,
					reason: w.reason ?? null, createdAt: w.createdAt,
				})), 0);
			return;
		}

		// ---- liquidity (market-maker ladders) -----------------------------
		//
		// "Add liquidity" on an order book is a ladder of resting orders, not a
		// pool. See mm.ts — and note that a maker here PAYS the 0.20% fee on
		// both legs, so the quote carries the break-even and the UI has to show
		// it rather than implying makers earn a rebate they do not get.
		if (p === "/liquidity/quote" && req.method === "GET") {
			await me();
			const symbol = url.searchParams.get("market") ?? "";
			const m = marketDef(symbol);
			const bd = assetDef(m.base).decimals;
			// `qd` is for quote AMOUNTS (the capital, the total needed); `ps` is
			// for PRICES (the mid, every rung). On a priceDecimals market they
			// are different numbers and swapping them misprices the ladder.
			const qd = assetDef(m.quote).decimals;
			const ps = priceScale(m);
			const q = mmQuote({
				market: symbol,
				mid: parse(url.searchParams.get("mid") ?? "0", { symbol: m.quote, decimals: ps }),
				spreadBps: Number(url.searchParams.get("spreadBps") ?? "0"),
				rungs: Number(url.searchParams.get("rungs") ?? "0"),
				baseCapital: parse(url.searchParams.get("base") ?? "0", { symbol: m.base, decimals: bd }),
				quoteCapital: parse(url.searchParams.get("quote") ?? "0", { symbol: m.quote, decimals: qd }),
			});
			json(res, 200, {
				market: symbol,
				breakEvenBps: q.breakEvenBps,
				loses: q.loses,
				note: q.note,
				baseNeeded: fmt(q.baseNeeded, bd),
				quoteNeeded: fmt(q.quoteNeeded, qd),
				bids: q.bids.map((b) => ({ price: fmt(b.price, ps), amount: fmt(b.base, bd) })),
				asks: q.asks.map((a) => ({ price: fmt(a.price, ps), amount: fmt(a.base, bd) })),
			}, 0);
			return;
		}

		if (p === "/liquidity" && req.method === "GET") {
			const who = await me();
			json(res, 200, mm.list(who).map((pos) => {
				const m = marketDef(pos.market);
				const bd = assetDef(m.base).decimals;
				return {
					id: pos.id,
					market: pos.market,
					state: pos.state,
					// A price, so it scales by priceScale and not by the quote.
					mid: fmt(pos.mid, priceScale(m)),
					spreadBps: pos.spreadBps,
					rungs: pos.rungs,
					orders: pos.orderIds.length,
					filled: fmt(pos.filledBase, bd),
					resting: fmt(pos.restingBase, bd),
					createdAt: pos.createdAt,
				};
			}), 0);
			return;
		}

		if (p === "/liquidity" && req.method === "POST") {
			const who = await caller("trade");
			const b = parseBody(rawBody);
			const symbol = str(b, "market");
			const m = marketDef(symbol);
			const bd = assetDef(m.base).decimals;
			const qd = assetDef(m.quote).decimals;
			const r = mm.open({
				accountId: who,
				market: symbol,
				// The mid is a PRICE; the capital below is an AMOUNT. Same asset,
				// two different scales on a priceDecimals market.
				mid: parse(str(b, "mid"), { symbol: m.quote, decimals: priceScale(m) }),
				spreadBps: Number(b.spreadBps),
				rungs: Number(b.rungs),
				baseCapital: parse(
					typeof b.base === "string" && b.base !== "" ? b.base : "0",
					{ symbol: m.base, decimals: bd },
				),
				quoteCapital: parse(
					typeof b.quote === "string" && b.quote !== "" ? b.quote : "0",
					{ symbol: m.quote, decimals: qd },
				),
				// EXPLICIT, and only ever set by the user ticking the box after
				// reading the break-even. Never defaulted true.
				acceptLoss: b.acceptLoss === true,
			});
			json(res, 200, {
				id: r.position.id,
				orders: r.position.orderIds.length,
				loses: r.quote.loses,
				note: r.quote.note,
			}, 0);
			return;
		}

		const closePos = /^\/liquidity\/(mm_[a-f0-9]+)\/close$/.exec(p);
		if (closePos !== null && req.method === "POST") {
			const who = await caller("trade");
			const r = mm.close(who, closePos[1]!);
			json(res, 200, {
				cancelled: r.cancelled,
				// Named rather than hidden: a ladder that did its job is mostly
				// filled, and those fills are real trades that are NOT undone.
				alreadyFilledOrGone: r.alreadyGone,
			}, 0);
			return;
		}

		// ---- programmatic trading keys ------------------------------------
		//
		// Session-only, all three. See `sessionOnly` for why minting keys is on
		// that list.
		// ---- withdrawal address allowlist ----------------------------------
		//
		// ADDING AN ADDRESS IS A MONEY CONTROL, so it needs the second factor
		// for exactly the reason replacing an authenticator does: if a session
		// alone could add a destination, an attacker holding one would add their
		// own and the allowlist would have cost them a single extra request.
		//
		// REMOVING needs no code. Removal only ever narrows what can be paid, and
		// a control that is hard to loosen but easy to tighten is the right way
		// round. A customer who suspects trouble should not be hunting for their
		// phone to take an address OFF the list.

		if (p === "/allowlist" && req.method === "GET") {
			const owner = await sessionOnly("read your withdrawal addresses");
			json(res, 200, {
				addresses: wd.listAllowlist(owner),
				cooldownHours: 24,
				required: WD_REQUIRE_ALLOWLIST,
				note:
					"A new address becomes usable 24 hours after you add it. That " +
					"delay is deliberate: it is what stops someone who has taken " +
					"over your session from adding their own address and emptying " +
					"the account before you notice.",
			}, 0);
			return;
		}

		if (p === "/allowlist" && req.method === "POST") {
			const owner = await sessionOnly("add a withdrawal address");
			const b = parseBody(rawBody);
			userTotp.requireCode(
				owner, header(req, "x-blockle-totp"), "adding a withdrawal address",
			);
			const asset = str(b, "asset").toUpperCase();
			if (asset !== settlementAsset(asset)) {
				throw new VenueError(
					"asset must be a settlement symbol with no network suffix",
				);
			}
			assetDef(asset);                       // rejects an unknown asset
			const address = str(b, "address").trim();
			if (address === "") throw new VenueError("an address is required");
			// Bounded: this is stored and echoed back, and no chain this venue
			// lists has an address anywhere near this long.
			if (address.length > 128) throw new VenueError("that address is too long");
			wd.allowlist(owner, asset, address);
			const st = wd.allowlistStatus(owner, asset, address);
			json(res, 200, {
				ok: true,
				asset,
				address,
				usableAt:
					st.usableAt === undefined ? null : new Date(st.usableAt).toISOString(),
			}, 0);
			return;
		}

		if (p === "/allowlist/remove" && req.method === "POST") {
			const owner = await sessionOnly("remove a withdrawal address");
			const b = parseBody(rawBody);
			const asset = str(b, "asset").toUpperCase();
			const removed = wd.removeFromAllowlist(owner, asset, str(b, "address").trim());
			json(res, 200, { ok: true, removed }, 0);
			return;
		}

		// ---- second factor ------------------------------------------------
		//
		// SESSION-ONLY, all of them, for the same reason key management is: an API
		// key that could enrol or replace the factor guarding withdrawals would be
		// a key that escalates itself past the control designed to stop it.

		if (p === "/2fa" && req.method === "GET") {
			const owner = await sessionOnly("read second-factor status");
			json(res, 200, { enrolled: userTotp.enrolled(owner) }, 0);
			return;
		}

		if (p === "/2fa/begin" && req.method === "POST") {
			const owner = await sessionOnly("set up a second factor");
			const b = parseBody(rawBody);
			const r = userTotp.begin({
				accountId: owner,
				issuer: "Blockle Exchange",
				account: owner,
				// Only consulted when one is already confirmed — replacing a live
				// authenticator requires proving you hold it.
				...(typeof b.currentCode === "string" ? { currentCode: b.currentCode } : {}),
			});
			// THE SECRET IS SHOWN EXACTLY ONCE, here, and never stored client-side.
			// maxAge 0 so no cache keeps a copy.
			json(res, 200, {
				secret: r.secret,
				uri: r.uri,
				note:
					"Scan this with an authenticator app, then confirm a code to arm it. " +
					"Until you confirm, it is not protecting anything.",
			}, 0);
			return;
		}

		if (p === "/2fa/confirm" && req.method === "POST") {
			const owner = await sessionOnly("confirm a second factor");
			const b = parseBody(rawBody);
			userTotp.confirm(owner, str(b, "code"));
			json(res, 200, { ok: true, enrolled: true }, 0);
			return;
		}

		if (p === "/2fa/disable" && req.method === "POST") {
			const owner = await sessionOnly("turn off a second factor");
			const b = parseBody(rawBody);
			userTotp.disable(owner, str(b, "code"));
			json(res, 200, { ok: true, enrolled: false }, 0);
			return;
		}

		if (p === "/api-keys" && req.method === "GET") {
			const owner = await sessionOnly("list API keys");
			json(res, 200, {
				keys: apiKeys.list(owner).map((k) => ({
					keyId: k.keyId,
					label: k.label,
					scopes: k.scopes,
					ratePerMin: k.ratePerMin,
					createdAt: k.createdAt,
					lastUsedAt: k.lastUsedAt,
					revokedAt: k.revokedAt,
				})),
				// The client needs these to sign, and reading them from the server
				// means the page and the verifier cannot drift apart.
				signing: {
					algorithm: SIGNING_ALGORITHM,
					skewMs: SKEW_MS,
					stringToSign: "timestamp + METHOD + path + sha256hex(body)",
					headers: {
						key: "X-Blockle-Key",
						timestamp: "X-Blockle-Timestamp",
						signature: "X-Blockle-Signature",
					},
					scopes: SCOPES,
					// Said out loud on the endpoint that lists keys, not just in
					// the docs, so nobody writes a withdrawal bot and finds out
					// later.
					cannotWithdraw: true,
				},
			}, 0);
			return;
		}

		if (p === "/api-keys" && req.method === "POST") {
			const owner = await sessionOnly("create an API key");
			const b = parseBody(rawBody);
			const scopes = Array.isArray(b.scopes)
				? b.scopes.map((x) => String(x))
				: ["read"];
			const made = apiKeys.create({
				userId: owner,
				label: str(b, "label"),
				scopes,
				...(typeof b.ratePerMin === "number" ? { ratePerMin: b.ratePerMin } : {}),
			});
			json(res, 200, {
				keyId: made.keyId,
				// SHOWN ONCE. Not retrievable afterwards, and the UI says so
				// before the dialog can be dismissed.
				secret: made.secret,
				scopes: made.key.scopes,
				ratePerMin: made.key.ratePerMin,
				warning:
					"This is the only time the secret is shown. Store it somewhere " +
					"your bot can read and nobody else can.",
			}, 0);
			return;
		}

		const revokeKey = /^\/api-keys\/(bk_[a-z0-9]+)$/.exec(p);
		if (revokeKey !== null && req.method === "DELETE") {
			const owner = await sessionOnly("revoke an API key");
			apiKeys.revoke(owner, revokeKey[1]!);
			json(res, 200, { ok: true, revoked: revokeKey[1] }, 0);
			return;
		}

		/*
		 * `[^/]+`, NOT `[A-Za-z0-9_]+` — same shape-vs-value rule as /book and
		 * /trades. The /rest catalogue matches `{id}` as one whole segment, so a
		 * stricter pattern here leaves a band of ids that the published route
		 * accepts and no handler claims, which answered a flat 404 "not found"
		 * instead of the documented refusal. `cancelOrder` looks the id up with
		 * a bound parameter and answers 404 "no such order" for anything it does
		 * not hold, which is both safe and the right error.
		 */
		const cancel = /^\/orders\/([^/]+)\/cancel$/.exec(p);
		if (cancel !== null && req.method === "POST") {
			const who = await caller("trade");
			json(res, 200, { state: venue.cancelOrder(who, cancel[1]!).state }, 0);
			return;
		}

		json(res, 404, { error: "not found" });
	} catch (e) {
		// AN AUTH FAILURE KEEPS ITS OWN STATUS. Flattening a 401 to a 400 makes
		// the UI unable to tell "sign in" from "that order was invalid", and
		// flattening the 503 from an unreachable accounts service would send
		// customers round a sign-in loop that cannot succeed.
		// TwoFactorError belongs here for exactly the reason above: its 403 ("you
		// have no authenticator, go and enrol one") and its 401 ("that code is
		// wrong or spent") are different instructions to the customer, and a 400
		// would tell them neither.
		if (
			e instanceof AuthError ||
			e instanceof VenueError ||
			e instanceof ApiKeyError ||
			e instanceof TwoFactorError
		) {
			json(res, e.status, { error: e.message }, 0);
			return;
		}
		// Anything else: report the message, not a stack. A stack on a public
		// endpoint leaks paths and dependency versions.
		json(res, 400, { error: e instanceof Error ? e.message : String(e) }, 0);
	}
}

export function start(): void {
	// READ-ONLY at the SQLite level. A handler that tried to write would fail
	// rather than succeed, which is a stronger guarantee than "we only wrote
	// GET handlers".
	//
	// `fileMustExist: false` would create an empty database; we want a clear
	// failure instead if the path is wrong, but we also must not crash-loop
	// before the ledger exists, so absence is handled explicitly.
	// ORDER MATTERS HERE, and getting it wrong makes the public dashboard
	// silently empty forever.
	//
	// The first version opened the READ-ONLY handle first, guarded by
	// existsSync(DB_PATH). On a fresh install the file does not exist yet, so
	// `ledger` stayed undefined — and /public/reserves and /public/liquidity
	// then returned `{assets: []}` for the lifetime of the process, even after
	// the venue created the database and real trades settled into it. The
	// symptom was a reserves panel that stayed blank while trading worked
	// perfectly, which is the worst kind of bug on a transparency page: it
	// looks like the venue has nothing to disclose.
	//
	// So the WRITABLE handle is opened first — that creates the file and the
	// schema — and the read-only handle is opened against a database that is
	// then guaranteed to exist.
	const wdb0 = new Database(DB_PATH);
	wdb0.pragma("journal_mode = WAL");
	wdb0.pragma("busy_timeout = 5000");
	// Constructing a Ledger applies its schema, so the read-only handle below
	// finds the tables it needs.
	new Ledger(wdb0);

	const db: Database.Database = new Database(DB_PATH, {
		readonly: true,
		fileMustExist: true,
	});
	const ledger: Ledger | undefined = new Ledger(db);

	const commitments = db !== undefined ? commitmentsFrom(db) : { committedByNetwork: () => new Map<string, bigint>() };

	// THE VENUE NEEDS A SEPARATE, WRITABLE HANDLE.
	//
	// The public read path above is deliberately read-only so a bug there
	// cannot write. Trading must write, so it gets its own connection rather
	// than relaxing that guarantee for every handler in the process.
	//
	// WAL mode so readers and the writer do not block each other: the public
	// endpoints are polled every few seconds by every open front page, and
	// without WAL a single order would stall all of them.
	const wdb = wdb0;
	const wledger = new Ledger(wdb);
	/*
	 * IS THE RECONCILER COMPARING AGAINST A LIVE CUSTODIAN?
	 *
	 * This, not the presence of a token, is what makes the faucet dangerous.
	 * The faucet credits CUSTODY alongside the user's balance; if the
	 * reconciler compares that against a real custodian, the coins it credited
	 * are not there and the difference reads as a shortfall, which halts that
	 * asset permanently.
	 *
	 * My first version keyed this off BITGO_ACCESS_TOKEN being set, which was
	 * too blunt — a token can be configured while the reconciler still runs
	 * against the declared treasury file, and in that combination the faucet is
	 * harmless and is the only way to fund a test account. Keying on the
	 * reconcile source is the precise condition.
	 */
	const reconcileSource =
		(process.env.RECONCILE_SOURCE ?? "").trim().toLowerCase() ||
		(gate().mainnetEnabled ? "bitgo" : "declared");
	const liveCustodian = reconcileSource === "bitgo";
	const venue = new Venue(wdb, wledger, undefined, {
		mainnetEnabled: gate().mainnetEnabled,
		liveCustodian,
		/*
		 * THE FAUCET'S CEILING, read fresh on every call.
		 *
		 * Note the ordering this composes with: the route bumps the declaration
		 * BEFORE calling testnetCredit, so by the time the cap runs the
		 * declaration already includes this amount. The check
		 * `booked + amount > declared` therefore reduces to `booked > declared
		 * before the bump` — it refuses precisely when the books are ALREADY
		 * ahead of the declaration, i.e. when a break exists.
		 *
		 * So this does not throttle normal use; it stops the faucet compounding
		 * a drift that is already there, which is how USDT ended up
		 * 1,390,000,000,000 base units past its declaration with the interlock
		 * pinned on.
		 */
		declaredHoldings: (custodyId) => {
			try {
				return readDeclared(TREASURY_FILE)[custodyId];
			} catch {
				// An unreadable declaration is not a licence to credit. Undefined
				// makes testnetCredit refuse and say so.
				return undefined;
			}
		},
	});

	// WITHDRAWAL POLICY. Every asset listed here needs BOTH a per-request
	// ceiling and a 24h velocity cap, and anything absent is UNWITHDRAWABLE —
	// with no human in the loop, a missing config entry must not mean
	// "unlimited". Testnet figures; tighten before mainnet.
	const wdPolicy: WdPolicy = {
		autoApprove: true,
		approvalThreshold: {},
		// EVERY LISTED ASSET NEEDS BOTH FIGURES. An asset with a market but no
		// limits is tradable and not withdrawable, which is a worse trap than
		// not listing it — so adding a market without coming here would strand
		// customer funds. Checked at startup below.
		maxPerRequest: {
			BTC: 10n ** 9n, ETH: 100n * 10n ** 18n, USDT: 100_000n * 10n ** 6n,
			USDC: 100_000n * 10n ** 6n, SOL: 10_000n * 10n ** 9n,
			DOGE: 10_000_000n * 10n ** 8n, BLOCK: 10_000n * 10n ** 8n,
			PERBUG: 10_000n * 10n ** 8n, TRX: 1_000_000n * 10n ** 6n,
			XRP: 500_000n * 10n ** 6n, BNB: 1_000n * 10n ** 18n,
		},
		velocityCap24h: {
			BTC: 5n * 10n ** 9n, ETH: 500n * 10n ** 18n, USDT: 500_000n * 10n ** 6n,
			USDC: 500_000n * 10n ** 6n, SOL: 50_000n * 10n ** 9n,
			DOGE: 50_000_000n * 10n ** 8n, BLOCK: 50_000n * 10n ** 8n,
			PERBUG: 50_000n * 10n ** 8n, TRX: 5_000_000n * 10n ** 6n,
			XRP: 2_500_000n * 10n ** 6n, BNB: 5_000n * 10n ** 18n,
		},
		requireAllowlistedAddress: WD_REQUIRE_ALLOWLIST,
	};
	// GAS PRICING. The venue's own book first, the configured policy floor
	// second, and the WORST of the two is what the fee is computed from. See
	// gasrates.ts for why disagreement resolves toward safety.
	const bestAsk = (from: string, to: string): bigint | undefined => {
		const m = VENUE_MARKETS.find((x) => x.base === from && x.quote === to);
		if (m === undefined) return undefined;
		return venue.book(m.symbol, 1).asks[0]?.price;
	};
	const pricing: GasPricing = {
		sources: [new BookRates(bestAsk), new StaticRates(GAS_PRICE_FLOOR)] as RateSource[],
	};

	/**
	 * How many withdrawals over each chain are already accepted and unsent.
	 *
	 * Each will burn gas before the next one does, so without this a burst of
	 * withdrawals each pass a check that the batch as a whole fails.
	 */
	// Reads `wd`, which is constructed BELOW with this very function. That is a
	// genuine circularity — the gate needs the withdrawal table and the
	// withdrawals object owns it — resolved lazily: this closure only runs on a
	// request, long after the binding is initialised.
	const pendingOnChain = (asset: string, network: string | undefined): number =>
		wd.pending().filter(
			(w) => w.asset === asset && (w.network ?? undefined) === network,
		).length;

	const gasDeps: GasGateDeps = {
		ledger: wledger,
		pendingOnChain,
		table: LIVE_GAS_COSTS,
	};

	/*
	 * THE SAME GAS VERDICT THE WITHDRAWAL PATH USES, handed to the deposit path.
	 *
	 * One source of truth deliberately: if deposits and withdrawals could
	 * disagree about whether a chain can pay its fee, the venue would take coins
	 * on a chain it refuses to send from — which is the stranding this closes.
	 */
	const gasReadyFor = (
		asset: string,
		network: string | undefined,
	): { ok: true } | { ok: false; reason: string } => {
		const g = checkGas({ asset, network }, gasDeps);
		return g.ok ? { ok: true } : { ok: false, reason: g.reason };
	};

	// A LISTED ASSET WITH NO WITHDRAWAL LIMITS IS A TRAP. It would trade fine
	// and then refuse to pay out, which is the one failure a customer cannot
	// work around. Logged loudly at startup rather than discovered by them.
	for (const asset of LISTED) {
		const missing: string[] = [];
		if (wdPolicy.maxPerRequest[asset] === undefined) missing.push("maxPerRequest");
		if (wdPolicy.velocityCap24h[asset] === undefined) missing.push("velocityCap24h");
		if (missing.length > 0) {
			console.error(
				`CONFIG: ${asset} is listed for trading but has no ${missing.join(" or ")} ` +
					"— it CANNOT BE WITHDRAWN. Customers can buy it and not get it out.",
			);
		}
	}

	const wd: Withdrawals = new Withdrawals(wdb, wledger, wdPolicy, {
		feeTable: LIVE_FEES,
		pricing,
		gas: gasDeps,
		// The live service insists on the gate. Forgetting to wire it must be a
		// loud refusal, not tokens withdrawing with no gas check at all.
		requireGasGate: true,
		// OPEN ORDERS HOLD THEIR COLLATERAL. The venue derives reservations from
		// the order table, so only it can answer this — see the comment in
		// `Withdrawals.request`, which explains the spoof this closes.
		reserved: (userId, asset) => venue.reserved(userId).get(asset) ?? 0n,
		requireReservedCheck: true,
	});
	// Market-maker ladders share the venue's book and its writable handle.
	// CUSTOMER SECOND FACTOR. Same writable handle as the venue, since a
	// withdrawal checks it inside the same request.
	const userTotp = new UserTotp(wdb);
	const mm = new MarketMaker(wdb, venue);
	const deposits = new Deposits(wdb);

	/*
	 * ADDRESS PROVISIONING, wired only when a custodian is configured.
	 *
	 * Undefined without a token, in which case the deposit screen says no
	 * address is provisioned and names a chain that works — which is true, and
	 * is the only honest thing to show. The alternative (a placeholder, an
	 * omnibus address) loses deposits permanently.
	 *
	 * The wallet comes from the HOLDINGS adapter's scope, because that is where
	 * "which wallets are the exchange's" is configured. Creating an address on
	 * a wallet outside that scope would be issuing a deposit address for
	 * another project.
	 */
	const bitgoToken = (process.env.BITGO_ACCESS_TOKEN ?? "").trim();
	const bitgoEnv = (process.env.BITGO_ENV ?? "test").trim().toLowerCase();

	/*
	 * NODE-CUSTODIED COINS ISSUE THEIR OWN ADDRESSES.
	 *
	 * BitGo will not hold Raptoreum, so for those coins the daemon we run is
	 * the custodian and `getnewaddress` is the address source. Built here once
	 * so a per-request call does not reconnect, and empty when nothing is
	 * configured — which is the normal state of a planned listing.
	 */
	/*
	 * BLOCK DEPOSIT ADDRESSES COME FROM A POOL, NOT FROM A SEED HERE.
	 *
	 * The chain can derive unlimited addresses, but ML-DSA has no watch-only
	 * derivation — deriving requires the key that can spend. This process is
	 * the most exposed one in the system, so it gets the addresses and never
	 * the seed: an operator derives a batch on the wallet host and loads it
	 * (see blockpoolcli.ts). With no pool loaded, BLOCK deposits are closed
	 * and say so.
	 */
	const blockPool = new BlockAddressPool(wdb);
	const nodeChains = nodeAdapters({ env: process.env, blockPool });
	{
		const s = blockPool.status();
		if (s.total > 0) {
			console.log(
				`  block pool: ${s.free} free of ${s.total}${s.low ? "  <= LOW" : ""}`,
			);
		}
	}

	/*
	 * SOL IS IN BLOCK'S POSITION AND GETS THE SAME SHAPE — plus the gate BLOCK
	 * does not need.
	 *
	 * ed25519 under SLIP-0010 derives children from the private key and refuses
	 * non-hardened segments outright, so there is no watch-only derivation and
	 * this process can only ever hand out addresses someone else derived. Hence
	 * a pool, loaded by solpoolcli.ts from a batch made on the signer host.
	 *
	 * THE DIFFERENCE FROM BLOCK, AND WHY THE ASSERTIONS BELOW ARE NOT CEREMONY:
	 * Solana is account-per-address, so a deposit cannot be sent back out until
	 * a sweep is composed, signed off-host, and broadcast — none of which exists
	 * yet. A loaded pool would nevertheless be able to issue addresses
	 * immediately, which is the one-way door rule 4 forbids. So the rail checks
	 * its own preconditions and refuses, and the service refuses to START if
	 * settlement.ts has stopped saying the rail is shut while it still is.
	 *
	 * The pool status line is printed FROM THE RAIL, not from the pool object
	 * this function holds. That is the BLOCK bug's actual lesson: the old log
	 * read "block pool: 999 free of 1000" from publicapi's own reference while
	 * the deposit route had no pool at all, so the log proved nothing. Here the
	 * object that would issue is the object that reports, and
	 * assertSolRailUsesPool checks they are the same object rather than merely
	 * agreeing numbers — two pools over one database file always agree.
	 */
	const solPool = new SolAddressPool(wdb);
	const solHotAddress = (process.env.CHAIN_SOL_HOT_ADDRESS ?? "").trim();
	/*
	 * NO HOT ADDRESS MEANS NO SWEEPER, AND THAT IS A STATE, NOT A CRASH.
	 *
	 * The sweeper needs a destination to compose a proposal at all, and there
	 * is deliberately no default: a placeholder is a real curve point nobody
	 * controls, and the pool's own first address is worse — the planner refuses
	 * a hot address that is in the pool, because sweeping into a customer's
	 * deposit address credits the venue's whole balance to that customer. So
	 * with nothing configured the rail is simply not built, the readiness check
	 * is asked directly, and the startup assertion still runs. That assertion
	 * running on EVERY boot, configured or not, is the point of it.
	 */
	const solRail =
		solHotAddress === ""
			? undefined
			: solRailFromEnv({
					env: process.env,
					pool: solPool,
					consolidation: new SolConsolidation(wdb, solPool, {
						hotAddress: solHotAddress,
					}),
				});
	if (solRail !== undefined) assertSolRailUsesPool(solRail, solPool);
	{
		const s = solPool.status();
		const readiness =
			solRail?.readiness() ??
			solRailReadiness({
				poolStatus: { total: s.total, free: s.free },
				endpointUrl: process.env.CHAIN_SOL_URL ?? "",
				hotAddress: "",
			});
		assertSolRailBlockedUnlessProven(readiness);
		if (solRail !== undefined) {
			for (const note of solRail.notes()) console.log(`  sol: ${note}`);
		} else if (s.total > 0) {
			// A loaded pool with no sweeper is the exact shape of the one-way
			// door, so it is said out loud rather than left in the status file.
			console.log(
				`  sol: ${s.free} of ${s.total} pool addresses free, and NO sweeper is ` +
					"configured (CHAIN_SOL_HOT_ADDRESS unset) — deposits stay shut",
			);
		}
	}
	if (nodeChains.size > 0) {
		console.log(`  nodes:  ${[...nodeChains.keys()].join(", ")}`);
	}

	let provisionAddress:
		| ((userId: string, asset: string, network: string | undefined) => Promise<void>)
		| undefined;

	/*
	 * ONE FUNCTION, TWO CUSTODIANS. The caller asks for an address; which
	 * custodian answers is decided here, by the asset, and never guessed by
	 * the caller.
	 */
	const provisionFromNode = async (
		userId: string,
		asset: string,
		network: string | undefined,
	): Promise<boolean> => {
		const adapter = nodeChains.get(settlementAsset(asset));
		if (adapter === undefined) return false;
		if (network !== undefined) {
			// These coins are single-chain by definition — a qualified id for
			// one means the caller has confused it with a token.
			throw new VenueError(`${asset} is a single-chain coin; drop the network`);
		}
		/*
		 * A SYNCING NODE MUST NOT HAND OUT ADDRESSES.
		 *
		 * The address would be valid, and the deposit to it would be invisible
		 * to us until the node caught up — during which the customer sees
		 * nothing credited and we have no way to tell them when it will be.
		 * Refusing is the kinder answer, and it says which it is.
		 */
		const cap = await adapter.probe();
		if (!cap.reachable || !cap.synced) {
			throw new VenueError(
				`${asset} deposits are temporarily closed: our ${asset} node is ` +
					`${cap.reachable ? "still syncing" : "unreachable"}. An address ` +
					"issued now would receive coins we could not credit until it " +
					"caught up.",
				503,
			);
		}
		const made = await nodeDepositAddress({ adapter, userId });
		deposits.provision({
			userId,
			asset,
			network,
			address: made.address,
			source: made.source,
		});
		return true;
	};

	if (bitgoToken !== "" && (bitgoEnv === "test" || bitgoEnv === "prod")) {
		const depositClient = new BitGoDeposits(bitgoToken, { env: bitgoEnv });
		const holdingsForScope = BitGoHoldings.fromEnv();
		provisionAddress = async (userId, asset, network) => {
			// Node coins first: BitGo has no wallet for them, and asking would
			// fail with a message about the wrong custodian.
			if (await provisionFromNode(userId, asset, network)) return;
			const custodyId = network === undefined ? asset : `${asset}.${network}`;
			const coin = holdingsForScope.ticker(custodyId);
			const wallets = await holdingsForScope.exchangeWallets(custodyId);
			const wallet = wallets[0];
			if (wallet === undefined) {
				throw new Error(
					`no exchange wallet in scope for ${custodyId} — cannot issue a ` +
						"receive address",
				);
			}
			const created = await depositClient.createReceiveAddress({
				coin,
				walletId: wallet.id,
				// The account id is in the label so an operator can see whose
				// address it is in BitGo's own UI — which matters precisely when
				// our database is the thing under investigation.
				label: `blockle-ex:${userId}`,
			});
			deposits.provision({
				userId,
				asset,
				network,
				address: created.address,
				...(created.memo === undefined ? {} : { memo: created.memo }),
				source: `bitgo:${bitgoEnv}:${wallet.id}`,
			});
		};
	} else if (nodeChains.size > 0) {
		/*
		 * NO CUSTODIAN TOKEN, BUT WE DO RUN SOME NODES.
		 *
		 * Those coins can still take deposits — they do not depend on BitGo at
		 * all. An asset with no node here falls through to a refusal that names
		 * the reason, rather than to a BitGo call that cannot be made.
		 */
		provisionAddress = async (userId, asset, network) => {
			if (await provisionFromNode(userId, asset, network)) return;
			throw new VenueError(
				`no custodian is configured for ${asset}, so no deposit address can ` +
					"be issued for it. Deposits are open for: " +
					[...nodeChains.keys()].join(", "),
				503,
			);
		};
	}
	/*
	 * PROGRAMMATIC TRADING KEYS. Same database as withdrawals because a key
	 * must be revocable in the same transaction scope as the rest of a
	 * customer's state, and because there is no scenario where the keys
	 * survive a restore that the balances did not.
	 *
	 * read + trade only. There is no withdrawal scope and no way to add one
	 * from here — see apikeys.ts.
	 */
	const apiKeys = new ApiKeys(wdb);

	/*
	 * THE CUSTOMER DIRECTORY, for the operator console.
	 *
	 * Reads the venue's own tables — it has no customer table of its own, so
	 * it cannot drift out of step with the ledger.
	 */
	const customers = new Customers(wdb, wledger);

	// Listing applications. The row is the record; the email is a notification.
	const listings = new Listings(wdb, {
		mailer: sendmailMailer(),
		notifyTo: process.env.LISTING_NOTIFY ?? "alex@blockle.org",
	});
	const wdCommitments = commitmentsFrom(wdb);
	const liquidityOf = (symbol: string) =>
		assetLiquidity(wledger, symbol, wdCommitments, haltsFrom());

	// ---- admin ------------------------------------------------------------
	//
	// Reuses the Blockle account system (no second login) plus an allowlist of
	// account ids, and requires a fresh authenticator code for anything that
	// moves money. See adminapi.ts. An EMPTY allowlist means nobody is an
	// administrator, which is the correct default for an unconfigured box.
	wdb.exec(ADMIN_SCHEMA);
	// ONE accounts client, shared by the trading API and the admin API. Two
	// would mean two caches and two timeout settings for the same service.
	const accountsAuth = new BlockleAuth({
		base: process.env.ACCOUNTS_BASE ?? "https://blockle.org",
	});

	const adminDeps: AdminDeps = {
		db: wdb,
		ledger: wledger,
		auth: accountsAuth,
		gas: gasDeps,
		feeTable: LIVE_FEES,
		pricing,
		rates: pricing.sources ?? [],
		allowlist: allowlistFrom(process.env.EXCHANGE_ADMINS),
		customers,
		totpSecrets: totpSecretsFrom(process.env.EXCHANGE_ADMIN_TOTP),
		houseAccountId: process.env.EXCHANGE_HOUSE_ACCOUNT ?? "house",
		/*
		 * THE TREASURY VIEW'S TWO EXTRA INPUTS.
		 *
		 * `reservations` is the live Venue, passed as the one-method
		 * ReservationSource interface rather than as the Venue itself: the
		 * admin surface needs to read what resting orders have claimed, and
		 * must not thereby gain the ability to place or cancel one.
		 *
		 * SAME LEDGER, SAME FILE, SO THE SAME NUMBERS. `wledger` above and the
		 * venue here are both built on `wdb`, and the read-only public handle
		 * is the same DB_PATH — so the treasury panel, the trading engine and
		 * the reconcile job's own read-only handle all see one database.
		 * Handing the admin surface a different connection would have been the
		 * easy way to make the console disagree with the reconciler for a
		 * reason nobody could find.
		 *
		 * `reconcilerState` is a FUNCTION so the halt file is re-read on every
		 * request. The job rewrites it every two minutes; a value captured here
		 * would freeze the panel's "last reconciled" at process start and keep
		 * rendering it as though it were current.
		 */
		reservations: venue,
		reconcilerState: () => reconcilerStateFrom(),
	};

	/*
	 * LIVE MEANS NO TESTNET PLUMBING ANYWHERE. Checked at startup, and a
	 * failure REFUSES TO BOOT.
	 *
	 * Exiting is the right response rather than logging and continuing. Each of
	 * these combinations is a live, customer-facing venue whose money rails
	 * point at something fake: real liabilities recorded against testnet coins,
	 * or solvency "proven" against a file a human wrote. A venue that is down
	 * is an outage; a venue that is up and wrong takes deposits it cannot
	 * honour, and it looks healthy while doing it.
	 *
	 * These are belt-and-braces over the go-live preflight, which checks the
	 * same things before the gate is ever opened. The difference is that the
	 * preflight runs when someone remembers to run it, and this runs every
	 * single boot — including the one after somebody edits the config by hand.
	 */
	if (gate().mainnetEnabled) {
		const problems: string[] = [];
		const env = process.env;
		if ((env.BITGO_ENV ?? "").trim().toLowerCase() !== "prod") {
			problems.push(
				`BITGO_ENV=${env.BITGO_ENV ?? "(unset)"} — a live venue must use the ` +
					"production custody installation",
			);
		}
		if (((env.BITGO_COINS ?? "mainnet").trim().toLowerCase()) !== "mainnet") {
			problems.push(
				`BITGO_COINS=${env.BITGO_COINS} — a live venue holding testnet coins ` +
					"would record real customer liabilities against worthless assets",
			);
		}
		if ((env.BITGO_ACCESS_TOKEN ?? "").trim() === "") {
			problems.push(
				"BITGO_ACCESS_TOKEN is unset — nothing could be deposited or sent",
			);
		}
		if (reconcileSource !== "bitgo") {
			problems.push(
				`RECONCILE_SOURCE=${reconcileSource} — solvency would be checked ` +
					"against a declared file rather than the custodian, which proves " +
					"nothing",
			);
		}
		if (
			(env.BITGO_WALLETS ?? "").trim() === "" &&
			(env.BITGO_WALLET_PREFIX ?? "").trim() === ""
		) {
			problems.push(
				"no BITGO_WALLETS or BITGO_WALLET_PREFIX — custody is a shared " +
					"account, so without a scope other projects' balances would " +
					"count as exchange custody and hide a shortfall",
			);
		}
		if (problems.length > 0) {
			console.error(
				"REFUSING TO START. The mainnet gate is open but the venue still " +
					"has testnet plumbing:\n" +
					problems.map((x) => `  - ${x}`).join("\n") +
					"\nFix these or close the gate. A live venue pointed at " +
					"anything fake takes deposits it cannot honour, and looks " +
					"healthy while doing it.",
			);
			process.exit(78); // EX_CONFIG
		}
	}

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			try {
				const url = new URL(req.url ?? "/", `http://${HOST}`);

				/*
				 * CSRF: REFUSE A MUTATING REQUEST THAT CAME FROM ANOTHER SITE.
				 *
				 * FIRST, BEFORE EVERY SURFACE, INCLUDING /admin. The admin
				 * console authenticates with the same kind of session cookie a
				 * browser attaches automatically, so it is as exposed to a
				 * cross-site POST as /v1 is; putting the gate after adminRoute
				 * would have protected the customer surface and left the
				 * operator surface out.
				 *
				 * This call is the whole point of `crossSiteWrite`, and until
				 * now it was missing: the function existed, the comment above it
				 * claimed it "refuses any mutating request whose Origin names a
				 * different site", and nothing in the process ever called it —
				 * so the only thing standing between a hostile page and a
				 * cookie-authenticated POST was the accounts service's
				 * SameSite=Lax attribute, set in a different service, named
				 * nowhere here and pinned by no test. A control that is only
				 * described is not a control. test/restapi.test.ts now asserts
				 * both that the function refuses the right requests and that
				 * this file calls it before it routes anything.
				 *
				 * 403 and no CORS header: a cross-origin caller learns nothing
				 * from the body, which is correct, because the legitimate
				 * callers (same-origin pages, and non-browser clients that send
				 * no Origin at all) never see this path.
				 */
				if (
					crossSiteWrite(
						req.method,
						header(req, "origin"),
						header(req, "host"),
					)
				) {
					jsonResponse(
						res,
						403,
						{
							error:
								"cross-site writes are refused. Call this API from its " +
								"own origin, or from a server-to-server client that " +
								"sends no Origin header.",
						},
						0,
						"same-origin",
					);
					return;
				}

				if (await adminRoute(req, res, url, adminDeps)) return;

				// TRADING LIVES UNDER /v1 AND IS THE ONLY MUTABLE SURFACE.
				// Everything under /public stays GET-only, so the split is
				// visible in the URL rather than buried in a handler.
				if (url.pathname.startsWith("/v1/")) {
					await venueRoute(
						req, res, url, venue, wledger, wd, accountsAuth, liquidityOf,
						LIVE_FEES, pricing, mm, deposits, wdb, provisionAddress,
						apiKeys,
						userTotp,
						gasReadyFor,
						"/v1",
					);
					return;
				}

				/*
				 * ---- /rest : THE DOCUMENTED ALIAS ------------------------------
				 *
				 * Routed BEFORE the read-only method gate below, because two of
				 * its routes are the POST trading routes. Everything about why
				 * this is an alias and not a third implementation is in
				 * restapi.ts; what happens here is only dispatch:
				 *
				 *   * /rest itself serves the index — the whole catalogue, with
				 *     auth, parameters and a real example per route.
				 *   * an `account` route goes to the SAME venueRoute, with the
				 *     mount set to "/rest" so the route tail resolves. The URL is
				 *     not rewritten (API-key signatures cover the path as sent).
				 *   * a `public` route falls through to the public read block
				 *     below with `p` already resolved, so it is literally the same
				 *     handler the /public URL reaches.
				 *   * ANYTHING NOT IN THE CATALOGUE IS 404 HERE. That is the
				 *     enforcement point for "/rest cannot move funds or touch a
				 *     credential": the withdrawal, allowlist, 2FA and key-
				 *     management routes are not aliased, so /rest/withdrawals
				 *     never reaches a handler at all — it is not "reachable if you
				 *     guess the spelling".
				 *
				 * OPTIONS IS REFUSED, NOT ANSWERED, and that is the deliberate
				 * CORS decision rather than an omission. Answering a preflight
				 * here is what would turn the `Access-Control-Allow-Origin: *` on
				 * public market data into a cross-origin credentialed read of the
				 * account routes; same-origin browser calls need no preflight and
				 * server-to-server callers are not subject to CORS at all.
				 */
				let restPublicPath: string | undefined;
				if (
					url.pathname === REST_MOUNT ||
					url.pathname.startsWith(`${REST_MOUNT}/`)
				) {
					const m = matchRest(url.pathname, req.method ?? "GET");
					if (m.kind === "index") {
						// The index is a document about what exists, not live
						// state, so it may be cached — but briefly, because a
						// deploy changes it and a stale route list is the one
						// thing a self-describing index must not serve.
						json(res, 200, restIndex(), 60);
						return;
					}
					if (m.kind === "method") {
						// An Allow header, because "405" without one leaves a
						// caller guessing which verb the path wanted. Written
						// directly rather than through json() since that helper
						// does not carry extra headers.
						const b = JSON.stringify({
							error:
								`that path exists but does not accept ${req.method}. ` +
								`Allowed: ${m.allow.join(", ")}. See ${REST_MOUNT} for ` +
								"the full route list.",
						});
						res.writeHead(405, {
							"Content-Type": "application/json; charset=utf-8",
							"Content-Length": Buffer.byteLength(b),
							"Cache-Control": "no-store",
							"X-Content-Type-Options": "nosniff",
							Allow: m.allow.join(", "),
						});
						res.end(b);
						return;
					}
					if (m.kind === "unknown") {
						/*
						 * NAME THE INDEX IN THE 404.
						 *
						 * A bare {"error":"not found"} on a documented API is a
						 * dead end: the caller cannot tell a typo from a route
						 * that was never aliased. Note what is NOT said — whether
						 * the spelling exists on another mount. A money route
						 * answering "that exists at /v1" would be confirming the
						 * route to someone probing for it; the index already lists
						 * every exclusion with its reason, for callers rather than
						 * for probes.
						 */
						json(res, 404, {
							error: "no such route on this API",
							index: REST_MOUNT,
						}, 0);
						return;
					}
					if (m.route.surface === "account") {
						await venueRoute(
							req, res, url, venue, wledger, wd, accountsAuth, liquidityOf,
							LIVE_FEES, pricing, mm, deposits, wdb, provisionAddress,
							apiKeys,
							userTotp,
							gasReadyFor,
							REST_MOUNT,
						);
						return;
					}
					restPublicPath = m.tail;
				}

				// ONE MUTATING PUBLIC ROUTE, and it is deliberately outside the
				// read-only block below rather than a hole punched through it.
				// It writes to its own table, touches no balance and no ledger,
				// and needs no account — requiring one would filter out exactly
				// the project teams we want to hear from.
				if (url.pathname === "/public/listing-apply" && req.method === "POST") {
					try {
						const b = await body(req);
						const fwd = req.headers["x-forwarded-for"];
						const fwdStr = (Array.isArray(fwd) ? fwd[0] : fwd) ?? "";
						const ip =
							fwdStr.split(",")[0]?.trim() ||
							req.socket.remoteAddress ||
							"unknown";
						const r = await listings.submit({ fields: b, ip });
						json(res, 200, {
							ok: true,
							reference: r.id,
							// ACCURATE ABOUT WHAT IS KNOWN AT THIS MOMENT. The first
							// wording said the notification "did not go out", which
							// was wrong: the mail is detached, so at response time
							// it has not been ATTEMPTED yet, and the one that
							// printed that message then delivered fine. Claiming a
							// failure that has not happened sends someone chasing
							// support for nothing.
							note: r.notified
								? "Received. We will reply to the address you gave."
								: "Received and recorded under that reference. Email " +
									"support@blockle.org if you have heard nothing in a " +
									"few days.",
						}, 0);
					} catch (e) {
						const status = (e as { status?: number }).status ?? 400;
						json(res, status, {
							error: e instanceof Error ? e.message : String(e),
						}, 0);
					}
					return;
				}

				if (req.method !== "GET" && req.method !== "HEAD") {
					json(res, 405, { error: "this API is read-only" });
					return;
				}
				/*
				 * ONE HANDLER, THREE SPELLINGS — and the prefix strip is
				 * SEGMENT-ANCHORED.
				 *
				 * The public read routes answer at /public/x, at bare /x (the
				 * front page's own fetches), and now at /rest/x for the
				 * documented alias. `restPublicPath` is set above only after the
				 * /rest catalogue matched, so an unaliased spelling cannot arrive
				 * here by this door.
				 *
				 * The regex gained `(?=\/|$)`. Without it the strip was a plain
				 * prefix replace, so a future top-level route whose name merely
				 * STARTED with "public" — /publication, say — would silently have
				 * been rewritten to /ation and 404'd with nothing in the log to
				 * explain it. No such route exists today; the anchor is here so
				 * none can be added into the trap.
				 */
				const p =
					restPublicPath ?? (url.pathname.replace(/^\/public(?=\/|$)/, "") || "/");

				if (p === "/status") {
					const g = gate();
					json(res, 200, {
						// Both must be true. Either alone is not "live".
						live: g.mainnetEnabled && g.legalReviewCompleted,
						mainnetEnabled: g.mainnetEnabled,
						legalReviewCompleted: g.legalReviewCompleted,
						network: g.mainnetEnabled ? "mainnet" : "testnet",
						ledgerPresent: ledger !== undefined,
						// ALWAYS FALSE: the faucet route no longer exists. Kept as a
						// field rather than dropped, because a client reading it as
						// `undefined` would show the button, and `false` hides it.
						faucetAvailable: false,
					});
					return;
				}

				if (p === "/fees") {
					json(
						res,
						200,
						{ ...disclose(DEFAULT_FEES), makerBps: DEFAULT_FEES.makerBps, takerBps: DEFAULT_FEES.takerBps },
						300,
					);
					return;
				}

				// THE WITHDRAWAL FEE SCHEDULE, published. A venue that will not
				// say what a withdrawal costs until you are mid-withdrawal is
				// not being straight with anyone.
				if (p === "/withdrawal-fees") {
					json(res, 200, {
						fees: discloseWithdrawalFees(LIVE_FEES, pricing),
						note:
							"The fee is withheld from the amount, so you receive the " +
							"amount minus the fee. It covers the network cost of " +
							"sending — which for a token is paid in a different asset " +
							"(ERC-20 USDT costs ETH) — plus our margin. Minimums exist " +
							"because below them the fee would be most of the " +
							"withdrawal; the exact fee is always shown before you " +
							"confirm.",
					}, 120);
					return;
				}

				// THE LISTING QUESTION SET, so the form is generated from the
				// same list the validator and the email read. A question in the
				// HTML but not in that list would be silently dropped — the
				// worst outcome for a form, since the submitter answered and
				// nobody received it.
				if (p === "/listing-questions") {
					json(res, 200, { questions: QUESTIONS }, 600);
					return;
				}

				if (p === "/tickers") {
					// A REAL last price once the market has traded, and null
					// when it has not. Null is not zero: "no market" and "the
					// market is at zero" are different claims, and only one of
					// them is true before the first fill.
					json(
						res,
						200,
						VENUE_MARKETS.map((m) => {
							const last = venue.lastPrice(m.symbol);
							// Prices, so priceScale — the quote's decimals alone
							// would publish a last/bid/ask 10^priceDecimals too
							// large on the twelve markets that carry one.
							const ps = priceScale(m);
							const book = venue.book(m.symbol, 1);
							return {
								pair: `${m.base}/${m.quote}`,
								market: m.symbol,
								base: m.base,
								quote: m.quote,
								last: last === undefined ? null : fmt(last, ps),
								bid: book.bids[0] === undefined ? null : fmt(book.bids[0].price, ps),
								ask: book.asks[0] === undefined ? null : fmt(book.asks[0].price, ps),
								change24h: null,
								volume24h: null,
							};
						}),
					);
					return;
				}

				/*
				 * Public order book and trade tape — no account needed to look.
				 *
				 * THE CAPTURE IS `[^/]+`, NOT `[A-Z0-9-]+`, AND THAT IS A FIX.
				 *
				 * The /rest catalogue matches a path's SHAPE (`{market}` ->
				 * `([^/]+)`) and leaves validating the VALUE to the handler, on
				 * purpose: two copies of a validator drift. But these two
				 * handlers held a SECOND, STRICTER pattern, so there was a band
				 * of paths the catalogue accepted and no handler claimed —
				 * anything with a lower-case letter. `/public/book/btc-usdt`
				 * therefore fell past every route, through serveStatic, and out
				 * of the generic tail as `{"error":"not found"}` — or, to a
				 * browser, as 6 KB of 404.html from a JSON endpoint — while the
				 * published index promised `{"error":"unknown market"}`.
				 *
				 * Now the handler claims every shape the catalogue accepts and
				 * answers the documented error for a symbol it does not know.
				 * Symbols stay EXACT (upper case, as /markets spells them): a
				 * case-insensitive lookup would be a second spelling for every
				 * market, which is the one thing this alias design refuses.
				 */
				const bookMatch = /^\/book\/([^/]+)$/.exec(p);
				if (bookMatch !== null) {
					const sym = bookMatch[1]!;
					const m = VENUE_MARKETS.find((x) => x.symbol === sym);
					if (m === undefined) { json(res, 404, { error: "unknown market" }); return; }
					const bd = assetDef(m.base).decimals;
					const ps = priceScale(m);
					const b = venue.book(sym);
					json(res, 200, {
						market: sym,
						bids: b.bids.map((x) => ({ price: fmt(x.price, ps), base: fmt(x.base, bd) })),
						asks: b.asks.map((x) => ({ price: fmt(x.price, ps), base: fmt(x.base, bd) })),
					});
					return;
				}
				// Same shape-vs-value split as /book above, same reason.
				const tradeMatch = /^\/trades\/([^/]+)$/.exec(p);
				if (tradeMatch !== null) {
					const sym = tradeMatch[1]!;
					const m = VENUE_MARKETS.find((x) => x.symbol === sym);
					if (m === undefined) { json(res, 404, { error: "unknown market" }); return; }
					const bd = assetDef(m.base).decimals;
					const ps = priceScale(m);
					json(res, 200, venue.recentTrades(sym).map((t) => ({
						price: fmt(t.price, ps),
						base: fmt(t.base, bd),
						takerSide: t.takerSide,
						at: t.at,
					})));
					return;
				}
				if (p === "/markets") {
					/*
					 * `priceScale` IS PUBLISHED BECAUSE A CLIENT CANNOT DERIVE IT.
					 *
					 * `quoteDecimals` was enough to format a price while every
					 * market had priceDecimals 0. It no longer is: a price carries
					 * quoteDecimals + priceDecimals places, so a client that keeps
					 * using quoteDecimals renders every PERBUG-BTC price 10,000
					 * times too large and submits one 10,000 times too small.
					 * Both are published, and which one to use is stated: amounts
					 * take quoteDecimals, prices take priceScale.
					 *
					 * `state` and `closed` are published for the same reason the
					 * generator keeps a refusal rather than a bare `continue` — a
					 * market that refuses orders must say so where the customer
					 * reads it, not only when they try to trade.
					 */
					json(res, 200, VENUE_MARKETS.map((m) => ({
						symbol: m.symbol, base: m.base, quote: m.quote,
						baseDecimals: assetDef(m.base).decimals,
						quoteDecimals: assetDef(m.quote).decimals,
						priceDecimals: m.priceDecimals,
						priceScale: priceScale(m),
						minBase: fmt(m.minBase, assetDef(m.base).decimals),
						minNotional: fmt(m.minNotional, assetDef(m.quote).decimals),
						state: m.closed === undefined ? "open" : "closed",
						closed: m.closed ?? null,
						/*
						 * PUBLISHED BESIDE `state`, NOT INSTEAD OF IT.
						 *
						 * `state:"open"` plus a caveat is the honest answer for
						 * the ten BLOCK markets: they take orders and settle
						 * them, and BLOCK's deposits depend on our own node
						 * while its withdrawals are released by hand. The
						 * generator computed that sentence and nothing carried
						 * it, so every client read "open" with no qualification
						 * at all — which is why this is a field rather than a
						 * note in a runbook. A client that does not know the
						 * field is no worse off than before; one that does can
						 * say "open, with a known gap".
						 */
						caveat: m.caveat ?? null,
						listedAt: m.listedAt,
					})), 300);
					return;
				}

				/*
				 * THE PAIRS THAT HAVE NO SYMBOL, AND WHY.
				 *
				 * Served because a settlement-gated venue refuses pairs, and a
				 * refusal nobody can read is indistinguishable from a bug report.
				 * "Everything should trade against BTC" meets "one satoshi is
				 * worth more than one DINGO" somewhere, and this endpoint is where
				 * the venue says which pairs that happened to instead of leaving
				 * the customer to infer it from an absence.
				 */
				if (p === "/unlisted") {
					json(res, 200, {
						notListed: NOT_LISTED.map((x) => ({
							base: x.base, quote: x.quote, why: x.why, blockedBy: x.blockedBy,
						})),
						pendingSettlement: PENDING_SETTLEMENT.map((x) => ({
							base: x.base, quote: x.quote, why: x.why, blockedBy: x.blockedBy,
						})),
					}, 300);
					return;
				}

				if (p === "/liquidity") {
					if (ledger === undefined) {
						json(res, 200, { assets: [], note: "no ledger yet" });
						return;
					}
					const halts = haltsFrom();
					json(res, 200, {
						assets: LISTED.filter((a) => ASSETS[a] !== undefined).map((a) =>
							publish(assetLiquidity(ledger!, a, commitments, halts), fmt),
						),
					});
					return;
				}

				if (p === "/reserves") {
					if (ledger === undefined) {
						json(res, 200, { assets: [], note: "no ledger yet" });
						return;
					}
					json(res, 200, {
						// Labelled honestly: these are our own figures, not an
						// audit. Calling self-reported numbers "proof of
						// reserves" is the overstatement that destroys the
						// trust it was meant to build.
						disclaimer:
							"Self-reported figures from our own ledger, published live. " +
							"Not an independent audit or attestation.",
						assets: LISTED.filter((a) => ASSETS[a] !== undefined).map((a) =>
							reserves(ledger!, a, fmt),
						),
					});
					return;
				}

				if (p === "/assets") {
					json(
						res,
						200,
						Object.values(ASSETS).map((a) => ({
							symbol: a.symbol,
							decimals: a.decimals,
							networks: a.networks.map((n) => ({ id: n.id, label: n.label })),
						})),
						300,
					);
					return;
				}

				if (p === "/health") {
					json(res, 200, { ok: true });
					return;
				}

				/*
				 * A /rest PATH NEVER FALLS INTO THE STATIC SITE.
				 *
				 * Reaching here with `restPublicPath` set means the catalogue
				 * matched and no handler answered — i.e. the catalogue and the
				 * handlers disagree. Two ways that happens: a path parameter
				 * whose value no handler recognises, and a /public handler that
				 * was renamed while its /rest entry stayed behind. Without this
				 * block the request continued into serveStatic and the HTML 404
				 * page, so a JSON API answered `text/html` and 6 KB of marketing
				 * copy, and the index went on publishing an example response for
				 * a route that no longer existed.
				 *
				 * JSON, 404, and a pointer at the index. The log line names the
				 * tail — which is market data, never an account or a customer —
				 * because this state is a server-side defect worth finding in
				 * the log rather than only in a client's bug report.
				 */
				if (restPublicPath !== undefined) {
					console.warn(
						`/rest catalogue matched ${restPublicPath} but no handler ` +
							`answered it — catalogue and handlers disagree`,
					);
					json(res, 404, {
						error: "not found",
						detail:
							"that path is published but the value in it was not " +
							"recognised. Check the identifier against the route's " +
							"listing in the index.",
						index: REST_MOUNT,
					}, 0);
					return;
				}

				// /admin redirects to /admin/ so the console's relative API
				// paths resolve under it.
				if (url.pathname === "/admin") {
					res.writeHead(302, { Location: "/admin/" });
					res.end();
					return;
				}
				/*
				 * ONE URL PER PAGE. `/trade/x/index.html` serves the same bytes
				 * as `/trade/x`, which is two addresses for one page — a split
				 * in whatever ranking the page earns, and a second link for
				 * people to share. The canonical tag is a hint; a 301 is not.
				 */
				if (url.pathname.endsWith("/index.html")) {
					res.writeHead(301, {
						Location: url.pathname.slice(0, -"index.html".length).replace(/\/$/, "") || "/",
					});
					res.end();
					return;
				}
				if (await serveStatic(req, res, url.pathname)) return;

				/*
				 * A PERSON GETS A PAGE, A PROGRAM GETS JSON.
				 *
				 * Someone following a stale link to a coin we renamed used to
				 * land on `{"error":"not found"}` in a browser window, which
				 * tells them nothing and offers them nowhere to go. A navigation
				 * request gets the 404 page — with the right status, so it is
				 * not indexed as content.
				 */
				const accepts = header(req, "accept") ?? "";
				if (req.method === "GET" && accepts.includes("text/html")) {
					if (await serveStatic(req, res, "/404.html", 404)) return;
				}
				json(res, 404, { error: "not found" });
			} catch (e) {
				const why = e instanceof Error ? e.stack ?? e.message : String(e);
				// THE ORIGINAL ERROR IS LOGGED, ALWAYS. This catch used to
				// swallow it and reply 500; when the failure happened AFTER the
				// response was committed — a client disconnecting mid-download
				// is the common case — writing that 500 threw
				// ERR_HTTP_HEADERS_SENT from inside an async function, which is
				// an unhandled rejection, which exits the process. So a dropped
				// connection could restart the exchange, and the log said
				// nothing about what actually went wrong.
				console.error(`request ${req.method} ${req.url} failed: ${why}`);
				if (res.headersSent) {
					// Nothing can be said to this client any more; just stop
					// holding the socket open.
					res.destroy();
					return;
				}
				json(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		})();
	});

	// IPv4 ONLY. The BitGo token is whitelisted to this host's IPv4 address and
	// the box also has IPv6, so an unpinned request can leave over v6 and come
	// back as a 401 that reads exactly like a bad token. Verified by opening a
	// real socket, not just by setting a flag.
	void pinAndVerify("app.bitgo-test.com").catch((e: unknown) => {
		console.error(
			`IPv4 pin check failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	});

	server.listen(PORT, HOST, () => {
		console.log(
			`public market-data API on http://${HOST}:${PORT}\n` +
				`  ledger: ${ledger !== undefined ? DB_PATH : "ABSENT (liquidity empty)"}\n` +
				`  static: ${STATIC_DIR === "" ? "none" : STATIC_DIR}\n` +
				`  gate:   ${JSON.stringify(gate())}`,
		);
	});

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => server.close(() => process.exit(0)));
	}
}

if (require.main === module) start();
