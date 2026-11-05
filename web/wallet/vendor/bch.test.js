// bch.test.js — Bitcoin Cash golden-vector gate for the WEB WALLET vendor
// superset. Proves the vendor UTXO engine + CashAddr codec reproduce the SAME
// bytes as the canonical extension (docs/bch-vectors.json): CashAddr spec
// vectors, derived address, BIP143+FORKID (0x41) sighash, and the full signed
// raw tx hex. No network.
//
//   node web/wallet/vendor/bch.test.js

const C = require('./crypto-core.js');
const S = require('./secp256k1.js');
const HD = require('./hd.js');
const A = require('./address.js');
const U = require('./chains/utxo.js');
const REG = require('./chains/registry.js');

const h = C.bytesToHex;
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let pass = 0, fail = 0;
function eq(name, got, want) { if (got === want) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); } }
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// ---- CashAddr codec vs published spec vectors ------------------------------
const cashVectors = [
  ['1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
  ['1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR', 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'],
  ['16w1D5WRVKJuZUsSRzdLp9w3YGcgoxDXb', 'bitcoincash:qqq3728yw0y47sqn6l2na30mcw6zm78dzqre909m2r'],
];
for (const [legacy, cash] of cashVectors) {
  const h160 = C.base58checkDecode(legacy).slice(1);
  eq('cashaddr encode ' + legacy, A.cashAddrEncode('bitcoincash', 0, h160), cash);
  eq('cashaddr decode ' + legacy, h(A.cashAddrDecode(cash).hash), h(h160));
  eq('cashaddr bare decode ' + legacy, h(A.cashAddrDecode(cash.split(':')[1]).hash), h(h160));
  ok('looksLikeCashAddr ' + legacy, A.looksLikeCashAddr(cash) && !A.looksLikeCashAddr(legacy));
}

// ---- derived address + signed-tx golden vector -----------------------------
const seed = HD.mnemonicToSeed(ABANDON, '');
const net = U.NETWORKS.bitcoincash;
ok('vendor has bitcoincash network', !!net && net.forkId === true && net.segwit === false);
const node = HD.derivePath(seed, net.path + '/0');
const pub = node.publicKey;
eq('bch pubkey', h(pub), '02bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217');
eq('bch legacy address', A.p2pkh(pub, net.p2pkh), '1mW6fDEMjKrDHvLvoEsaeLxSCzZBf3Bfg');
const cash = A.cashAddrP2pkh(pub, net.cashaddr);
eq('bch cashaddr', cash, 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
eq('bch cashaddr decode == hash160(pub)', h(A.cashAddrDecode(cash).hash), h(C.hash160(pub)));

const to = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
eq('bch cashaddr recipient script == legacy recipient script',
  h(U.addressToScript(to, net)), h(U.addressToScript('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', net)));

const built = U.buildAndSign(net, node, cash, {
  to, amount: '120000', feeRate: 5,
  utxos: [{ txid: 'a'.repeat(64), vout: 0, value: '100000' }, { txid: 'b'.repeat(64), vout: 1, value: '50000' }],
});
eq('bch FORKID sighash input0', built.sighashes[0], '876731cd34024074ce64cd6d6c9324f7158c4ae7ce48d367d322560432f94fa2');
eq('bch signed raw tx hex (byte-identical to extension)', built.raw,
  '0100000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006a473044022045fe408740f38fb99760e24cb1655cba521cc06bc3017ad3b46dc844ae6bd56102205776349c08f4c615fdfb89960baf14c6c1c1fb6daaae46c7a8ab471cdc6a993c412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffffbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb010000006a473044022020ce30ef15c54e6723cfa453d4ef80a07453fdbd9340af575638f50f4c8ceb1d02203c1b7392f2706268714d26f79460914d79202e29f4b210314cb42274b3abf3db412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffff02c0d40100000000001976a91476a04053bda0a88bda5177b86a15c3b29f55987388ace26d0000000000001976a914086a977c7dad32a56996af2ce90a727238d4899888ac00000000');
eq('bch txid', built.txid, '660810784f5f726d09132f220004bf3c1416b188cedd0ed030a8fedcfff37ad5');
eq('bch fee', built.fee, '1870');
ok('bch no segwit marker', built.raw.slice(8, 12) !== '0001');
ok('bch sigs recover to owner', built.signedInputs.every((si) => h(S.recover(si._sh, si._sig.r, si._sig.s, si._sig.recovery, true)) === h(pub)));

// ---- registry wiring -------------------------------------------------------
{
  const reg = REG.createRegistry({});
  reg.unlock({ seed });
  reg.get('bitcoincash').deriveAccount({ seed }).then((bch) => {
    eq('registry bch addr (cashaddr)', bch.address, 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
    ok('registry enables bitcoincash', reg.enabled().includes('bitcoincash'));
    eq('registry bch default esplora', reg.endpoints('bitcoincash').esplora, 'https://bch.imaginary.cash/api');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }).catch((e) => { console.log('FAIL registry: ' + e.message); process.exit(1); });
}
