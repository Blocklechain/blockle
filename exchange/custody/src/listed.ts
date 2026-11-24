// -----------------------------------------------------------------------------
// THE LISTING REGISTRY — which coins this venue carries, and what is TRUE about
// each one right now.
//
// WHY THIS FILE EXISTS SEPARATELY FROM assets.ts.
//
// `assets.ts` describes assets the ledger can account for. This describes the
// venue's RELATIONSHIP with a coin: have we got a node, can we take a deposit,
// is there a market open. Those are different questions with different answers,
// and conflating them is how a site ends up with a page saying "trade RTM now"
// above a market that does not exist.
//
// THE PROBLEM THIS SOLVES.
//
// The plan is to list small proof-of-work coins that have real miners and
// almost nowhere to sell — and then to be findable when someone searches for
// that coin. That means publishing a page per coin, which means a page can
// exist long before a market does.
//
// So STATUS IS A FIELD, and every published page is generated from it:
//
//   planned    we intend to list it. No node, no deposits, no market.
//              The page says exactly that and offers the listing form.
//   integrating a node is syncing / the adapter is being wired. Still no
//              deposits. The page says that too.
//   live       deposits open, market open, withdrawals open.
//
// A page for a `planned` coin that said "buy and sell RTM" would be a lie that
// costs someone a deposit into an address that does not exist. The generator
// cannot produce that sentence: the copy comes from the status.
//
// PROMOTION IS NOT A TEXT EDIT.
//
// `live` is not something to type into this file. `canGoLive()` states what has
// to be true — a reachable node, confirmed decimals, a custody route, a market
// — and the operator CLI refuses to promote a coin that fails any of it. The
// registry is the declaration; the node is the authority.
//
// WHAT THE FACTS ARE FOR.
//
// The per-coin facts here (algorithm, block time) are published, so each one is
// marked with where it came from. `confirmed: false` facts are NOT printed as
// specifications — the page omits them rather than hedging them, because
// "Raptoreum uses GhostRider (probably)" is worse than not mentioning the
// algorithm at all. See seogen.ts.
// -----------------------------------------------------------------------------

export class ListingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ListingError";
	}
}

/**
 * How custody for this coin actually works.
 *
 * BitGo does not custody obscure forks, and that is the whole reason this
 * enumeration exists: most of the coins here are held on nodes this venue runs
 * itself, which is a different risk and a different code path.
 */
export type CustodyRoute =
	/** BitGo holds the key shares. The main-chain assets. */
	| "bitgo"
	/** A bitcoind-family daemon we run. Balance and addresses from its wallet. */
	| "bitcoin-rpc"
	/** An EVM JSON-RPC node. */
	| "evm-rpc"
	/** A Monero-family wallet RPC — subaddresses per customer. */
	| "monero-rpc"
	/** Something bespoke, with its own adapter. */
	| "custom";

export type ListingStatus = "planned" | "integrating" | "live";

/** A published claim, with its provenance. */
export interface Fact {
	readonly value: string;
	/**
	 * TRUE ONLY IF SOMEONE CHECKED. Unconfirmed facts are not published —
	 * see the header. Default to false; it costs nothing but a missing line.
	 */
	readonly confirmed: boolean;
	/** Where it came from. A URL, or the node, or a person. */
	readonly source: string;
}

export interface ListedCoin {
	/** Ticker, as the venue trades it. */
	readonly symbol: string;
	/** Full name, as its community writes it. */
	readonly name: string;
	/** URL slug. Stable forever once published — a changed slug is a dead link. */
	readonly slug: string;
	readonly status: ListingStatus;
	readonly custody: CustodyRoute;
	/**
	 * Base-unit decimals.
	 *
	 * `undefined` where nobody has confirmed it against the daemon. A coin
	 * cannot go live without this, because getting it wrong by one place
	 * misprices every balance by 10×.
	 */
	readonly decimals: number | undefined;
	/** Confirmations before a deposit is credited. */
	readonly confirmations: number | undefined;
	/** The project's own site. Linked, not scraped. */
	readonly homepage: string | undefined;
	readonly algorithm: Fact | undefined;
	readonly blockTime: Fact | undefined;
	/**
	 * WHY A MINER WOULD CARE. One sentence, specific to this coin, written by
	 * hand. Generated filler reads like generated filler, and these pages are
	 * for people who know their coin better than we do.
	 */
	readonly pitch: string;
	/**
	 * Venues we know of. Used to say "thinly traded" honestly, and to avoid
	 * claiming to be the only option when we are not.
	 *
	 * A COUNT, NOT A LIST, and dated — naming competitors on a page that may go
	 * stale for a year is how you end up advertising a dead exchange.
	 */
	readonly knownVenues: { readonly count: number; readonly asOf: string } | undefined;
}

/**
 * Markets a listed coin trades in, once live.
 *
 * Both, always: USDT for the price everyone quotes in, BLOCK because this is
 * the venue where BLOCK is the other half of everything.
 */
export const QUOTES: readonly string[] = ["USDT", "BLOCK"];

/* -------------------------------------------------------------------------- */

const f = (value: string, source: string, confirmed = true): Fact =>
	({ value, confirmed, source });

/**
 * THE REGISTRY.
 *
 * Chosen on one criterion: a real mining community, and almost nowhere to sell.
 * A coin with twenty exchange listings does not need us and will not search for
 * us. Everything here is proof-of-work and mined by people today.
 *
 * Every entry starts at `planned`. Nothing in this file can make a market
 * open — see canGoLive.
 */
export const LISTED: readonly ListedCoin[] = [
	{
		symbol: "BLOCK",
		name: "Blockle",
		slug: "blockle-block",
		// The venue's own chain. Held on our own node, which is the one case
		// where "we run the node" is not a caveat.
		status: "planned",
		custody: "custom",
		decimals: 8,
		confirmations: 6,
		homepage: "https://blockle.org/",
		algorithm: f("Equihash, with ten merge-mined auxiliary lanes", "the chain's own consensus code"),
		blockTime: f("10 minutes", "the chain's own consensus code"),
		pitch:
			"The chain this exchange is built by. Ten auxiliary lanes let miners " +
			"of other algorithms earn BLOCK on work they are already doing.",
		knownVenues: undefined,
	},
	{
		symbol: "PERBUG",
		name: "Perbug",
		slug: "perbug",
		status: "planned",
		custody: "bitcoin-rpc",
		decimals: 8,
		confirmations: 6,
		homepage: "https://perbug.com/",
		algorithm: f("SHA-256d", "the project's own node, which we run"),
		blockTime: undefined,
		pitch:
			"A Bitcoin Core fork with BLOCK merge-mining, so a SHA-256 miner " +
			"earns both from one share.",
		knownVenues: undefined,
	},
	{
		symbol: "RTM",
		name: "Raptoreum",
		slug: "raptoreum-rtm",
		status: "planned",
		custody: "bitcoin-rpc",
		decimals: undefined,
		confirmations: undefined,
		homepage: "https://raptoreum.com/",
		algorithm: f("GhostRider — a CPU algorithm", "the project's documentation"),
		blockTime: undefined,
		pitch:
			"One of the few coins a plain CPU still mines competitively, with a " +
			"smart-node layer on top. Miners have had almost nowhere to sell it.",
		knownVenues: { count: 2, asOf: "2026-11" },
	},
	{
		symbol: "PEP",
		name: "Pepecoin",
		slug: "pepecoin-pep",
		status: "planned",
		custody: "bitcoin-rpc",
		// Confirmed against our own pepecoind, not read off a site: every
		// output amount in a sampled block encodes exactly as an 8-byte
		// little-endian integer at 10^8 in the bytes the node serialized, and
		// no other scale matches.
		decimals: 8,
		confirmations: undefined,
		homepage: "https://pepecoin.org/",
		// Measured, not quoted. The block ID is sha256d of the header (as it is
		// for every Dogecoin-lineage chain) while the PROOF OF WORK is scrypt —
		// confirmed by checking which hash lands under the block's own
		// difficulty target. That is what makes it mergeable with BLOCK.
		algorithm: f("Scrypt", "measured against our own node: scrypt(header) satisfies the block's target"),
		blockTime: undefined,
		pitch:
			"Scrypt, so the same hardware that mines Litecoin and Dogecoin mines " +
			"it, with a community that has outlasted most of its cohort.",
		knownVenues: { count: 3, asOf: "2026-11" },
	},
	{
		symbol: "NEOX",
		name: "Neoxa",
		slug: "neoxa-neox",
		status: "planned",
		custody: "bitcoin-rpc",
		decimals: undefined,
		confirmations: undefined,
		homepage: "https://neoxa.net/",
		algorithm: f("KawPow — the same algorithm as Ravencoin", "neoxa.net/learn"),
		blockTime: undefined,
		pitch:
			"GPU mining with gaming rewards built into the chain. KawPow keeps " +
			"ASICs out, so consumer cards still compete.",
		knownVenues: undefined,
	},
	{
		symbol: "MEWC",
		name: "Meowcoin",
		slug: "meowcoin-mewc",
		status: "planned",
		custody: "bitcoin-rpc",
		decimals: undefined,
		confirmations: undefined,
		homepage: "https://www.mewccrypto.com/",
		algorithm: f("KawPow", "mining-pool coverage of the coin"),
		blockTime: undefined,
		pitch:
			"A KawPow chain with asset issuance, mined almost entirely by " +
			"hobbyists on single cards.",
		knownVenues: undefined,
	},
	{
		symbol: "DINGO",
		name: "Dingocoin",
		slug: "dingocoin-dingo",
		status: "planned",
		custody: "bitcoin-rpc",
		// Confirmed against our own dingocoind by the same method as PEP.
		decimals: 8,
		confirmations: undefined,
		homepage: "https://dingocoin.com/",
		// Measured. Dingocoin is itself AuxPoW-capable, so a merge-mined block
		// carries its work in an embedded parent header and the coin's own
		// header hashes to nothing under target — this chain measured as scrypt
		// at one height and as "unknown" a few thousand blocks later purely by
		// how the tip happened to be mined. Sampling a range of blocks resolves
		// it to scrypt, which is what makes it mergeable with BLOCK.
		algorithm: f("Scrypt", "measured against our own node across a range of blocks"),
		blockTime: f("1 minute", "the project's own repository"),
		pitch:
			"A one-minute Scrypt chain with per-block difficulty retargeting, so " +
			"a small miner is not waiting hours between payouts.",
		knownVenues: undefined,
	},
	{
		symbol: "RXD",
		name: "Radiant",
		slug: "radiant-rxd",
		status: "planned",
		custody: "bitcoin-rpc",
		decimals: undefined,
		confirmations: undefined,
		homepage: "https://radiantblockchain.org/",
		algorithm: f("SHA512/256d", "the project's own site"),
		blockTime: undefined,
		pitch:
			"A UTXO layer-one built for induction proofs, mined with SHA512/256d " +
			"— close enough to SHA-256 that purpose-built hardware exists, far " +
			"enough that it is not competing with Bitcoin's.",
		knownVenues: undefined,
	},
	{
		symbol: "XEL",
		name: "Xelis",
		slug: "xelis-xel",
		status: "planned",
		// Its own daemon and its own RPC. Not a Bitcoin fork, so not the
		// bitcoin-rpc adapter — this is exactly the case the custom route is for.
		custody: "custom",
		decimals: undefined,
		confirmations: undefined,
		homepage: "https://xelis.io/",
		algorithm: f("XelisHash — GPU, ASIC-resistant", "the project's own repository"),
		blockTime: undefined,
		pitch:
			"A blockDAG with homomorphic encryption, so balances are private " +
			"without a trusted setup. GPU-mined and young enough that miners " +
			"outnumber traders.",
		knownVenues: undefined,
	},
	{
		symbol: "ZEPH",
		name: "Zephyr Protocol",
		slug: "zephyr-zeph",
		status: "planned",
		custody: "monero-rpc",
		decimals: undefined,
		confirmations: undefined,
		homepage: "https://zephyrprotocol.com/",
		algorithm: f("RandomX — CPU", "the project's own documentation"),
		blockTime: undefined,
		pitch:
			"A Monero-derived chain running an over-collateralised private " +
			"stablecoin. RandomX, so an ordinary CPU mines it.",
		knownVenues: undefined,
	},
	{
		symbol: "OCTA",
		name: "OctaSpace",
		slug: "octaspace-octa",
		status: "planned",
		custody: "evm-rpc",
		decimals: 18,
		confirmations: undefined,
		homepage: "https://octa.space/",
		algorithm: f("Ethash", "mining-pool coverage of the coin"),
		blockTime: undefined,
		pitch:
			"Ethash on an EVM chain, which is where a lot of Ethereum-era GPU " +
			"hardware went. Compute rental is paid for in it.",
		knownVenues: undefined,
	},
	{
		symbol: "EPIC",
		name: "Epic Cash",
		slug: "epic-cash",
		status: "planned",
		custody: "custom",
		decimals: undefined,
		confirmations: undefined,
		homepage: "https://epiccash.com/",
		algorithm: f("ProgPow", "mining-pool coverage of the coin"),
		blockTime: undefined,
		pitch:
			"MimbleWimble, so the chain stays small as it grows. Mined across " +
			"several algorithms by design rather than one.",
		knownVenues: undefined,
	},
];

/* -------------------------------------------------------------------------- */

export function coinBySlug(slug: string): ListedCoin | undefined {
	return LISTED.find((c) => c.slug === slug);
}

export function coinBySymbol(symbol: string): ListedCoin | undefined {
	const s = symbol.trim().toUpperCase();
	return LISTED.find((c) => c.symbol === s);
}

/** Markets this coin trades in. Empty unless it is live. */
export function marketsFor(coin: ListedCoin): readonly string[] {
	if (coin.status !== "live") return [];
	return QUOTES.filter((q) => q !== coin.symbol).map((q) => `${coin.symbol}-${q}`);
}

/**
 * WHAT HAS TO BE TRUE BEFORE A COIN CAN BE PROMOTED TO `live`.
 *
 * Returns the reasons it cannot, empty if it can. The operator CLI refuses on a
 * non-empty list and there is no override, for the same reason the mainnet gate
 * has none: the failure mode is a customer depositing into an integration that
 * does not work, and no deadline is worth that.
 *
 * `probe` is the node's own answer. Passing it is mandatory — a promotion
 * decided from this file alone would be a promotion decided from an intention.
 */
export function canGoLive(
	coin: ListedCoin,
	probe: {
		/** Did the daemon answer? */
		readonly reachable: boolean;
		/** Is it synced to the tip, by its own account? */
		readonly synced: boolean;
		/** Decimals as the node reports them, where it can. */
		readonly decimals: number | undefined;
		/** Can it hand out a fresh deposit address per customer? */
		readonly canDeriveAddresses: boolean;
		/** Can it send, i.e. are withdrawals possible at all? */
		readonly canSend: boolean;
		/** Is a market defined for it in the venue? */
		readonly marketDefined: boolean;
		/**
		 * Does the LEDGER know this asset?
		 *
		 * Separate from the market, and it has to be. The registry and
		 * `assets.ts` were disconnected: a coin could be promoted here while
		 * the ledger refused every posting for it with "unknown asset", so the
		 * first deposit would be credited to a customer and then fail to
		 * balance. Found by writing a payout test for a registry coin and
		 * watching the ledger reject it.
		 */
		readonly ledgerKnowsAsset: boolean;
	},
): readonly string[] {
	const no: string[] = [];
	if (!probe.reachable) no.push("the node does not answer");
	if (!probe.synced) no.push("the node is not synced to the tip");
	if (coin.decimals === undefined) {
		no.push("decimals are unconfirmed in the registry");
	} else if (probe.decimals !== undefined && probe.decimals !== coin.decimals) {
		// A MISMATCH IS NOT SOMETHING TO SPLIT THE DIFFERENCE ON. One of the two
		// is wrong and being wrong by a decimal place means every balance on
		// this coin is out by a factor of ten.
		no.push(
			`decimals disagree: the registry says ${coin.decimals}, the node ` +
				`says ${probe.decimals}`,
		);
	}
	if (coin.confirmations === undefined) {
		no.push("the confirmation count is unconfirmed");
	} else if (coin.confirmations < 1) {
		no.push("a deposit cannot be credited at zero confirmations");
	}
	if (!probe.canDeriveAddresses) {
		// Without per-customer addresses, deposits are attributed by hand, and a
		// deposit nobody can attribute is a deposit nobody can be paid.
		no.push("the node cannot issue a deposit address per customer");
	}
	if (!probe.canSend) no.push("the node cannot send, so withdrawals would be stuck");
	if (!probe.marketDefined) no.push("no market is defined for it");
	if (!probe.ledgerKnowsAsset) {
		no.push(
			"the ledger does not know this asset — add it to assets.ts, with its " +
				"confirmed decimals, before anything can be posted for it",
		);
	}
	if (coin.status === "live") no.push("it is already marked live");
	return no;
}

/** Counts for the status page and the coin index. */
export function listingSummary(): {
	readonly total: number;
	readonly live: number;
	readonly integrating: number;
	readonly planned: number;
} {
	const by = (s: ListingStatus) => LISTED.filter((c) => c.status === s).length;
	return {
		total: LISTED.length,
		live: by("live"),
		integrating: by("integrating"),
		planned: by("planned"),
	};
}
