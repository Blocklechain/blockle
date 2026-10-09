// Hex / txid conventions.
//
// The wasm signer and the node's submitrawtransaction RPC both return a
// transaction id as RAW hex (hex::encode(tx.txid())). The explorer, however,
// addresses blocks and txids by their DISPLAY hash — the same bytes reversed,
// Bitcoin-style — so /explorer/tx/{id} and waitForTx expect the reversed form.
// Keep raw everywhere internally; reverse only when talking to the explorer.

/** Reverse a 32-byte (64 hex char) value — raw <-> display txid. */
export function reverseHex(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  let out = "";
  for (let i = clean.length - 2; i >= 0; i -= 2) out += clean.slice(i, i + 2);
  return out;
}

/** raw-hex txid (as returned by build/submit) -> explorer display txid */
export const toDisplayTxid = reverseHex;
/** explorer display txid -> raw-hex txid */
export const toRawTxid = reverseHex;

const HEX64 = /^[0-9a-fA-F]{64}$/;
export function isHash32(s: string): boolean {
  return HEX64.test(s);
}
