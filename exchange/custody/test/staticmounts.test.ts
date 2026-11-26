// -----------------------------------------------------------------------------
// STATIC MOUNT TESTS — "the page was 200 and its script was 404".
//
// On 2026-11-25 admin.blockle.org was unusable: it showed "checking session…"
// and never resolved. Nothing was down. The console is published at the URL
// path `/admin/`, but its files are deployed FLAT into the static root — there
// is no `admin/` directory on disk. The resolver special-cased only the
// document (`/admin/` -> `/admin.html`), so admin.html's relative
// `<script src="admin.inline.js">` resolved to `/admin/admin.inline.js`, which
// mapped to `<STATIC_DIR>/admin/admin.inline.js` and had never existed.
//
// Result: the document served 200, its only script served 404, no code ran,
// and the markup's static placeholder stayed on screen. Server-side nothing
// had failed — a missing file is a correct 404 — so there was nothing in the
// log to find.
//
// These tests therefore do not check "does /admin/ work". They check the
// property that was actually missing: EVERY ASSET THE CONSOLE REFERENCES MUST
// RESOLVE UNDER ITS MOUNT. The last test reads admin.html and proves it for
// whatever that file happens to reference, so adding a stylesheet or a second
// script tomorrow cannot reintroduce this without failing here.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { staticCandidates } from "../src/publicapi";

// dist/test -> dist -> custody -> exchange -> repo root
const FRONTPAGE = join(__dirname, "../../../../deploy/exchange/frontpage");

test("the console's document resolves with and without the trailing slash", () => {
	assert.deepEqual(staticCandidates("/admin/"), ["/admin.html"]);
	assert.deepEqual(staticCandidates("/admin"), ["/admin.html"]);
});

test("an asset under the mount falls back to the flat static root", () => {
	// THE REGRESSION. Before the fix this produced only the literal path, so
	// a flat deploy could never serve it.
	const c = staticCandidates("/admin/admin.inline.js");
	assert.ok(
		c.includes("/admin.inline.js"),
		`'/admin/admin.inline.js' must be servable from the static root; got ${JSON.stringify(c)}`,
	);
	// Literal first, so a real subdirectory still wins if one is ever added.
	assert.equal(c[0], "/admin/admin.inline.js");
});

test("the mount fallback is not limited to scripts", () => {
	for (const asset of ["exchange.css", "logo.png", "nested/thing.svg"]) {
		assert.ok(
			staticCandidates(`/admin/${asset}`).includes(`/${asset}`),
			`${asset} must resolve under the mount too — the bug was per-subtree, ` +
				`not per-file-type`,
		);
	}
});

test("the mount does not swallow the rest of the site", () => {
	// `/administration` starts with "/admin" but not with the mount "/admin/".
	assert.deepEqual(staticCandidates("/administrators.html"), ["/administrators.html"]);
	// The root, and the extensionless coin pages, keep their old behaviour.
	assert.deepEqual(staticCandidates("/"), ["/index.html"]);
	assert.deepEqual(staticCandidates("/coins"), ["/coins", "/coins/index.html"]);
	assert.deepEqual(staticCandidates("/trade/raptoreum-rtm"), [
		"/trade/raptoreum-rtm",
		"/trade/raptoreum-rtm/index.html",
	]);
	// A path that looks like a file must NOT become a directory lookup.
	assert.deepEqual(staticCandidates("/exchange.js"), ["/exchange.js"]);
});

test("the mount fallback offers no path the containment check must catch", () => {
	// Traversal is stopped by normalize + the startsWith(STATIC_DIR) check in
	// serveStatic, but the candidates themselves should not be inventive about
	// it: the fallback is a plain prefix strip, nothing more.
	assert.deepEqual(staticCandidates("/admin/../secrets.env"), [
		"/admin/../secrets.env",
		"/../secrets.env",
	]);
});

test("EVERY asset admin.html references is servable at /admin/", () => {
	const htmlPath = join(FRONTPAGE, "admin.html");
	assert.ok(
		existsSync(htmlPath),
		`admin.html not found at ${htmlPath} — this test must see the real page, ` +
			`not a stand-in`,
	);
	const html = readFileSync(htmlPath, "utf8");

	// Relative src=/href= only. An absolute or cross-origin URL is not this
	// resolver's problem.
	const refs = new Set<string>();
	for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
		const ref = m[1];
		if (ref === undefined) continue;
		if (/^(?:[a-z]+:|\/\/|\/|#|data:)/i.test(ref)) continue;
		refs.add(ref.split(/[?#]/)[0] as string);
	}

	assert.ok(
		refs.has("admin.inline.js"),
		"admin.html must still load admin.inline.js — if that reference is gone " +
			"this test is guarding nothing",
	);

	for (const ref of refs) {
		// What the browser asks for, given the page is served at /admin/.
		const resolved = staticCandidates(`/admin/${ref}`);
		const found = resolved.find((c) => existsSync(join(FRONTPAGE, c)));
		assert.ok(
			found !== undefined,
			`admin.html references "${ref}". Served at /admin/ the browser requests ` +
				`"/admin/${ref}", which this resolver maps to ${JSON.stringify(resolved)} ` +
				`— and none of those exist in ${FRONTPAGE}. That is a 200 page with a ` +
				`404 asset, which is exactly how the console came to show ` +
				`"checking session…" forever.`,
		);
	}
});
