// -----------------------------------------------------------------------------
// Tests for the setup step engine.
//
// The engine's job is to be honest about state on a half-built host, so these
// test the dishonest cases: a step that claims success without doing anything,
// a probe that throws, a gate that someone tries to click through, and a
// destructive step swept up by "run everything".
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	Phase,
	Runner,
	Status,
	StepError,
	topoSort,
	type Step,
	type StepResult,
} from "../src/steps";

const OK: StepResult = { ok: true, detail: "done" };
const NO: StepResult = { ok: false, detail: "not yet" };

/** A step whose state lives in a closure, so `run` really changes `check`. */
function stateful(
	id: string,
	opts: Partial<Step> & { startsDone?: boolean } = {},
): Step & { runs: () => number } {
	let done = opts.startsDone === true;
	let runs = 0;
	const s: Step = {
		id,
		phase: opts.phase ?? Phase.PREFLIGHT,
		title: opts.title ?? id,
		why: opts.why ?? "because",
		dependsOn: opts.dependsOn ?? [],
		check: async () => (done ? OK : NO),
		run: async () => {
			runs++;
			done = true;
			return OK;
		},
		...(opts.destructive === true ? { destructive: true } : {}),
	};
	return Object.assign(s, { runs: () => runs });
}

test("topoSort orders dependencies before dependents", () => {
	const steps: Step[] = [
		stateful("c", { dependsOn: ["b"] }),
		stateful("a"),
		stateful("b", { dependsOn: ["a"] }),
	];
	assert.deepEqual(
		topoSort(steps).map((s) => s.id),
		["a", "b", "c"],
	);
});

test("topoSort is stable among equally-ready steps", () => {
	// The console's layout must not shuffle between page loads.
	const steps: Step[] = [stateful("x"), stateful("y"), stateful("z")];
	assert.deepEqual(
		topoSort(steps).map((s) => s.id),
		["x", "y", "z"],
	);
});

test("a dependency on a nonexistent step is caught, not ignored", () => {
	assert.throws(
		() => topoSort([stateful("a", { dependsOn: ["ghost"] })]),
		/depends on "ghost", which does not exist/,
	);
});

test("A DEPENDENCY CYCLE IS RAISED, not silently stuck", () => {
	// Without this check the symptom is a console showing everything WAITING
	// with no explanation, which is far harder to diagnose than an error.
	assert.throws(
		() =>
			topoSort([
				stateful("a", { dependsOn: ["b"] }),
				stateful("b", { dependsOn: ["a"] }),
			]),
		/dependency cycle among: a, b/,
	);
});

test("refresh reports OK for what is already true and READY for what is not", async () => {
	const r = new Runner([
		stateful("done", { startsDone: true }),
		stateful("todo"),
	]);
	await r.refresh();
	assert.equal(r.get("done").status, Status.OK);
	assert.equal(r.get("todo").status, Status.READY);
});

test("a step waits while its dependencies are unmet, and names them", async () => {
	const r = new Runner([stateful("a"), stateful("b", { dependsOn: ["a"] })]);
	await r.refresh();
	assert.equal(r.get("b").status, Status.WAITING);
	assert.match(r.get("b").detail, /waiting on: a/);
});

test("an already-satisfied step reports OK even if its dependencies are not", async () => {
	// Realistic on a pre-existing host: the thing is already installed even
	// though the step that would have installed it has not run. Hiding that
	// behind WAITING would make the console lie.
	const r = new Runner([
		stateful("install"),
		stateful("configured", { dependsOn: ["install"], startsDone: true }),
	]);
	await r.refresh();
	assert.equal(r.get("install").status, Status.READY);
	assert.equal(r.get("configured").status, Status.OK);
});

test("RUNNING A SATISFIED STEP IS A NO-OP", async () => {
	// The console gets reloaded and re-run constantly; a step that re-executes
	// when already done will eventually corrupt something.
	const s = stateful("x", { startsDone: true });
	const r = new Runner([s]);
	const out = await r.runStep("x");
	assert.equal(out.status, Status.OK);
	assert.match(out.detail, /already done/);
	assert.equal(s.runs(), 0, "run must not have been called");
});

test("A STEP THAT CLAIMS SUCCESS BUT CHANGES NOTHING IS REPORTED AS FAILED", async () => {
	// The failure mode that makes a green console a lie. `run` returns ok but
	// `check` still fails, so the engine must not take run's word for it.
	const liar: Step = {
		id: "liar",
		phase: Phase.INSTALL,
		title: "liar",
		why: "tests the verify-after-run path",
		dependsOn: [],
		check: async () => NO,
		run: async () => OK,
	};
	const r = new Runner([liar]);
	const out = await r.runStep("liar");
	assert.equal(out.status, Status.FAILED);
	assert.match(out.detail, /reported success but the check still fails/);
});

test("a run that throws is a failed step, not a crashed engine", async () => {
	const boom: Step = {
		id: "boom",
		phase: Phase.INSTALL,
		title: "boom",
		why: "w",
		dependsOn: [],
		check: async () => NO,
		run: async () => {
			throw new Error("exit status 1: could not connect");
		},
	};
	const r = new Runner([boom]);
	const out = await r.runStep("boom");
	assert.equal(out.status, Status.FAILED);
	assert.match(out.detail, /could not connect/);
});

test("A CHECK THAT THROWS IS A FAILED CHECK, NOT A CRASHED CONSOLE", async () => {
	// Probes touch DNS, sockets and subprocesses — all of which throw for
	// ordinary reasons on a fresh host. One unreachable service must not take
	// down the page that exists to tell you about it.
	const thrower: Step = {
		id: "dns",
		phase: Phase.PREFLIGHT,
		title: "dns",
		why: "w",
		dependsOn: [],
		check: async () => {
			throw new Error("ENOTFOUND");
		},
		run: async () => OK,
	};
	const r = new Runner([thrower, stateful("other")]);
	const states = await r.refresh();
	assert.equal(states.length, 2);
	assert.equal(r.get("dns").status, Status.READY);
	assert.match(r.get("dns").detail, /ENOTFOUND/);
});

test("a step cannot run while its dependencies are unmet", async () => {
	const b = stateful("b", { dependsOn: ["a"] });
	const r = new Runner([stateful("a"), b]);
	const out = await r.runStep("b");
	assert.equal(out.status, Status.WAITING);
	assert.equal(b.runs(), 0);
});

test("runAll walks the graph in order and satisfies the chain", async () => {
	const a = stateful("a");
	const b = stateful("b", { dependsOn: ["a"] });
	const c = stateful("c", { dependsOn: ["b"] });
	const r = new Runner([c, b, a]);
	await r.runAll();
	for (const id of ["a", "b", "c"]) assert.equal(r.get(id).status, Status.OK, id);
	assert.equal(r.summary().automatableComplete, true);
});

test("runAll stops a branch when its dependency failed", async () => {
	const broken: Step = {
		id: "broken",
		phase: Phase.INSTALL,
		title: "broken",
		why: "w",
		dependsOn: [],
		check: async () => NO,
		run: async () => ({ ok: false, detail: "composer not found" }),
	};
	const downstream = stateful("downstream", { dependsOn: ["broken"] });
	const r = new Runner([broken, downstream]);
	await r.runAll();

	assert.equal(r.get("broken").status, Status.FAILED);
	assert.equal(r.get("downstream").status, Status.WAITING);
	assert.equal(downstream.runs(), 0, "must not run on a failed foundation");
	assert.equal(r.summary().automatableComplete, false);
});

test("RUNALL SKIPS DESTRUCTIVE STEPS unless explicitly included", async () => {
	// Dropping a column should be a deliberate click, not a side effect of
	// "run everything" against a populated database.
	const d = stateful("drop-wallet-key", { destructive: true });
	const r = new Runner([d]);

	await r.runAll();
	assert.equal(d.runs(), 0, "not swept up");
	assert.equal(r.get("drop-wallet-key").status, Status.BLOCKED_ON_YOU);
	assert.match(r.get("drop-wallet-key").detail, /run this one deliberately/);

	await r.runAll({ includeDestructive: true });
	assert.equal(d.runs(), 1);
	assert.equal(r.get("drop-wallet-key").status, Status.OK);
});

test("a destructive step that is already satisfied reports OK, not blocked", async () => {
	const d = stateful("already", { destructive: true, startsDone: true });
	const r = new Runner([d]);
	await r.runAll();
	assert.equal(r.get("already").status, Status.OK);
});

test("A GATE CAN NEVER BE SATISFIED BY SOFTWARE", async () => {
	// The licence question, the MSB registration, the legal sign-off. A console
	// that let someone click through these would be worse than no console,
	// because it would imply the work was done.
	const gate: Step = {
		id: "licence",
		phase: Phase.GATE,
		title: "Envato Extended License",
		why: "A Regular License covers a free end product only.",
		dependsOn: [],
		gate: true,
		action: "Get written confirmation from Envato, or buy the Extended License.",
		// Even a check that returns true must not flip a gate.
		check: async () => OK,
	};
	const r = new Runner([gate]);

	await r.refresh();
	assert.equal(r.get("licence").status, Status.GATE);

	const out = await r.runStep("licence");
	assert.equal(out.status, Status.GATE);
	assert.match(out.detail, /written confirmation from Envato/);

	await r.runAll({ includeDestructive: true });
	assert.equal(r.get("licence").status, Status.GATE);
});

test("a manual step is BLOCKED_ON_YOU and states what to do", async () => {
	const manual: Step = {
		id: "envato-zip",
		phase: Phase.ARTIFACT,
		title: "TradeXPro 3.2.0 archive",
		why: "The local copy is the July 2023 build.",
		dependsOn: [],
		manual: true,
		action: "Log in to Envato, download 3.2.0, and drop the zip here.",
		check: async () => NO,
	};
	const r = new Runner([manual]);
	await r.refresh();
	assert.equal(r.get("envato-zip").status, Status.BLOCKED_ON_YOU);
	assert.match(r.get("envato-zip").detail, /drop the zip here/);
});

test("a manual step flips to OK once its check passes", async () => {
	// i.e. once the upload has landed, without anyone clicking anything.
	let uploaded = false;
	const manual: Step = {
		id: "zip",
		phase: Phase.ARTIFACT,
		title: "zip",
		why: "w",
		dependsOn: [],
		manual: true,
		action: "upload it",
		check: async () => (uploaded ? OK : NO),
	};
	const r = new Runner([manual]);
	await r.refresh();
	assert.equal(r.get("zip").status, Status.BLOCKED_ON_YOU);

	uploaded = true;
	await r.refresh();
	assert.equal(r.get("zip").status, Status.OK);
});

test("GATES ARE EXCLUDED FROM THE COMPLETION COUNT", async () => {
	// Otherwise the console could never report itself done, since nothing it
	// can do will ever satisfy a gate. They are surfaced separately instead.
	const gate: Step = {
		id: "msb",
		phase: Phase.GATE,
		title: "FinCEN MSB registration",
		why: "Custody is money transmission.",
		dependsOn: [],
		gate: true,
		action: "Register, or document an exemption with counsel.",
		check: async () => NO,
	};
	const r = new Runner([stateful("a"), gate]);
	await r.runAll();

	const s = r.summary();
	assert.equal(s.total, 2);
	assert.equal(s.ok, 1);
	assert.equal(s.gates, 1);
	assert.equal(
		s.automatableComplete,
		true,
		"everything automatable is done even though a gate remains",
	);
});

test("summary counts failures and blocks separately", async () => {
	const r = new Runner([
		stateful("fine", { startsDone: true }),
		{
			id: "bad",
			phase: Phase.INSTALL,
			title: "bad",
			why: "w",
			dependsOn: [],
			check: async () => NO,
			run: async () => ({ ok: false, detail: "nope" }),
		},
		{
			id: "yours",
			phase: Phase.ARTIFACT,
			title: "yours",
			why: "w",
			dependsOn: [],
			manual: true,
			action: "do it",
			check: async () => NO,
		},
	]);
	await r.runAll();
	const s = r.summary();
	assert.equal(s.ok, 1);
	assert.equal(s.failed, 1);
	assert.equal(s.blocked, 1);
	assert.equal(s.automatableComplete, false);
});

test("an unknown step id is an error, not a silent no-op", async () => {
	const r = new Runner([stateful("a")]);
	await assert.rejects(() => r.runStep("nope"), StepError);
	assert.throws(() => r.get("nope"), StepError);
});

test("timestamps come from the injected clock", async () => {
	const r = new Runner([stateful("a")], () => Date.parse("2026-11-23T12:00:00Z"));
	await r.refresh();
	assert.equal(r.get("a").at, "2026-11-23T12:00:00.000Z");
});
