// evmsign.js — server-side EVM (EIP-1559) signing for the live bot runner
// (Stage 2a). Reuses the SAME audited, dependency-free crypto the wallet signs
// with — vendored verbatim from the extension (src/vendor/, loaded as CommonJS)
// — so a server-signed tx is byte-identical to what the device would produce.
//
// This module ONLY signs a fully-specified transaction object. It does NOT
// build strategy intents, manage keys, or broadcast — the runner (Stage 2b)
// owns gating (cap/allowlist), nonce/gas, and broadcast, and holds the key only
// inside the ephemeral delegation registry.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const _dir = dirname(fileURLToPath(import.meta.url));
const Evm = require(join(_dir, 'vendor', 'evm.js'));
const S = require(join(_dir, 'vendor', 'secp256k1.js'));
const Addr = require(join(_dir, 'vendor', 'address.js'));
const C = require(join(_dir, 'vendor', 'crypto-core.js'));

/// Sign an EIP-1559 tx. [tx] keys: chainId, nonce, maxPriorityFeePerGas,
/// maxFeePerGas, gasLimit, to, value, data (BigInt for the numerics). [privHex]
/// is the 0x/bare 32-byte secp256k1 key. Returns { raw, txid, sigHash }.
export function signEip1559(tx, privHex) {
  const priv = C.hexToBytes(String(privHex).replace(/^0x/, ''));
  if (priv.length !== 32) throw new Error('evm private key must be 32 bytes');
  return Evm.signEip1559(tx, priv);
}

/// The 0x address controlled by [privHex] — for sender checks + address scope.
export function evmAddressFromPrivate(privHex) {
  const priv = C.hexToBytes(String(privHex).replace(/^0x/, ''));
  return Addr.evmAddress(S.publicKey(priv, true));
}

/// ERC-20 transfer(to,amount) calldata, for token trades.
export function erc20TransferData(to, amountBase) {
  const sel = 'a9059cbb';
  const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
  const amtHex = BigInt(amountBase).toString(16);
  return '0x' + sel + pad(to) + pad(amtHex);
}
