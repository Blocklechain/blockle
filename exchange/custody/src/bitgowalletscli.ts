// -----------------------------------------------------------------------------
// `node dist/src/bitgowalletscli.js --confirm` — create the custody wallets.
//
// bitgowallets.ts had no runner, so the one operation the venue cannot go live
// without had to be driven by hand. This is that runner, and it is deliberately
// joyless: it prints what it is about to do, refuses without `--confirm`, and
// says what must be moved offline afterwards.
//
// READ bitgowallets.ts's header BEFORE running this. Two secrets come out of it
// that cannot be recovered: the wallet passphrase, and each wallet's backup key
// xprv, which BitGo returns once at creation and never again. They are written
// to a single root-only file and that file is the only copy. Lose it and the
// funds in those wallets are gone — not frozen, gone.
//
// WHY A SEPARATE ENTRY POINT rather than folding this into golivecli: that
// module can flip the live gate, and a module that can both mint custody keys
// and open the venue is one typo away from doing both at once.
// -----------------------------------------------------------------------------

import { generate } from "./bitgowallets";
import { pinAndVerify } from "./ipv4";

function env(name: string, fallback?: string): string {
	const v = process.env[name];
	if (v !== undefined && v.trim() !== "") return v.trim();
	if (fallback !== undefined) return fallback;
	throw new Error(`${name} is not set`);
}

async function main(): Promise<void> {
	/*
	 * PIN IPv4 FIRST. The BitGo token is restricted to this host's IPv4 address
	 * and the box also has IPv6; an unpinned request returns a 401 that reads
	 * exactly like a bad token. Same reason golivecli does this.
	 */
	await pinAndVerify();

	const bitgoEnv = env("BITGO_ENV") === "prod" ? "prod" : "test";
	const enterprise = env("BITGO_ENTERPRISE");
	const secretsFile = env("BITGO_SECRETS_FILE", "/etc/blockle/secrets/bitgo-wallets.json");
	const passphraseFile = env(
		"BITGO_PASSPHRASE_FILE",
		"/etc/blockle/secrets/bitgo-wallet-passphrase",
	);

	console.log("BitGo custody wallet generation");
	console.log(`  environment : ${bitgoEnv}${bitgoEnv === "prod" ? "  (REAL MONEY)" : ""}`);
	console.log(`  enterprise  : ${enterprise}`);
	console.log(`  secrets     : ${secretsFile}`);
	console.log(`  passphrase  : ${passphraseFile}`);
	console.log("");
	console.log("  Existing wallets whose label starts with 'Blockle Exchange' are");
	console.log("  SKIPPED, so this is safe to re-run and will not adopt another");
	console.log("  project's wallet in a shared enterprise.");
	console.log("");

	if (!process.argv.includes("--confirm")) {
		console.log("  Refusing without --confirm. Nothing was created.");
		process.exit(1);
	}

	const r = await generate({
		env: bitgoEnv,
		enterprise,
		secretsFile,
		passphraseFile,
		log: (s) => console.log(s),
	});

	console.log("");
	console.log(`created: ${r.created.length}  skipped: ${r.skipped.length}  failed: ${r.failed.length}`);
	for (const f of r.failed) console.log(`  FAILED ${f.coin}: ${f.error}`);

	if (r.created.length > 0) {
		console.log("");
		console.log("MOVE THE SECRETS FILE OFF THIS HOST NOW.");
		console.log(`  ${secretsFile} holds the wallet passphrase and every backup`);
		console.log("  key xprv. BitGo cannot reissue either. While it exists only here,");
		console.log("  losing this box loses the ability to recover funds without BitGo.");
	}
	// A failure to create even one wallet means the venue cannot custody that
	// chain, so it exits non-zero rather than looking like a success.
	process.exit(r.failed.length > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
	console.error(`wallet generation failed: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
