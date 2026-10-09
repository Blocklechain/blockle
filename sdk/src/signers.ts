// Pluggable signers for the non-custodial exchange. Keys NEVER leave the
// agent: every signature and every on-chain HTLC leg is performed locally by
// one of these. The relay only coordinates the hashlock/preimage/timelocks —
// it never holds funds or keys.
//
// - The BLOCK leg is always available (backed by blockle-wasm via BlockSigner).
// - EVM (ethers) and Solana (@solana/web3.js) legs are OPTIONAL: the agent
//   injects a signer object implementing HtlcSigner if it wants to settle
//   ETH/BASE/SOL/USDC/USDT legs itself. We depend on NEITHER library directly
//   so the SDK stays dependency-light; the agent brings its own.

export type ChainKind = "block" | "ethereum" | "base" | "solana" | (string & {});

/** Minimal signer used for exchange sign-in (sign the auth nonce). */
export interface AuthSigner {
  readonly chain: ChainKind;
  address(): string | Promise<string>;
  /**
   * Sign the auth nonce the chain's way:
   *  - block: ML-DSA via blockle-wasm sign_message
   *  - ethereum/base: EVM personal_sign
   *  - solana: ed25519 detached signature
   * Return the signature as a hex (block/evm) or base58/hex (solana) string.
   */
  signNonce(nonce: string): string | Promise<string>;
}

/** One leg of an atomic swap, as instructed by the relay's /swaps/{id}/step. */
export interface HtlcLockParams {
  /** hashlock H (hex) the counterparty leg must reveal the preimage for */
  hashlock: string;
  /** absolute timelock (unix seconds) after which refund is allowed */
  timelock: number;
  /** who can withdraw with the preimage (counterparty's address on this chain) */
  recipient: string;
  /** asset identifier on this chain (contract/mint; empty = native) */
  asset?: string;
  /** amount in base units of the asset */
  amount: bigint;
  /** opaque extra fields the relay supplied for this chain */
  extra?: Record<string, unknown>;
}

export interface HtlcWithdrawParams {
  /** the HTLC the counterparty locked, as identified by the relay */
  lockRef: string;
  /** preimage (hex) that hashes to H */
  preimage: string;
  asset?: string;
  extra?: Record<string, unknown>;
}

export interface HtlcRefundParams {
  lockRef: string;
  asset?: string;
  extra?: Record<string, unknown>;
}

export interface HtlcReceipt {
  /** on-chain tx id / hash of the lock, withdraw, or refund */
  txid: string;
  /** chain-specific handle the relay/counterparty uses to find this lock */
  lockRef?: string;
}

/** A signer that can also perform the on-chain HTLC legs for its chain. */
export interface HtlcSigner extends AuthSigner {
  htlcLock(p: HtlcLockParams): Promise<HtlcReceipt>;
  htlcWithdraw(p: HtlcWithdrawParams): Promise<HtlcReceipt>;
  htlcRefund(p: HtlcRefundParams): Promise<HtlcReceipt>;
}

export interface EvmSignerConfig {
  chain: "ethereum" | "base";
  /** an injected HtlcSigner (e.g. built on ethers) the agent controls */
  signer: HtlcSigner;
}

export interface SolanaSignerConfig {
  chain: "solana";
  signer: HtlcSigner;
}
