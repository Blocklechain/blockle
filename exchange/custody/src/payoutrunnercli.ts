// -----------------------------------------------------------------------------
// `node dist/src/payoutrunnercli.js` — the payout runner as a service.
//
// One pass per invocation, driven by a timer, for the same reason as the
// deposit watcher: a wedged internal loop reports "active" to systemd while
// paying nobody, and "active" is what an operator checks.
//
// EXIT CODES
//   0  the pass completed (per-payout errors are logged; a transient is not a
//      unit failure, or the alert becomes noise an operator learns to ignore)
//   1  the pass could not run at all — no token, no database, bad environment
//   3  APPROVED PAYOUTS WERE REFUSED for want of a signing passphrase. This is
//      separated from both of the above on purpose: customer funds are already
//      debited and waiting, so it must be visible as a distinct, actionable
//      failure rather than buried among transients.
// -----------------------------------------------------------------------------

import Database from "better-sqlite3";

import { ASSETS, settlementAsset } from "./assets";
import { BitGoHoldings } from "./bitgo";
import { BitGoPayouts } from "./bitgopayouts";
import { BitcoinRpcAdapter } from "./chains";
import { nodeAdapters } from "./custodyrouting";
import { coinBySymbol } from "./listed";
import { NodePayoutRail, SINGLE_INSTANCE_NOTE } from "./noderail";
import { pinAndVerify } from "./ipv4";
import { Ledger } from "./ledger";
import { runOnce } from "./payoutrunner";
import { MARKETS } from "./venue";
import { LIVE_FEES, type GasPricing } from "./withdrawalfees";
import { GAS_PRICE_FLOOR, StaticRates } from "./gasrates";
import { LIVE_GAS_COSTS, type GasGateDeps } from "./gasgate";
import { Withdrawals, type Policy } from "./withdrawals";

/** Our own chains are self-custodied; BitGo refuses them by design. */
const SELF_CUSTODIED = new Set(["BLOCK", "PERBUG"]);

async function main(): Promise<void> {
	// IPv4 FIRST. The token is whitelisted to this host's IPv4 address and the
	// box also has IPv6, so an unpinned request returns a 401 that reads
	// exactly like a bad token.
	try {
		await pinAndVerify("app.bitgo.com");
	} catch (e) {
		console.error(`IPv4 pin failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	const token = (process.env.BITGO_ACCESS_TOKEN ?? "").trim();
	if (token === "") {
		console.error(
			"BITGO_ACCESS_TOKEN is not set — no payout can be sent. Customer funds " +
				"that are already debited would sit in INFLIGHT indefinitely, so this " +
				"is a hard failure rather than an idle pass.",
		);
		process.exit(1);
	}
	const env = (process.env.BITGO_ENV ?? "test").trim().toLowerCase();
	if (env !== "test" && env !== "prod") {
		console.error(`BITGO_ENV must be "test" or "prod", got "${env}"`);
		process.exit(1);
	}

	const db = new Database(
		process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db",
	);
	db.pragma("busy_timeout = 10000");
	const ledger = new Ledger(db);

	/*
	 * THE POLICY HERE MUST MATCH THE API'S.
	 *
	 * The runner constructs its own Withdrawals to read and advance state. If
	 * the two disagreed about limits, a withdrawal accepted by one could be
	 * rejected by the other — so the figures are read from one place. They are
	 * only consulted for new requests, which this process never makes, but a
	 * divergence here would be a trap for whoever next adds a check.
	 */
	const policy: Policy = {
		autoApprove: true,
		approvalThreshold: {},
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

	const pricing: GasPricing = { sources: [new StaticRates(GAS_PRICE_FLOOR)] };
	const gas: GasGateDeps = {
		ledger,
		pendingOnChain: () => 0,
		table: LIVE_GAS_COSTS,
	};
	const withdrawals = new Withdrawals(db, ledger, policy, {
		feeTable: LIVE_FEES,
		pricing,
		gas,
	});

	const client = new BitGoPayouts(token, {
		env,
		// Absent means the runner refuses to send and says why, loudly.
		...(process.env.BITGO_WALLET_PASSPHRASE === undefined
			? {}
			: { passphrase: process.env.BITGO_WALLET_PASSPHRASE }),
	});

	// The wallet scope lives in the holdings adapter's configuration. A runner
	// that picked its own wallet could pay out of one the exchange does not own.
	const holdings = BitGoHoldings.fromEnv();
	const cache = new Map<string, { coin: string; walletId: string } | undefined>();
	const walletFor = async (
		custodyId: string,
	): Promise<{ coin: string; walletId: string } | undefined> => {
		if (cache.has(custodyId)) return cache.get(custodyId);
		let out: { coin: string; walletId: string } | undefined;
		const asset = settlementAsset(custodyId);
		if (ASSETS[asset] === undefined || SELF_CUSTODIED.has(asset)) {
			cache.set(custodyId, undefined);
			return undefined;
		}
		try {
			const coin = holdings.ticker(custodyId);
			const mine = await holdings.exchangeWallets(custodyId);
			out = mine[0] === undefined ? undefined : { coin, walletId: mine[0].id };
		} catch (e) {
			console.error(
				`${custodyId}: no exchange wallet (${e instanceof Error ? e.message : String(e)})`,
			);
			out = undefined;
		}
		cache.set(custodyId, out);
		return out;
	};

	void MARKETS; // the asset list comes from the withdrawal rows themselves

	/*
	 * RAILS FOR THE COINS BITGO DOES NOT HOLD.
	 *
	 * `SELF_CUSTODIED` above has always made `walletFor` return undefined for
	 * these, which stopped the runner attempting them on the wrong custodian —
	 * correct, but it also meant they could never be paid out at all. Now they
	 * have a rail of their own; `walletFor` still answers undefined, and the
	 * node rail ignores the wallet fields anyway.
	 *
	 * A coin with no node configured gets no rail and keeps the old behaviour:
	 * reported as unactionable rather than attempted.
	 */
	const nodeRails = new Map<string, NodePayoutRail>();
	for (const [symbol, adapter] of nodeAdapters({
		env: process.env,
		onSkip: (sym, why) => console.log(`  ${sym}: no payout rail (${why})`),
	})) {
		if (!(adapter instanceof BitcoinRpcAdapter)) {
			// Only the bitcoind family has the comment-based idempotency this
			// rail depends on. Anything else would need its own rail with its
			// own answer to "has this already been sent", and until it has one
			// it must not send at all.
			console.log(
				`  ${symbol}: ${adapter.route} has no payout rail yet — withdrawals ` +
					"for it stay unactioned rather than being sent without a " +
					"double-payment guard",
			);
			continue;
		}
		const coin = coinBySymbol(symbol);
		const confirmations = coin?.confirmations;
		if (confirmations === undefined) {
			console.log(`  ${symbol}: no confirmed settlement depth, so no payout rail`);
			continue;
		}
		nodeRails.set(symbol, new NodePayoutRail(adapter, confirmations));
	}
	if (nodeRails.size > 0) {
		console.log(`  node rails: ${[...nodeRails.keys()].join(", ")}`);
		// The weakness relative to BitGo, printed where someone reading the
		// logs during an incident will see it.
		console.log(`  NOTE: ${SINGLE_INSTANCE_NOTE}`);
	}

	const r = await runOnce({
		db, ledger, withdrawals, client, walletFor,
		railFor: (asset) => nodeRails.get(asset),
	});
	console.log(
		`payout-runner: ${r.sent} sent, ${r.recovered} recovered, ` +
			`${r.settled} settled, ${r.failed} reversed, ${r.waiting} confirming` +
			(r.refused > 0 ? `, ${r.refused} REFUSED` : ""),
	);
	for (const e of r.errors) console.error(`  ${e}`);

	if (r.refused > 0) process.exit(3);
	process.exit(0);
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
