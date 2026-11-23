// -----------------------------------------------------------------------------
// THE SETUP FLOW, AS DATA.
//
// This is the whole exchange bring-up expressed as a dependency graph of steps,
// so the console at admin.blockle.org can show exactly where things stand and
// run everything that does not need a human. The goal is that ONE step is
// blocked on the operator — fetching the TradeXPro build from Envato, which
// needs a login we cannot and should not automate.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE:
//
// 1. EVERY STEP IS IDEMPOTENT, and `check` is separate from `run`. `check` is a
//    read-only probe that answers "is this already true?"; `run` is the action.
//    A setup console gets re-opened, reloaded, and re-run halfway through, so a
//    step that cannot safely run twice is a step that will eventually corrupt
//    something. Running a satisfied step is a no-op by construction: the engine
//    checks first and skips.
//
// 2. DEPENDENCIES ARE DECLARED, NOT IMPLIED BY ORDER. "Migrate the database"
//    must not run before "install the code", and relying on array order to
//    guarantee that breaks the moment someone inserts a step. The engine
//    resolves the graph and refuses to run a step whose dependencies are not
//    satisfied.
//
// 3. SOME STEPS CAN NEVER BE AUTOMATED, AND SAY SO. The licence question, the
//    money-transmitter registration, the legal sign-off — these are marked
//    `gate` and are deliberately unrunnable. A console that let someone click
//    through them would be worse than no console, because it would imply the
//    work was done. They render as blocked, with the reason, forever, until a
//    human records the answer out of band.
// -----------------------------------------------------------------------------

export enum Phase {
	/** Read-only probes of the host: DNS, TLS, services, mail DNS, egress. */
	PREFLIGHT = "preflight",
	/** The one phase that needs the operator. */
	ARTIFACT = "artifact",
	/** Install and configure TradeXPro. */
	INSTALL = "install",
	/** Harden: drop the plaintext-key model, widen precision, brand it. */
	HARDEN = "harden",
	/** Custody service, BitGo, reconciliation. */
	CUSTODY = "custody",
	/** Legal and licensing. NEVER automated. */
	GATE = "gate",
}

export enum Status {
	/** Dependencies unmet; cannot run yet. */
	WAITING = "waiting",
	/** Ready to run. */
	READY = "ready",
	/** Currently running. */
	RUNNING = "running",
	/** `check` passed. */
	OK = "ok",
	/** `run` failed, or `check` failed after a run. */
	FAILED = "failed",
	/** Needs the operator — upload, a password, a decision. */
	BLOCKED_ON_YOU = "blocked_on_you",
	/** A gate that no software may satisfy. */
	GATE = "gate",
}

export interface StepResult {
	readonly ok: boolean;
	/** Shown verbatim in the console. Must be true and specific. */
	readonly detail: string;
}

export interface Step {
	readonly id: string;
	readonly phase: Phase;
	readonly title: string;
	/** What this does and why, shown in the console. Plain language. */
	readonly why: string;
	readonly dependsOn: readonly string[];
	/**
	 * Read-only probe. MUST NOT mutate anything — the engine calls it freely,
	 * including on every page load.
	 */
	readonly check: () => Promise<StepResult>;
	/**
	 * The action. Absent means the step cannot be automated:
	 *   - `manual: true`  -> the operator does something (upload, password)
	 *   - `gate: true`    -> nothing may satisfy it but a recorded human answer
	 */
	readonly run?: () => Promise<StepResult>;
	readonly manual?: boolean;
	readonly gate?: boolean;
	/** Shown when manual or gated: what the human actually has to do. */
	readonly action?: string;
	/**
	 * True if running this is hard to undo (drops a column, writes a schema).
	 * The console requires an explicit confirm for these rather than running
	 * them as part of "run everything".
	 */
	readonly destructive?: boolean;
}

export interface StepState {
	readonly id: string;
	readonly status: Status;
	readonly detail: string;
	/** ISO timestamp of the last check or run. */
	readonly at: string | undefined;
}

export class StepError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StepError";
	}
}

/**
 * Resolve the graph into a safe execution order.
 *
 * Kahn's algorithm, with the cycle case raised rather than silently dropped —
 * a cycle means two steps each wait for the other, and the symptom without this
 * check is a console that shows everything as WAITING with no explanation.
 */
export function topoSort(steps: readonly Step[]): readonly Step[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	for (const s of steps) {
		for (const d of s.dependsOn) {
			if (!byId.has(d)) {
				throw new StepError(`step "${s.id}" depends on "${d}", which does not exist`);
			}
		}
	}

	const indegree = new Map<string, number>(steps.map((s) => [s.id, s.dependsOn.length]));
	const dependents = new Map<string, string[]>();
	for (const s of steps) {
		for (const d of s.dependsOn) {
			const list = dependents.get(d) ?? [];
			list.push(s.id);
			dependents.set(d, list);
		}
	}

	// Stable: preserve declaration order among equally-ready steps, so the
	// console's layout does not shuffle between loads.
	const ready = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
	const out: Step[] = [];
	while (ready.length > 0) {
		const id = ready.shift()!;
		out.push(byId.get(id)!);
		for (const dep of dependents.get(id) ?? []) {
			const n = (indegree.get(dep) ?? 0) - 1;
			indegree.set(dep, n);
			if (n === 0) ready.push(dep);
		}
	}

	if (out.length !== steps.length) {
		const stuck = steps.filter((s) => !out.includes(s)).map((s) => s.id);
		throw new StepError(`dependency cycle among: ${stuck.join(", ")}`);
	}
	return out;
}

/**
 * The engine: probes every step, runs what it can, and reports honestly.
 *
 * Deliberately has NO opinion about HTTP or the UI — it is pure orchestration
 * over the step list, which is what makes it testable without a server, a
 * database, or a host to install onto.
 */
export class Runner {
	private readonly byId: Map<string, Step>;
	private readonly order: readonly Step[];
	private readonly state = new Map<string, StepState>();

	constructor(
		steps: readonly Step[],
		private readonly now: () => number = () => Date.now(),
	) {
		this.order = topoSort(steps);
		this.byId = new Map(steps.map((s) => [s.id, s]));
		for (const s of steps) {
			this.state.set(s.id, {
				id: s.id,
				status: s.gate === true ? Status.GATE : Status.WAITING,
				detail: s.gate === true ? (s.action ?? "requires a human decision") : "not checked",
				at: undefined,
			});
		}
	}

	steps(): readonly Step[] {
		return this.order;
	}

	states(): readonly StepState[] {
		return this.order.map((s) => this.state.get(s.id)!);
	}

	get(id: string): StepState {
		const s = this.state.get(id);
		if (s === undefined) throw new StepError(`no step "${id}"`);
		return s;
	}

	/**
	 * Probe every step, in dependency order, without changing anything.
	 *
	 * Runs sequentially rather than in parallel on purpose: a later step's
	 * `check` is often only meaningful once an earlier one is known satisfied
	 * (there is no point probing the database schema before the code is even
	 * installed), and a parallel sweep produces a wall of confusing failures on
	 * a fresh host.
	 */
	async refresh(): Promise<readonly StepState[]> {
		for (const step of this.order) {
			if (step.gate === true) {
				this.set(step.id, Status.GATE, step.action ?? "requires a human decision");
				continue;
			}

			const unmet = this.unmetDeps(step);
			if (unmet.length > 0) {
				// Still probe it — a step can legitimately already be satisfied
				// even when its declared dependencies are not (a pre-existing
				// host), and reporting OK is more useful than hiding it.
				const probe = await this.safeCheck(step);
				if (probe.ok) {
					this.set(step.id, Status.OK, probe.detail);
				} else {
					this.set(
						step.id,
						Status.WAITING,
						`waiting on: ${unmet.join(", ")}`,
					);
				}
				continue;
			}

			const probe = await this.safeCheck(step);
			if (probe.ok) {
				this.set(step.id, Status.OK, probe.detail);
			} else if (step.manual === true || step.run === undefined) {
				this.set(step.id, Status.BLOCKED_ON_YOU, step.action ?? probe.detail);
			} else {
				this.set(step.id, Status.READY, probe.detail);
			}
		}
		return this.states();
	}

	/**
	 * Run one step, if it is runnable and its dependencies are met.
	 *
	 * Checks FIRST and skips if already satisfied — that is what makes the
	 * console safe to re-run. Then checks AGAIN after running, because a `run`
	 * that returns success while leaving the system unchanged is the failure
	 * mode that makes a green console a lie.
	 */
	async runStep(id: string): Promise<StepState> {
		const step = this.byId.get(id);
		if (step === undefined) throw new StepError(`no step "${id}"`);

		if (step.gate === true) {
			return this.set(id, Status.GATE, step.action ?? "requires a human decision");
		}
		if (step.run === undefined) {
			return this.set(
				id,
				Status.BLOCKED_ON_YOU,
				step.action ?? "this step has to be done by hand",
			);
		}

		const unmet = this.unmetDeps(step);
		if (unmet.length > 0) {
			return this.set(id, Status.WAITING, `waiting on: ${unmet.join(", ")}`);
		}

		const before = await this.safeCheck(step);
		if (before.ok) return this.set(id, Status.OK, `already done — ${before.detail}`);

		this.set(id, Status.RUNNING, "running");
		let ran: StepResult;
		try {
			ran = await step.run();
		} catch (e) {
			return this.set(id, Status.FAILED, e instanceof Error ? e.message : String(e));
		}
		if (!ran.ok) return this.set(id, Status.FAILED, ran.detail);

		// VERIFY. Trusting `run`'s own word is how a console ends up green over
		// a broken host.
		const after = await this.safeCheck(step);
		return after.ok
			? this.set(id, Status.OK, after.detail)
			: this.set(
					id,
					Status.FAILED,
					`the step reported success but the check still fails: ${after.detail}`,
				);
	}

	/**
	 * Run everything runnable, in dependency order, stopping a branch when a
	 * step it depends on fails.
	 *
	 * SKIPS DESTRUCTIVE STEPS. Dropping a column or rewriting a schema should
	 * be a deliberate click, not a side effect of "run everything" — the
	 * operator may be re-running this against a populated database.
	 */
	async runAll(opts: { includeDestructive?: boolean } = {}): Promise<readonly StepState[]> {
		for (const step of this.order) {
			if (step.gate === true) {
				this.set(step.id, Status.GATE, step.action ?? "requires a human decision");
				continue;
			}

			// A STEP WE CANNOT RUN STILL HAS TO BE PROBED AND REPORTED.
			//
			// Skipping it outright left manual steps sitting at WAITING after a
			// full run, so the operator's one genuinely required action — fetching
			// the build from Envato — rendered as "waiting on something else"
			// rather than "blocked on you". That is precisely backwards for a
			// console whose entire job is to surface the human's one task.
			if (step.run === undefined) {
				const probe = await this.safeCheck(step);
				this.set(
					step.id,
					probe.ok ? Status.OK : Status.BLOCKED_ON_YOU,
					probe.ok ? probe.detail : (step.action ?? probe.detail),
				);
				continue;
			}

			if (step.destructive === true && opts.includeDestructive !== true) {
				const probe = await this.safeCheck(step);
				this.set(
					step.id,
					probe.ok ? Status.OK : Status.BLOCKED_ON_YOU,
					probe.ok
						? probe.detail
						: `${step.action ?? "irreversible"} — run this one deliberately`,
				);
				continue;
			}
			if (this.unmetDeps(step).length > 0) {
				this.set(step.id, Status.WAITING, `waiting on: ${this.unmetDeps(step).join(", ")}`);
				continue;
			}
			await this.runStep(step.id);
		}
		return this.states();
	}

	/** Dependencies not currently OK. */
	private unmetDeps(step: Step): readonly string[] {
		return step.dependsOn.filter((d) => this.state.get(d)?.status !== Status.OK);
	}

	/**
	 * A `check` that throws is a failed check, not a crashed console.
	 *
	 * Probes touch DNS, sockets and subprocesses, all of which throw for
	 * ordinary reasons on a half-built host. One unreachable service must not
	 * take down the page that is supposed to tell you about it.
	 */
	private async safeCheck(step: Step): Promise<StepResult> {
		try {
			return await step.check();
		} catch (e) {
			return { ok: false, detail: e instanceof Error ? e.message : String(e) };
		}
	}

	private set(id: string, status: Status, detail: string): StepState {
		const s: StepState = {
			id,
			status,
			detail,
			at: new Date(this.now()).toISOString(),
		};
		this.state.set(id, s);
		return s;
	}

	/** Progress summary for the console header. */
	summary(): {
		total: number;
		ok: number;
		failed: number;
		blocked: number;
		gates: number;
		/** True when everything automatable is OK. Gates are reported apart. */
		automatableComplete: boolean;
	} {
		const all = this.states();
		const gates = all.filter((s) => s.status === Status.GATE).length;
		const ok = all.filter((s) => s.status === Status.OK).length;
		const failed = all.filter((s) => s.status === Status.FAILED).length;
		const blocked = all.filter((s) => s.status === Status.BLOCKED_ON_YOU).length;
		return {
			total: all.length,
			ok,
			failed,
			blocked,
			gates,
			// Gates are excluded: they are never satisfiable by this console, so
			// counting them would mean it could never report itself done. They
			// are surfaced separately and loudly instead.
			automatableComplete: ok === all.length - gates && failed === 0 && blocked === 0,
		};
	}
}
