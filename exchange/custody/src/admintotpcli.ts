#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Enrol an operator's authenticator.
//
//     node dist/src/admintotpcli.js --status
//     node dist/src/admintotpcli.js --email alex@blockle.org --confirm
//     node dist/src/admintotpcli.js --email alex@blockle.org --verify 123456
//
// `Operator 2FA is enrolled` was the last failing go-live check, and it had no
// way to pass: generateSecret and provisioningUri existed in totp.ts with
// nothing calling them, so enrolling meant hand-assembling a base32 secret into
// an env var and hoping the phone agreed.
//
// WHY A CLI AND NOT A WEB FLOW. The console is read-only until a secret exists,
// so the enrolment cannot be done through the thing it unlocks. And the secret
// must never travel: this prints it on the operator's own terminal and writes
// it to a root-only file, and nothing in between ever holds it.
//
// THE SECRET IS NOT TRUSTED UNTIL A CODE PROVES IT.
//
// Writing a secret into the env is the easy half. The failure that matters is a
// secret that does not match the authenticator — mistyped, scanned from a stale
// QR, or added to the wrong profile — because the symptom appears later, when an
// operator needs the console during an incident and cannot get in. So `--confirm`
// writes it in a PENDING file and refuses to arm it; `--verify <code>` checks a
// live code against it and only then writes the line the service reads. Until
// that happens the preflight keeps reporting 2FA as unenrolled, which is true.
// -----------------------------------------------------------------------------

import {
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { generateSecret, provisioningUri, verify } from "./totp";

const ENV_FILE = process.env.ADMIN_TOTP_FILE ?? "/etc/blockle/secrets/admin-totp.env";
const PENDING_FILE = `${ENV_FILE}.pending`;

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

/** Existing enrolments, as `id=secret` pairs, parsed the way adminapi parses them. */
function existing(): Map<string, string> {
	const out = new Map<string, string>();
	if (!existsSync(ENV_FILE)) return out;
	const m = /EXCHANGE_ADMIN_TOTP=(.*)/.exec(readFileSync(ENV_FILE, "utf8"));
	if (m?.[1] === undefined) return out;
	for (const pair of m[1].replace(/^["']|["']$/g, "").split(/[,\s]+/)) {
		const eq = pair.indexOf("=");
		if (eq > 0) out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
	return out;
}

/** Write atomically, 0640 root:<group of the existing file>, like the gate does. */
function writeEnv(pairs: Map<string, string>): void {
	const body =
		"# Operator TOTP secrets, as id=secret pairs. Written by admintotpcli.\n" +
		"# Each was proven against a live code before being armed here.\n" +
		`EXCHANGE_ADMIN_TOTP=${[...pairs].map(([k, v]) => `${k}=${v}`).join(",")}\n`;
	const tmp = join(dirname(ENV_FILE), `.admin-totp.${process.pid}.tmp`);
	writeFileSync(tmp, body, { mode: 0o640 });
	renameSync(tmp, ENV_FILE);
	chmodSync(ENV_FILE, 0o640);
}

function status(): void {
	const have = existing();
	console.log(`operator TOTP (${ENV_FILE})`);
	if (have.size === 0) {
		console.log("  nobody enrolled — the admin console is read-only.");
	} else {
		// NEVER the secret. Only who is enrolled.
		for (const id of have.keys()) console.log(`  enrolled: ${id}`);
	}
	/*
	 * A pending file that is empty or unparseable is REPORTED, not thrown on.
	 * This is the command an operator runs to find out what is going on, very
	 * possibly because something is already wrong; it crashing is the one
	 * behaviour that leaves them with nothing to go on.
	 */
	if (existsSync(PENDING_FILE) && statSync(PENDING_FILE).size > 0) {
		let id: string | undefined;
		try {
			id = (JSON.parse(readFileSync(PENDING_FILE, "utf8")) as { id?: string }).id;
		} catch {
			console.log(`  a pending enrolment exists at ${PENDING_FILE} but does not parse.`);
			console.log("  Delete it and start over with --email <addr> --confirm");
			return;
		}
		console.log(`  PENDING, not yet armed: ${id ?? "?"}`);
		console.log("  Finish with: --email <that address> --verify <6-digit code>");
	}
}

function begin(email: string, force: boolean): void {
	const have = existing();
	if (have.has(email) && !force) {
		console.error(
			`${email} already has an authenticator enrolled. Re-enrolling INVALIDATES\n` +
				"the existing one — if that device is lost, pass --force; if it is not,\n" +
				"you are about to lock out a working authenticator for no reason.",
		);
		process.exit(1);
	}
	const secret = generateSecret();
	const uri = provisioningUri({ secret, issuer: "Blockle Exchange", account: email });

	writeFileSync(PENDING_FILE, JSON.stringify({ id: email, secret }, null, 2) + "\n", {
		mode: 0o600,
	});
	chmodSync(PENDING_FILE, 0o600);

	console.log("");
	console.log(`  Enrolling: ${email}`);
	console.log("");
	console.log("  Add this to your authenticator — scan the URI as a QR, or type the");
	console.log("  secret in by hand:");
	console.log("");
	console.log(`    ${uri}`);
	console.log("");
	console.log(`    secret: ${secret}`);
	console.log("");
	console.log("  THIS IS NOT ACTIVE YET. The console stays read-only and the go-live");
	console.log("  preflight still reports 2FA as unenrolled, both correctly, until a");
	console.log("  code from that authenticator proves the secret arrived intact:");
	console.log("");
	console.log(`    node dist/src/admintotpcli.js --email ${email} --verify <6 digits>`);
	console.log("");
	console.log(`  (held meanwhile in ${PENDING_FILE}, root-only)`);
}

function finish(email: string, code: string): void {
	if (!existsSync(PENDING_FILE)) {
		console.error(`nothing pending. Start with --email ${email} --confirm`);
		process.exit(1);
	}
	const p = JSON.parse(readFileSync(PENDING_FILE, "utf8")) as { id: string; secret: string };
	if (p.id !== email) {
		console.error(`pending enrolment is for ${p.id}, not ${email}`);
		process.exit(1);
	}
	const r = verify(p.secret, code);
	if (!r.ok) {
		// NOT armed on a bad code. A near-miss is usually clock drift, which is
		// worth saying, because "wrong code" sends people to the wrong problem.
		console.error(
			"that code does not match. Nothing was armed. If the authenticator shows " +
				"a different code now, try again with the current one — and if it keeps " +
				"failing, check this host's clock (`timedatectl`), since TOTP is a " +
				"function of time and a drifting server rejects every correct code.",
		);
		process.exit(1);
	}
	const pairs = existing();
	pairs.set(email, p.secret);
	writeEnv(pairs);
	/*
	 * UNLINK the pending file, do not blank it. Blanking left a zero-byte file
	 * behind that `--status` then tried to JSON.parse, so the command that
	 * reports the state crashed immediately after a SUCCESSFUL enrolment — which
	 * reads exactly like the enrolment broke something.
	 */
	unlinkSync(PENDING_FILE);
	console.log(`  verified and armed for ${email}.`);
	console.log("  Restart the services that read it, then re-run the preflight:");
	console.log("    systemctl restart exchange-public-api");
}

const email = arg("email");
const code = arg("verify");

if (process.argv.includes("--status") || process.argv.length <= 2) {
	status();
} else if (email === undefined) {
	console.error("usage: admintotpcli --status | --email <addr> --confirm | --email <addr> --verify <code>");
	process.exit(64); // EX_USAGE
} else if (code !== undefined) {
	finish(email, code);
} else if (process.argv.includes("--confirm")) {
	begin(email, process.argv.includes("--force"));
} else {
	console.error(
		"refusing without --confirm. This generates a new secret; if one already\n" +
			"exists for that address, generating another invalidates it.",
	);
	process.exit(1);
}
