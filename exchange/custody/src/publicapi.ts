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
import { ASSETS, assetDef } from "./assets";
import { MARKETS as VENUE_MARKETS, Venue, VenueError, market as marketDef, quoteFor } from "./venue";
import { MarketMaker, quote as mmQuote } from "./mm";
import { Deposits, describeDeposit } from "./deposits";
import { Withdrawals, type Policy as WdPolicy } from "./withdrawals";
import { canPay } from "./liquidity";
import { pinAndVerify } from "./ipv4";
import { DEFAULT_FEES, disclose } from "./fees";
import { Ledger } from "./ledger";
import { LIVE_GAS_COSTS, type GasGateDeps } from "./gasgate";
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

const PORT = Number(process.env.PUBLIC_API_PORT ?? 3100);
const HOST = process.env.PUBLIC_API_HOST ?? "127.0.0.1";
const DB_PATH = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";
const STATIC_DIR = process.env.PUBLIC_STATIC_DIR ?? "";
const CONFIG_PATH = process.env.EXCHANGE_CONFIG ?? "/etc/blockle/exchange.json";

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
	// Quotes first — they are what people deposit to trade with — then the rest
	// alphabetically, so the order is stable as assets are added.
	const quotes = ["USDT", "BLOCK"].filter((q) => seen.has(q));
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
	// `/admin/` maps to admin.html. The trailing slash matters: the console
	// fetches its API at the RELATIVE path `api/`, so serving it at `/admin`
	// without the slash would resolve that to `/api/` at the root and 404 —
	// the same mount-relative mistake the setup console made once already.
	const wanted =
		urlPath === "/" ? "/index.html"
		: urlPath === "/admin" || urlPath === "/admin/" ? "/admin.html"
		: urlPath;
	const rel = normalize(wanted).replace(
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

/** Read a JSON body, with a hard cap so a huge POST cannot exhaust memory. */
async function body(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let n = 0;
	for await (const c of req) {
		n += (c as Buffer).length;
		if (n > limit) throw new VenueError("request body too large", 413);
		chunks.push(c as Buffer);
	}
	if (n === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			throw new VenueError("body must be a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch (e) {
		if (e instanceof VenueError) throw e;
		throw new VenueError("body is not valid JSON");
	}
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
): Promise<void> {
	const p = url.pathname.slice("/v1".length);

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
	const me = async (): Promise<string> => {
		const cookie = req.headers.cookie ?? "";
		const hit = cached.get(cookie);
		if (hit !== undefined) return hit;
		const u = await auth.whoami(cookie);
		cached.set(cookie, u.id);
		return u.id;
	};

	try {
		if (p === "/me" && req.method === "GET") {
			const u = await auth.whoami(req.headers.cookie ?? "");
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
		if (p === "/deposit-address" && req.method === "GET") {
			const who = await me();
			const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
			const netRaw = url.searchParams.get("network");
			json(res, 200, describeDeposit(
				deposits,
				who,
				asset,
				netRaw === null || netRaw === "" ? undefined : netRaw,
			), 0);
			return;
		}

		// TESTNET FAUCET. The venue itself refuses this when the mainnet gate
		// is on, so the guard is not merely in this handler.
		if (p === "/testnet-fund" && req.method === "POST") {
			const who = await me();
			const b = await body(req);
			const asset = str(b, "asset").toUpperCase();
			const def = assetDef(asset);
			const amount = parse(str(b, "amount"), { symbol: asset, decimals: def.decimals });
			// Multi-network assets need a chain for the custody side.
			const custodyId = def.networks.length === 0
				? asset
				: `${asset}.${def.networks[0]!.id}`;
			venue.testnetCredit(who, asset, amount, custodyId);
			json(res, 200, { ok: true, asset, credited: fmt(amount, def.decimals) }, 0);
			return;
		}

		if (p === "/orders" && req.method === "POST") {
			const who = await me();
			const b = await body(req);
			const m = VENUE_MARKETS.find((x) => x.symbol === str(b, "market"));
			if (m === undefined) throw new VenueError("unknown market", 404);
			const side = str(b, "side");
			if (side !== "buy" && side !== "sell") {
				throw new VenueError('side must be "buy" or "sell"');
			}
			const bd = assetDef(m.base).decimals;
			const qd = assetDef(m.quote).decimals;
			const r = venue.placeOrder({
				accountId: who,
				market: m.symbol,
				side,
				price: parse(str(b, "price"), { symbol: m.quote, decimals: qd }),
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
				const qd = assetDef(m.quote).decimals;
				return {
					id: o.id, market: o.market, side: o.side, state: o.state,
					price: fmt(o.price, qd),
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
			const who = await me();
			const b = await body(req);
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
			const qd = assetDef(m.quote).decimals;
			const q = mmQuote({
				market: symbol,
				mid: parse(url.searchParams.get("mid") ?? "0", { symbol: m.quote, decimals: qd }),
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
				bids: q.bids.map((b) => ({ price: fmt(b.price, qd), amount: fmt(b.base, bd) })),
				asks: q.asks.map((a) => ({ price: fmt(a.price, qd), amount: fmt(a.base, bd) })),
			}, 0);
			return;
		}

		if (p === "/liquidity" && req.method === "GET") {
			const who = await me();
			json(res, 200, mm.list(who).map((pos) => {
				const m = marketDef(pos.market);
				const bd = assetDef(m.base).decimals;
				const qd = assetDef(m.quote).decimals;
				return {
					id: pos.id,
					market: pos.market,
					state: pos.state,
					mid: fmt(pos.mid, qd),
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
			const who = await me();
			const b = await body(req);
			const symbol = str(b, "market");
			const m = marketDef(symbol);
			const bd = assetDef(m.base).decimals;
			const qd = assetDef(m.quote).decimals;
			const r = mm.open({
				accountId: who,
				market: symbol,
				mid: parse(str(b, "mid"), { symbol: m.quote, decimals: qd }),
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
			const who = await me();
			const r = mm.close(who, closePos[1]!);
			json(res, 200, {
				cancelled: r.cancelled,
				// Named rather than hidden: a ladder that did its job is mostly
				// filled, and those fills are real trades that are NOT undone.
				alreadyFilledOrGone: r.alreadyGone,
			}, 0);
			return;
		}

		const cancel = /^\/orders\/([A-Za-z0-9_]+)\/cancel$/.exec(p);
		if (cancel !== null && req.method === "POST") {
			const who = await me();
			json(res, 200, { state: venue.cancelOrder(who, cancel[1]!).state }, 0);
			return;
		}

		json(res, 404, { error: "not found" });
	} catch (e) {
		// AN AUTH FAILURE KEEPS ITS OWN STATUS. Flattening a 401 to a 400 makes
		// the UI unable to tell "sign in" from "that order was invalid", and
		// flattening the 503 from an unreachable accounts service would send
		// customers round a sign-in loop that cannot succeed.
		if (e instanceof AuthError || e instanceof VenueError) {
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
		requireAllowlistedAddress: false,
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
	});
	// Market-maker ladders share the venue's book and its writable handle.
	const mm = new MarketMaker(wdb, venue);
	const deposits = new Deposits(wdb);
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
		totpSecrets: totpSecretsFrom(process.env.EXCHANGE_ADMIN_TOTP),
		houseAccountId: process.env.EXCHANGE_HOUSE_ACCOUNT ?? "house",
	};

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			try {
				const url = new URL(req.url ?? "/", `http://${HOST}`);

				if (await adminRoute(req, res, url, adminDeps)) return;

				// TRADING LIVES UNDER /v1 AND IS THE ONLY MUTABLE SURFACE.
				// Everything under /public stays GET-only, so the split is
				// visible in the URL rather than buried in a handler.
				if (url.pathname.startsWith("/v1/")) {
					await venueRoute(
						req, res, url, venue, wledger, wd, accountsAuth, liquidityOf,
						LIVE_FEES, pricing, mm, deposits,
					);
					return;
				}

				if (req.method !== "GET" && req.method !== "HEAD") {
					json(res, 405, { error: "this API is read-only" });
					return;
				}
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
						// So the deposit screen can hide the faucet rather than
						// offering a button that always 403s.
						faucetAvailable: !g.mainnetEnabled && !liveCustodian,
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
							const qd = assetDef(m.quote).decimals;
							const book = venue.book(m.symbol, 1);
							return {
								pair: `${m.base}/${m.quote}`,
								market: m.symbol,
								base: m.base,
								quote: m.quote,
								last: last === undefined ? null : fmt(last, qd),
								bid: book.bids[0] === undefined ? null : fmt(book.bids[0].price, qd),
								ask: book.asks[0] === undefined ? null : fmt(book.asks[0].price, qd),
								change24h: null,
								volume24h: null,
							};
						}),
					);
					return;
				}

				// Public order book and trade tape — no account needed to look.
				const bookMatch = /^\/book\/([A-Z0-9-]+)$/.exec(p);
				if (bookMatch !== null) {
					const sym = bookMatch[1]!;
					const m = VENUE_MARKETS.find((x) => x.symbol === sym);
					if (m === undefined) { json(res, 404, { error: "unknown market" }); return; }
					const bd = assetDef(m.base).decimals;
					const qd = assetDef(m.quote).decimals;
					const b = venue.book(sym);
					json(res, 200, {
						market: sym,
						bids: b.bids.map((x) => ({ price: fmt(x.price, qd), base: fmt(x.base, bd) })),
						asks: b.asks.map((x) => ({ price: fmt(x.price, qd), base: fmt(x.base, bd) })),
					});
					return;
				}
				const tradeMatch = /^\/trades\/([A-Z0-9-]+)$/.exec(p);
				if (tradeMatch !== null) {
					const sym = tradeMatch[1]!;
					const m = VENUE_MARKETS.find((x) => x.symbol === sym);
					if (m === undefined) { json(res, 404, { error: "unknown market" }); return; }
					const bd = assetDef(m.base).decimals;
					const qd = assetDef(m.quote).decimals;
					json(res, 200, venue.recentTrades(sym).map((t) => ({
						price: fmt(t.price, qd),
						base: fmt(t.base, bd),
						takerSide: t.takerSide,
						at: t.at,
					})));
					return;
				}
				if (p === "/markets") {
					json(res, 200, VENUE_MARKETS.map((m) => ({
						symbol: m.symbol, base: m.base, quote: m.quote,
						baseDecimals: assetDef(m.base).decimals,
						quoteDecimals: assetDef(m.quote).decimals,
						minBase: fmt(m.minBase, assetDef(m.base).decimals),
					})), 300);
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

				// /admin redirects to /admin/ so the console's relative API
				// paths resolve under it.
				if (url.pathname === "/admin") {
					res.writeHead(302, { Location: "/admin/" });
					res.end();
					return;
				}
				if (await serveStatic(res, url.pathname)) return;
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
