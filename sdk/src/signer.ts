// BLOCK signer — the only place the SDK touches private keys. Wraps
// blockle-wasm (the SAME ML-DSA-44 + bincode tx encoding consensus uses) so
// every signature and raw transaction is byte-identical to what the node
// validates. NEVER hand-roll ML-DSA or tx bytes; always go through here.
//
// Keys live in this object, in the agent's process, and never leave it.

import * as wasm from "blockle-wasm";
import type { Utxo } from "./types";

export interface Keys {
  address: string;
  publicKey: string;
  secretKey: string;
}

/** Shape every build_* wasm call returns (parsed from its JSON string). */
export interface BuiltTx {
  txid: string;
  raw: string;
  fee?: number;
  change?: number;
  inputs?: number;
  contractId?: string;
}

function utxosJson(utxos: Utxo[]): string {
  return JSON.stringify(
    utxos.map((u) => ({ txid: u.txid, vout: u.vout, amount: Number(u.amount) })),
  );
}

/**
 * Holds an ML-DSA-44 keypair and builds/signs transactions through wasm.
 * Also the pluggable BLOCK leg-signer for the exchange (signNonce / address).
 */
export class BlockSigner {
  readonly chain = "block" as const;

  private constructor(private keys: Keys) {}

  /** Fresh wallet. */
  static create(): BlockSigner {
    return new BlockSigner(JSON.parse(wasm.keygen()) as Keys);
  }

  /** Restore from hex secret + public key. */
  static import(secretHex: string, publicHex: string): BlockSigner {
    const address = wasm.address_from_pubkey(publicHex);
    return new BlockSigner({ address, publicKey: publicHex, secretKey: secretHex });
  }

  address(): string {
    return this.keys.address;
  }

  publicKey(): string {
    return this.keys.publicKey;
  }

  /** Export secret + public hex. Handle with care — this is the raw key. */
  export(): Keys {
    return { ...this.keys };
  }

  /** ML-DSA sign a UTF-8 message (used for exchange auth nonce). Returns the
   *  signature hex. */
  signMessage(msg: string): string {
    const r = JSON.parse(wasm.sign_message(this.keys.secretKey, this.keys.publicKey, msg));
    return r.signature as string;
  }

  // ---- transaction builders (all amounts base units, bigint) --------------

  buildTransfer(utxos: Utxo[], to: string, amount: bigint, fee: bigint): BuiltTx {
    return JSON.parse(
      wasm.build_transfer(this.keys.secretKey, this.keys.publicKey, utxosJson(utxos), to, amount, fee),
    );
  }

  buildDeploy(utxos: Utxo[], codeHex: string, gasLimit: bigint, gasPrice: bigint): BuiltTx {
    return JSON.parse(
      wasm.build_deploy(this.keys.secretKey, this.keys.publicKey, utxosJson(utxos), codeHex, gasLimit, gasPrice),
    );
  }

  buildCall(
    utxos: Utxo[],
    contractHex: string,
    inputHex: string,
    value: bigint,
    gasLimit: bigint,
    gasPrice: bigint,
  ): BuiltTx {
    return JSON.parse(
      wasm.build_call(
        this.keys.secretKey,
        this.keys.publicKey,
        utxosJson(utxos),
        contractHex,
        inputHex,
        value,
        gasLimit,
        gasPrice,
      ),
    );
  }

  buildPoolCreate(
    utxos: Utxo[],
    tokenHex: string,
    blockAmt: bigint,
    tokenAmt: bigint,
    gasLimit: bigint,
    gasPrice: bigint,
  ): BuiltTx {
    return JSON.parse(
      wasm.build_pool_create(
        this.keys.secretKey,
        this.keys.publicKey,
        utxosJson(utxos),
        tokenHex,
        blockAmt,
        tokenAmt,
        gasLimit,
        gasPrice,
      ),
    );
  }

  buildPoolAdd(
    utxos: Utxo[],
    tokenHex: string,
    blockAmt: bigint,
    tokenMax: bigint,
    gasLimit: bigint,
    gasPrice: bigint,
  ): BuiltTx {
    return JSON.parse(
      wasm.build_pool_add(
        this.keys.secretKey,
        this.keys.publicKey,
        utxosJson(utxos),
        tokenHex,
        blockAmt,
        tokenMax,
        gasLimit,
        gasPrice,
      ),
    );
  }

  buildPoolRemove(utxos: Utxo[], tokenHex: string, shares: bigint, gasLimit: bigint, gasPrice: bigint): BuiltTx {
    return JSON.parse(
      wasm.build_pool_remove(
        this.keys.secretKey,
        this.keys.publicKey,
        utxosJson(utxos),
        tokenHex,
        shares,
        gasLimit,
        gasPrice,
      ),
    );
  }

  buildPoolSwapBuy(
    utxos: Utxo[],
    tokenHex: string,
    blockIn: bigint,
    minTokenOut: bigint,
    gasLimit: bigint,
    gasPrice: bigint,
  ): BuiltTx {
    return JSON.parse(
      wasm.build_pool_swap_buy(
        this.keys.secretKey,
        this.keys.publicKey,
        utxosJson(utxos),
        tokenHex,
        blockIn,
        minTokenOut,
        gasLimit,
        gasPrice,
      ),
    );
  }

  buildPoolSwapSell(
    utxos: Utxo[],
    tokenHex: string,
    tokenIn: bigint,
    minBlockOut: bigint,
    gasLimit: bigint,
    gasPrice: bigint,
  ): BuiltTx {
    return JSON.parse(
      wasm.build_pool_swap_sell(
        this.keys.secretKey,
        this.keys.publicKey,
        utxosJson(utxos),
        tokenHex,
        tokenIn,
        minBlockOut,
        gasLimit,
        gasPrice,
      ),
    );
  }

  /** BLOCK-20 bytecode for a token with metadata + supply baked in. */
  static buildBlock20Token(name: string, symbol: string, decimals: bigint, supply: bigint): string {
    return wasm.build_block20_token(name, symbol, decimals, supply);
  }
}
