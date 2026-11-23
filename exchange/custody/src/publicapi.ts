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

import { format } from "./amount";
import { ASSETS } from "./assets";
import { DEFAULT_FEES, disclose } from "./fees";
import { Ledger } from "./ledger";
import {
	NOTHING_HALTED,
	assetLiquidity,
	publish,
	reserves,
	type CommitmentSource,
	type HaltSource,
} from "./liquidity";

const PORT = Number(process.env.PUBLIC_API_PORT ?? 3100);
const HOST = process.env.PUBLIC_API_HOST ?? "127.0.0.1";
const DB_PATH = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";
const STATIC_DIR = process.env.PUBLIC_STATIC_DIR ?? "";
const CONFIG_PATH = process.env.EXCHANGE_CONFIG ?? "/etc/blockle/exchange.json";

/** Assets offered to customers. Order is the order the front page lists them. */
const LISTED = ["BTC", "ETH", "USDT", "USDC", "BLOCK", "PERBUG", "SOL", "DOGE"];

/** Markets, as pairs. No prices until there is trading. */
const MARKETS: readonly { base: string; quote: string }[] = [
	{ base: "BLOCK", quote: "BTC" },
	{ base: "PERBUG", quote: "BTC" },
	{ base: "BTC", quote: "USDT" },
	{ base: "ETH", quote: "USDT" },
	{ base: "SOL", quote: "USDT" },
	{ base: "DOGE", quote: "USDT" },
];

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
			} catch {
				// No withdrawal table yet, or no `network` column yet. Nothing
				// is in flight, so nothing is committed.
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

function json(res: ServerResponse, code: number, body: unknown, maxAge = 2): void {
	const s = JSON.stringify(body);
	res.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(s),
		"Cache-Control": `public, max-age=${maxAge}`,
		"X-Content-Type-Options": "nosniff",
		// Same-origin once the exchange owns the root; explicit for the interim
		// where the front page may be served from a different host.
		"Access-Control-Allow-Origin": "*",
	});
	res.end(s);
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
	if (STATIC_DIR === "") return false;
	const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(
		/^(\.\.[/\\])+/,
		"",
	);
	const file = join(STATIC_DIR, rel);
	// Containment check, not just normalize — this is what stops traversal.
	if (!file.startsWith(STATIC_DIR)) return false;
	if (!existsSync(file)) return false;
	const st = statSync(file);
	if (!st.isFile()) return false;

	res.writeHead(200, {
		"Content-Type": MIME[extname(file)] ?? "application/octet-stream",
		"Content-Length": st.size,
		"Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
		"X-Content-Type-Options": "nosniff",
	});
	await pipeline(createReadStream(file), res);
	return true;
}

export function start(): void {
	// READ-ONLY at the SQLite level. A handler that tried to write would fail
	// rather than succeed, which is a stronger guarantee than "we only wrote
	// GET handlers".
	//
	// `fileMustExist: false` would create an empty database; we want a clear
	// failure instead if the path is wrong, but we also must not crash-loop
	// before the ledger exists, so absence is handled explicitly.
	let ledger: Ledger | undefined;
	let db: Database.Database | undefined;
	if (existsSync(DB_PATH)) {
		db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
		ledger = new Ledger(db);
	}

	const commitments = db !== undefined ? commitmentsFrom(db) : { committedByNetwork: () => new Map<string, bigint>() };

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			try {
				// Read-only service: anything but GET/HEAD is a category error.
				if (req.method !== "GET" && req.method !== "HEAD") {
					json(res, 405, { error: "this API is read-only" });
					return;
				}
				const url = new URL(req.url ?? "/", `http://${HOST}`);
				const p = url.pathname.replace(/^\/public/, "") || "/";

				if (p === "/status") {
					const g = gate();
					json(res, 200, {
						// Both must be true. Either alone is not "live".
						live: g.mainnetEnabled && g.legalReviewCompleted,
						mainnetEnabled: g.mainnetEnabled,
						legalReviewCompleted: g.legalReviewCompleted,
						network: g.mainnetEnabled ? "mainnet" : "testnet",
						ledgerPresent: ledger !== undefined,
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

				if (p === "/tickers") {
					// NO PRICES EXIST YET. Returning nulls rather than zeroes is
					// the difference between "we have no market" and "the market
					// is at zero". The front page renders null as an em dash.
					json(
						res,
						200,
						MARKETS.map((m) => ({
							pair: `${m.base}/${m.quote}`,
							base: m.base,
							quote: m.quote,
							last: null,
							change24h: null,
							volume24h: null,
						})),
					);
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

				if (await serveStatic(res, url.pathname)) return;
				json(res, 404, { error: "not found" });
			} catch (e) {
				// A thrown handler must not take down the front page's data.
				json(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		})();
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
