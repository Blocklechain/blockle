// wallet_import_test.dart — FUND-CRITICAL round-trip gate for single-key import.
// For the canonical BIP39 mnemonic, each chain's EXPORTED key (already golden-
// vector-proven in wallet_export) is parsed back by wallet_import and fed to the
// SAME live adapter as an imported RootSecret. The imported account MUST derive
// byte-identically to the mnemonic-derived account — proving the imported key
// controls the exact address the wallet signs for (so no funds can be lost to a
// mis-parsed / mis-injected key). One secp256k1 key is also shown to control
// multiple EVM chains.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/evm.dart';
import 'package:blockle_app/multichain/chains/utxo.dart';
import 'package:blockle_app/multichain/chains/solana.dart';
import 'package:blockle_app/multichain/chains/tron.dart';
import 'package:blockle_app/multichain/chains/xrp.dart';
import 'package:blockle_app/multichain/chains/stellar.dart';
import 'package:blockle_app/multichain/chains/tezos.dart';
import 'package:blockle_app/multichain/chains/ton.dart';
import 'package:blockle_app/multichain/chains/cardano.dart';
import 'package:blockle_app/multichain/wallet_export.dart' as wx;
import 'package:blockle_app/multichain/wallet_import.dart' as wi;
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;

const _mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon '
    'abandon abandon abandon about';

void main() {
  final seed = wx.fromMnemonic(_mnemonic).seed;
  final entropy = hd.mnemonicToEntropy(_mnemonic);
  final keys = wx.privateKeys(seed);
  final mnemonicRoot = RootSecret(seed: seed, entropy: entropy);

  // Expected (mnemonic-derived) address vs imported-key-derived address.
  Future<void> check(dynamic adapter, String exportedKey, wi.ImportKind kind) async {
    final expected = (await adapter.deriveAccount(mnemonicRoot)).address;
    final res = wi.parseImportedKey(exportedKey, kind: kind);
    final imported = (await adapter.deriveAccount(res.toRootSecret())).address;
    expect(imported, expected);
  }

  test('EVM 0x-hex key → same address (and controls every EVM chain)', () async {
    final pk = keys['evm']!.privateKey!;
    await check(EvmAdapter(id: 'ethereum', chainId: 1), pk, wi.ImportKind.evm);
    // SAME secp256k1 key on other EVM chains — one import, many chains.
    await check(EvmAdapter(id: 'base', chainId: 8453), pk, wi.ImportKind.evm);
    await check(EvmAdapter(id: 'arbitrum', chainId: 42161), pk, wi.ImportKind.auto);
  });

  test('UTXO WIF → same address (BTC/LTC/DOGE/BCH)', () async {
    await check(UtxoAdapter('bitcoin'), keys['bitcoin']!.wif!, wi.ImportKind.wif);
    await check(UtxoAdapter('litecoin'), keys['litecoin']!.wif!, wi.ImportKind.wif);
    await check(UtxoAdapter('dogecoin'), keys['dogecoin']!.wif!, wi.ImportKind.wif);
    await check(UtxoAdapter('bitcoincash'), keys['bitcoincash']!.wif!, wi.ImportKind.wif);
  });

  test('Tron raw-hex key → same address', () async {
    await check(TronAdapter(), keys['tron']!.privateKey!, wi.ImportKind.auto);
  });

  test('XRP 00-prefixed key → same address', () async {
    await check(XrpAdapter(), keys['xrp']!.privateKey!, wi.ImportKind.xrp);
  });

  test('Solana base58 secret → same address', () async {
    await check(SolanaAdapter(), keys['solana']!.secretKey!, wi.ImportKind.solana);
  });

  test('Stellar StrKey S… → same address', () async {
    await check(StellarAdapter(), keys['stellar']!.secretKey!, wi.ImportKind.auto);
  });

  test('Tezos edsk… → same address', () async {
    await check(TezosAdapter(), keys['tezos']!.secretKey!, wi.ImportKind.auto);
  });

  test('TON ed25519 key → same address', () async {
    await check(TonAdapter(), keys['ton']!.secretKey!, wi.ImportKind.solana);
  });

  test('Cardano account xprv → same address', () async {
    final ck = wx.cardanoKey(_mnemonic);
    await check(CardanoAdapter(), ck.secretKey!, wi.ImportKind.cardano);
  });

  test('scheme → enabled chains', () {
    final secp = wi.parseImportedKey(keys['evm']!.privateKey!, kind: wi.ImportKind.evm);
    expect(secp.scheme, wi.ImportScheme.secp256k1);
    expect(secp.chains, contains('ethereum'));
    expect(secp.chains, contains('bitcoin'));
    final ed = wi.parseImportedKey(keys['solana']!.secretKey!, kind: wi.ImportKind.solana);
    expect(ed.scheme, wi.ImportScheme.ed25519);
    expect(ed.chains, contains('solana'));
    expect(ed.chains, isNot(contains('ethereum')));
  });

  test('garbage input throws (never a silent/guessed key)', () {
    expect(() => wi.parseImportedKey('not a key', kind: wi.ImportKind.evm),
        throwsA(isA<wi.ImportException>()));
    expect(() => wi.parseImportedKey('0x00', kind: wi.ImportKind.evm),
        throwsA(isA<wi.ImportException>()));
  });
}
