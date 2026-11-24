#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Write the coin pages to disk.
//
//     node dist/src/seogencli.js --out /var/www/exchange-frontpage [--dry-run]
//
// `--lastmod` defaults to today in UTC. Passing it is what a repeatable build
// does, so a regeneration of unchanged pages does not move every date in the
// sitemap.
// -----------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { generate } from "./seogen";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

const out = arg("out");
if (out === undefined) {
	console.error("usage: seogencli --out <dir> [--lastmod YYYY-MM-DD] [--dry-run]");
	process.exit(64); // EX_USAGE
}
const dry = process.argv.includes("--dry-run");
const lastmod = arg("lastmod") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) {
	console.error(`--lastmod must be YYYY-MM-DD, got ${lastmod}`);
	process.exit(64);
}

const files = generate(lastmod);
const root = resolve(out);
let written = 0;
let unchanged = 0;

for (const [rel, body] of files) {
	const path = join(root, rel);
	// COMPARE BEFORE WRITING. Rewriting an identical file churns its mtime,
	// which is the one signal a human has for "what did this deploy change".
	let before: string | undefined;
	try {
		before = readFileSync(path, "utf8");
	} catch {
		before = undefined;
	}
	if (before === body) {
		unchanged += 1;
		continue;
	}
	if (dry) {
		console.log(`  would ${before === undefined ? "create" : "update"} ${rel}`);
		written += 1;
		continue;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	console.log(`  ${before === undefined ? "created" : "updated"} ${rel}`);
	written += 1;
}

console.log(
	`${dry ? "[dry run] " : ""}${written} ${written === 1 ? "file" : "files"} ` +
		`${dry ? "to write" : "written"}, ${unchanged} unchanged, in ${root}`,
);
