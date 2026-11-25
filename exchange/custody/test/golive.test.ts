// -----------------------------------------------------------------------------
// readableByService — the check that was missing when the venue first went live.
//
// The flip wrote `mainnetEnabled: true` into /etc/blockle/exchange.json, read it
// back, confirmed it parsed as live, and reported success. The site kept saying
// "Testnet" for an hour. The gate was 0640 root:root and the API runs as
// www-data, so the service got EACCES and — correctly — failed closed.
//
// The reason no check caught it is the whole point of these tests: the preflight
// runs as ROOT, and root bypasses the permission bits. access(R_OK) says yes to
// a 0640 root:root file regardless of who the service is. Any check that asks
// "can I read this" is therefore guaranteed to pass and guaranteed to be
// irrelevant. The question has to be asked about the OTHER account.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readableByService } from "../src/golive";

/** A user that exists on every Unix and is never the one running the tests. */
const OTHER = "nobody";

/*
 * Fixtures live under /tmp, NOT os.tmpdir(). On macOS tmpdir() is a per-user
 * directory at mode 700, so every one of these cases would fail on traversal
 * before the file's own mode was ever consulted — the function would look
 * broken while being exactly right. /tmp is 1777 on both macOS and the Linux
 * box, so here the file mode is genuinely the variable under test.
 */
function tempGate(mode: number): string {
	const dir = mkdtempSync("/tmp/golive-gate-");
	chmodSync(dir, 0o755); // traversable, so the file's own mode is what decides
	const p = join(dir, "exchange.json");
	writeFileSync(p, JSON.stringify({ mainnetEnabled: true }), { mode });
	chmodSync(p, mode);
	return p;
}

test("a 0640 gate owned by someone else is NOT readable by the service", () => {
	// THE EXACT PRODUCTION FAILURE. Owner can read, group can read, other
	// cannot — and the service is 'other'. This must report false even though
	// the process running the check can open the file perfectly well.
	const p = tempGate(0o640);
	assert.ok(readFileSync(p, "utf8").length > 0, "the test process can read it");

	const r = readableByService(p, OTHER);
	assert.equal(r.ok, false);
	assert.match(r.why, /has no read bit/);
	// The evidence must carry the mode and the uid, because an operator reading
	// a FAIL line needs to know what to chgrp without going to look.
	assert.match(r.why, /mode 640/);
});

test("a world-readable gate IS readable by the service", () => {
	const r = readableByService(tempGate(0o644), OTHER);
	assert.equal(r.ok, true);
	assert.match(r.why, /can read/);
});

test("0600 is not readable either — tightening the mode does not help", () => {
	// Guards against a 'fix' that chmods instead of chgrps.
	assert.equal(readableByService(tempGate(0o600), OTHER).ok, false);
});

test("an untraversable parent directory fails even when the file is 0644", () => {
	// A mode that looks fine on the file itself while the open still fails, which
	// is the confusing variant of this bug: ls -l on the file tells you nothing.
	const dir = mkdtempSync("/tmp/golive-gate-");
	const p = join(dir, "exchange.json");
	writeFileSync(p, "{}", { mode: 0o644 });
	chmodSync(p, 0o644);
	chmodSync(dir, 0o700);

	const r = readableByService(p, OTHER);
	assert.equal(r.ok, false);
	assert.match(r.why, /cannot traverse/);
});

test("an unknown service account is a failure, never a pass", () => {
	// Fail closed: a typo'd or renamed service user must not read as 'fine'.
	const r = readableByService(tempGate(0o644), "definitely-not-a-real-account");
	assert.equal(r.ok, false);
	assert.match(r.why, /does not exist/);
});

test("a missing gate file is reported, not thrown", () => {
	const r = readableByService(join(mkdtempSync("/tmp/golive-"), "absent.json"), OTHER);
	assert.equal(r.ok, false);
	assert.ok(r.why.length > 0);
});
