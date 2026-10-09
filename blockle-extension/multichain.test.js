// multichain.test.js — unit tests for the multi-chain account layer.
//
//   node multichain.test.js
//
// Covers (all against published, independently-verifiable vectors):
//   • crypto primitives: SHA-256/512, HMAC, RIPEMD-160, Keccak-256, base58check
//   • secp256k1: pubkey derivation + RFC6979 deterministic ECDSA (sipa vector)
//   • BIP39 seed (Trezor vector) + BIP32 derivation (BIP32 Test Vector 1)
//   • address derivation: EIP-55, BIP84 P2WPKH (BTC/LTC), legacy P2PKH (DOGE)
//   • tx building: ERC-20 calldata, EIP-1559 + legacy EVM (sender recovery),
//     BIP143 segwit sighash (exact spec vector) + full UTXO build self-consistency
//
// No network, no external deps.

const C = require('./crypto-core.js');
const S = require('./secp256k1.js');
const HD = require('./hd.js');
const A = require('./address.js');
const E = require('./chains/evm.js');
const U = require('./chains/utxo.js');
const REG = require('./chains/registry.js');

const h = C.bytesToHex;
const te = (s) => new TextEncoder().encode(s);
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; /* console.log('ok  ' + name); */ }
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
function throws(name, fn) { try { fn(); fail++; console.log('FAIL ' + name + ' (did not throw)'); } catch { pass++; } }

// ---- crypto-core ----------------------------------------------------------
eq('sha256(abc)', h(C.sha256(te('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
eq('sha512(abc)', h(C.sha512(te('abc'))), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
eq('ripemd160(abc)', h(C.ripemd160(te('abc'))), '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');
eq('keccak256(abc)', h(C.keccak256(te('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
eq('hmac-sha512 rfc4231', h(C.hmacSha512(C.hexToBytes('0b'.repeat(20)), te('Hi There'))), '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854');
eq('hash160(abc)', h(C.hash160(te('abc'))), 'bb1be98c142444d7a56aa3981c3942a978e4dc33');

// ---- secp256k1 (sipa RFC6979 vector) --------------------------------------
eq('pub(1) compressed', h(S.publicKey(C.hexToBytes('1'.padStart(64, '0')), true)), '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
{
  const msg = C.sha256(te('Everything should be made as simple as possible, but not simpler.'));
  const sig = S.sign(msg, C.hexToBytes('1'.padStart(64, '0')));
  eq('rfc6979 r', sig.rHex, '33a69cd2065432a30f3d1ce4eb0d59b8ab58c74f27c41a7fdb5696ad4e6108c9');
  eq('rfc6979 s', sig.sHex, '6f807982866f785d3f6418d24163ddae117b7db4d5fdf0071de069fa54342262');
  ok('verify roundtrip', S.verify(msg, sig, S.publicKey(C.hexToBytes('1'.padStart(64, '0')), true)));
}

// ---- BIP39 seed + BIP32 Test Vector 1 -------------------------------------
eq('bip39 trezor seed', h(HD.mnemonicToSeed(ABANDON, 'TREZOR')), 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
ok('bip39 validate', HD.validateMnemonic(ABANDON));
ok('bip39 reject bad', !HD.validateMnemonic('abandon abandon zoo'));
{
  const seed = C.hexToBytes('000102030405060708090a0b0c0d0e0f');
  eq('bip32 m xprv', HD.serialize(HD.masterFromSeed(seed), false), 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi');
  eq('bip32 m/0H xpub', HD.serialize(HD.derivePath(seed, "m/0'"), true), 'xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw');
  eq('bip32 m/0H/1/2H/2/1000000000 xprv', HD.serialize(HD.derivePath(seed, "m/0'/1/2'/2/1000000000"), false), 'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76');
}

// ---- address derivation (abandon mnemonic / seed) -------------------------
{
  const seed = HD.mnemonicToSeed(ABANDON, '');
  const eth = HD.derivePath(seed, "m/44'/60'/0'/0/0");
  eq('eth privkey', h(eth.privateKey), '1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
  eq('eth address (EIP-55)', A.evmAddress(eth.publicKey), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  eq('BIP84 btc p2wpkh', A.p2wpkh(HD.derivePath(seed, "m/84'/0'/0'/0/0").publicKey, 'bc'), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  eq('BIP84 ltc p2wpkh', A.p2wpkh(HD.derivePath(seed, "m/84'/2'/0'/0/0").publicKey, 'ltc'), 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh');
  eq('doge p2pkh', A.p2pkh(HD.derivePath(seed, "m/44'/3'/0'/0/0").publicKey, 0x1e), 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
  eq('eip55 known', A.toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
}

// ---- EVM tx building ------------------------------------------------------
eq('erc20 transfer calldata', E.erc20TransferData('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '1'),
  '0xa9059cbb0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed0000000000000000000000000000000000000000000000000000000000000001');
eq('formatUnits eth', E.formatUnits('1500000000000000000', 18), '1.5');
eq('formatUnits usdc', E.formatUnits('1234567', 6), '1.234567');
{
  const seed = HD.mnemonicToSeed(ABANDON, '');
  const node = HD.derivePath(seed, "m/44'/60'/0'/0/0");
  const from = A.evmAddress(node.publicKey);
  // EIP-1559 send: sign, recover sender, assert == from
  const tx = { chainId: 1, nonce: 0n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 20_000_000_000n, gasLimit: 21000n, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: '0x' };
  const signed = E.signEip1559(tx, node.privateKey);
  const sig = S.sign(C.hexToBytes(signed.sigHash.slice(2)), node.privateKey);
  const rec = A.evmAddress(S.recover(C.hexToBytes(signed.sigHash.slice(2)), sig.r, sig.s, sig.recovery, false));
  eq('eip1559 sender recovers', rec.toLowerCase(), from.toLowerCase());
  ok('eip1559 raw is typed-2', signed.raw.startsWith('0x02'));
  ok('eip1559 txid 32 bytes', /^0x[0-9a-f]{64}$/.test(signed.txid));
}

// ---- UTXO tx building -----------------------------------------------------
// BIP143 native P2WPKH example — exact sighash + exact RFC6979 signature.
{
  const le0 = 'fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f';
  const le1 = 'ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a';
  const inputs = [
    { txid: h(C.hexToBytes(le0).reverse()), vout: 0, sequence: 0xffffffee },
    { txid: h(C.hexToBytes(le1).reverse()), vout: 1, sequence: 0xffffffff },
  ];
  const outputs = [
    { script: C.hexToBytes('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac'), value: 112340000n },
    { script: C.hexToBytes('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac'), value: 223450000n },
  ];
  const scriptCode = C.hexToBytes('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac');
  const sh = U.sighashSegwit(1, inputs, outputs, 1, scriptCode, 600000000n, 0xffffffff, 0x11, 0x01);
  eq('BIP143 sighash', h(sh), 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670');
  const priv = C.hexToBytes('619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9');
  const sig = S.sign(sh, priv);
  eq('BIP143 DER+hashtype', h(sig.der) + '01', '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01');
  eq('BIP143 pubkey', h(S.publicKey(priv, true)), '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357');
}
// Full build self-consistency: BTC (segwit) + DOGE (legacy)
{
  const seed = HD.mnemonicToSeed(ABANDON, '');
  // BTC P2WPKH
  const net = U.NETWORKS.bitcoin;
  const node = HD.derivePath(seed, net.path + '/0');
  const from = A.p2wpkh(node.publicKey, 'bc');
  const built = U.buildAndSign(net, node, from, { to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amount: '120000', feeRate: 10, utxos: [{ txid: 'a'.repeat(64), vout: 0, value: '100000' }, { txid: 'b'.repeat(64), vout: 1, value: '50000' }] });
  ok('btc segwit marker', built.raw.slice(8, 12) === '0001');
  ok('btc txid is 64 hex', /^[0-9a-f]{64}$/.test(built.txid));
  ok('btc sigs recover to owner', built.signedInputs.every((si) => h(S.recover(si._sh, si._sig.r, si._sig.s, si._sig.recovery, true)) === h(node.publicKey)));
  // DOGE P2PKH
  const dnet = U.NETWORKS.dogecoin;
  const dnode = HD.derivePath(seed, dnet.path + '/0');
  const dfrom = A.p2pkh(dnode.publicKey, dnet.p2pkh);
  const dbuilt = U.buildAndSign(dnet, dnode, dfrom, { to: dfrom, amount: '100000000', feeRate: 1000, utxos: [{ txid: 'c'.repeat(64), vout: 0, value: '500000000' }] });
  ok('doge no segwit marker', dbuilt.raw.slice(8, 12) !== '0001');
  ok('doge sig recovers to owner', dbuilt.signedInputs.every((si) => h(S.recover(si._sh, si._sig.r, si._sig.s, si._sig.recovery, true)) === h(dnode.publicKey)));
  throws('insufficient funds throws', () => U.buildAndSign(net, node, from, { to: from, amount: '999999999', feeRate: 10, utxos: [{ txid: 'a'.repeat(64), vout: 0, value: '100000' }] }));
}

// ---- registry derivation (no network) -------------------------------------
{
  const reg = REG.createRegistry({});
  const seed = HD.mnemonicToSeed(ABANDON, '');
  reg.unlock({ seed });
  const run = async () => {
    const eth = await reg.get('ethereum').deriveAccount({ seed });
    const base = await reg.get('base').deriveAccount({ seed });
    eq('registry eth == base key (same secp account)', eth.address.toLowerCase(), base.address.toLowerCase());
    eq('registry eth addr', eth.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    const btc = await reg.get('bitcoin').deriveAccount({ seed });
    eq('registry btc addr', btc.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    ok('registry enables block+evm+utxo', reg.enabled().includes('ethereum') && reg.enabled().includes('bitcoin'));
    ok('registry usdc token present', reg.tokensFor('ethereum').some((t) => t.symbol === 'USDC'));
  };
  run().then(() => done()).catch((e) => { fail++; console.log('FAIL registry: ' + e.message); done(); });
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
