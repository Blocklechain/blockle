// -----------------------------------------------------------------------------
// Harness for the collapsible rail in exchange.js.
//
// The rail is a small state machine with four inputs — screen width, a stored
// preference, the toggle, and navigation — and getting it wrong is the kind of
// bug that only shows up on someone else's phone. So it is driven here instead
// of eyeballed.
//
// What it pins down:
//
//   * exactly one of nav-icons / nav-labels is on the body, always. A third
//     "unset" state is what makes responsive navigation confusing when the
//     stylesheet and the script disagree about the default;
//   * a phone starts with icons and a desktop with labels;
//   * a DESKTOP choice is remembered and a PHONE drawer is not — reopening the
//     app with a drawer over the screen you came for is a bug, not a feature;
//   * the scrim exists only while the rail actually floats over the content;
//   * choosing a destination closes the drawer, so moving around is one tap;
//   * crossing the breakpoint lands on that size's default.
// -----------------------------------------------------------------------------

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const SRC = fs.readFileSync(path.join(__dirname, "exchange.js"), "utf8");

/**
 * Lift the rail functions out of the IIFE.
 *
 * Running the whole of exchange.js would start timers and fetches; the state
 * machine is self-contained, so only it is evaluated — against the real
 * source text, so the test cannot drift from what ships.
 */
function extract() {
  const from = SRC.indexOf("  var NARROW = window.matchMedia");
  const to = SRC.indexOf("  function curtain(on)");
  assert.ok(from > 0 && to > from, "could not find the nav block in exchange.js");
  return SRC.slice(from, to);
}

function classList() {
  const set = new Set();
  return {
    _s: set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
  };
}

function node(id) {
  return {
    id,
    hidden: false,
    attrs: {},
    classList: classList(),
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(e, h) { this["on" + e] = h; },
  };
}

/** One page, at a given width, with a given stored preference. */
function page(opts = {}) {
  const nodes = { navtoggle: node("navtoggle"), scrim: node("scrim"), rail: node("rail") };
  const store = new Map();
  if (opts.stored !== undefined) store.set("blk_nav", opts.stored);

  const listeners = [];
  const mq = {
    matches: Boolean(opts.narrow),
    addEventListener: (_e, h) => listeners.push(h),
  };

  const body = { classList: classList() };
  const sandbox = {
    window: { matchMedia: () => mq },
    document: { body },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    $: (id) => nodes[id],
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(), sandbox);
  sandbox.navInit();

  return {
    body,
    nodes,
    store,
    mode: () => (body.classList.contains("nav-icons") ? "icons" : "labels"),
    toggle: () => nodes.navtoggle.onclick(),
    // Navigating from the rail: the handler only acts on a click that landed
    // on a link.
    navigate: () =>
      nodes.rail.onclick({ target: { closest: (sel) => (sel === "a" ? {} : null) } }),
    clickScrim: () => nodes.scrim.onclick(),
    resizeTo(narrow) {
      mq.matches = narrow;
      for (const h of listeners) h();
    },
  };
}

// --------------------------------------------------------------- defaults

{
  const desktop = page({ narrow: false });
  assert.equal(desktop.mode(), "labels", "a desktop starts with labels");
  assert.equal(desktop.body.classList.contains("nav-labels"), true);
  assert.equal(desktop.body.classList.contains("nav-icons"), false);

  const phone = page({ narrow: true });
  assert.equal(phone.mode(), "icons", "a phone starts with icons");
  assert.equal(phone.nodes.scrim.hidden, true, "nothing is floating yet");
}

// EXACTLY ONE CLASS, ALWAYS — through every transition.
{
  const p = page({ narrow: true });
  const both = () =>
    [p.body.classList.contains("nav-icons"), p.body.classList.contains("nav-labels")];
  for (const step of [() => p.toggle(), () => p.toggle(), () => p.resizeTo(false),
                      () => p.toggle(), () => p.resizeTo(true)]) {
    step();
    const [i, l] = both();
    assert.notEqual(i, l, `both or neither class set: icons=${i} labels=${l}`);
  }
}

// --------------------------------------------------------------- the toggle

{
  const p = page({ narrow: false });
  p.toggle();
  assert.equal(p.mode(), "icons");
  assert.equal(p.nodes.navtoggle.attrs["aria-expanded"], "false",
    "the control reports its state to a screen reader");
  p.toggle();
  assert.equal(p.mode(), "labels");
  assert.equal(p.nodes.navtoggle.attrs["aria-expanded"], "true");
}

// ------------------------------------------------------------- persistence

{
  // A DESKTOP CHOICE STICKS: someone who collapses the rail for chart room
  // wants it collapsed tomorrow.
  const p = page({ narrow: false });
  p.toggle();
  assert.equal(p.store.get("blk_nav"), "icons");
  const again = page({ narrow: false, stored: "icons" });
  assert.equal(again.mode(), "icons", "the stored choice is honoured");
}

{
  // A PHONE DRAWER DOES NOT STICK. It overlays the content, so restoring it
  // on the next visit would hide the screen the person came for.
  const p = page({ narrow: true });
  p.toggle();
  assert.equal(p.mode(), "labels", "the drawer opened");
  assert.equal(p.store.has("blk_nav"), false, "and was not remembered");

  // Even a desktop preference left over from before is ignored on a phone,
  // where 232px of labels would leave no usable column.
  const small = page({ narrow: true, stored: "labels" });
  assert.equal(small.mode(), "icons");
}

// -------------------------------------------------------------- the scrim

{
  const p = page({ narrow: true });
  assert.equal(p.nodes.scrim.hidden, true);
  p.toggle();
  assert.equal(p.nodes.scrim.hidden, false, "the rail is floating, so it is dismissable");
  p.clickScrim();
  assert.equal(p.mode(), "icons", "tapping beside the drawer closes it");
  assert.equal(p.nodes.scrim.hidden, true);
}

{
  // On a desktop the rail pushes the content rather than covering it, so a
  // scrim would be a dead layer over a usable page.
  const p = page({ narrow: false });
  assert.equal(p.nodes.scrim.hidden, true);
  p.toggle();
  assert.equal(p.nodes.scrim.hidden, true);
}

// ------------------------------------------------------------- navigation

{
  const p = page({ narrow: true });
  p.toggle();
  p.navigate();
  assert.equal(p.mode(), "icons", "choosing a destination closes the drawer");
}

{
  // Not on a desktop: the rail is the navigation, and collapsing it every
  // time you used it would be hostile.
  const p = page({ narrow: false });
  p.navigate();
  assert.equal(p.mode(), "labels");
}

// ----------------------------------------------------------- the breakpoint

{
  // Rotating a phone or dragging a window across the breakpoint should land
  // on that size's default rather than keeping a state that only made sense
  // at the old width.
  const p = page({ narrow: false });
  assert.equal(p.mode(), "labels");
  p.resizeTo(true);
  assert.equal(p.mode(), "icons", "narrowing collapses the rail");
  p.resizeTo(false);
  assert.equal(p.mode(), "labels", "widening brings the labels back");
}

{
  // A drawer left open while the window grows must not become a floating
  // panel on a desktop — it becomes the ordinary labelled rail.
  const p = page({ narrow: true });
  p.toggle();
  assert.equal(p.nodes.scrim.hidden, false);
  p.resizeTo(false);
  assert.equal(p.mode(), "labels");
  assert.equal(p.nodes.scrim.hidden, true, "the scrim goes with the overlay");
}

console.log(
  "nav: 11 cases correct — one class always, phone icons, desktop labels, " +
    "desktop choice remembered, drawer not, scrim + close-on-navigate",
);
