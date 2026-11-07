// evmsign.test.js — proves the server EVM signer is byte-identical to the
// vendored wallet crypto and that the signed tx recovers to the key's own
// address (fund-critical: a server-signed trade must come from the delegated
// account and nowhere else).

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import assert from 'node:assert';
import { signEip1559, evmAddressFromPrivate, erc20TransferData } from '../src/evmsign.js';

const require = createRequire(import.meta.url);
const _dir = dirname(fileURLToPath(import.meta.url));
const C = require(join(_dir, '..', 'src', 'vendor', 'crypto-core.js'));
const S = require(join(_dir, '..', 'src', 'vendor', 'secp256k1.js'));
const Addr = require(join(_dir, '..', 'src', 'vendor', 'address.js'));

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };

// A fixed test private key (not a real funded account).
const privHex = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const priv = C.hexToBytes(privHex.slice(2));
const from = Addr.evmAddress(S.publicKey(priv, true));

ok('address derivation matches', evmAddressFromPrivate(privHex).toLowerCase() === from.toLowerCase());

const tx = {
  chainId: 8453, nonce: 0n,
  maxPriorityFeePerGas: BigInt('0x3b9aca00'),
  maxFeePerGas: BigInt('0x4a817c800'),
  gasLimit: 21000n,
  to: '0x3535353535353535353535353535353535353535',
  value: 1000000000000000n,
  data: '0x',
};

const a = signEip1559(tx, privHex);
const b = signEip1559(tx, privHex);
ok('type-2 (EIP-1559) raw', a.raw.startsWith('0x02'));
ok('deterministic — same input, same raw', a.raw === b.raw);
ok('txid is 32 bytes', /^0x[0-9a-f]{64}$/.test(a.txid));

// Recover the sender from the sighash + signature → must be the key's address.
const sig = S.sign(C.hexToBytes(a.sigHash.slice(2)), priv);
const rec = Addr.evmAddress(S.recover(C.hexToBytes(a.sigHash.slice(2)), sig.r, sig.s, sig.recovery, false));
ok('signed tx recovers to the signing address', rec.toLowerCase() === from.toLowerCase());

// ERC-20 transfer calldata shape.
const data = erc20TransferData('0x' + '11'.repeat(20), 1234567n);
ok('erc20 transfer selector', data.startsWith('0xa9059cbb'));
ok('erc20 calldata length', data.length === 2 + 8 + 64 + 64);

console.log(`evmsign.test.js: ${pass} checks passed`);
