// -----------------------------------------------------------------------------
// THE ACTUAL BRING-UP, as concrete steps over the host.
//
// Each step is a small shell probe (`check`) and, where automatable, a shell
// action (`run`). They are declarative on purpose: the whole flow is readable
// in one file, which matters because this is the thing that installs a venue
// that will hold customer money.
//
// Every `check` is read-only. Every `run` is idempotent — re-running the
// console must never be the cause of an outage.
// -----------------------------------------------------------------------------

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { Phase, type Step, type StepResult } from "./steps";

/** Where the uploaded Envato archive lands, and where things get installed. */
export const PATHS = {
	archive: "/var/lib/exchange-bootstrap/tradexpro-3.2.0.zip",
	admin: "/var/www/exchange-admin",
	api: "/var/www/exchange-api",
	ui: "/var/www/exchange-ui",
	custody: "/opt/blockle/exchange-custody",
} as const;

/**
 * Run a shell command, capturing both streams.
 *
 * Never throws for a non-zero exit — a failing probe is data, not an
 * exception, and the step engine's job is to report it rather than crash.
 */
export function sh(
	cmd: string,
	timeoutMs = 600_000,
): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		exec(
			cmd,
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: "/bin/bash" },
			(err, stdout, stderr) => {
				const out = `${stdout}${stderr}`.trim();
				resolve({ code: err === null ? 0 : ((err as never as { code?: number }).code ?? 1), out });
			},
		);
	});
}

/** Last line of output, trimmed — what a probe usually wants to report. */
function tail(s: string, n = 200): string {
	const lines = s.split("\n").filter((l) => l.trim() !== "");
	return (lines[lines.length - 1] ?? "").slice(0, n);
}

/** A check built from a command: exit 0 means satisfied. */
function probe(cmd: string, okDetail: (out: string) => string): () => Promise<StepResult> {
	return async () => {
		const { code, out } = await sh(cmd, 60_000);
		return code === 0
			? { ok: true, detail: okDetail(out) || "ok" }
			: { ok: false, detail: tail(out) || `exit ${code}` };
	};
}

/** An action built from a command. */
function action(cmd: string, timeoutMs = 900_000): () => Promise<StepResult> {
	return async () => {
		const { code, out } = await sh(cmd, timeoutMs);
		return code === 0
			? { ok: true, detail: tail(out) || "done" }
			: { ok: false, detail: tail(out, 400) || `exit ${code}` };
	};
}

export function hostSteps(): readonly Step[] {
	return [
		// ---------------------------------------------------------------- preflight
		{
			id: "dns",
			phase: Phase.PREFLIGHT,
			title: "DNS for both subdomains",
			why: "exchange.blockle.org and admin.blockle.org must resolve here before certbot can issue.",
			dependsOn: [],
			check: probe(
				`for h in exchange.blockle.org admin.blockle.org; do ` +
					`getent hosts $h | grep -q 144.126.133.21 || exit 1; done; echo both resolve`,
				(o) => o,
			),
			manual: true,
			action: "Add A records for exchange.blockle.org and admin.blockle.org → 144.126.133.21.",
		},
		{
			id: "nginx",
			phase: Phase.PREFLIGHT,
			title: "nginx vhosts installed and valid",
			why: "Both site configs in place and nginx -t clean.",
			dependsOn: [],
			check: probe(
				`test -f /etc/nginx/sites-enabled/nginx-exchange.blockle.org.conf && ` +
					`test -f /etc/nginx/sites-enabled/nginx-admin.blockle.org.conf && ` +
					`nginx -t 2>&1 | tail -1`,
				(o) => tail(o),
			),
			run: action(
				`set -e; cd "$(dirname "$0")/../../deploy/exchange" 2>/dev/null || cd /opt/blockle/deploy/exchange; ` +
					`install -m644 nginx-*.conf /etc/nginx/sites-available/; ` +
					`install -d /etc/nginx/snippets; install -m644 snippets/*.conf /etc/nginx/snippets/; ` +
					`ln -sf /etc/nginx/sites-available/nginx-exchange.blockle.org.conf /etc/nginx/sites-enabled/; ` +
					`ln -sf /etc/nginx/sites-available/nginx-admin.blockle.org.conf /etc/nginx/sites-enabled/; ` +
					`nginx -t && systemctl reload nginx && echo reloaded`,
			),
		},
		{
			id: "tls",
			phase: Phase.PREFLIGHT,
			title: "TLS certificates",
			why: "Let's Encrypt certs for both hosts.",
			dependsOn: ["dns"],
			check: probe(
				`test -f /etc/letsencrypt/live/exchange.blockle.org/fullchain.pem && ` +
					`test -f /etc/letsencrypt/live/admin.blockle.org/fullchain.pem && echo present`,
				(o) => o,
			),
			run: action(
				`install -d /var/www/acme && certbot certonly --non-interactive --agree-tos ` +
					`--webroot -w /var/www/acme -m support@blockle.org ` +
					`-d exchange.blockle.org -d admin.blockle.org 2>&1 | tail -3`,
			),
		},
		{
			id: "services",
			phase: Phase.PREFLIGHT,
			title: "MySQL, Redis and Postfix reachable",
			why: "TradeXPro needs all three; Postfix on loopback means no SMTP credentials in .env.",
			dependsOn: [],
			check: probe(
				`mysqladmin ping >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1 && ` +
					`(ss -ltn | grep -q '127.0.0.1:25') && echo "mysql+redis+postfix up"`,
				(o) => o,
			),
		},
		{
			id: "mail-dns",
			phase: Phase.PREFLIGHT,
			title: "SPF, DKIM, DMARC and PTR",
			why: "Verification mail from support@blockle.org lands in spam without all four. PTR is the one everyone forgets.",
			dependsOn: [],
			check: probe(
				`set -e; ` +
					`dig +short TXT blockle.org | grep -q 'v=spf1' || { echo "SPF missing"; exit 1; }; ` +
					`dig +short TXT _dmarc.blockle.org | grep -q 'v=DMARC1' || { echo "DMARC missing"; exit 1; }; ` +
					`dig +short -x 144.126.133.21 | grep -qi 'blockle' || { echo "PTR not set to a blockle.org host (set at the VPS provider, not in DNS)"; exit 1; }; ` +
					`echo "SPF+DMARC+PTR present"`,
				(o) => o,
			),
			manual: true,
			action:
				"Publish SPF and DMARC TXT records, enable OpenDKIM signing, and set reverse DNS " +
				"for 144.126.133.21 at the VPS provider.",
		},
		{
			id: "ipv4-egress",
			phase: Phase.PREFLIGHT,
			title: "BitGo reachable over IPv4",
			why: "The access token is IP-restricted to this host's IPv4. A request leaving over IPv6 is rejected as an unauthorised IP.",
			dependsOn: [],
			check: async () => {
				const { code, out } = await sh(
					`curl -s -4 --max-time 15 -o /dev/null -w '%{http_code}' ` +
						`https://app.bitgo-test.com/api/v2/ping`,
					30_000,
				);
				if (code !== 0) return { ok: false, detail: `no IPv4 route to BitGo: ${tail(out)}` };
				return { ok: true, detail: `IPv4 egress to app.bitgo-test.com ok (HTTP ${out.trim()})` };
			},
		},

		// ---------------------------------------------------------------- artifact
		{
			id: "tradexpro-archive",
			phase: Phase.ARTIFACT,
			title: "TradeXPro 3.2.0 archive",
			why:
				"The copy on disk is the July 2023 build (Laravel 8.65 / Next 12.3.1). " +
				"3.2.0 is already covered by the existing licence — updates are lifetime.",
			dependsOn: [],
			manual: true,
			action:
				"Log in to Envato → Downloads → item 39228546, download the main files, " +
				"and drop the zip on this page.",
			check: async () =>
				existsSync(PATHS.archive)
					? { ok: true, detail: `archive present at ${PATHS.archive}` }
					: { ok: false, detail: "no archive uploaded yet" },
		},

		// ---------------------------------------------------------------- install
		{
			id: "extract",
			phase: Phase.INSTALL,
			title: "Extract the three apps",
			why: "AdminPortal, UserPortal and NodeWallet into their own roots.",
			dependsOn: ["tradexpro-archive"],
			check: probe(`test -f ${PATHS.admin}/artisan && echo extracted`, (o) => o),
			run: action(
				`set -e; install -d ${PATHS.admin} ${PATHS.api} ${PATHS.ui}; ` +
					`tmp=$(mktemp -d); unzip -oq ${PATHS.archive} -d "$tmp"; ` +
					`cp -a "$tmp"/*AdminPortal*/. ${PATHS.admin}/; ` +
					`cp -a "$tmp"/*UserPortal*/.  ${PATHS.ui}/; ` +
					`rm -rf "$tmp"; echo extracted`,
			),
		},
		{
			id: "version-check",
			phase: Phase.INSTALL,
			title: "Framework support status",
			why:
				"TradeXPro 3.2.0 (the current release) ships Laravel 8.65, whose SECURITY " +
				"support ended January 2023. This is the vendor's current state, not a stale " +
				"download — so no upstream fix is coming and this is a decision, not a wait.",
			dependsOn: ["extract"],
			// A GATE, not a failing check.
			//
			// The first version of this step asserted Laravel >= 9 and failed,
			// on the assumption that the on-disk copy was the 2023 build and a
			// re-download would fix it. That assumption was wrong: the tree has
			// thousands of files newer than 2024 and is 3.2.0, which still pins
			// "laravel/framework": "^8.65".
			//
			// So a red check here would be permanently red and would imply there
			// is something to retry. There is not. It is a judgement call about
			// running an unpatched framework under customer funds, and the
			// console must present it as such rather than as a build failure.
			gate: true,
			action:
				"Laravel 8.65 has had no security patches since Jan 2023. Decide: (a) upgrade " +
				"it in-house and fork from vendor updates, (b) accept it behind compensating " +
				"controls and document that for your auditor, or (c) use TradeXPro for the UI " +
				"only and run the money paths on exchange/custody. See docs/CEX-ARCHITECTURE.md.",
			check: probe(
				`L=$(grep -oE '"laravel/framework": *"[^"]+"' ${PATHS.admin}/composer.json | head -1); ` +
					`N=$(grep -oE '"next": *"[^"]+"' ${PATHS.ui}/package.json | head -1); ` +
					`echo "installed: $L / $N"`,
				(o) => tail(o),
			),
		},
		{
			id: "deps",
			phase: Phase.INSTALL,
			title: "composer install + npm ci + build",
			why: "Production dependencies and the Next.js build.",
			dependsOn: ["version-check"],
			check: probe(
				`test -d ${PATHS.admin}/vendor && test -d ${PATHS.ui}/.next && echo built`,
				(o) => o,
			),
			run: action(
				`set -e; cd ${PATHS.admin} && composer install --no-dev --no-interaction -q; ` +
					`cd ${PATHS.ui} && npm ci --omit=dev && npm run build; echo built`,
				1_800_000,
			),
		},
		{
			id: "env",
			phase: Phase.INSTALL,
			title: "Generate .env — mail from support@blockle.org",
			why:
				"App keys, database, Redis, and mail relayed over loopback Postfix so no SMTP " +
				"credentials exist in a file.",
			dependsOn: ["deps"],
			check: probe(
				`grep -q '^MAIL_FROM_ADDRESS=support@blockle.org' ${PATHS.admin}/.env && ` +
					`grep -q '^APP_KEY=base64:' ${PATHS.admin}/.env && echo configured`,
				(o) => o,
			),
			run: action(
				`set -e; cd ${PATHS.admin}; ` +
					`[ -f .env ] || cp .env.example .env; ` +
					`php artisan key:generate --force -q; ` +
					`sed -i 's|^MAIL_MAILER=.*|MAIL_MAILER=smtp|; s|^MAIL_HOST=.*|MAIL_HOST=127.0.0.1|; ` +
					`s|^MAIL_PORT=.*|MAIL_PORT=25|; s|^MAIL_ENCRYPTION=.*|MAIL_ENCRYPTION=null|; ` +
					`s|^MAIL_FROM_ADDRESS=.*|MAIL_FROM_ADDRESS=support@blockle.org|; ` +
					`s|^MAIL_FROM_NAME=.*|MAIL_FROM_NAME="Blockle Exchange"|' .env; ` +
					`grep -q '^MAIL_FROM_ADDRESS' .env || echo 'MAIL_FROM_ADDRESS=support@blockle.org' >> .env; ` +
					`echo configured`,
			),
		},
		{
			id: "migrate",
			phase: Phase.INSTALL,
			title: "Run migrations",
			why: "163 migrations in the 2023 build; 3.2.0 will have more.",
			dependsOn: ["env"],
			check: probe(
				`cd ${PATHS.admin} && php artisan migrate:status 2>/dev/null | grep -qv 'Pending' && echo migrated`,
				(o) => o,
			),
			run: action(`cd ${PATHS.admin} && php artisan migrate --force 2>&1 | tail -2`),
		},
		{
			id: "admin-user",
			phase: Phase.INSTALL,
			title: "The single admin account (alex@blockle.org)",
			why:
				"One operator. The password is prompted, never passed as an argument or stored " +
				"in a file — a command line is visible in ps and recorded in shell history.",
			dependsOn: ["migrate"],
			manual: true,
			action:
				`On the box: cd ${PATHS.admin} && /opt/blockle/deploy/exchange/provision-admin.sh — ` +
				"then enrol TOTP in the portal immediately.",
			check: probe(
				`cd ${PATHS.admin} && php artisan tinker --execute=` +
					`'echo \\App\\User::where("email","alex@blockle.org")->exists() ? "present" : "";' ` +
					`2>/dev/null | grep -q present && echo "admin exists"`,
				(o) => o,
			),
		},

		// ---------------------------------------------------------------- harden
		{
			id: "drop-wallet-keys",
			phase: Phase.HARDEN,
			title: "Drop the plaintext private-key columns",
			why:
				"wallet_address_histories.wallet_key and coin_settings.wallet_key hold private keys " +
				"in MySQL. One backup or injection is total loss of funds. BitGo holds the keys instead.",
			dependsOn: ["migrate"],
			destructive: true,
			check: probe(
				`! mysql -N -e "SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() ` +
					`AND column_name='wallet_key' LIMIT 1;" 2>/dev/null | grep -q 1 && echo "no wallet_key columns remain"`,
				(o) => o,
			),
			run: action(
				`set -e; mysql -e "ALTER TABLE wallet_address_histories DROP COLUMN wallet_key;" 2>/dev/null || true; ` +
					`mysql -e "ALTER TABLE coin_settings DROP COLUMN wallet_key;" 2>/dev/null || true; ` +
					`echo dropped`,
			),
		},
		{
			id: "widen-precision",
			phase: Phase.HARDEN,
			title: "Widen withdrawal amounts to 18 decimals",
			why:
				"withdraw_histories.amount is decimal(19,8) while balances are decimal(29,18). " +
				"An 18-decimal ERC-20 or BLOCK-20 withdrawal silently truncates.",
			dependsOn: ["migrate"],
			destructive: true,
			check: probe(
				`mysql -N -e "SELECT numeric_scale FROM information_schema.columns WHERE ` +
					`table_schema=DATABASE() AND table_name='withdraw_histories' AND column_name='amount';" ` +
					`2>/dev/null | grep -q '^18$' && echo "amount is (36,18)"`,
				(o) => o,
			),
			run: action(
				`mysql -e "ALTER TABLE withdraw_histories MODIFY amount DECIMAL(36,18) NOT NULL DEFAULT 0;" && echo widened`,
			),
		},
		{
			id: "branding",
			phase: Phase.HARDEN,
			title: "Blockle branding, vendor references removed",
			why: "Logos in both portals and the mail templates; no itech-theme strings in shipped UI.",
			dependsOn: ["deps"],
			check: probe(
				`! grep -rqi 'itech-theme' ${PATHS.ui}/public ${PATHS.admin}/public 2>/dev/null && ` +
					`test -f ${PATHS.ui}/public/blockle-logo.png && echo branded`,
				(o) => o,
			),
			run: action(
				`set -e; for d in ${PATHS.ui}/public ${PATHS.admin}/public; do install -d "$d"; ` +
					`install -m644 /opt/blockle/src/assets/logo-512.png "$d/blockle-logo.png"; ` +
					`install -m644 /opt/blockle/src/assets/logo-mark-128.png "$d/favicon.png"; done; ` +
					`grep -rli 'itech-theme' ${PATHS.ui}/public ${PATHS.admin}/public 2>/dev/null | ` +
					`xargs -r sed -i 's/itech-theme/blockle/g'; echo branded`,
			),
		},

		// ---------------------------------------------------------------- custody
		{
			id: "custody-build",
			phase: Phase.CUSTODY,
			title: "Custody service built",
			why: "The double-entry ledger, reconciler, BitGo adapter and withdrawal machine.",
			dependsOn: [],
			check: probe(`test -f ${PATHS.custody}/dist/src/ledger.js && echo built`, (o) => o),
			run: action(`cd ${PATHS.custody} && npm ci && npm run build && echo built`),
		},
		{
			id: "custody-tests",
			phase: Phase.CUSTODY,
			title: "Custody test suite green",
			why: "121 tests over the money paths. A red suite must block the venue, not warn about it.",
			dependsOn: ["custody-build"],
			check: probe(
				`cd ${PATHS.custody} && node --test dist/test/ 2>&1 | grep -E '^# fail' | grep -q ' 0$' && echo "all pass"`,
				(o) => o,
			),
			run: action(`cd ${PATHS.custody} && node --test dist/test/ 2>&1 | tail -6`),
		},
		{
			id: "bitgo-auth",
			phase: Phase.CUSTODY,
			title: "BitGo token accepted",
			why:
				"Confirms the token works from this host's IPv4. Observed: it is a TEST-environment " +
				"token and was rejected from here, most likely because the request left over IPv6.",
			dependsOn: ["custody-build", "ipv4-egress"],
			check: probe(
				`cd ${PATHS.custody} && node -e ` +
					`'const{BitGoHoldings}=require("./dist/src/bitgo");` +
					`BitGoHoldings.fromEnv().whoami().then(m=>{console.log("authenticated as "+m.id);process.exit(0)})` +
					`.catch(e=>{console.error(e.message);process.exit(1)})'`,
				(o) => tail(o),
			),
			manual: true,
			action:
				"Set BITGO_ACCESS_TOKEN in the custody service environment, and make sure this " +
				"host's egress IP is on the token's whitelist (force IPv4 if it has IPv6).",
		},
		{
			id: "reconcile-timer",
			phase: Phase.CUSTODY,
			title: "Reconciliation running on a timer",
			why:
				"The control that catches everything else. A shortfall halts withdrawals " +
				"automatically; nobody has to be watching.",
			dependsOn: ["custody-tests"],
			check: probe(
				`systemctl is-enabled exchange-reconcile.timer >/dev/null 2>&1 && echo "timer enabled"`,
				(o) => o,
			),
			run: action(
				`systemctl enable --now exchange-reconcile.timer && echo enabled`,
			),
		},
		{
			id: "policy",
			phase: Phase.CUSTODY,
			title: "Withdrawal policy configured (automatic, with caps)",
			why:
				"Withdrawals are automatic, so maxPerRequest and velocityCap24h are the only brake. " +
				"An asset with no cap configured cannot be withdrawn at all — fail closed.",
			dependsOn: ["custody-build"],
			check: probe(
				`test -f /etc/blockle/exchange-policy.json && ` +
					`node -e 'const p=require("/etc/blockle/exchange-policy.json");` +
					`const a=Object.keys(p.velocityCap24h||{});if(!a.length)process.exit(1);` +
					`console.log("caps set for: "+a.join(", "))'`,
				(o) => tail(o),
			),
			manual: true,
			action:
				"Write /etc/blockle/exchange-policy.json with maxPerRequest and velocityCap24h " +
				"per asset (BTC, ETH, USDC, DOGE, BLOCK, PERBUG…). Unlisted assets stay unwithdrawable.",
		},

		// ---------------------------------------------------------------- gates
		{
			id: "gate-licence",
			phase: Phase.GATE,
			title: "Envato licence covers a fee-charging venue",
			why:
				"You hold ONE REGULAR LICENSE. Envato's Regular covers a FREE end product; an " +
				"exchange charging trading fees looks like Extended License territory.",
			dependsOn: [],
			gate: true,
			action:
				"Get written confirmation from Envato Help that Regular covers this, or buy the " +
				"Extended License. Also confirm the EVM addon is covered.",
			check: async () => ({ ok: false, detail: "unresolved" }),
		},
		{
			id: "gate-msb",
			phase: Phase.GATE,
			title: "FinCEN MSB registration + state money-transmitter licensing",
			why:
				"Holding customer funds is money transmission in the US. BitGo custody confers no " +
				"licence on Alienbeing LLC.",
			dependsOn: [],
			gate: true,
			action: "Register with FinCEN and resolve state MTLs, or document an exemption with counsel.",
			check: async () => ({ ok: false, detail: "unresolved" }),
		},
		{
			id: "gate-aml",
			phase: Phase.GATE,
			title: "Written AML/KYC program and named compliance officer",
			why: "Sanctions and PEP screening, transaction monitoring, SAR procedures, recordkeeping.",
			dependsOn: [],
			gate: true,
			action: "Adopt the written program and name the officer.",
			check: async () => ({ ok: false, detail: "unresolved" }),
		},
		{
			id: "gate-noncustodial-promise",
			phase: Phase.GATE,
			title: "Rewrite the non-custodial promise",
			why:
				"exchange/server/README.md states in writing that the service holds no user funds, " +
				"ever. Launching a custodial venue makes a truthful past statement into a false one.",
			dependsOn: [],
			gate: true,
			action:
				"Rewrite that text, and make the custodial venue and the non-custodial relay " +
				"visibly distinguishable to a user.",
			check: async () => ({ ok: false, detail: "unresolved" }),
		},
		{
			id: "gate-mainnet",
			phase: Phase.GATE,
			title: "mainnetEnabled + legalReview.completed",
			why: "The flag that lets the venue touch real money. Both set by a human, out of band.",
			dependsOn: [],
			gate: true,
			action: "Set both only after every gate above is closed and a security review is done.",
			check: async () => ({ ok: false, detail: "testnet — correct for now" }),
		},
	];
}
