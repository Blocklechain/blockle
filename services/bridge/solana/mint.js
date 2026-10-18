// mint.js — wBLOCK SPL token tooling for the BLOCK<->wBLOCK bridge.
//
// TRUST MODEL (read docs/bridge/SOLANA.md): this is a CUSTODIAL / trusted-operator
// bridge. wBLOCK is a STANDARD SPL mint (SPL Token Program, no custom program)
// whose supply is backed 1:1 by BLOCK held in the operator's reserve wallet. It is
// NOT a trustless on-chain vault. An off-chain DB is NOT an on-chain vault. Supply
// goes UP when a BLOCK deposit is verified (mint-to) and DOWN on redemption (burn).
//
// wBLOCK is decimals=8 to match BLOCK (COIN = 1e8 base units), so 1 wBLOCK base
// unit == 1 BLOCK base unit and reconciliation is exact integer math.
//
// SAFETY (NON-NEGOTIABLE):
//   * Every function here is DRY-RUN by default. A real on-chain transaction only
//     happens when the caller passes { execute: true } AND the loaded config says
//     mainnet/devnet sends are enabled. Nothing in this file is auto-run.
//   * The mint authority keypair is NEVER inlined. It is loaded from a filesystem
//     path given by env (BRIDGE_SOLANA_KEYPAIR) or config — a Solana CLI keypair
//     JSON (byte array). Secrets never enter source/config/committed files.
//   * There is NO public/unrestricted mint. mintSolblock is called by the bridge
//     ONLY after services/settlement/src/chain.ts-style deposit verification.
//
// This module exports clear functions and RUNS NOTHING on import. ESM (the bridge
// service is type:module).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as splToken from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- token spec ------------------------------------------------------------
// The SPL Token Program itself stores NO name/symbol — those live in a separate
// Metaplex Token Metadata account (optional, see metadataPlan below). We keep the
// canonical spec here so every tool agrees.
export const wBLOCK = Object.freeze({
  name: "Wrapped Blockle",
  symbol: "wBLOCK",
  decimals: 8, // MUST match BLOCK (1 COIN = 1e8) so backing is exact integer math
  // Metaplex off-chain metadata (served by the Blockle site). Carries the FULL
  // BLOCK ecosystem description + the custodial-wrapped disclosure and REUSES the
  // canonical BLOCK logo (https://blockle.org/logo.png) — see web/wblock-token.json.
  uri: process.env.BRIDGE_wBLOCK_METADATA_URI || "https://blockle.org/wblock-token.json",
  image: "https://blockle.org/logo.png",
});

export const KNOWN_CLUSTERS = Object.freeze({
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
});

function envBool(k, d) {
  const v = process.env[k];
  if (v == null || v === "") return d;
  return v === "1" || String(v).toLowerCase() === "true";
}

// ---- config ----------------------------------------------------------------
// env overrides file overrides defaults. The file is services/bridge/config.json
// (NOT committed with secrets — keypair PATH only). See config.sample.json.
export function loadSolanaConfig(overrides = {}) {
  const cfgPath =
    process.env.BRIDGE_SOLANA_CONFIG || path.join(__dirname, "..", "config.json");
  let file = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    file = parsed.solana || parsed || {};
  } catch {
    /* defaults */
  }
  const cluster = process.env.BRIDGE_SOLANA_CLUSTER || file.cluster || "devnet";
  const rpcUrl =
    process.env.BRIDGE_SOLANA_RPC_URL ||
    file.rpcUrl ||
    KNOWN_CLUSTERS[cluster] ||
    KNOWN_CLUSTERS.devnet;
  // The master switch. Even with execute:true, no send happens unless this is on.
  // Default OFF. mainnet-beta additionally requires explicit mainnetEnabled.
  const sendsEnabled = envBool("BRIDGE_SOLANA_SENDS_ENABLED", file.sendsEnabled ?? false);
  const mainnetEnabled = envBool("BRIDGE_SOLANA_MAINNET_ENABLED", file.mainnetEnabled ?? false);
  return {
    cluster,
    rpcUrl,
    sendsEnabled,
    mainnetEnabled,
    // Path to a Solana CLI keypair JSON (byte array). NEVER the key itself.
    authorityKeypairPath:
      process.env.BRIDGE_SOLANA_KEYPAIR || file.authorityKeypairPath || "",
    // Existing wBLOCK mint address (base58). Empty until createSolblockMint ran.
    mintAddress: process.env.BRIDGE_wBLOCK_MINT || file.mintAddress || "",
    ...overrides,
  };
}

// A real on-chain send is permitted only when the caller asked to execute AND the
// config enables sends AND (for mainnet-beta) mainnet is explicitly enabled.
export function sendsPermitted(cfg, execute) {
  if (!execute) return false;
  if (!cfg.sendsEnabled) return false;
  if (cfg.cluster === "mainnet-beta" && !cfg.mainnetEnabled) return false;
  return true;
}

// ---- keypair / connection --------------------------------------------------
// Load a Solana CLI keypair JSON (array of 64 bytes) from a filesystem path.
// Throws loudly if the path is missing/invalid — we never fabricate a key.
export function loadAuthorityKeypair(cfg) {
  const p = cfg.authorityKeypairPath;
  if (!p) {
    throw new Error(
      "no authority keypair: set BRIDGE_SOLANA_KEYPAIR (or solana.authorityKeypairPath) " +
        "to a Solana CLI keypair JSON path — never inline the key",
    );
  }
  let bytes;
  try {
    bytes = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`cannot read keypair at ${p}: ${e.message}`);
  }
  if (!Array.isArray(bytes) || (bytes.length !== 64 && bytes.length !== 32)) {
    throw new Error(`keypair at ${p} is not a valid Solana keypair byte array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function getConnection(cfg) {
  return new Connection(cfg.rpcUrl, "confirmed");
}

// ---- base-unit helpers (wBLOCK shares BLOCK's 8 decimals) ----------------
export function toBaseUnits(amount) {
  // amount: integer base-unit string/number/bigint -> bigint. We take base units
  // directly (not a decimal wBLOCK float) so there is no rounding ambiguity on
  // the money path; the bridge passes the exact BLOCK base units it verified.
  const b = BigInt(amount);
  if (b <= 0n) throw new Error("amountBase must be a positive integer (base units)");
  return b;
}

export function formatUnits(base) {
  const n = BigInt(base);
  const d = 10n ** BigInt(wBLOCK.decimals);
  const whole = n / d;
  const frac = (n % d).toString().padStart(wBLOCK.decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function assertPubkey(v, label) {
  try {
    return new PublicKey(v);
  } catch {
    throw new Error(`invalid ${label}: not a base58 Solana public key`);
  }
}

// ---- create the wBLOCK mint ----------------------------------------------
// Creates a standard SPL mint, decimals 8, mint authority = the loaded bridge key,
// freeze authority disabled (null) by default. DRY-RUN unless sends permitted.
export async function createSolblockMint({ cfg, execute = false, freezeAuthority = null } = {}) {
  cfg = cfg || loadSolanaConfig();
  const authority = loadAuthorityKeypair(cfg);
  const plan = {
    action: "createMint",
    cluster: cfg.cluster,
    rpcUrl: cfg.rpcUrl,
    name: wBLOCK.name,
    symbol: wBLOCK.symbol,
    uri: wBLOCK.uri, // off-chain Metaplex JSON: full BLOCK ecosystem info + the BLOCK logo
    image: wBLOCK.image,
    decimals: wBLOCK.decimals,
    mintAuthority: authority.publicKey.toBase58(),
    freezeAuthority: freezeAuthority ? assertPubkey(freezeAuthority, "freezeAuthority").toBase58() : null,
    // NOTE: createMint() mints the token but does NOT publish the name/symbol/logo —
    // wallets/explorers read those from a Metaplex Token Metadata account. After
    // creating the mint you MUST attach metadata (createMetadataAccountV3 /
    // mpl-token-metadata createV1) with name="Wrapped Blockle", symbol="wBLOCK",
    // uri=wBLOCK.uri, so the token shows the BLOCK logo + ecosystem description.
    metadataStep: "attach Metaplex metadata with { name, symbol, uri } after mint creation (see docs/bridge/SOLANA.md)",
  };
  if (!sendsPermitted(cfg, execute)) {
    return {
      dryRun: true,
      ...plan,
      note:
        "DRY-RUN: no mint created. To create for real, pass { execute:true } AND enable " +
        "sends in config (and mainnetEnabled for mainnet-beta). Requires human authorization.",
    };
  }
  const connection = getConnection(cfg);
  const mint = await splToken.createMint(
    connection,
    authority, // payer
    authority.publicKey, // mint authority
    freezeAuthority ? new PublicKey(freezeAuthority) : null,
    wBLOCK.decimals,
  );
  return { dryRun: false, ...plan, mint: mint.toBase58(), note: "wBLOCK mint created" };
}

// ---- mint-to (bridge issuance after a VERIFIED BLOCK deposit) --------------
// The bridge calls this ONLY after chain.ts-style verification confirmed the BLOCK
// deposit (correct address + >= confirmationDepth confirmations). amountBase is the
// exact verified BLOCK base units; recipient is the user's Solana address.
export async function mintSolblock({ cfg, recipient, amountBase, execute = false, depositRef } = {}) {
  cfg = cfg || loadSolanaConfig();
  if (!cfg.mintAddress) throw new Error("no wBLOCK mint configured (mintAddress / BRIDGE_wBLOCK_MINT)");
  const mint = assertPubkey(cfg.mintAddress, "mintAddress");
  const to = assertPubkey(recipient, "recipient");
  const amount = toBaseUnits(amountBase);
  const authority = loadAuthorityKeypair(cfg);

  const ata = splToken.getAssociatedTokenAddressSync(mint, to, true);
  const plan = {
    action: "mintTo",
    cluster: cfg.cluster,
    mint: mint.toBase58(),
    recipient: to.toBase58(),
    recipientTokenAccount: ata.toBase58(),
    amountBase: amount.toString(),
    amountDisplay: formatUnits(amount),
    depositRef: depositRef || null,
  };
  if (!sendsPermitted(cfg, execute)) {
    return {
      dryRun: true,
      ...plan,
      note:
        "DRY-RUN: no tokens minted. mintSolblock MUST only be invoked after a verified " +
        "BLOCK deposit. Real mint needs { execute:true } + sends enabled + human authorization.",
    };
  }
  const connection = getConnection(cfg);
  // Ensure the recipient ATA exists (creates it, payer = authority, if absent).
  const account = await splToken.getOrCreateAssociatedTokenAccount(
    connection,
    authority, // payer
    mint,
    to,
    true,
  );
  const signature = await splToken.mintTo(
    connection,
    authority, // payer
    mint,
    account.address,
    authority, // mint authority
    amount,
  );
  return { dryRun: false, ...plan, signature, note: "minted" };
}

// ---- burn (redemption: wBLOCK destroyed, then BLOCK released via signer) --
// Burns from an owner's token account. In production the bridge takes custody of
// the user's wBLOCK (transfer-in) then burns from its own account; the actual
// burn authority is whichever account signs. Here we expose the primitive: burn
// `amountBase` from `ownerTokenAccount`, signed by the bridge authority, OR by a
// distinct owner keypair whose PATH is supplied (never the key itself).
export async function burnSolblock({ cfg, ownerTokenAccount, owner, amountBase, execute = false, redemptionRef } = {}) {
  cfg = cfg || loadSolanaConfig();
  if (!cfg.mintAddress) throw new Error("no wBLOCK mint configured");
  const mint = assertPubkey(cfg.mintAddress, "mintAddress");
  const tokenAccount = assertPubkey(ownerTokenAccount, "ownerTokenAccount");
  const amount = toBaseUnits(amountBase);
  const signer = owner
    ? loadAuthorityKeypair({ ...cfg, authorityKeypairPath: owner })
    : loadAuthorityKeypair(cfg);

  const plan = {
    action: "burn",
    cluster: cfg.cluster,
    mint: mint.toBase58(),
    ownerTokenAccount: tokenAccount.toBase58(),
    amountBase: amount.toString(),
    amountDisplay: formatUnits(amount),
    redemptionRef: redemptionRef || null,
  };
  if (!sendsPermitted(cfg, execute)) {
    return {
      dryRun: true,
      ...plan,
      note:
        "DRY-RUN: nothing burned. Real burn needs { execute:true } + sends enabled. " +
        "On redemption the BLOCK is released by POSTing services/reserve-signer AFTER this burn confirms.",
    };
  }
  const connection = getConnection(cfg);
  const signature = await splToken.burn(
    connection,
    signer, // payer
    tokenAccount,
    mint,
    signer, // owner/authority of the token account
    amount,
  );
  return { dryRun: false, ...plan, signature, note: "burned" };
}

// ---- supply reconciliation -------------------------------------------------
// Reads the live wBLOCK mint supply (on-chain, READ-ONLY — no tx) and compares
// it to the bridge's backing figure (BLOCK base units held in the reserve, as the
// bridge accounts it). Because both sides are 8-decimal base units, the compare is
// exact integer math. A healthy custodial bridge has supply <= backing (never mint
// more wBLOCK than BLOCK held). Returns a structured report.
export async function reconcileSupply({ cfg, backingBaseUnits } = {}) {
  cfg = cfg || loadSolanaConfig();
  if (!cfg.mintAddress) throw new Error("no wBLOCK mint configured");
  const mint = assertPubkey(cfg.mintAddress, "mintAddress");
  const backing = BigInt(backingBaseUnits);
  const connection = getConnection(cfg);
  const info = await splToken.getMint(connection, mint); // read-only
  const supply = BigInt(info.supply);
  const delta = backing - supply; // >=0 means fully/over-backed (good)
  return {
    cluster: cfg.cluster,
    mint: mint.toBase58(),
    decimals: info.decimals,
    supplyBase: supply.toString(),
    supplyDisplay: formatUnits(supply),
    backingBase: backing.toString(),
    backingDisplay: formatUnits(backing),
    deltaBase: delta.toString(),
    healthy: supply <= backing,
    mintAuthorityOnChain: info.mintAuthority ? info.mintAuthority.toBase58() : null,
    note:
      supply <= backing
        ? "OK: wBLOCK supply is fully backed by BLOCK in custody"
        : "ALERT: wBLOCK supply EXCEEDS BLOCK backing — under-collateralized; halt mints",
  };
}

// ---- optional: Metaplex Token Metadata (name/symbol) — DOCUMENTED STUB -----
// The SPL Token Program stores no name/symbol; wallets read them from a Metaplex
// Token Metadata PDA. Attaching metadata needs @metaplex-foundation/mpl-token-metadata
// (NOT a current repo dependency). We intentionally do NOT add it. If/when metadata
// is wanted, create the metadata account with name=wBLOCK.name, symbol=wBLOCK.symbol.
export function metadataPlan(cfg) {
  cfg = cfg || loadSolanaConfig();
  return {
    stub: true,
    name: wBLOCK.name,
    symbol: wBLOCK.symbol,
    mint: cfg.mintAddress || "(create mint first)",
    requires: "@metaplex-foundation/mpl-token-metadata (not installed; add deliberately)",
    note: "Metadata is OPTIONAL and off the money path. Token functions correctly without it.",
  };
}
