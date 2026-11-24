// -----------------------------------------------------------------------------
// GENERATE THE BITGO CUSTODY WALLETS.
//
// Run ONCE per environment, on the whitelisted host. Idempotent: a coin that
// already has a wallet is skipped, so re-running is safe.
//
// ============================ READ THIS FIRST ============================
//
// THIS CREATES KEY MATERIAL, AND TWO SECRETS COME OUT OF IT THAT CANNOT BE
// RECOVERED LATER:
//
//   1. THE WALLET PASSPHRASE. It encrypts the user key share. BitGo cannot
//      reset it and does not hold it. Lose it and the user share is
//      permanently undecryptable.
//
//   2. THE BACKUP KEY xprv. BitGo returns this ONCE, at creation, in the clear,
//      and never again. It is the key that lets you recover funds if BitGo
//      itself is unavailable. There is no second chance to copy it down.
//
// Lose both and the funds in those wallets are gone — not frozen, gone. So this
// script writes everything to a single root-only 0600 file and then tells the
// operator, in the imperative, to move it somewhere offline. It deliberately
// does NOT print secrets to stdout, because stdout ends up in journald, in
// terminal scrollback, and in whatever is capturing this session.
//
// WHY THE SDK AND NOT RAW REST. Creating a wallet means generating BIP32
// keychains, encrypting the user share, and registering three public keys in
// the right order. Hand-rolling that over REST would be hand-rolling custody
// key handling, which is the single worst thing in this codebase to get subtly
// wrong. The SDK is the vendor's own and does it for us.
// -----------------------------------------------------------------------------

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { pinIPv4 } from "./ipv4";

export class WalletGenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WalletGenError";
	}
}

/**
 * The coins to create wallets for, per environment.
 *
 * Token wallets are NOT created separately: an ERC-20 like USDT lives inside
 * the chain's wallet (teth holds teth:usdt), so creating a "USDT wallet" would
 * be a category error. One wallet per CHAIN, and tokens are balances within it.
 */
const COINS: Readonly<Record<"test" | "prod", readonly string[]>> = {
	// `hteth` (Holesky), NOT `teth`. BitGo retired the Goerli coin and `teth`
	// now fails with a bare "coin unsupported" — which reads like a bad coin
	// name rather than a retired network, and cost a round of debugging.
	test: ["tbtc", "hteth", "tbsc", "tpolygon", "tsol", "ttrx", "tdoge", "tltc", "tbch", "txrp", "txlm"],
	prod: ["btc", "eth", "bsc", "polygon", "sol", "trx", "doge", "ltc", "bch", "xrp", "xlm"],
};

/**
 * Wallet-creation option sets, tried in order until one is accepted.
 *
 * WHY A SEQUENCE RATHER THAN ONE SET. What a coin accepts depends on the
 * ENTERPRISE's configuration, not just the coin. This enterprise is TSS-only
 * for EVM chains, which surfaces as:
 *
 *   "EVM TSS wallets are only supported for wallet version 3, 5 and 6"
 *
 * — while non-EVM chains here take plain multisig and REJECT a TSS version
 * outright. Hard-coding either one fails half the list, and the error messages
 * do not say which half. So each coin is offered TSS v3, then TSS v5 (MPCv2,
 * which newer chains want and eth explicitly does not), then plain multisig,
 * and the first acceptance is recorded so a future run knows what worked.
 */
const ATTEMPTS: readonly Record<string, unknown>[] = [
	{ multisigType: "tss", walletVersion: 3 },
	{ multisigType: "tss", walletVersion: 5 },
	{},
];

export interface GeneratedWallet {
	readonly coin: string;
	/** Which option set BitGo accepted — TSS version, or plain multisig. */
	readonly createdWith?: Record<string, unknown>;
	readonly id: string;
	readonly label: string;
	readonly receiveAddress: string | undefined;
	/** BitGo's one-time backup xprv. IRRECOVERABLE IF LOST. */
	readonly backupXprv: string | undefined;
	readonly backupXpub: string | undefined;
	readonly userXpub: string | undefined;
	readonly bitgoXpub: string | undefined;
}

export interface GenResult {
	readonly created: readonly GeneratedWallet[];
	readonly skipped: readonly { coin: string; id: string; reason: string }[];
	readonly failed: readonly { coin: string; error: string }[];
	readonly secretsFile: string;
	readonly passphraseFile: string;
}

/**
 * Load or create the wallet passphrase.
 *
 * CREATED ONCE AND REUSED, because every wallet sharing one passphrase is what
 * makes the signing service workable — and because a per-wallet passphrase
 * multiplies the number of irrecoverable secrets by nine without making
 * anything safer (they would all live in the same file anyway).
 *
 * 32 bytes of randomness, hex. Not a human-memorable phrase: nobody needs to
 * type this, so there is no reason to weaken it for typability.
 */
function passphrase(path: string): string {
	if (existsSync(path)) {
		const p = readFileSync(path, "utf8").trim();
		if (p.length < 32) {
			throw new WalletGenError(
				`${path} exists but holds something too short to be the passphrase. ` +
					"Refusing to continue: overwriting it would orphan any wallet " +
					"already encrypted with the real one.",
			);
		}
		return p;
	}
	const p = randomBytes(32).toString("hex");
	writeFileSync(path, `${p}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return p;
}

export async function generate(opts: {
	env: "test" | "prod";
	enterprise: string;
	secretsFile: string;
	passphraseFile: string;
	/** Injected for tests. */
	sdk?: unknown;
	log?: (s: string) => void;
}): Promise<GenResult> {
	const log = opts.log ?? console.log;

	// The BitGo token is IP-restricted to this host's IPv4 and the box also has
	// IPv6 — an unpinned request returns a 401 that reads exactly like a bad
	// token. Pin before the first call, not after.
	pinIPv4();

	const token = process.env.BITGO_ACCESS_TOKEN;
	if (token === undefined || token.trim() === "") {
		throw new WalletGenError("BITGO_ACCESS_TOKEN is not set");
	}

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { BitGo } = require("bitgo") as { BitGo: new (o: object) => BitGoLike };
	const bitgo: BitGoLike =
		(opts.sdk as BitGoLike | undefined) ??
		new BitGo({ env: opts.env === "prod" ? "prod" : "test", accessToken: token });

	const pass = passphrase(opts.passphraseFile);

	const created: GeneratedWallet[] = [];
	const skipped: { coin: string; id: string; reason: string }[] = [];
	const failed: { coin: string; error: string }[] = [];

	for (const coin of COINS[opts.env]) {
		try {
			const c = bitgo.coin(coin);

			// IDEMPOTENT. A second run must not create a second wallet per coin:
			// two hot wallets on one chain means deposits land in whichever the
			// address came from and reconciliation has to know about both.
			const existing = await c.wallets().list({ limit: 25 });
			// THE SDK RETURNS Wallet OBJECTS, NOT PLAIN JSON. `label` and `id`
			// are METHODS on them, so `w.label ?? ""` yields a function and
			// `.startsWith` throws — which is what happened: eight coins that
			// already had wallets were reported as FAILED rather than skipped.
			//
			// No duplicates were created (the throw preceded generation), but
			// idempotency was broken, which is the one property this check
			// exists to provide. Handle both shapes, because `list()` has
			// returned plain objects in other SDK versions.
			const nameOf = (w: { label?: unknown }): string => {
				const l = w.label;
				const v = typeof l === "function" ? (l as () => unknown).call(w) : l;
				return typeof v === "string" ? v : "";
			};
			const idOf = (w: { id?: unknown }): string => {
				const i = w.id;
				const v = typeof i === "function" ? (i as () => unknown).call(w) : i;
				return typeof v === "string" ? v : "(unknown)";
			};
			const already = (existing.wallets ?? []).find((w) =>
				nameOf(w).startsWith("Blockle Exchange"),
			);
			if (already !== undefined) {
				const id = idOf(already);
				skipped.push({ coin, id, reason: "a Blockle Exchange wallet already exists" });
				log(`  ${coin.padEnd(9)} skipped — already exists (${id})`);
				continue;
			}

			log(`  ${coin.padEnd(9)} generating …`);
			let res: Awaited<ReturnType<ReturnType<typeof c.wallets>["generateWallet"]>> | undefined;
			let usedOpts: Record<string, unknown> = {};
			let lastErr = "";
			for (const attempt of ATTEMPTS) {
				try {
					res = await c.wallets().generateWallet({
						label: `Blockle Exchange ${coin.toUpperCase()}`,
						passphrase: pass,
						enterprise: opts.enterprise,
						...attempt,
					});
					usedOpts = attempt;
					break;
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
				}
			}
			if (res === undefined) throw new WalletGenError(lastErr);

			const w: GeneratedWallet = {
				coin,
				createdWith: usedOpts,
				id: res.wallet?.id?.() ?? res.wallet?._wallet?.id ?? "(unknown)",
				label: `Blockle Exchange ${coin.toUpperCase()}`,
				receiveAddress:
					res.wallet?.receiveAddress?.() ?? res.wallet?._wallet?.receiveAddress,
				backupXprv: res.backupKeychain?.prv,
				backupXpub: res.backupKeychain?.pub,
				userXpub: res.userKeychain?.pub,
				bitgoXpub: res.bitgoKeychain?.pub,
			};
			created.push(w);
			// Address only — never a key — to stdout.
			log(`  ${coin.padEnd(9)} created ${w.id}  ${w.receiveAddress ?? ""}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			failed.push({ coin, error: msg });
			log(`  ${coin.padEnd(9)} FAILED: ${msg.slice(0, 120)}`);
		}
	}

	// Write the secrets BEFORE anything else can go wrong. If the process died
	// after creating wallets but before persisting the backup xprvs, those keys
	// would be gone for good.
	if (created.length > 0) {
		const prior = existsSync(opts.secretsFile)
			? (JSON.parse(readFileSync(opts.secretsFile, "utf8")) as { wallets?: unknown[] })
			: {};
		const payload = {
			warning:
				"IRRECOVERABLE SECRETS. backupXprv is returned by BitGo exactly once, " +
				"at creation, and never again. The passphrase in the companion file " +
				"decrypts the user key share and cannot be reset. Move this file " +
				"offline and keep a second copy somewhere else. Losing both means " +
				"losing the funds in these wallets.",
			env: opts.env,
			enterprise: opts.enterprise,
			generatedAt: new Date().toISOString(),
			wallets: [...((prior.wallets as unknown[]) ?? []), ...created],
		};
		writeFileSync(opts.secretsFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
		chmodSync(opts.secretsFile, 0o600);
	}

	return {
		created,
		skipped,
		failed,
		secretsFile: opts.secretsFile,
		passphraseFile: opts.passphraseFile,
	};
}

// Minimal structural types for the parts of the SDK used above. Typed locally
// rather than pulled from the SDK's own types, which are large and version-
// sensitive; only these few shapes matter here.
interface BitGoLike {
	coin(name: string): {
		wallets(): {
			// `id` and `label` are METHODS on the SDK's Wallet objects, not fields.
		list(o: { limit: number }): Promise<{ wallets?: { id?: unknown; label?: unknown }[] }>;
			generateWallet(o: {
				label: string;
				passphrase: string;
				enterprise: string;
				[k: string]: unknown;
			}): Promise<{
				wallet?: {
					id?: () => string;
					receiveAddress?: () => string;
					_wallet?: { id?: string; receiveAddress?: string };
				};
				userKeychain?: { pub?: string; prv?: string };
				backupKeychain?: { pub?: string; prv?: string };
				bitgoKeychain?: { pub?: string };
			}>;
		};
	};
}

export async function main(): Promise<void> {
	const env = (process.env.BITGO_ENV ?? "test").trim().toLowerCase();
	if (env !== "test" && env !== "prod") {
		throw new WalletGenError(`BITGO_ENV must be "test" or "prod", got "${env}"`);
	}
	const enterprise = process.env.BITGO_ENTERPRISE;
	if (enterprise === undefined || enterprise.trim() === "") {
		throw new WalletGenError(
			"BITGO_ENTERPRISE is required — without it wallets are created outside " +
				"the enterprise and will not appear in its balances or policies",
		);
	}

	const dir = process.env.BITGO_SECRET_DIR ?? "/etc/blockle";
	console.log(`generating BitGo wallets (${env}, enterprise ${enterprise})`);
	const res = await generate({
		env,
		enterprise: enterprise.trim(),
		secretsFile: `${dir}/bitgo-wallets.${env}.json`,
		passphraseFile: `${dir}/bitgo-passphrase.${env}`,
	});

	console.log(
		`\ncreated ${res.created.length}, skipped ${res.skipped.length}, ` +
			`failed ${res.failed.length}`,
	);
	if (res.created.length > 0) {
		console.log(`
============================================================
DO THIS NOW, BEFORE ANYTHING ELSE:

  ${res.secretsFile}
  ${res.passphraseFile}

Those two files are the only copies of secrets BitGo will not
give you again. Copy them somewhere offline — a password
manager or an encrypted drive, not this server. If the box is
lost with them on it, the funds in these wallets are lost too.

Both are 0600 and root-owned. Nothing was printed to this
terminal except wallet ids and receive addresses.
============================================================`);
	}
	if (res.failed.length > 0) process.exit(1);
}

if (require.main === module) {
	void main().catch((e: unknown) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	});
}
