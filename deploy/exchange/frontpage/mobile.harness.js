// -----------------------------------------------------------------------------
// MOBILE AUDIT — the phone-layout mistakes that are checkable without a browser.
//
//     node mobile.harness.js
//
// WHAT THIS CAN AND CANNOT DO.
//
// It cannot lay anything out; there is no engine here. What it CAN do is catch
// the handful of mistakes that reliably produce a broken phone page and that
// are visible in the source:
//
//   * a wide table with no horizontal-scroll container, which makes the whole
//     PAGE scroll sideways instead of the table;
//   * a hard-coded pixel width in a style attribute, which no media query can
//     override — that is how the markets filter ended up at 190px on a 390px
//     screen;
//   * a page with no viewport meta, which phones render at 980px and shrink;
//   * a touch target defined smaller than 44px inside a phone breakpoint;
//   * an input under 16px inside a phone breakpoint, which makes iOS zoom the
//     page on focus and leaves it zoomed.
//
// It does NOT replace looking at the thing on a phone. It replaces
// REMEMBERING to look, which is the part that fails.
// -----------------------------------------------------------------------------

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const DIR = __dirname;
const PAGES = ["app.html", "signin.html", "admin.html"];

/** Every <table> and whether an ancestor div carries the scroll class. */
function unscrolledTables(html) {
	const out = [];
	const re = /<table\b[^>]*id="([^"]+)"/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		const before = html.slice(0, m.index);
		// The nearest unclosed container before the table: if the last thing
		// opened was a scroll div and it has not closed, the table is inside.
		const lastScroll = before.lastIndexOf('scroll"');
		const lastClose = before.lastIndexOf("</div>");
		if (lastScroll < lastClose) out.push(m[1]);
	}
	return out;
}

/** Style attributes that pin a width in pixels. */
function inlinePixelWidths(html) {
	const out = [];
	const re = /style="([^"]*)"/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		// `max-width` is a cap, not a pin — it still shrinks on a phone.
		const decls = m[1].split(";");
		for (const d of decls) {
			if (/(^|[^-])\bwidth\s*:\s*\d+px/.test(d)) out.push(d.trim());
		}
	}
	return out;
}

/** Declarations inside a narrow media query, flattened. */
function phoneBlocks(css) {
	const out = [];
	const re = /@media[^{]*max-width:\s*(\d+)px[^{]*\{/g;
	let m;
	while ((m = re.exec(css)) !== null) {
		if (Number(m[1]) > 700) continue; // a tablet rule, not a phone one
		// Walk braces to the end of the at-rule.
		let depth = 1;
		let i = re.lastIndex;
		for (; i < css.length && depth > 0; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}") depth--;
		}
		out.push(css.slice(re.lastIndex, i - 1));
	}
	return out;
}

let failures = 0;
const fail = (msg) => {
	failures += 1;
	console.error(`  FAIL  ${msg}`);
};

// ---------------------------------------------------------------- the pages

for (const page of PAGES) {
	const file = path.join(DIR, page);
	if (!fs.existsSync(file)) continue;
	const html = fs.readFileSync(file, "utf8");

	// A page without this is rendered at 980px and scaled down — every font
	// on it becomes unreadable, which is the single worst mobile bug.
	if (!/<meta[^>]+name="viewport"[^>]+width=device-width/.test(html)) {
		fail(`${page}: no <meta name="viewport" content="width=device-width">`);
	}

	const loose = unscrolledTables(html);
	for (const id of loose) {
		fail(`${page}: table #${id} is not inside a .scroll container — on a ` +
			`phone the page scrolls sideways instead of the table`);
	}

	const pinned = inlinePixelWidths(html);
	for (const d of pinned) {
		fail(`${page}: inline ${JSON.stringify(d)} cannot be overridden by a ` +
			`media query — move the width into the stylesheet`);
	}

	// Every page must have SOME phone handling.
	const css = /<style>([\s\S]*?)<\/style>/.exec(html);
	const external = page === "app.html";
	const sheet = css ? css[1] : "";
	if (!external && phoneBlocks(sheet).length === 0) {
		fail(`${page}: no phone breakpoint (max-width <= 700px) anywhere`);
	}
}

// ------------------------------------------------------------ the stylesheet

const appCss = fs.readFileSync(path.join(DIR, "exchange.css"), "utf8");
const blocks = [
	...phoneBlocks(appCss),
	...PAGES.flatMap((p) => {
		const f = path.join(DIR, p);
		if (!fs.existsSync(f)) return [];
		const m = /<style>([\s\S]*?)<\/style>/.exec(fs.readFileSync(f, "utf8"));
		return m ? phoneBlocks(m[1]) : [];
	}),
];

assert.ok(blocks.length > 0, "no phone breakpoints found at all");

for (const block of blocks) {
	// A min-height below 44px inside a phone rule is a target a finger misses.
	for (const m of block.matchAll(/min-height:\s*(\d+)px/g)) {
		if (Number(m[1]) < 40) {
			fail(`a phone rule sets min-height:${m[1]}px — under the 44px touch floor`);
		}
	}
	// iOS zooms the viewport when a focused input is under 16px, and does not
	// zoom back out. Every input rule in a phone block must be >= 16px.
	for (const m of block.matchAll(/(input|select|textarea)[^{}]*\{([^}]*)\}/g)) {
		const size = /font-size:\s*([\d.]+)px/.exec(m[2]);
		if (size && Number(size[1]) < 16) {
			fail(`a phone rule sets ${m[1]} font-size:${size[1]}px — iOS will zoom ` +
				`the page on focus and leave it zoomed`);
		}
	}
}

// ------------------------------------------- sticky headers vs the top bar
//
// THE BUG THIS EXISTS FOR, because it is invisible in the source unless you
// know to look for it:
//
// `thead th { position: sticky; top: 0 }` sticks to the nearest SCROLLING
// ANCESTOR. On desktop that is the `.work` pane, so the header parks below
// the brand bar — correct. The phone breakpoint hands scrolling to the page
// instead (`.work { overflow: visible }`), which silently changes the anchor
// to the viewport: `top: 0` becomes the top of the SCREEN, where the brand
// bar and nav strip live, and `z-index: 1` paints the header over them.
//
// Nothing about either rule looks wrong on its own. The bug is the pairing,
// so that is what this checks.
{
	const stickyTop = /position:\s*sticky[^}]*top:\s*0|top:\s*0[^}]*position:\s*sticky/;
	const hasStickyTop = stickyTop.test(appCss);
	// Does any phone breakpoint hand scrolling back to the page?
	const pageScrolls = phoneBlocks(appCss).concat(
		// The 900px shell rule is the one that does it, and it is wider than
		// the "phone" cutoff above, so it is matched directly.
		(/@media[^{]*max-width:\s*900px[^{]*\{([\s\S]*?)\n\}/.exec(appCss) || [, ""])[1],
	);
	const releasing = pageScrolls.filter((b) => /\.work\s*\{[^}]*overflow:\s*visible/.test(b));

	for (const block of releasing) {
		const neutralised = /thead\s+th\s*\{[^}]*position:\s*(static|relative)/.test(block);
		if (hasStickyTop && !neutralised) {
			fail(
				"a breakpoint sets .work{overflow:visible} — the PAGE scrolls there — " +
					"while thead th is still sticky at top:0, so the table header will " +
					"cover the brand bar and nav. Neutralise it in that block.",
			);
		}
	}
}

// ------------------------------------------------------------------- report

const checked = PAGES.filter((p) => fs.existsSync(path.join(DIR, p)));
if (failures > 0) {
	console.error(`\nmobile: ${failures} problem(s) across ${checked.length} pages`);
	process.exit(1);
}
console.log(
	`mobile: ${checked.length} pages clean — viewport, table scrolling, no pinned ` +
		`widths, 44px targets, 16px inputs, no header over the top bar`,
);
