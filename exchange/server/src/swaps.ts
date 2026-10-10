// Atomic-swap state machine. The relay COORDINATES the hashlock/preimage
// handshake and tracks the state machine; it NEVER touches funds or keys. The
// two parties perform the actual on-chain HTLC lock/withdraw/refund with their
// own wallets (the SDK's HtlcSigner), driven by the step instructions here.
//
// State machine (matches the shared contract):
//   proposed -> makerLocked -> takerLocked -> makerWithdrew -> claimed
//   any locked state can also -> refunded (on timelock expiry)
//
// Secret handling: the relay generates the preimage and its hash H at swap
// creation, hands H to both parties to lock against, releases the preimage to
// the MAKER to claim the taker's leg, then to the TAKER to claim the maker's
// leg (the preimage is already on-chain by then). The relay holds no funds and
// no keys, so knowing the preimage never lets it move value. A stronger model
// where the maker owns the secret is a documented followup.

import * as crypto from "crypto";
import type { DB } from "./db";
import { audit } from "./db";
import { hash160 } from "./btc";
import { htlcTarget, type Config, type HtlcTarget } from "./config";

export type SwapState =
  | "proposed"
  | "makerLocked"
  | "takerLocked"
  | "makerWithdrew"
  | "claimed"
  | "refunded";

export interface SwapLeg {
  chain: string;
  asset?: string;
  amount: string;
  recipient?: string;
  role: "maker" | "taker";
  timelock: number;
  lockRef?: string;
  status: "pending" | "locked" | "withdrawn" | "refunded";
  /** DEPLOYED HTLC address this leg settles against, resolved for the active
   *  network at create() (fail-closed if unset). Absent on legacy swaps
   *  created without a config. */
  htlcAddress?: string;
  /** concrete network/cluster the htlcAddress belongs to. */
  htlcNetwork?: string;
}

export interface Swap {
  swapId: string;
  market: string;
  state: SwapState;
  hashlock: string;
  maker: string;
  taker: string;
  makerOrder?: string;
  takerOrder?: string;
  legs: SwapLeg[];
  feeBps: number;
  expiry: number;
  created: number;
  updated: number;
  [k: string]: unknown;
}

export interface SwapStep {
  action: "lock" | "withdraw" | "refund" | "wait" | "done" | string;
  chain?: string;
  payload?: Record<string, any>;
  swap: PublicSwap;
}

/** Swap as returned over the wire — preimage is NEVER serialized unless it is
 *  being handed to a party inside a step payload. */
export type PublicSwap = Omit<Swap, never>;

export interface CreateSwapParams {
  market: string;
  maker: string;
  taker: string;
  makerOrder?: string;
  takerOrder?: string;
  /** what the maker locks (gives); recipient = taker's addr on that chain */
  makerLeg: { chain: string; asset?: string; amount: string; recipient?: string };
  /** what the taker locks (gives); recipient = maker's addr on that chain */
  takerLeg: { chain: string; asset?: string; amount: string; recipient?: string };
  feeBps: number;
  /** seconds from now the whole swap expires (drives timelocks) */
  ttlSec?: number;
}

export type SwapEvent = (swap: Swap) => void;

export class SwapEngine {
  private cfg?: Config;
  private onEvent?: SwapEvent;

  /**
   * `cfg` is optional for backward compatibility: when provided (as the server
   * does) the engine resolves + ENFORCES the deployed HTLC address for each leg
   * (fail-closed). When omitted (legacy/unit callers) no HTLC wiring happens.
   * Accepts `(db)`, `(db, onEvent)`, or `(db, cfg, onEvent)`.
   */
  constructor(private db: DB, cfgOrEvent?: Config | SwapEvent, onEvent?: SwapEvent) {
    if (typeof cfgOrEvent === "function") {
      this.onEvent = cfgOrEvent;
    } else if (cfgOrEvent) {
      this.cfg = cfgOrEvent;
      this.onEvent = onEvent;
    }
  }

  /** Resolve the deployed HTLC target for a leg, refusing (fail-closed) when
   *  no address is configured for the active network. Only called when a cfg
   *  is present. */
  private requireHtlc(chain: string): HtlcTarget {
    const t = htlcTarget(this.cfg!, chain);
    if (!t.address) {
      throw new SwapError(
        `no HTLC address configured for chain '${t.chain}' on ${this.cfg!.network} ` +
          `(family=${t.family}, network=${t.network}); set cfg.htlc.* for this network ` +
          `or the leg is refused (fail-closed)`,
      );
    }
    return t;
  }

  create(p: CreateSwapParams): Swap {
    const swapId = "swap_" + crypto.randomBytes(12).toString("hex");
    const preimage = crypto.randomBytes(32).toString("hex");
    const hashlock = crypto.createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const now = Math.floor(Date.now() / 1000);
    const ttl = p.ttlSec ?? 4 * 3600;
    // initiator (maker) locks first with the LONGER timelock; taker's is shorter
    const makerTimelock = now + ttl;
    const takerTimelock = now + Math.floor(ttl / 2);

    // Fail-closed: resolve the DEPLOYED HTLC address for BOTH legs BEFORE any
    // DB write. If a leg's address is unset for the active network, refuse the
    // whole swap (no partial state). Skipped when the engine has no config.
    const makerHtlc = this.cfg ? this.requireHtlc(p.makerLeg.chain) : undefined;
    const takerHtlc = this.cfg ? this.requireHtlc(p.takerLeg.chain) : undefined;

    const legs: SwapLeg[] = [
      {
        chain: p.makerLeg.chain,
        asset: p.makerLeg.asset,
        amount: p.makerLeg.amount,
        recipient: p.makerLeg.recipient,
        role: "maker",
        timelock: makerTimelock,
        status: "pending",
        htlcAddress: makerHtlc?.address,
        htlcNetwork: makerHtlc?.network,
      },
      {
        chain: p.takerLeg.chain,
        asset: p.takerLeg.asset,
        amount: p.takerLeg.amount,
        recipient: p.takerLeg.recipient,
        role: "taker",
        timelock: takerTimelock,
        status: "pending",
        htlcAddress: takerHtlc?.address,
        htlcNetwork: takerHtlc?.network,
      },
    ];

    this.db
      .prepare(
        `INSERT INTO swaps (swap_id, market, state, hashlock, maker, taker, maker_order, taker_order, legs, fee_bps, expiry, created, updated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        swapId,
        p.market,
        "proposed",
        hashlock,
        p.maker,
        p.taker,
        p.makerOrder ?? null,
        p.takerOrder ?? null,
        JSON.stringify(legs),
        p.feeBps,
        makerTimelock,
        now,
        now,
      );
    // preimage lives in the idempotency table under a private scope — never in
    // the swaps row that gets serialized to clients.
    this.db
      .prepare("INSERT OR REPLACE INTO idempotency (key, scope, result, ts) VALUES (?,?,?,?)")
      .run("preimage:" + swapId, "swap-secret", preimage, Date.now());

    const swap = this.get(swapId)!;
    audit(this.db, "swap.create", p.maker, { swapId, market: p.market, taker: p.taker });
    this.onEvent?.(swap);
    return swap;
  }

  private preimage(swapId: string): string {
    const row = this.db
      .prepare("SELECT result FROM idempotency WHERE key=?")
      .get("preimage:" + swapId) as any;
    return row?.result;
  }

  get(swapId: string): Swap | null {
    const r = this.db.prepare("SELECT * FROM swaps WHERE swap_id=?").get(swapId) as any;
    if (!r) return null;
    return rowToSwap(r);
  }

  mine(address: string): Swap[] {
    const rows = this.db
      .prepare("SELECT * FROM swaps WHERE maker=? OR taker=? ORDER BY created DESC")
      .all(address, address) as any[];
    return rows.map(rowToSwap);
  }

  private save(swap: Swap): void {
    swap.updated = Math.floor(Date.now() / 1000);
    this.db
      .prepare("UPDATE swaps SET state=?, legs=?, updated=? WHERE swap_id=?")
      .run(swap.state, JSON.stringify(swap.legs), swap.updated, swap.swapId);
    this.onEvent?.(swap);
  }

  private roleOf(swap: Swap, caller: string): "maker" | "taker" | null {
    if (caller === swap.maker) return "maker";
    if (caller === swap.taker) return "taker";
    return null;
  }

  private leg(swap: Swap, role: "maker" | "taker"): SwapLeg {
    return swap.legs.find((l) => l.role === role)!;
  }

  /**
   * Advance the handshake. `caller` is the authenticated address (maker or
   * taker). `action` is the client's report ("poll" | "locked" | "withdrawn" |
   * "refunded"); the returned SwapStep tells the caller what to do next.
   */
  step(swapId: string, caller: string, action: string, payload?: Record<string, any>): SwapStep {
    const swap = this.get(swapId);
    if (!swap) throw new SwapError("unknown swap");
    const role = this.roleOf(swap, caller);
    if (!role) throw new SwapError("caller is not a party to this swap");

    // Apply the client's report, if any.
    switch (action) {
      case "locked":
        this.applyLocked(swap, role, payload);
        break;
      case "withdrawn":
        this.applyWithdrawn(swap, role, payload);
        break;
      case "refunded":
        this.applyRefunded(swap, role, payload);
        break;
      case "poll":
      case undefined:
      case "":
        break;
      default:
        // unknown report — ignore, just return next instruction
        break;
    }

    return this.instruct(swap, role);
  }

  private applyLocked(swap: Swap, role: "maker" | "taker", payload?: Record<string, any>): void {
    const lockRef = payload?.lockRef ?? payload?.txid;
    if (role === "maker" && swap.state === "proposed") {
      const leg = this.leg(swap, "maker");
      leg.lockRef = lockRef;
      leg.status = "locked";
      swap.state = "makerLocked";
      audit(this.db, "swap.makerLocked", swap.maker, { swapId: swap.swapId, lockRef });
      this.save(swap);
    } else if (role === "taker" && swap.state === "makerLocked") {
      const leg = this.leg(swap, "taker");
      leg.lockRef = lockRef;
      leg.status = "locked";
      swap.state = "takerLocked";
      audit(this.db, "swap.takerLocked", swap.taker, { swapId: swap.swapId, lockRef });
      this.save(swap);
    }
    // otherwise out-of-order report — ignored; instruct() will re-issue.
  }

  private applyWithdrawn(swap: Swap, role: "maker" | "taker", _payload?: Record<string, any>): void {
    if (role === "maker" && swap.state === "takerLocked") {
      this.leg(swap, "taker").status = "withdrawn";
      swap.state = "makerWithdrew";
      audit(this.db, "swap.makerWithdrew", swap.maker, { swapId: swap.swapId });
      this.save(swap);
    } else if (role === "taker" && swap.state === "makerWithdrew") {
      this.leg(swap, "maker").status = "withdrawn";
      swap.state = "claimed";
      audit(this.db, "swap.claimed", swap.taker, { swapId: swap.swapId });
      this.save(swap);
    }
  }

  private applyRefunded(swap: Swap, role: "maker" | "taker", _payload?: Record<string, any>): void {
    const leg = this.leg(swap, role);
    if (leg.status === "locked") {
      leg.status = "refunded";
      audit(this.db, "swap.refunded.leg", role === "maker" ? swap.maker : swap.taker, {
        swapId: swap.swapId,
        role,
      });
    }
    // if neither leg still holds funds, the swap is fully refunded
    if (swap.legs.every((l) => l.status !== "locked")) {
      swap.state = "refunded";
    }
    this.save(swap);
  }

  /** The HTLC settlement context handed to a client inside a `lock` step:
   *  the deployed contract/program/package address for this leg's chain plus
   *  any per-family extras (BTC Esplora endpoint + hot wallet). Empty when the
   *  engine has no config (legacy callers). */
  private htlcPayload(chain: string): Record<string, any> {
    if (!this.cfg) return {};
    const t = this.requireHtlc(chain); // re-asserts fail-closed at instruct time
    return {
      htlcAddress: t.address,
      htlcNetwork: t.network,
      htlcFamily: t.family,
      ...(t.extra ? { htlc: t.extra } : {}),
    };
  }

  /** Decide what the caller should do next given current state. */
  private instruct(swap: Swap, role: "maker" | "taker"): SwapStep {
    const now = Math.floor(Date.now() / 1000);

    if (swap.state === "claimed" || swap.state === "refunded") {
      return { action: "done", swap };
    }

    // refund path: this caller's own leg is locked and its timelock passed
    const myLeg = this.leg(swap, role);
    if (myLeg.status === "locked" && now >= myLeg.timelock) {
      return {
        action: "refund",
        chain: myLeg.chain,
        payload: { lockRef: myLeg.lockRef, asset: myLeg.asset },
        swap,
      };
    }

    const makerLeg = this.leg(swap, "maker");
    const takerLeg = this.leg(swap, "taker");

    switch (swap.state) {
      case "proposed":
        if (role === "maker") {
          const hints = legHints(makerLeg.chain, swap.hashlock, this.preimage(swap.swapId));
          return {
            action: "lock",
            chain: makerLeg.chain,
            payload: {
              hashlock: hints.hashlock || swap.hashlock,
              hashAlgo: hints.hashAlgo,
              timelock: makerLeg.timelock,
              timelockKind: hints.timelockKind,
              timelockUnit: hints.timelockUnit,
              recipient: makerLeg.recipient,
              asset: makerLeg.asset,
              amount: makerLeg.amount,
              note: hints.note,
              ...this.htlcPayload(makerLeg.chain),
            },
            swap,
          };
        }
        return { action: "wait", swap };

      case "makerLocked":
        if (role === "taker") {
          const hints = legHints(takerLeg.chain, swap.hashlock, this.preimage(swap.swapId));
          return {
            action: "lock",
            chain: takerLeg.chain,
            payload: {
              hashlock: hints.hashlock || swap.hashlock,
              hashAlgo: hints.hashAlgo,
              timelock: takerLeg.timelock,
              timelockKind: hints.timelockKind,
              timelockUnit: hints.timelockUnit,
              recipient: takerLeg.recipient,
              asset: takerLeg.asset,
              amount: takerLeg.amount,
              note: hints.note,
              ...this.htlcPayload(takerLeg.chain),
            },
            swap,
          };
        }
        return { action: "wait", swap };

      case "takerLocked":
        if (role === "maker") {
          return {
            action: "withdraw",
            chain: takerLeg.chain,
            payload: {
              lockRef: takerLeg.lockRef,
              preimage: this.preimage(swap.swapId),
              asset: takerLeg.asset,
            },
            swap,
          };
        }
        return { action: "wait", swap };

      case "makerWithdrew":
        if (role === "taker") {
          return {
            action: "withdraw",
            chain: makerLeg.chain,
            payload: {
              lockRef: makerLeg.lockRef,
              preimage: this.preimage(swap.swapId),
              asset: makerLeg.asset,
            },
            swap,
          };
        }
        return { action: "done", swap };
    }

    return { action: "wait", swap };
  }
}

// ---- per-chain HTLC leg semantics -----------------------------------------
//
// The shared protocol uses sha256(preimage) as the canonical hashlock. Bitcoin
// Script's HTLC redeem path uses OP_HASH160 == ripemd160(sha256(preimage)), so
// a BTC leg locks against hash160(preimage) — the SAME preimage, hashed the way
// Bitcoin Script checks it. Both legs are satisfied by the one revealed secret.

export interface LegHints {
  /** how the client must hash the preimage when building this leg's HTLC. */
  hashAlgo: "sha256" | "hash160";
  /** the hashlock value for this leg, hex (no 0x). */
  hashlock: string;
  /** what the leg's timelock encodes. */
  timelockKind: "unixTime" | "blockHeight";
  /** unit of the `timelock` integer handed to the client. */
  timelockUnit: "seconds";
  /** extra per-chain guidance for the HTLC builder. */
  note?: string;
}

/** Derive the hashlock + timelock semantics a given chain's HTLC leg needs,
 *  from the swap's canonical sha256 hashlock and (for BTC) the preimage. */
export function legHints(chain: string, sha256Hashlock: string, preimageHex?: string): LegHints {
  if (chain === "bitcoin" || chain === "btc") {
    // OP_HASH160 over the preimage. Needs the preimage to compute; falls back
    // to just announcing the algo when the preimage is not being revealed.
    let h = "";
    if (preimageHex) {
      const d = hash160(Buffer.from(preimageHex, "hex"));
      h = Buffer.from(d).toString("hex");
    }
    return {
      hashAlgo: "hash160",
      hashlock: h,
      timelockKind: "unixTime",
      timelockUnit: "seconds",
      note: "Bitcoin Script HTLC: OP_HASH160 <h> redeem, OP_CHECKLOCKTIMEVERIFY refund (nLockTime = unix seconds).",
    };
  }
  if (chain === "sui") {
    return {
      hashAlgo: "sha256",
      hashlock: sha256Hashlock,
      timelockKind: "unixTime",
      timelockUnit: "seconds",
      note: "Sui Move HTLC shared object: sha256 hashlock; refund after Clock timestamp (seconds*1000 = ms).",
    };
  }
  // EVM / Solana / BLOCK: canonical sha256 hashlock. BLOCK uses a height
  // timelock in the contract, but the engine issues a unix-seconds timelock the
  // client translates; label it accordingly.
  return {
    hashAlgo: "sha256",
    hashlock: sha256Hashlock,
    timelockKind: chain === "block" ? "blockHeight" : "unixTime",
    timelockUnit: "seconds",
  };
}

function rowToSwap(r: any): Swap {
  return {
    swapId: r.swap_id,
    market: r.market,
    state: r.state,
    hashlock: r.hashlock,
    maker: r.maker,
    taker: r.taker,
    makerOrder: r.maker_order ?? undefined,
    takerOrder: r.taker_order ?? undefined,
    legs: JSON.parse(r.legs),
    feeBps: r.fee_bps,
    expiry: r.expiry,
    created: r.created,
    updated: r.updated,
  };
}

export class SwapError extends Error {}
