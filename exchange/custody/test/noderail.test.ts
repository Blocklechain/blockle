// -----------------------------------------------------------------------------
// NODE PAYOUT RAIL TESTS.
//
// The thing being defended is the same as on the BitGo rail — NEVER PAY A
// CUSTOMER TWICE — but the mechanism is weaker, and these tests pin down
// exactly how far it goes.
//
// BitGo refuses a duplicate sequence id. bitcoind does not refuse anything. So
// the protection is: the withdrawal id travels in the send's COMMENT, the
// daemon stores it with the transaction, and a retry finds it there. These
// tests cover the recovery path and the one state transition that can refund
// a customer — which must happen on the daemon's own word and nothing else.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { BitcoinRpcAdapter, JsonRpc } from "../src/chains";
import { NodePayoutRail, SINGLE_INSTANCE_NOTE, railFor } from "../src/noderail";

function rpcStub(
	answers: Record<string, unknown>,
	seen?: Array<{ method: string; params: unknown }>,
): typeof fetch {
	return (async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
		seen?.push({ method: body.method, params: body.params });
		if (!(body.method in answers)) {
			return new Response(
				JSON.stringify({ error: { message: `Method not found: ${body.method}` } }),
				{ status: 200 },
			);
		}
		const v = answers[body.method];
		if (v instanceof Error) {
			return new Response(JSON.stringify({ error: { message: v.message } }), { status: 200 });
		}
		return new Response(JSON.stringify({ result: v }), { status: 200 });
	}) as unknown as typeof fetch;
}

function rail(
	answers: Record<string, unknown>,
	opts: { send?: boolean; confirmations?: number } = {},
	seen?: Array<{ method: string; params: unknown }>,
) {
	const adapter = new BitcoinRpcAdapter(
		"RTM",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			fetchImpl: rpcStub(answers, seen),
			...(opts.send === false ? {} : { allowSend: true }),
		}),
		8,
	);
	return new NodePayoutRail(adapter, opts.confirmations ?? 6);
}

// ------------------------------------------------------------ the double pay

test("A PRIOR SEND IS FOUND BY ITS COMMENT, so a retry recovers instead of resending", async () => {
	// This is the whole substitute for BitGo's sequence id.
	const r = rail({
		listtransactions: [
			{ category: "send", txid: "abc123", comment: "blockle-wd-7" },
		],
		gettransaction: { txid: "abc123", confirmations: 3, fee: -0.0001 },
	});
	const found = await r.findBySequenceId({ coin: "", walletId: "", sequenceId: "blockle-wd-7" });
	assert.equal(found?.txid, "abc123");
	assert.equal(found?.id, "abc123", "the txid IS the transfer id on this rail");
	// Its state comes from the chain, not from the fact that it was found.
	assert.equal(found?.state, "unconfirmed");
	assert.equal(found?.confirmations, 3);
	// Fee magnitude, sign discarded: a send reports it negative.
	assert.equal(found?.feeBaseUnits, 10_000n);
});

test("no prior send is undefined, not an error", async () => {
	const r = rail({ listtransactions: [] });
	assert.equal(
		await r.findBySequenceId({ coin: "", walletId: "", sequenceId: "blockle-wd-7" }),
		undefined,
	);
});

test("the withdrawal id goes out as the comment, and the amount as a decimal string", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const r = rail({ sendtoaddress: "newtx" }, {}, seen);
	const out = await r.send({
		coin: "", walletId: "", address: "RTMaddr", amount: 150_000_000n,
		sequenceId: "blockle-wd-9",
	});
	assert.deepEqual(seen[0]!.params, ["RTMaddr", "1.5", "blockle-wd-9"]);
	assert.equal(out.transfer.txid, "newtx");
	// A FRESH BROADCAST IS NOT CONFIRMED. Saying otherwise would settle a
	// payout the chain has not accepted.
	assert.equal(out.transfer.state, "unconfirmed");
	assert.equal(out.transfer.confirmations, 0);
	assert.equal(out.alreadySent, false, "a daemon cannot tell us it already sent this");
});

// ---------------------------------------------------------------- settlement

test("CONFIRMED ONLY AT THE REQUIRED DEPTH", async () => {
	for (const [confs, state] of [[0, "unconfirmed"], [5, "unconfirmed"], [6, "confirmed"],
		[99, "confirmed"]] as const) {
		const r = rail({ gettransaction: { txid: "t", confirmations: confs } }, { confirmations: 6 });
		assert.equal((await r.transfer({ coin: "", walletId: "", transferId: "t" })).state, state,
			`${confs} confirmations`);
	}
});

test("NEGATIVE CONFIRMATIONS ARE THE ONE GROUND FOR REVERSING A DEBIT", async () => {
	// bitcoind reports a conflicted transaction this way: replaced or reorged
	// out, and not coming back. That is the custodian's own word, which is the
	// only thing the runner reverses on.
	const r = rail({ gettransaction: { txid: "t", confirmations: -1 } });
	const t = await r.transfer({ coin: "", walletId: "", transferId: "t" });
	assert.equal(t.state, "failed");
	// Reported as zero outward: a negative count in a report reads as a bug.
	assert.equal(t.confirmations, 0);
});

test("an unreachable daemon throws rather than reporting a state", async () => {
	// "I cannot tell" must never resolve to "failed" — that would refund a
	// customer whose coins may be on their way.
	const r = new NodePayoutRail(
		new BitcoinRpcAdapter("RTM", new JsonRpc({
			url: "http://127.0.0.1:9999",
			allowSend: true,
			fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
		}), 8),
		6,
	);
	await assert.rejects(
		() => r.transfer({ coin: "", walletId: "", transferId: "t" }),
		/could not reach/,
	);
});

// ------------------------------------------------------------- can it send

test("a read-only adapter makes the rail refuse, and it names what to set", async () => {
	const r = rail({}, { send: false });
	assert.equal(r.canSend, false);
	assert.match(r.credentialHint, /CHAIN_RTM_SEND=1/);
	assert.match(r.credentialHint, /CHAIN_RTM_PASSPHRASE/);
	await assert.rejects(
		() => r.send({ coin: "", walletId: "", address: "a", amount: 1n, sequenceId: "k" }),
		/read-only/,
	);
});

test("a nonsensical confirmation depth is refused at construction", () => {
	const adapter = new BitcoinRpcAdapter("RTM", new JsonRpc({
		url: "http://127.0.0.1:1", fetchImpl: rpcStub({}),
	}), 8);
	for (const n of [0, -1, 1.5]) {
		assert.throws(() => new NodePayoutRail(adapter, n), /cannot settle at/, String(n));
	}
});

test("the single-instance assumption is written down where it can be printed", () => {
	// It is a real weakness relative to BitGo, not a footnote.
	assert.match(SINGLE_INSTANCE_NOTE, /cannot refuse a duplicate send/);
	assert.match(SINGLE_INSTANCE_NOTE, /only from its systemd unit/);
});

// -------------------------------------------------------------------- routing

test("a node coin goes to its own rail; everything else to the custodian", () => {
	const node = rail({});
	const bitgo = { canSend: true } as never;
	const nodeRails = new Map([["RTM", node]]);
	assert.equal(railFor({ asset: "RTM", bitgo, nodeRails }), node);
	assert.equal(railFor({ asset: "BTC", bitgo, nodeRails }), bitgo);
	// No custodian at all is undefined, which the runner already handles as
	// "cannot action this withdrawal" rather than attempting it somewhere.
	assert.equal(railFor({ asset: "BTC", nodeRails }), undefined);
});
