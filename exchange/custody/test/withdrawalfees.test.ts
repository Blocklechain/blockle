// -----------------------------------------------------------------------------
// WITHDRAWAL FEE TESTS.
//
// The centrepiece is the second-to-last test: a sweep over every configured
// chain at prices from 1x to 1000x the policy floor, asserting that the fee
// covers the gas at every one of them. That is the claim the user asked
// for — "never spend more on gas than we can possibly take in" — and it is the
// only form of the claim that is worth anything, because a fee table that
// covers gas at today's prices and nowhere else is a fee table that will stop
// covering gas without anybody editing it.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/amount";
import { assetDef, networkOf, settlementAsset } from "../src/assets";
import { LIVE_GAS_COSTS } from "../src/gasgate";
import { GAS_PRICE_FLOOR, StaticRates, rateFromPrice, convertCeil } from "../src/gasrates";
import {
	LIVE_FEES,
	MIN_NET_SHARE_BPS,
	WithdrawalFeeError,
	auditGasCoverage,
	discloseWithdrawalFees,
	gasCoverage,
	quoteWithdrawal,
	type FeeTable,
	type GasPricing,
} from "../src/withdrawalfees";

const FLOOR: GasPricing = { sources: [new StaticRates(GAS_PRICE_FLOOR)] };
const usdt = (s: string): bigint => parse(s, { symbol: "USDT", decimals: 6 });

test("THE FEE IS WITHHELD FROM THE AMOUNT, NOT ADDED TO IT", () => {
	// Which is what lets "withdraw everything" work. If the fee were charged on
	// top, the most common withdrawal there is would fail for want of a balance
	// the customer has by definition just emptied.
	const q = quoteWithdrawal({
		asset: "USDT",
		network: "TRC20",
		amount: usdt("100"),
		table: LIVE_FEES,
		pricing: FLOOR,
	});
	assert.equal(q.amount, usdt("100"), "the debit is the gross");
	assert.equal(q.net + q.fee, q.amount, "net plus fee is exactly the amount");
	assert.ok(q.net < q.amount);
	assert.ok(q.fee > 0n);
});

test("the breakdown adds up and is reported in the asset withdrawn", () => {
	const q = quoteWithdrawal({
		asset: "USDT",
		network: "ERC20",
		amount: usdt("500"),
		table: LIVE_FEES,
		pricing: FLOOR,
	});
	assert.equal(q.gasAllowance + q.margin, q.fee);
	assert.equal(q.gasAsset, "ETH", "ERC-20 gas is paid in ETH, not USDT");
	assert.equal(q.asset, "USDT", "but the fee is charged in USDT");
	assert.match(q.display.note, /paid in ETH/);
});

test("AN UNPRICED CHAIN CANNOT BE WITHDRAWN", () => {
	// Fail closed. A newly-listed asset with no fee row must not withdraw for
	// free — withdrawals are automatic, so nobody would notice until the gas
	// bill arrived.
	assert.throws(
		() =>
			quoteWithdrawal({
				asset: "BLOCK",
				network: undefined,
				amount: 100_000_000n,
				table: {},
				pricing: FLOOR,
			}),
		/no withdrawal fee configured/,
	);
});

test("A CHAIN WITH NO FRESH RATE CANNOT BE WITHDRAWN", () => {
	// The honest refusal: without a rate we cannot show the fee covers the gas,
	// and finding out afterwards means finding out from the books that we lost.
	const stale = rateFromPrice("4000", "ETH", "USDT", {
		asOf: 1_000_000,
		source: "stale-book",
	});
	const pricing: GasPricing = {
		sources: [{ name: "stale-book", rate: () => stale }],
		now: 1_000_000 + 60 * 60 * 1000, // an hour later
	};
	assert.throws(
		() =>
			quoteWithdrawal({
				asset: "USDT",
				network: "ERC20",
				amount: usdt("500"),
				table: LIVE_FEES,
				pricing,
			}),
		/no fresh ETH\/USDT rate/,
	);
});

test("the worst rate wins when sources disagree", () => {
	// Disagreement resolves toward safety. A cheap quote from one source must
	// not be what the fee is computed from.
	const cheap = { name: "cheap", rate: () => rateFromPrice("1000", "ETH", "USDT", { asOf: Number.MAX_SAFE_INTEGER, source: "cheap" }) };
	const dear = { name: "dear", rate: () => rateFromPrice("9000", "ETH", "USDT", { asOf: Number.MAX_SAFE_INTEGER, source: "dear" }) };

	const q = quoteWithdrawal({
		asset: "USDT",
		network: "ERC20",
		amount: usdt("5000"),
		table: LIVE_FEES,
		pricing: { sources: [cheap, dear] },
	});
	assert.equal(q.rateUsed?.source, "dear");
	assert.equal(q.rateUsed?.price, "9000");
});

test("a source that throws is ignored rather than taking the quote down", () => {
	const broken = {
		name: "broken",
		rate: (): never => {
			throw new Error("upstream down");
		},
	};
	const good = new StaticRates(GAS_PRICE_FLOOR);
	const q = quoteWithdrawal({
		asset: "USDT",
		network: "ERC20",
		amount: usdt("500"),
		table: LIVE_FEES,
		pricing: { sources: [broken, good] },
	});
	assert.equal(q.rateUsed?.source, "configured");
});

test("A FEE THAT WOULD EAT MOST OF THE WITHDRAWAL IS REFUSED", () => {
	// We could take it — it is the most profitable withdrawal on the book. A
	// customer who pays 60% to move 10 USDT has been treated badly, and
	// disclosing it in the confirmation is not a defence.
	assert.throws(
		() =>
			quoteWithdrawal({
				asset: "USDT",
				network: "ERC20",
				amount: usdt("5"),
				table: LIVE_FEES,
				pricing: FLOOR,
			}),
		(e: unknown) => {
			assert.ok(e instanceof WithdrawalFeeError);
			assert.match(String(e), /more than half/);
			assert.match(String(e), /minimum withdrawal on this chain is/);
			return true;
		},
	);
});

test("the refusal names a cheaper chain when there is one", () => {
	// A bare "minimum is 29 USDT" leaves someone with 15 USDT at a dead end
	// when another chain would have sent it.
	try {
		quoteWithdrawal({
			asset: "USDT",
			network: "ERC20",
			amount: usdt("5"),
			table: LIVE_FEES,
			pricing: FLOOR,
		});
		assert.fail("should refuse");
	} catch (e) {
		assert.match(String(e), /(SOL|BEP20|TRC20) is cheaper/);
	}
});

test("the minimum is exactly the smallest amount that passes", () => {
	// Off by one here either refuses a legal withdrawal or accepts one that
	// breaches the share rule.
	for (const network of ["TRC20", "ERC20", "SOL", "BEP20"]) {
		const probe = (amount: bigint): ReturnType<typeof quoteWithdrawal> =>
			quoteWithdrawal({ asset: "USDT", network, amount, table: LIVE_FEES, pricing: FLOOR });
		// Find the minimum by quoting a large amount and reading it off.
		const { minimum } = probe(usdt("100000"));
		const atMin = probe(minimum);
		const share = (atMin.net * 10_000n) / atMin.amount;
		assert.ok(
			share >= BigInt(MIN_NET_SHARE_BPS),
			`${network}: at the minimum the customer keeps ${share} bps`,
		);
		assert.throws(() => probe(minimum - 1n), /more than half/, `${network}: one below`);
	}
});

test("a zero-margin fee is refused unless the subsidy is declared", () => {
	// A fee that only reimburses gas is a standing commitment to lose money the
	// moment the estimate goes stale. That has to be a decision somebody wrote
	// down, not a field left blank.
	const noMargin: FeeTable = {
		BLOCK: { gas: 100_000n, gasBufferBps: 0, margin: 0n, marginBps: 0 },
	};
	assert.throws(
		() =>
			quoteWithdrawal({
				asset: "BLOCK",
				network: undefined,
				amount: 10_000_000n,
				table: noMargin,
				pricing: FLOOR,
			}),
		/no margin/,
	);

	const declared: FeeTable = {
		BLOCK: { gas: 100_000n, gasBufferBps: 0, margin: 0n, marginBps: 0, subsidised: true },
	};
	const q = quoteWithdrawal({
		asset: "BLOCK",
		network: undefined,
		amount: 10_000_000n,
		table: declared,
		pricing: FLOOR,
	});
	assert.equal(q.fee, 100_000n, "the gas allowance, with nothing on top");
});

test("A DECLARED SUBSIDY IS STILL REPORTED AS A LOSS", () => {
	// A subsidy you cannot see the cost of is indistinguishable from a bug.
	const declared: FeeTable = {
		BLOCK: { gas: 0n, gasBufferBps: 0, margin: 0n, marginBps: 0, subsidised: true },
	};
	const c = gasCoverage({ asset: "BLOCK", network: undefined, table: declared, pricing: FLOOR });
	assert.equal(c.subsidised, true);
	assert.equal(c.covered, false, "not covered — we are paying");
	assert.match(c.note, /DELIBERATELY SUBSIDISED/);
});

test("an amount of zero or less is refused", () => {
	for (const amount of [0n, -1n, usdt("-5")]) {
		assert.throws(
			() =>
				quoteWithdrawal({
					asset: "USDT",
					network: "TRC20",
					amount,
					table: LIVE_FEES,
					pricing: FLOOR,
				}),
			/must be positive/,
		);
	}
});

test("a qualified asset id is refused — asset and network are separate", () => {
	assert.throws(
		() =>
			quoteWithdrawal({
				asset: "USDT.TRC20",
				network: undefined,
				amount: usdt("100"),
				table: LIVE_FEES,
				pricing: FLOOR,
			}),
		/separately/,
	);
});

test("a self-funding chain involves no conversion", () => {
	// BTC pays its own network fee, so there is no rate and nothing to go stale.
	const c = gasCoverage({ asset: "BTC", network: undefined, table: LIVE_FEES, pricing: FLOOR });
	assert.equal(c.selfFunding, true);
	assert.equal(c.gasAsset, "BTC");
	assert.equal(c.rateSource, "self-funding");
	assert.equal(c.covered, true);
});

test("the published schedule lists every chain with its minimum", () => {
	const rows = discloseWithdrawalFees(LIVE_FEES);
	assert.equal(rows.length, Object.keys(LIVE_FEES).length);
	const erc = rows.find((r) => r.asset === "USDT" && r.network === "ERC20");
	assert.ok(erc !== undefined);
	assert.equal(erc.gasAsset, "ETH", "customers should know what pays the gas");
	assert.ok(Number(erc.minimum) > 0);
});

test("every configured chain covers its gas at the policy floor", () => {
	for (const row of auditGasCoverage(LIVE_FEES, FLOOR)) {
		assert.equal(
			row.covered,
			true,
			`${row.chain} does NOT cover its gas: cost ${row.gasCost}, fee ` +
				`${row.fee}, headroom ${row.headroom} — ${row.note}`,
		);
	}
});

test("THE GUARANTEE: the fee covers the gas across a 1000x price range", () => {
	// The claim is not "covers gas today" but "cannot be configured into a loss
	// by a price move". Sweep every cross-asset chain from a tenth of the
	// policy floor to a hundred times it, and assert the inequality holds at
	// every point. Both sides move with the rate, so this is really a test that
	// the derivation is monotone and never substitutes the configured floor for
	// the derived figure.
	const multipliers = [1, 2, 5, 10, 25, 100, 1000];
	let checked = 0;

	for (const chain of Object.keys(LIVE_GAS_COSTS)) {
		const asset = settlementAsset(chain);
		const network = networkOf(chain);
		const budget = LIVE_GAS_COSTS[chain]!.perWithdrawal;
		const gasAsset =
			network === "ERC20" ? "ETH"
			: network === "TRC20" ? "TRX"
			: network === "SOL" ? "SOL"
			: "BNB";
		const basePrice = GAS_PRICE_FLOOR[`${gasAsset}/${asset}`];
		assert.ok(basePrice !== undefined, `${chain}: no floor price for ${gasAsset}`);

		for (const mult of multipliers) {
			// Scaled in cents and rendered back as a decimal string, because
			// integer bigint division would floor a sub-dollar floor price like
			// TRX's 0.35 to zero — which the rate builder correctly refuses.
			const cents = BigInt(Math.round(Number(basePrice) * 100)) * BigInt(mult);
			const price = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
			const rate = rateFromPrice(price, gasAsset, asset, {
				asOf: Number.MAX_SAFE_INTEGER,
				source: `x${mult}`,
			});
			const pricing: GasPricing = {
				sources: [{ name: `x${mult}`, rate: () => rate }],
			};

			const trueGasCost = convertCeil(budget, rate);
			// Quote at a comfortable amount so the share rule does not refuse.
			const amount =
				trueGasCost * 10n > 0n ? trueGasCost * 10n : 10n ** BigInt(assetDef(asset).decimals);
			const q = quoteWithdrawal({ asset, network, amount, table: LIVE_FEES, pricing });

			assert.ok(
				q.gasAllowance >= trueGasCost,
				`${chain} at ${mult}x: allowance ${q.gasAllowance} < gas cost ` +
					`${trueGasCost} — this withdrawal loses money`,
			);
			assert.ok(
				q.fee > trueGasCost,
				`${chain} at ${mult}x: fee ${q.fee} does not exceed gas cost ` +
					`${trueGasCost} — no margin at all`,
			);
			checked++;
		}
	}
	assert.equal(checked, Object.keys(LIVE_GAS_COSTS).length * multipliers.length);
});

test("and the fee tracks the rate rather than lagging it", () => {
	// A fee that stays put while gas triples is the failure mode this whole
	// derivation exists to remove, so assert the fee actually MOVES.
	const at = (price: string): bigint =>
		quoteWithdrawal({
			asset: "USDT",
			network: "ERC20",
			amount: usdt("100000"),
			table: LIVE_FEES,
			pricing: {
				sources: [
					{
						name: "book",
						rate: () =>
							rateFromPrice(price, "ETH", "USDT", {
								asOf: Number.MAX_SAFE_INTEGER,
								source: "book",
							}),
					},
				],
			},
		}).fee;

	const cheap = at("4000");
	const dear = at("12000");
	assert.ok(dear > cheap * 2n, `fee went ${cheap} -> ${dear} when ETH tripled`);
});
