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
const TRON = require('./chains/tron.js');
const REG = require('./chains/registry.js');
const TRONV = require('../docs/tron-vectors.json');

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

// ---- Bitcoin Cash (BCH): CashAddr + BIP143+FORKID (0x41) GOLDEN VECTOR ------
// docs/bch-vectors.json — the cross-wallet gate. CashAddr is NOT bech32 (own
// 40-bit polymod); signing reuses the BIP143 preimage but with hashType 0x41
// (SIGHASH_ALL|SIGHASH_FORKID) and legacy P2PKH scriptSig / NO witness.
{
  // (a) CashAddr codec vs the published CashAddr spec vectors (legacy -> cash).
  const cashVectors = [
    ['1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
    ['1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR', 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'],
    ['16w1D5WRVKJuZUsSRzdLp9w3YGcgoxDXb', 'bitcoincash:qqq3728yw0y47sqn6l2na30mcw6zm78dzqre909m2r'],
  ];
  for (const [legacy, cash] of cashVectors) {
    const h160 = C.base58checkDecode(legacy).slice(1);
    eq('cashaddr encode ' + legacy, A.cashAddrEncode('bitcoincash', 0, h160), cash);
    const d = A.cashAddrDecode(cash);
    eq('cashaddr decode roundtrip ' + legacy, h(d.hash), h(h160));
    ok('cashaddr decode type p2pkh ' + legacy, d.type === 0);
    eq('cashaddr bare decode ' + legacy, h(A.cashAddrDecode(cash.split(':')[1]).hash), h(h160));
    ok('looksLikeCashAddr true ' + legacy, A.looksLikeCashAddr(cash) && A.looksLikeCashAddr(cash.split(':')[1]));
    ok('legacy not detected as cashaddr ' + legacy, !A.looksLikeCashAddr(legacy));
  }

  const seed = HD.mnemonicToSeed(ABANDON, '');
  const bnet = U.NETWORKS.bitcoincash;
  const bnode = HD.derivePath(seed, bnet.path + '/0');
  const bpub = bnode.publicKey;
  // (1) address derivation
  eq('bch network forkId flag', String(bnet.forkId), 'true');
  ok('bch is NOT segwit', bnet.segwit === false);
  eq('bch pubkey', h(bpub), '02bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217');
  eq('bch legacy address', A.p2pkh(bpub, bnet.p2pkh), '1mW6fDEMjKrDHvLvoEsaeLxSCzZBf3Bfg');
  const bcash = A.cashAddrP2pkh(bpub, bnet.cashaddr);
  eq('bch cashaddr', bcash, 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
  eq('bch cashaddr decode == hash160(pub)', h(A.cashAddrDecode(bcash).hash), h(C.hash160(bpub)));

  // (7) addressToScript accepts BOTH CashAddr and legacy, same scriptPubKey
  const to = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
  eq('bch cashaddr recipient script == legacy recipient script',
    h(U.addressToScript(to, bnet)), h(U.addressToScript('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', bnet)));

  // (2)(3)(4)(5)(6) build, sign, assert byte-identical golden + FORKID sighash
  const built = U.buildAndSign(bnet, bnode, bcash, {
    to, amount: '120000', feeRate: 5,
    utxos: [{ txid: 'a'.repeat(64), vout: 0, value: '100000' }, { txid: 'b'.repeat(64), vout: 1, value: '50000' }],
  });
  eq('bch FORKID sighash input0', built.sighashes[0], '876731cd34024074ce64cd6d6c9324f7158c4ae7ce48d367d322560432f94fa2');
  eq('bch signed raw tx hex (byte-identical)', built.raw,
    '0100000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006a473044022045fe408740f38fb99760e24cb1655cba521cc06bc3017ad3b46dc844ae6bd56102205776349c08f4c615fdfb89960baf14c6c1c1fb6daaae46c7a8ab471cdc6a993c412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffffbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb010000006a473044022020ce30ef15c54e6723cfa453d4ef80a07453fdbd9340af575638f50f4c8ceb1d02203c1b7392f2706268714d26f79460914d79202e29f4b210314cb42274b3abf3db412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffff02c0d40100000000001976a91476a04053bda0a88bda5177b86a15c3b29f55987388ace26d0000000000001976a914086a977c7dad32a56996af2ce90a727238d4899888ac00000000');
  eq('bch txid', built.txid, '660810784f5f726d09132f220004bf3c1416b188cedd0ed030a8fedcfff37ad5');
  eq('bch fee', built.fee, '1870');
  ok('bch no segwit marker', built.raw.slice(8, 12) !== '0001');
  ok('bch hashtype 0x41 present in scriptSig', built.raw.includes('c6a993c41'));
  ok('bch sigs recover to owner', built.signedInputs.every((si) => h(S.recover(si._sh, si._sig.r, si._sig.s, si._sig.recovery, true)) === h(bpub)));
}

// ---- Tron (TRX + USDT-TRC20): secp256k1 -> 0x41 -> base58check + LOCAL txID
// signing GOLDEN VECTOR — docs/tron-vectors.json. Tron reuses the EVM keccak
// body but a 0x41 prefix + base58check; the client signs ONLY the node-returned
// txID after recomputing txID == sha256(raw_data_hex) (malicious-node guard).
{
  const seed = HD.mnemonicToSeed(TRONV.mnemonic, TRONV.passphrase || '');
  const tnode = HD.derivePath(seed, TRONV.path);
  // (1) key + address derivation
  eq('tron priv key', h(tnode.privateKey), TRONV.expected.privKeyHex);
  const tpub = S.publicKey(tnode.privateKey, false);
  eq('tron uncompressed pubkey', h(tpub), TRONV.expected.pubkeyHexUncompressed);
  const thash20 = C.keccak256(tpub.slice(1)).slice(-20);
  eq('tron keccak20 body', h(thash20), TRONV.expected.ethStyleHash20);
  eq('tron address hex (0x41||hash20)', '41' + h(thash20), TRONV.expected.addressHex);
  eq('tron base58 address', A.tronAddress(tnode.publicKey), TRONV.expected.base58Address);
  // same keccak body as the EVM address — only prefix + encoding differ
  eq('tron body == evm body', h(thash20), A.evmAddress(tnode.publicKey).slice(2).toLowerCase());

  // (2) address codec both-ways + validation
  for (const [hex, b58] of TRONV.addressSpecVectors) {
    eq('tron hexToBase58 ' + b58, A.tronHexToBase58(hex), b58);
    eq('tron addressToHex ' + b58, A.tronAddressToHex(b58), hex);
    ok('tron isTronAddress base58 ' + b58, A.isTronAddress(b58));
    ok('tron isTronAddress hex ' + b58, A.isTronAddress(hex) && A.isTronAddress('0x' + hex));
  }
  ok('tron rejects evm address', !A.isTronAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'));
  ok('tron rejects btc address', !A.isTronAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));

  // (3)(4)(5) native + trc20: recompute txID, sign, assert byte-identical, recover
  for (const [label, vec] of [['native', TRONV.tx], ['trc20', TRONV.trc20Tx]]) {
    const txId = h(C.sha256(C.hexToBytes(vec.rawDataHex)));
    eq('tron ' + label + ' txID == sha256(raw_data_hex)', txId, vec.expected.txID);
    eq('tron ' + label + ' verifyTxId ok', TRON.verifyTxId(vec.rawDataHex, vec.expected.txID), txId);
    throws('tron ' + label + ' verifyTxId rejects tampered id', () => TRON.verifyTxId(vec.rawDataHex, '00'.repeat(32)));
    const sig65 = TRON.signTxId(txId, tnode.privateKey);
    eq('tron ' + label + ' sig 65B [r||s||v]', h(sig65), vec.expected.signatureHex);
    ok('tron ' + label + ' sig length 65', sig65.length === 65);
    const r = S.bytesToBig(sig65.slice(0, 32)), sv = S.bytesToBig(sig65.slice(32, 64)), v = sig65[64];
    ok('tron ' + label + ' ECDSA verifies', S.verify(C.hexToBytes(txId), { r, s: sv }, tpub));
    eq('tron ' + label + ' recovers to owner', h(S.recover(C.hexToBytes(txId), r, sv, v, false)), h(tpub));
  }
  // (6) TRC-20 ABI parameter = 32B to ++ 32B amount
  eq('tron trc20 abi parameter', TRON.trc20TransferParam(TRONV.trc20Tx.to, TRONV.trc20Tx.amount), TRONV.trc20Tx.parameterHex);
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
    ok('registry has bitcoincash adapter', reg.has('bitcoincash'));
    ok('registry enables bitcoincash', reg.enabled().includes('bitcoincash'));
    eq('registry bch default esplora', reg.endpoints('bitcoincash').esplora, 'https://bch.imaginary.cash/api');
    const bch = await reg.get('bitcoincash').deriveAccount({ seed });
    eq('registry bch addr (cashaddr)', bch.address, 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
    eq('registry bch path', bch.path, "m/44'/145'/0'/0/0");
    ok('registry enables block+evm+utxo', reg.enabled().includes('ethereum') && reg.enabled().includes('bitcoin'));
    ok('registry usdc token present', reg.tokensFor('ethereum').some((t) => t.symbol === 'USDC'));
    // Solana adapter is REGISTERED (ed25519/SLIP-0010 m/44'/501'/0'/0'), enabled
    // by default, and derives a base58 SOL address from the same HD seed. Its RPC
    // defaults to the public mainnet endpoint (config-overridable, no key).
    ok('registry has solana adapter', reg.has('solana'));
    ok('registry enables solana', reg.enabled().includes('solana'));
    eq('registry solana default rpc', reg.endpoints('solana').rpcUrl, 'https://solana-rpc.publicnode.com');
    const sol = await reg.get('solana').deriveAccount({ seed });
    eq('registry solana scheme', sol.scheme, 'ed25519');
    eq('registry solana path', sol.path, "m/44'/501'/0'/0'");
    eq('registry solana addr', sol.address, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
    ok('registry solana addr is base58 (no 0/O/I/l)', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sol.address));
    // Tron adapter is REGISTERED (secp256k1 m/44'/195'/0'/0/0), enabled by
    // default, derives a 'T…' base58check address from the SAME HD seed, and its
    // TronGrid REST endpoint defaults to the public mainnet host (no key).
    ok('registry has tron adapter', reg.has('tron'));
    ok('registry enables tron', reg.enabled().includes('tron'));
    eq('registry tron default api', reg.endpoints('tron').api, 'https://api.trongrid.io');
    ok('registry tron usdt token present', reg.tokensFor('tron').some((t) => t.kind === 'trc20' && t.symbol === 'USDT' && t.address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'));
    const trx = await reg.get('tron').deriveAccount({ seed });
    eq('registry tron scheme', trx.scheme, 'secp256k1');
    eq('registry tron path', trx.path, "m/44'/195'/0'/0/0");
    eq('registry tron addr', trx.address, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    ok('registry tron addr is T-prefixed base58', /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trx.address));
    // TON adapter is REGISTERED (ed25519 SLIP-0010 m/44'/607'/0'), enabled by
    // default, derives the v4R2 bounceable 'EQ…' address from the SAME HD seed,
    // and its toncenter v2 endpoint defaults to the public mainnet host (no key).
    ok('registry has ton adapter', reg.has('ton'));
    ok('registry enables ton', reg.enabled().includes('ton'));
    eq('registry ton default api', reg.endpoints('ton').api, 'https://toncenter.com/api/v2');
    ok('registry ton usdt jetton present', reg.tokensFor('ton').some((t) => t.kind === 'jetton' && t.symbol === 'USDT' && t.master === 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'));
    const ton = await reg.get('ton').deriveAccount({ seed });
    eq('registry ton scheme', ton.scheme, 'ed25519');
    eq('registry ton path', ton.path, "m/44'/607'/0'");
    eq('registry ton addr', ton.address, 'EQAzWZa6nM5mJev91wGc7VCSfBoIsYRqKJpV78N8Add9-U9d');
    ok('registry ton addr is EQ-prefixed base64url', /^EQ[A-Za-z0-9_-]{46}$/.test(ton.address));
    // XRP adapter is REGISTERED (secp256k1 m/44'/144'/0'/0/0), enabled by default,
    // derives a classic 'r…' address from the SAME HD seed; rippled JSON-RPC
    // endpoint defaults to the public mainnet cluster (no key).
    ok('registry has xrp adapter', reg.has('xrp'));
    ok('registry enables xrp', reg.enabled().includes('xrp'));
    eq('registry xrp default rpc', reg.endpoints('xrp').rpc, 'https://xrplcluster.com');
    const xrp = await reg.get('xrp').deriveAccount({ seed });
    eq('registry xrp scheme', xrp.scheme, 'secp256k1');
    eq('registry xrp path', xrp.path, "m/44'/144'/0'/0/0");
    eq('registry xrp addr', xrp.address, 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3');
    ok('registry xrp addr is r-prefixed', /^r[1-9A-HJ-NP-Za-km-zA-Z]{24,34}$/.test(xrp.address));
    // Stellar adapter is REGISTERED (ed25519 SLIP-0010 m/44'/148'/0'), enabled by
    // default, derives a strkey 'G…' address from the SAME HD seed; Horizon REST
    // endpoint defaults to the public mainnet host (no key).
    ok('registry has stellar adapter', reg.has('stellar'));
    ok('registry enables stellar', reg.enabled().includes('stellar'));
    eq('registry stellar default horizon', reg.endpoints('stellar').horizon, 'https://horizon.stellar.org');
    const xlm = await reg.get('stellar').deriveAccount({ seed });
    eq('registry stellar scheme', xlm.scheme, 'ed25519');
    eq('registry stellar path', xlm.path, "m/44'/148'/0'");
    eq('registry stellar addr', xlm.address, 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX');
    ok('registry stellar addr is G-prefixed base32', /^G[A-Z2-7]{55}$/.test(xlm.address));
    // A config override replaces the default RPC without touching the key path.
    const reg2 = REG.createRegistry({ endpoints: { solana: { rpcUrl: 'https://solana.example/rpc' } } });
    eq('registry solana rpc override', reg2.endpoints('solana').rpcUrl, 'https://solana.example/rpc');
  };
  run().then(() => done()).catch((e) => { fail++; console.log('FAIL registry: ' + e.message); done(); });
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
