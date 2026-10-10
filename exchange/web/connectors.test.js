// connectors.test.js — unit tests for the BTC + Sui wallet connectors'
// message/address/signature/payload handling.
//
//   node connectors.test.js
//
// Covers (no browser, no network — a fake `window` is injected into detect):
//   BTC: provider detection order, address sanity-check, signMessage type,
//        signature normalization, PSBT extraction (base64/hex, flags).
//   SUI: provider detection order, address normalization/padding, UTF-8 message
//        encoding, signature normalization, Move-call / tx-block extraction.

const C = require('./connectors.js');
const { BTC, SUI } = C;

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// ---- BTC: detection order --------------------------------------------------
{
  ok('btc none', BTC.detect({}) === null);
  ok('btc present false on empty', BTC.present({}) === false);

  const unisat = { requestAccounts() {} };
  eq('btc unisat api', BTC.detect({ unisat }).api, 'unisat');
  ok('btc unisat provider', BTC.detect({ unisat }).provider === unisat);

  // UniSat wins over Xverse when both injected.
  const xverse = { BitcoinProvider: { request() {} } };
  eq('btc unisat beats xverse', BTC.detect({ unisat, XverseProviders: xverse }).api, 'unisat');
  eq('btc xverse api', BTC.detect({ XverseProviders: xverse }).api, 'sats-connect');
  eq('btc bareXverse api', BTC.detect({ BitcoinProvider: { request() {} } }).api, 'sats-connect');
  eq('btc generic api', BTC.detect({ btc: { request() {} } }).api, 'webbtc');
  ok('btc present true', BTC.present({ unisat }) === true);
}

// ---- BTC: address sanity-check + sign type ---------------------------------
{
  ok('btc tb1 bech32 ok', BTC.isValidAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'));
  ok('btc bc1 bech32 ok', BTC.isValidAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'));
  ok('btc legacy ok', BTC.isValidAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'));
  ok('btc testnet legacy ok', BTC.isValidAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'));
  ok('btc empty bad', BTC.isValidAddress('') === false);
  ok('btc junk bad', BTC.isValidAddress('0xdeadbeef') === false);

  eq('btc bech32 -> bip322', BTC.signMessageType('tb1qxyz'), 'bip322-simple');
  eq('btc bc1 -> bip322', BTC.signMessageType('bc1qxyz'), 'bip322-simple');
  eq('btc legacy -> ecdsa', BTC.signMessageType('1BvBMxyz'), 'ecdsa');

  eq('btc sig string passthrough', BTC.normalizeSignature('AbCdBase64=='), 'AbCdBase64==');
  eq('btc sig from {signature}', BTC.normalizeSignature({ signature: 'SIG64' }), 'SIG64');
  eq('btc sig from nested result', BTC.normalizeSignature({ result: { signature: 'R' } }), 'R');
  eq('btc sig null -> empty', BTC.normalizeSignature(null), '');
}

// ---- BTC: sign-in message + PSBT extraction --------------------------------
{
  eq('btc signin msg verbatim', BTC.buildSignInMessage('nonce-abc-123'), 'nonce-abc-123');

  ok('btc no psbt -> null', BTC.extractPsbt({}) === null);
  ok('btc no psbt (undef) -> null', BTC.extractPsbt() === null);

  const b64 = BTC.extractPsbt({ psbt: 'cHNidP8BAHcC==' });
  eq('btc psbt base64 value', b64.psbt, 'cHNidP8BAHcC==');
  eq('btc psbt base64 encoding', b64.encoding, 'base64');
  eq('btc psbt autoFinalized default', b64.autoFinalized, true);
  eq('btc psbt broadcast default', b64.broadcast, true);

  const hex = BTC.extractPsbt({ psbtHex: '70736274ff0001' });
  eq('btc psbt hex encoding', hex.encoding, 'hex');

  const flags = BTC.extractPsbt({ psbt: 'AA==', autoFinalized: false, broadcast: false, signInputs: [{ index: 0 }] });
  eq('btc psbt autoFinalized off', flags.autoFinalized, false);
  eq('btc psbt broadcast off', flags.broadcast, false);
  ok('btc psbt signInputs', Array.isArray(flags.signInputs) && flags.signInputs[0].index === 0);

  const alt = BTC.extractPsbt({ toSignInputs: [{ index: 2 }] , psbtBase64: 'QQ==' });
  ok('btc psbt toSignInputs mapped', alt.signInputs[0].index === 2);
}

// ---- BTC: network config (testnet-first) -----------------------------------
{
  eq('btc default net testnet', BTC.networkFromCfg({}).name, 'testnet');
  eq('btc default net no cfg', BTC.networkFromCfg(null).name, 'testnet');
  eq('btc signet net', BTC.networkFromCfg({ btc: { network: 'signet' } }).name, 'signet');
  eq('btc mainnet net', BTC.networkFromCfg({ btc: { network: 'mainnet' } }).name, 'mainnet');
  eq('btc mainnet hrp', BTC.networkFromCfg({ btc: { network: 'mainnet' } }).hrp, 'bc');
  eq('btc unknown net -> testnet', BTC.networkFromCfg({ btc: { network: 'nope' } }).name, 'testnet');
}

// ---- SUI: detection order --------------------------------------------------
{
  ok('sui none', SUI.detect({}) === null);
  const suiWallet = { getAccounts() {} };
  const suiet = { getAccounts() {} };
  eq('sui wallet api', SUI.detect({ suiWallet }).api, 'sui-wallet');
  eq('sui wallet beats suiet', SUI.detect({ suiWallet, suiet }).api, 'sui-wallet');
  eq('sui suiet api', SUI.detect({ suiet }).api, 'suiet');
  eq('sui wallet-standard api', SUI.detect({ __suiWallets: [{ features: {} }] }).api, 'wallet-standard');
  ok('sui present', SUI.present({ suiet }) === true);
  ok('sui present false', SUI.present({}) === false);
}

// ---- SUI: address normalization --------------------------------------------
{
  const full = '0x' + 'a'.repeat(64);
  eq('sui full passthrough', SUI.normalizeAddress(full), full);
  eq('sui uppercase lowered', SUI.normalizeAddress('0x' + 'AB'.repeat(32)), '0x' + 'ab'.repeat(32));
  eq('sui short padded', SUI.normalizeAddress('0x2'), '0x' + '0'.repeat(63) + '2');
  eq('sui no-0x padded', SUI.normalizeAddress('ff'), '0x' + '0'.repeat(62) + 'ff');
  eq('sui empty -> empty', SUI.normalizeAddress(''), '');
  eq('sui junk -> empty', SUI.normalizeAddress('0xZZ'), '');
  eq('sui too long -> empty', SUI.normalizeAddress('0x' + 'a'.repeat(65)), '');
  ok('sui valid', SUI.isValidAddress('0x2') === true);
  ok('sui invalid', SUI.isValidAddress('nope') === false);
}

// ---- SUI: message encoding + signature normalization -----------------------
{
  const bytes = SUI.encodeMessage('nonce-xyz');
  ok('sui encode is Uint8Array', bytes instanceof Uint8Array);
  eq('sui encode length ascii', bytes.length, 'nonce-xyz'.length);
  eq('sui encode first byte', bytes[0], 'n'.charCodeAt(0));
  // round-trip via node Buffer for a quick sanity check
  eq('sui encode utf8 roundtrip', Buffer.from(bytes).toString('utf8'), 'nonce-xyz');
  // multi-byte char expands
  ok('sui encode multibyte', SUI.encodeMessage('é').length === 2);

  eq('sui sig string passthrough', SUI.normalizeSignature('AA=='), 'AA==');
  eq('sui sig from {signature}', SUI.normalizeSignature({ signature: 'S', bytes: 'B' }), 'S');
  eq('sui sig nested result', SUI.normalizeSignature({ result: { signature: 'R' } }), 'R');
  eq('sui sig null -> empty', SUI.normalizeSignature(null), '');
}

// ---- SUI: Move-call / tx-block extraction ----------------------------------
{
  ok('sui no payload -> null', SUI.extractMoveCall({}) === null);
  ok('sui undef -> null', SUI.extractMoveCall() === null);

  const tb = SUI.extractMoveCall({ transactionBlock: 'AAEC' });
  eq('sui tx block value', tb.transactionBlock, 'AAEC');
  const tb2 = SUI.extractMoveCall({ txBytes: 'BBB=' });
  eq('sui txBytes mapped', tb2.transactionBlock, 'BBB=');

  const mc = SUI.extractMoveCall({
    moveCall: { target: '0xpkg::htlc::redeem', arguments: ['obj', 'preimage'], typeArguments: ['0x2::sui::SUI'] }
  });
  eq('sui movecall target', mc.moveCall.target, '0xpkg::htlc::redeem');
  eq('sui movecall args', mc.moveCall.arguments.length, 2);
  eq('sui movecall typeargs', mc.moveCall.typeArguments[0], '0x2::sui::SUI');

  // inline target form (payload itself is the move call)
  const inline = SUI.extractMoveCall({ target: '0xp::htlc::refund' });
  eq('sui inline target', inline.moveCall.target, '0xp::htlc::refund');
  ok('sui inline default arrays', Array.isArray(inline.moveCall.arguments) && inline.moveCall.arguments.length === 0);

  // tx block preferred over move call when both present
  const both = SUI.extractMoveCall({ transactionBlock: 'TB', moveCall: { target: 't' } });
  eq('sui txblock beats movecall', both.transactionBlock, 'TB');
  ok('sui txblock has no moveCall', both.moveCall === undefined);
}

// ---- SUI: network config (testnet-first) -----------------------------------
{
  eq('sui default net testnet', SUI.networkFromCfg({}).name, 'testnet');
  eq('sui devnet', SUI.networkFromCfg({ sui: { network: 'devnet' } }).name, 'devnet');
  eq('sui mainnet', SUI.networkFromCfg({ sui: { network: 'mainnet' } }).name, 'mainnet');
  eq('sui mainnet chainId', SUI.networkFromCfg({ sui: { network: 'mainnet' } }).chainId, 'sui:mainnet');
  eq('sui unknown -> testnet', SUI.networkFromCfg({ sui: { network: 'nope' } }).name, 'testnet');
}

console.log(`connectors.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
