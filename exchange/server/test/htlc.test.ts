// HTLC address wiring + fail-closed gating for the swap engine.
//
// When the engine is constructed WITH a config it must resolve the DEPLOYED
// HTLC address for each leg (per the active network) and hand it to the client
// in the `lock` step. If a leg's address is unset for the active network the
// engine REFUSES the swap (fail-closed) rather than instructing a lock against
// a missing contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, htlcTarget, type Config } from "../src/config";
import { openDb } from "../src/db";
import { SwapEngine, SwapError } from "../src/swaps";

const MAKER = "block1maker";
const TAKER = "0xsuitaker";

function engineWith(cfg: Config) {
  return new SwapEngine(openDb(cfg.dbPath), cfg);
}

// An htlc config with EVERY leg unset — used to prove fail-closed.
const EMPTY_HTLC = {
  evm: {},
  solana: {},
  sui: {},
  btc: { hotWallet: "", esploraUrl: "" },
  block: { contractId: "" },
};

test("engine refuses a leg whose HTLC address is unset (fail-closed)", () => {
  const cfg = loadConfig({ dbPath: ":memory:", htlc: { ...EMPTY_HTLC } });
  const e = engineWith(cfg);
  assert.throws(
    () =>
      e.create({
        market: "BLOCK/SUI",
        maker: MAKER,
        taker: TAKER,
        makerLeg: { chain: "block", amount: "100000000", recipient: TAKER },
        takerLeg: { chain: "sui", amount: "1000000000", recipient: MAKER },
        feeBps: 10,
      }),
    (err: unknown) =>
      err instanceof SwapError && /no HTLC address configured/i.test((err as Error).message),
    "a swap with an unconfigured leg must be refused, not created",
  );
});

test("fail-closed refusal happens BEFORE any swap row is written", () => {
  const cfg = loadConfig({ dbPath: ":memory:", htlc: { ...EMPTY_HTLC } });
  const e = engineWith(cfg);
  assert.throws(() =>
    e.create({
      market: "BLOCK/SUI",
      maker: MAKER,
      taker: TAKER,
      makerLeg: { chain: "block", amount: "1", recipient: TAKER },
      takerLeg: { chain: "sui", amount: "1", recipient: MAKER },
      feeBps: 10,
    }),
  );
  // nothing persisted for either party
  assert.equal(e.mine(MAKER).length, 0);
  assert.equal(e.mine(TAKER).length, 0);
});

test("only the UNSET leg is refused; a configured counterpart is fine", () => {
  // block configured, sui unset => still refused because BOTH legs must resolve
  const cfg = loadConfig({
    dbPath: ":memory:",
    htlc: { ...EMPTY_HTLC, block: { contractId: "ab".repeat(32) } },
  });
  const e = engineWith(cfg);
  assert.throws(
    () =>
      e.create({
        market: "BLOCK/SUI",
        maker: MAKER,
        taker: TAKER,
        makerLeg: { chain: "block", amount: "1", recipient: TAKER },
        takerLeg: { chain: "sui", amount: "1", recipient: MAKER },
        feeBps: 10,
      }),
    /no HTLC address configured for chain 'sui'/i,
  );
});

test("configured HTLC address is carried into the lock step payload", () => {
  // default testnet config seeds DEV placeholders for testnet-family chains
  const cfg = loadConfig({ dbPath: ":memory:" });
  assert.equal(cfg.mainnetEnabled, false);
  const e = engineWith(cfg);

  const swap = e.create({
    market: "BLOCK/SUI",
    maker: MAKER,
    taker: TAKER,
    makerLeg: { chain: "block", amount: "100000000", recipient: TAKER },
    takerLeg: { chain: "sui", amount: "1000000000", recipient: MAKER },
    feeBps: 10,
  });

  // leg carries the resolved address
  const blockLeg = swap.legs.find((l) => l.role === "maker")!;
  assert.equal(blockLeg.htlcAddress, htlcTarget(cfg, "block").address);
  assert.equal(blockLeg.htlcNetwork, "testnet");

  // maker's lock instruction exposes it to the client
  const step = e.step(swap.swapId, MAKER, "poll");
  assert.equal(step.action, "lock");
  assert.equal(step.chain, "block");
  assert.equal(step.payload!.htlcAddress, htlcTarget(cfg, "block").address);
  assert.equal(step.payload!.htlcFamily, "block");

  // advance to the taker (Sui) lock and check its address too
  e.step(swap.swapId, MAKER, "locked", { lockRef: "blk1" });
  const tStep = e.step(swap.swapId, TAKER, "poll");
  assert.equal(tStep.action, "lock");
  assert.equal(tStep.payload!.htlcAddress, htlcTarget(cfg, "sui").address);
  assert.equal(tStep.payload!.htlcNetwork, "testnet");
});

test("BTC leg lock payload carries the Esplora endpoint + hot wallet", () => {
  const cfg = loadConfig({ dbPath: ":memory:" });
  const e = engineWith(cfg);
  const swap = e.create({
    market: "BTC/SUI",
    maker: "bc1qmaker",
    taker: TAKER,
    makerLeg: { chain: "bitcoin", amount: "100000", recipient: TAKER },
    takerLeg: { chain: "sui", amount: "1000000000", recipient: "bc1qmaker" },
    feeBps: 10,
  });
  const step = e.step(swap.swapId, "bc1qmaker", "poll");
  assert.equal(step.action, "lock");
  assert.equal(step.payload!.htlcFamily, "btc");
  assert.equal(step.payload!.htlc.esploraUrl, cfg.htlc.btc.esploraUrl);
  assert.equal(step.payload!.htlc.hotWallet, cfg.htlc.btc.hotWallet);
});

test("htlcTarget honors the mainnet gate: ethereum→sepolia on testnet", () => {
  const testnet = loadConfig({ dbPath: ":memory:" });
  assert.equal(htlcTarget(testnet, "ethereum").network, "sepolia");
  assert.equal(htlcTarget(testnet, "base").network, "baseSepolia");
  assert.equal(htlcTarget(testnet, "solana").network, "devnet");
  // mainnet-only networks are blank on a testnet deployment => fail-closed
  const mainnetKeyOnTestnet = htlcTarget(
    loadConfig({ dbPath: ":memory:", htlc: { ...EMPTY_HTLC } }),
    "ethereum",
  );
  assert.equal(mainnetKeyOnTestnet.address, "");
});
