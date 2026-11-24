// -----------------------------------------------------------------------------
// ASSETS AND NETWORKS — the model that makes multi-chain USDT correct.
//
// THE PROBLEM, STATED PRECISELY.
//
// "USDT" is not one token. Tether deploys a separate contract on each chain:
// ERC-20 USDT on Ethereum, TRC-20 USDT on Tron, an SPL mint on Solana, and so
// on. They are NOT interchangeable on-chain — you cannot send ERC-20 USDT to a
// Tron address, and no contract can move a balance from one to the other.
// Crossing chains means either Tether's own burn-and-mint (institutional, with
// minimums) or a third-party bridge.
//
// BITGO DOES NOT CONVERT BETWEEN THEM. It custodies each as a distinct asset.
// Asking custody to "convert TRC-20 USDT to ERC-20 USDT on withdrawal" is
// asking for something that does not exist at the custody layer.
//
// THE RESOLUTION IS TO STOP NEEDING CONVERSION.
//
// To a customer, USDT is one balance — they deposited 500 and they have 500.
// That is a LIABILITY, and it is fungible. What is not fungible is the
// INVENTORY backing it, which lives on specific chains.
//
//     LIABILITY   user:alice:USDT = 500          one number, fungible
//     INVENTORY   custody::USDT.ERC20 = 300      three holdings,
//                 custody::USDT.TRC20 = 150      not interchangeable
//                 custody::USDT.SOL   =  50
//
// So a deposit on ANY network credits the single USDT balance, and a withdrawal
// names a network and is paid from that network's inventory. If TRC-20
// inventory is short, TRON withdrawals are disabled — not USDT withdrawals.
// Rebalancing between chains is an occasional treasury operation, not something
// that happens per withdrawal. This is what every major venue does, and it is
// why they all make you pick a network.
//
// WHAT THIS COSTS IN THE LEDGER.
//
// The zero-sum invariant was "postings for each asset sum to zero". That breaks
// the moment a deposit credits `user:alice:USDT` and `custody::USDT.TRC20`,
// because those read as two different assets.
//
// So the invariant is restated in terms of the SETTLEMENT ASSET: every network
// variant settles to its base asset, and sums are checked per settlement asset.
// `USDT.TRC20` and `USDT.ERC20` both settle to `USDT`, so that deposit balances
// correctly — while custody remains queryable per network, which is what
// reconciliation and inventory need.
//
// The invariant is not weakened: value still cannot be created or destroyed. It
// is stated at the level where fungibility is actually true.
// -----------------------------------------------------------------------------

export class AssetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssetError";
	}
}

/**
 * A chain a multi-network asset can live on.
 *
 * The identifier is the suffix after the dot in a qualified asset id, so
 * `USDT.TRC20` is USDT on Tron.
 */
export interface Network {
	/** Suffix used in qualified asset ids. */
	readonly id: string;
	/** What a customer sees in a network picker. */
	readonly label: string;
	/** BitGo's coin ticker for this asset on this chain, per environment. */
	readonly bitgo: { readonly prod: string; readonly test: string } | undefined;
	/**
	 * Typical withdrawal cost on this chain, as an ORDER OF MAGNITUDE only, for
	 * sorting the picker so the cheap chain is the obvious default. Never used
	 * as an actual fee — the real fee comes from the chain at send time.
	 */
	readonly costHint: "low" | "medium" | "high";
	/**
	 * THE ASSET THE CHAIN TAKES ITS FEE IN — which is not the asset being sent.
	 *
	 * Sending USDT over Ethereum costs ETH. The USDT moves; the ETH is burned
	 * out of custody. Booking that gas against USDT — which the first version of
	 * `confirm()` did — debits a custody holding that never moved, producing a
	 * permanent phantom USDT shortfall and a phantom ETH surplus. Since a
	 * shortfall halts withdrawals via the reconciliation interlock, that is not
	 * a cosmetic error: every token withdrawal would move the venue one step
	 * closer to halting itself.
	 *
	 * Undefined means "the asset itself" — a BTC send pays its fee in BTC.
	 */
	readonly gasAsset?: string;
}

/** Asset definitions: decimals, and the networks it exists on. */
export interface AssetDef {
	readonly symbol: string;
	readonly decimals: number;
	/**
	 * Empty for single-chain assets (BTC, ETH, BLOCK). Non-empty means the
	 * asset is MULTI-NETWORK and every custody posting must name a network.
	 */
	readonly networks: readonly Network[];
}

const TRON: Network = {
	id: "TRC20",
	label: "Tron (TRC-20)",
	bitgo: { prod: "trx:usdt", test: "ttrx:usdt" },
	costHint: "low",
	gasAsset: "TRX",
};
const ETHEREUM: Network = {
	id: "ERC20",
	label: "Ethereum (ERC-20)",
	bitgo: { prod: "eth:usdt", test: "teth:usdt" },
	costHint: "high",
	gasAsset: "ETH",
};
const SOLANA: Network = {
	id: "SOL",
	label: "Solana (SPL)",
	bitgo: { prod: "sol:usdt", test: "tsol:usdt" },
	costHint: "low",
	gasAsset: "SOL",
};
const BSC: Network = {
	id: "BEP20",
	label: "BNB Smart Chain (BEP-20)",
	bitgo: { prod: "bsc:usdt", test: "tbsc:usdt" },
	costHint: "low",
	gasAsset: "BNB",
};

/**
 * The asset registry.
 *
 * USDT and USDC are multi-network. Everything else is single-chain, and
 * `networks: []` is what says so — it is not a placeholder, it is the statement
 * that a custody posting for that asset must NOT carry a network.
 */
export const ASSETS: Readonly<Record<string, AssetDef>> = {
	USDT: {
		symbol: "USDT",
		// 6 on Ethereum, Tron and Solana. NOT 18 — a common and expensive
		// mistake, since treating 6-decimal USDT as 18-decimal understates a
		// balance by a factor of 10^12.
		decimals: 6,
		networks: [TRON, ETHEREUM, SOLANA, BSC],
	},
	USDC: {
		symbol: "USDC",
		decimals: 6,
		networks: [
			{ ...ETHEREUM, bitgo: { prod: "eth:usdc", test: "teth:usdc" } },
			{ ...SOLANA, bitgo: { prod: "sol:usdc", test: "tsol:usdc" } },
			{ ...TRON, bitgo: { prod: "trx:usdc", test: "ttrx:usdc" } },
		],
	},
	BTC: { symbol: "BTC", decimals: 8, networks: [] },
	ETH: { symbol: "ETH", decimals: 18, networks: [] },
	SOL: { symbol: "SOL", decimals: 9, networks: [] },
	DOGE: { symbol: "DOGE", decimals: 8, networks: [] },
	TRX: { symbol: "TRX", decimals: 6, networks: [] },
	// Listed because BEP-20 withdrawals burn BNB as gas, and gas we spend has
	// to have somewhere to be booked even before BNB itself is tradeable.
	BNB: { symbol: "BNB", decimals: 18, networks: [] },
	XRP: { symbol: "XRP", decimals: 6, networks: [] },
	BLOCK: { symbol: "BLOCK", decimals: 8, networks: [] },
	PERBUG: { symbol: "PERBUG", decimals: 8, networks: [] },
};

/**
 * The settlement asset for a (possibly network-qualified) asset id.
 *
 *     settlementAsset("USDT.TRC20") === "USDT"
 *     settlementAsset("USDT")       === "USDT"
 *     settlementAsset("BTC")        === "BTC"
 *
 * This is the function the ledger's zero-sum invariant is stated over. It is
 * deliberately total — an unknown id returns itself rather than throwing — so
 * that the ledger can check an invariant on data it does not recognise instead
 * of refusing to account for it at all.
 */
export function settlementAsset(assetId: string): string {
	const dot = assetId.indexOf(".");
	return dot === -1 ? assetId : assetId.slice(0, dot);
}

/** The network part, or undefined for an unqualified id. */
export function networkOf(assetId: string): string | undefined {
	const dot = assetId.indexOf(".");
	return dot === -1 ? undefined : assetId.slice(dot + 1);
}

/** Build a qualified id, validating that the pairing exists. */
export function qualify(symbol: string, networkId: string): string {
	const def = ASSETS[symbol];
	if (def === undefined) throw new AssetError(`unknown asset ${symbol}`);
	if (def.networks.length === 0) {
		throw new AssetError(
			`${symbol} is single-chain; it must not be qualified with a network`,
		);
	}
	if (!def.networks.some((n) => n.id === networkId)) {
		throw new AssetError(
			`${symbol} is not deployed on ${networkId} — available: ` +
				def.networks.map((n) => n.id).join(", "),
		);
	}
	return `${symbol}.${networkId}`;
}

export function assetDef(assetId: string): AssetDef {
	const sym = settlementAsset(assetId);
	const def = ASSETS[sym];
	if (def === undefined) throw new AssetError(`unknown asset ${sym}`);
	return def;
}

/** True when custody postings for this asset must carry a network. */
export function isMultiNetwork(assetId: string): boolean {
	return assetDef(assetId).networks.length > 0;
}

/** Every qualified custody id for an asset — what reconciliation iterates. */
export function custodyIds(symbol: string): readonly string[] {
	const def = ASSETS[symbol];
	if (def === undefined) throw new AssetError(`unknown asset ${symbol}`);
	return def.networks.length === 0
		? [symbol]
		: def.networks.map((n) => `${symbol}.${n.id}`);
}

export function networkDef(assetId: string): Network | undefined {
	const net = networkOf(assetId);
	if (net === undefined) return undefined;
	return assetDef(assetId).networks.find((n) => n.id === net);
}

/**
 * Validate that an asset id is one we can actually account for.
 *
 * REJECTS the two dangerous shapes:
 *   - a multi-network asset used WITHOUT a network on a custody posting
 *     (which chain is that inventory on? unanswerable, and reconciliation
 *     would compare it against nothing)
 *   - a single-chain asset used WITH one (`BTC.ERC20` is not a thing, and
 *     accepting it would silently create a second, phantom BTC balance)
 */
export function assertCustodyId(assetId: string): void {
	const sym = settlementAsset(assetId);
	const def = ASSETS[sym];
	if (def === undefined) throw new AssetError(`unknown asset ${sym}`);
	const net = networkOf(assetId);

	if (def.networks.length > 0 && net === undefined) {
		throw new AssetError(
			`${sym} exists on ${def.networks.length} chains, so a custody holding ` +
				`must name one (e.g. ${sym}.${def.networks[0]!.id}). An unqualified ` +
				`custody balance cannot be reconciled against any chain.`,
		);
	}
	if (def.networks.length === 0 && net !== undefined) {
		throw new AssetError(
			`${sym} is single-chain; "${assetId}" would create a phantom balance`,
		);
	}
	if (net !== undefined && !def.networks.some((n) => n.id === net)) {
		throw new AssetError(
			`${sym} is not deployed on ${net} — available: ` +
				def.networks.map((n) => n.id).join(", "),
		);
	}
}

/** BitGo ticker for a qualified custody id, per environment. */
export function bitgoTicker(assetId: string, env: "prod" | "test"): string {
	const net = networkDef(assetId);
	if (net !== undefined) {
		if (net.bitgo === undefined) {
			throw new AssetError(`${assetId} has no BitGo mapping — self-custodied`);
		}
		return net.bitgo[env];
	}
	// Single-chain assets keep their mapping in bitgo.ts's own table; this
	// function only resolves the multi-network ones, where the mapping is
	// network-specific and belongs beside the network definition.
	throw new AssetError(
		`${assetId} is single-chain; resolve it through bitgo.ts TICKERS`,
	);
}

/**
 * Networks a customer may withdraw an asset over, cheapest-hint first.
 *
 * Sorted so the low-cost chain is the natural default. For USDT that puts Tron
 * ahead of Ethereum, which is what a customer wants and what keeps our Ethereum
 * inventory from being drained by people who did not care which chain they got.
 */
export function withdrawalNetworks(symbol: string): readonly Network[] {
	const order = { low: 0, medium: 1, high: 2 } as const;
	return [...(ASSETS[symbol]?.networks ?? [])].sort(
		(a, b) => order[a.costHint] - order[b.costHint],
	);
}

/**
 * The asset a withdrawal's gas is actually paid in.
 *
 *     gasAssetFor("USDT", "ERC20") === "ETH"
 *     gasAssetFor("USDT", "TRC20") === "TRX"
 *     gasAssetFor("BTC",  undefined) === "BTC"
 *
 * This exists because the asset leaving custody as a fee is routinely NOT the
 * asset the customer asked for, and the ledger has to debit the holding that
 * genuinely moved. See the note on `Network.gasAsset`.
 */
export function gasAssetFor(symbol: string, network: string | undefined): string {
	const def = assetDef(symbol);
	if (def.networks.length === 0) {
		if (network !== undefined) {
			throw new AssetError(`${symbol} is single-chain; do not name a network`);
		}
		return symbol;
	}
	if (network === undefined) {
		throw new AssetError(
			`${symbol} is multi-network, so its gas asset depends on the chain — ` +
				"name one",
		);
	}
	const net = def.networks.find((n) => n.id === network);
	if (net === undefined) {
		throw new AssetError(`${symbol} is not available on ${network}`);
	}
	return net.gasAsset ?? symbol;
}
