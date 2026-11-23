// -----------------------------------------------------------------------------
// THE SETUP CONSOLE SERVER — admin.blockle.org
//
// Serves the console and runs the steps. This process can install software,
// drop database columns, and restart services, so it is treated as what it is:
// a REMOTE CODE EXECUTION ENDPOINT with a web page in front of it.
//
// FOUR CONSEQUENCES OF THAT, all of them non-negotiable:
//
// 1. IT BINDS TO LOOPBACK. nginx on admin.blockle.org proxies to it, so the
//    IP allowlist and TLS in that vhost apply. Binding 0.0.0.0 would put an
//    installer on the public internet.
//
// 2. EVERY REQUEST NEEDS THE BOOTSTRAP TOKEN, compared in constant time. No
//    token in the environment means the server REFUSES TO START rather than
//    starting open — a setup tool that defaults to unauthenticated is worse
//    than one that will not run.
//
// 3. ONE ACTION AT A TIME. A global mutex, because two concurrent `composer
//    install`s or two migrations racing is a corrupted install, and the UI
//    polls every five seconds.
//
// 4. IT SHUTS ITSELF OFF. Once every automatable step is OK, `/api/run-*`
//    starts refusing. The window in which this thing can execute anything is
//    the setup window and nothing longer.
//
// THE ARCHIVE UPLOAD IS A RAW PUT, NOT MULTIPART. The TradeXPro zip is a few
// hundred megabytes; multipart would mean buffering and parsing it in memory
// for no benefit. A raw body streams straight to disk at constant memory.
// -----------------------------------------------------------------------------

import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";

import { Runner, Status } from "./steps";
import { PATHS, hostSteps } from "./hoststeps";

const PORT = Number(process.env.BOOTSTRAP_PORT ?? 8099);
const HOST = "127.0.0.1";
const PUBLIC_DIR = join(__dirname, "..", "..", "public");

const TOKEN = process.env.BOOTSTRAP_TOKEN ?? "";
if (TOKEN.trim().length < 24) {
	console.error(
		"refusing to start: BOOTSTRAP_TOKEN must be set and at least 24 characters.\n" +
			"This server can install software and drop database columns; it must not\n" +
			"run unauthenticated.\n\n" +
			"  openssl rand -hex 32\n",
	);
	process.exit(1);
}
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest();

const runner = new Runner(hostSteps());

/** One action at a time. The UI polls, and installs must not overlap. */
let busy = false;

function authorized(req: IncomingMessage): boolean {
	// Accept either a bearer header (for curl) or a cookie (for the browser,
	// set once via /auth?t=...). Both are compared as SHA-256 digests in
	// constant time — comparing the raw strings leaks length and prefix through
	// timing, and `===` on a secret is a habit worth not having.
	const header = req.headers.authorization ?? "";
	const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
	const cookie = /(?:^|;\s*)bootstrap=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
	for (const candidate of [bearer, decodeURIComponent(cookie)]) {
		if (candidate === "") continue;
		const h = createHash("sha256").update(candidate).digest();
		if (h.length === TOKEN_HASH.length && timingSafeEqual(h, TOKEN_HASH)) return true;
	}
	return false;
}

function json(res: ServerResponse, code: number, body: unknown): void {
	const s = JSON.stringify(body);
	res.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(s),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(s);
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
	// Resolve inside PUBLIC_DIR and verify containment. `normalize` alone is
	// not enough — the check below is what actually stops `../../etc/shadow`.
	const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
	const file = join(PUBLIC_DIR, rel);
	if (!file.startsWith(PUBLIC_DIR)) {
		json(res, 403, { error: "outside the public directory" });
		return;
	}
	try {
		const st = await stat(file);
		if (!st.isFile()) throw new Error("not a file");
		res.writeHead(200, {
			"Content-Type": MIME[extname(file)] ?? "application/octet-stream",
			"Content-Length": st.size,
			"Cache-Control": "no-store",
			"X-Frame-Options": "DENY",
		});
		await pipeline(createReadStream(file), res);
	} catch {
		json(res, 404, { error: "not found" });
	}
}

/** Everything automatable is done — the console has no further job. */
function setupComplete(): boolean {
	return runner.summary().automatableComplete;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${HOST}`);
	const path = url.pathname;

	// One-shot cookie set, so the browser does not need to send a header on
	// every poll. The token is in the query string here, which is why this is
	// the ONLY endpoint that accepts it that way and why it redirects
	// immediately — a token in a URL lands in logs and history.
	if (path === "/auth") {
		const t = url.searchParams.get("t") ?? "";
		const h = createHash("sha256").update(t).digest();
		if (h.length !== TOKEN_HASH.length || !timingSafeEqual(h, TOKEN_HASH)) {
			json(res, 401, { error: "bad token" });
			return;
		}
		res.writeHead(302, {
			// RELATIVE, not "/". This server is mounted at /setup/ behind nginx,
			// so an absolute "/" sent the browser to the Laravel root — which
			// 404s, because the thing this console exists to install is not
			// installed yet. "./" resolves against /setup/auth to /setup/, and
			// against /auth to / if it is ever mounted at the root, so it is
			// correct under any mount point.
			Location: "./",
			// HttpOnly so page scripts cannot read it; SameSite=Strict so no
			// cross-site request can carry it into an install action.
			"Set-Cookie":
				`bootstrap=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; ` +
				`Path=/; Max-Age=28800`,
		});
		res.end();
		return;
	}

	if (!authorized(req)) {
		json(res, 401, {
			error:
				"unauthorized — open /auth?t=<BOOTSTRAP_TOKEN> once, or send " +
				"Authorization: Bearer <token>",
		});
		return;
	}

	// ---- state ------------------------------------------------------------
	if (path === "/api/state" && req.method === "GET") {
		await runner.refresh();
		json(res, 200, {
			// `run` is a function and cannot be serialised; send only what the
			// UI needs, and never the shell commands themselves.
			steps: runner.steps().map((s) => ({
				id: s.id,
				phase: s.phase,
				title: s.title,
				why: s.why,
				destructive: s.destructive === true,
				manual: s.manual === true,
				gate: s.gate === true,
			})),
			states: runner.states(),
			summary: runner.summary(),
			env: process.env.BITGO_ENV === "prod" ? "mainnet" : "testnet",
			complete: setupComplete(),
		});
		return;
	}

	// ---- archive upload ---------------------------------------------------
	if (path === "/api/archive" && (req.method === "PUT" || req.method === "POST")) {
		if (busy) {
			json(res, 409, { error: "another action is running" });
			return;
		}
		busy = true;
		const tmp = `${PATHS.archive}.part`;
		try {
			await mkdir(dirname(PATHS.archive), { recursive: true });
			// Stream to a .part file and rename on success, so an interrupted
			// upload never leaves a truncated zip that the extract step would
			// happily try to unpack.
			await pipeline(req, createWriteStream(tmp));
			const st = await stat(tmp);
			if (st.size < 1_000_000) {
				await unlink(tmp).catch(() => {});
				json(res, 400, {
					error: `that file is only ${st.size} bytes — not a TradeXPro archive`,
				});
				return;
			}
			await rename(tmp, PATHS.archive);
			json(res, 200, {
				ok: true,
				detail: `received ${(st.size / 1048576).toFixed(0)} MB — re-checking`,
			});
		} catch (e) {
			await unlink(tmp).catch(() => {});
			json(res, 500, { error: e instanceof Error ? e.message : String(e) });
		} finally {
			busy = false;
		}
		return;
	}

	// ---- run --------------------------------------------------------------
	if (path.startsWith("/api/run") && req.method === "POST") {
		if (setupComplete()) {
			json(res, 410, {
				error:
					"setup is complete; this console no longer executes actions. " +
					"Stop the service: systemctl disable --now exchange-bootstrap",
			});
			return;
		}
		if (busy) {
			json(res, 409, { error: "another action is running" });
			return;
		}
		busy = true;
		try {
			if (path === "/api/run-all") {
				const destructive = url.searchParams.get("destructive") === "1";
				await runner.runAll(
					destructive ? { includeDestructive: true } : {},
				);
			} else {
				const id = path.slice("/api/run/".length);
				if (id === "") {
					json(res, 400, { error: "no step id" });
					return;
				}
				await runner.runStep(id);
			}
			json(res, 200, { states: runner.states(), summary: runner.summary() });
		} catch (e) {
			json(res, 400, { error: e instanceof Error ? e.message : String(e) });
		} finally {
			busy = false;
		}
		return;
	}

	if (req.method === "GET") {
		await serveStatic(res, path);
		return;
	}
	json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
	handle(req, res).catch((e) => {
		// A thrown handler must not take the process down mid-install.
		try {
			json(res, 500, { error: e instanceof Error ? e.message : String(e) });
		} catch {
			/* response already sent */
		}
	});
});

// No socket timeout: `composer install` and `npm run build` legitimately take
// many minutes, and the default would kill the request mid-install and leave
// the console unable to report what happened.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, HOST, () => {
	console.log(
		`exchange setup console on http://${HOST}:${PORT} (loopback only)\n` +
			`open it through admin.blockle.org, then visit /auth?t=<BOOTSTRAP_TOKEN> once`,
	);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
	process.on(sig, () => {
		server.close(() => process.exit(0));
	});
}

export { Status };
