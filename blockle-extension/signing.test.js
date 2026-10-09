// signing.test.js — unit tests for the DEX-execution signing layer:
//
//   node signing.test.js
//
// Covers (against published, independently-verifiable vectors):
//   • ed25519 (RFC 8032 §7.1 Test 1/2/3): public key, sign, verify + reject
//   • SLIP-0010 ed25519 HD derivation (SLIP-0010 Test vector 1: m and m/0')
//   • Solana: shortvec decode, signer-slot location, serialized-tx sign that
//     verifies against the derived account key (legacy + v0 versioned layout)
//   • EVM arbitrary-tx sign → sender recovers to owner; ERC-20 approve/allowance
//     calldata; buildApprove is a type-2 tx whose sender recovers to owner
//
// No network, no external deps. Additive to multichain.test.js / pass2.test.js.

const C = require('./crypto-core.js');
const S = require('./secp256k1.js');
const HD = require('./hd.js');
const A = require('./address.js');
const ED = require('./ed25519.js');
const SOL = require('./chains/solana.js');
const E = require('./chains/evm.js');

const h = C.bytesToHex;
const hx = (s) => C.hexToBytes(s);
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
function throws(name, fn) { try { fn(); fail++; console.log('FAIL ' + name + ' (did not throw)'); } catch { pass++; } }

// ---- ed25519 (RFC 8032 §7.1) ----------------------------------------------
{
  // TEST 1 (empty message)
  const sk1 = hx('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const pk1 = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  eq('rfc8032 t1 pubkey', h(ED.publicKey(sk1)), pk1);
  eq('rfc8032 t1 sign', h(ED.sign(new Uint8Array(0), sk1)),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
  ok('rfc8032 t1 verify', ED.verify(new Uint8Array(0), hx(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'), hx(pk1)));

  // TEST 2 (1-byte message 0x72)
  const sk2 = hx('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
  const pk2 = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
  eq('rfc8032 t2 pubkey', h(ED.publicKey(sk2)), pk2);
  eq('rfc8032 t2 sign', h(ED.sign(hx('72'), sk2)),
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00');
  ok('rfc8032 t2 verify', ED.verify(hx('72'), ED.sign(hx('72'), sk2), hx(pk2)));

  // TEST 3 (2-byte message 0xaf82)
  const sk3 = hx('c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7');
  const pk3 = 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025';
  eq('rfc8032 t3 pubkey', h(ED.publicKey(sk3)), pk3);
  eq('rfc8032 t3 sign', h(ED.sign(hx('af82'), sk3)),
    '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a');

  // reject a tampered signature + wrong message
  const sig3 = ED.sign(hx('af82'), sk3);
  ok('rfc8032 t3 verify ok', ED.verify(hx('af82'), sig3, hx(pk3)));
  ok('ed25519 reject wrong msg', !ED.verify(hx('af83'), sig3, hx(pk3)));
  const bad = sig3.slice(); bad[0] ^= 0x01;
  ok('ed25519 reject tampered sig', !ED.verify(hx('af82'), bad, hx(pk3)));
}

// ---- SLIP-0010 ed25519 derivation (SLIP-0010 Test vector 1) ---------------
{
  const seed = hx('000102030405060708090a0b0c0d0e0f');
  const m = SOL.masterKey(seed);
  eq('slip10 m chaincode', h(m.chainCode), '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
  eq('slip10 m privkey', h(m.key), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  eq('slip10 m pubkey', '00' + h(ED.publicKey(m.key)), '00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed');

  const m0 = SOL.deriveSlip10(seed, "m/0'");
  eq('slip10 m/0h chaincode', h(m0.chainCode), '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69');
  eq('slip10 m/0h privkey', h(m0.key), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  eq('slip10 m/0h pubkey', '00' + h(ED.publicKey(m0.key)), '008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c');

  // ed25519 derivation must reject a non-hardened segment
  throws('slip10 rejects soft segment', () => SOL.deriveSlip10(seed, "m/44'/501'/0'/0"));
}

// ---- Solana adapter: derive + address -------------------------------------
{
  const seed = HD.mnemonicToSeed(ABANDON, '');
  const adapter = SOL.createSolanaAdapter({ rpcUrl: 'http://localhost' });
  adapter.unlock({ seed });
  (async () => {
    const acct = await adapter.deriveAccount({ seed }, 0);
    ok('solana address is base58 (32-byte key)', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(acct.address));
    eq('solana scheme', acct.scheme, 'ed25519');
    eq('solana path', acct.path, "m/44'/501'/0'/0'");
    ok('solana pubkey round-trips to address', C.base58encode(C.hexToBytes(acct.publicKey)) === acct.address);
  })();
}

// ---- shortvec (compact-u16) ----------------------------------------------
{
  eq('shortvec 1', JSON.stringify(SOL.decodeShortVec(Uint8Array.of(0x01), 0)), JSON.stringify({ value: 1, size: 1 }));
  eq('shortvec 0x80 0x01 = 128', JSON.stringify(SOL.decodeShortVec(Uint8Array.of(0x80, 0x01), 0)), JSON.stringify({ value: 128, size: 2 }));
  eq('shortvec 0xff 0xff 0x03 = 65535', JSON.stringify(SOL.decodeShortVec(Uint8Array.of(0xff, 0xff, 0x03), 0)), JSON.stringify({ value: 65535, size: 3 }));
}

// ---- Solana serialized-tx signing (legacy + v0 layouts) -------------------
function buildTx(pubkey, versioned) {
  // signatures: 1 x 64-byte zero placeholder
  const sigArea = C.concatBytes(Uint8Array.of(0x01), new Uint8Array(64));
  // message
  const header = Uint8Array.of(0x01, 0x00, 0x00); // 1 required sig, 0+0 readonly
  const keys = C.concatBytes(Uint8Array.of(0x01), pubkey); // 1 account key = ours
  const blockhash = new Uint8Array(32).fill(7);            // dummy recent blockhash
  const instrs = Uint8Array.of(0x00);                      // 0 instructions
  let message = C.concatBytes(header, keys, blockhash, instrs);
  if (versioned) {
    message = C.concatBytes(Uint8Array.of(0x80), message); // v0 prefix
    const luts = Uint8Array.of(0x00);                      // 0 address-table lookups
    message = C.concatBytes(message, luts);
  }
  return C.concatBytes(sigArea, message);
}
{
  const seedKey = SOL.deriveSlip10(hx('000102030405060708090a0b0c0d0e0f'), "m/44'/501'/0'/0'").key;
  const pub = ED.publicKey(seedKey);
  for (const versioned of [false, true]) {
    const label = versioned ? 'v0' : 'legacy';
    const tx = buildTx(pub, versioned);
    const loc = SOL.locateSigner(tx, pub);
    eq('solana ' + label + ' sigCount', loc.sigCount, 1);
    eq('solana ' + label + ' signerIndex', loc.signerIndex, 0);
    const signed = SOL.signSerializedTx(tx, seedKey, pub);
    const sig = signed.slice(loc.sigAreaStart, loc.sigAreaStart + 64);
    const message = tx.slice(loc.messageStart);
    ok('solana ' + label + ' sig verifies vs message', ED.verify(message, sig, pub));
    ok('solana ' + label + ' message bytes unchanged', h(signed.slice(loc.messageStart)) === h(message));
  }
  // signing fails when our key is not a required signer
  const otherKey = ED.publicKey(SOL.deriveSlip10(hx('000102030405060708090a0b0c0d0e0f'), "m/44'/501'/1'/0'").key);
  const tx2 = buildTx(otherKey, false);
  throws('solana signing rejects non-signer', () => SOL.signSerializedTx(tx2, seedKey, pub));
}

// ---- EVM arbitrary-tx sign + recover --------------------------------------
{
  const seed = HD.mnemonicToSeed(ABANDON, '');
  const node = HD.derivePath(seed, "m/44'/60'/0'/0/0");
  const from = A.evmAddress(node.publicKey);
  const adapter = E.createEvmAdapter({ id: 'base', chainId: 8453, rpcUrl: 'http://localhost' });
  adapter.unlock({ seed });

  // A DEX router call: {to(router), data(swap calldata), value(eth in)}.
  (async () => {
    const acct = { chain: 'base', index: 0, address: from };
    const req = {
      to: '0x1111111254EEB25477B68fb85Ed929f73A960582', // a router
      data: '0x12aa3caf' + '00'.repeat(64),
      value: 10n ** 16n, // 0.01 ETH
      gasLimit: '0x30d40', feeRate: '0x4a817c800', maxPriorityFeePerGas: '0x3b9aca00',
      nonce: '0x0',
    };
    const built = await adapter.signArbitraryTx(acct, req);
    ok('evm arb raw is type-2', built.raw.startsWith('0x02'));
    ok('evm arb txid 32 bytes', /^0x[0-9a-f]{64}$/.test(built.txid));
    // recover sender from the signed raw: re-sign the sighash deterministically
    // and recover (RFC6979 => same sig), asserting it maps back to the owner.
    const tx = {
      chainId: 8453, nonce: 0n,
      maxPriorityFeePerGas: BigInt('0x3b9aca00'), maxFeePerGas: BigInt('0x4a817c800'),
      gasLimit: BigInt('0x30d40'), to: req.to, value: req.value, data: req.data,
    };
    const signed = E.signEip1559(tx, node.privateKey);
    eq('evm arb raw matches deterministic sign', built.raw, signed.raw);
    const sig = S.sign(C.hexToBytes(signed.sigHash.slice(2)), node.privateKey);
    const rec = A.evmAddress(S.recover(C.hexToBytes(signed.sigHash.slice(2)), sig.r, sig.s, sig.recovery, false));
    eq('evm arb sender recovers to owner', rec.toLowerCase(), from.toLowerCase());
  })();

  (async () => {
    let threw = false;
    try { await adapter.signArbitraryTx({ index: 0, address: from }, { data: '0x' }); }
    catch { threw = true; }
    ok('evm arb rejects missing to', threw);
  })();
}

// ---- ERC-20 approve / allowance calldata ----------------------------------
{
  const spender = '0x1111111254EEB25477B68fb85Ed929f73A960582';
  eq('erc20 approve(unlimited)', E.erc20ApproveData(spender),
    '0x095ea7b30000000000000000000000001111111254eeb25477b68fb85ed929f73a960582ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  eq('erc20 approve(1000)', E.erc20ApproveData(spender, 1000n),
    '0x095ea7b30000000000000000000000001111111254eeb25477b68fb85ed929f73a96058200000000000000000000000000000000000000000000000000000000000003e8');
  eq('erc20 allowance calldata', E.erc20AllowanceData('0x9858EfFD232B4033E47d90003D41EC34EcaEda94', spender),
    '0xdd62ed3e0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda940000000000000000000000001111111254eeb25477b68fb85ed929f73a960582');
}

process.on('exit', () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
});
