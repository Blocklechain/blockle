import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/wallet_export.dart' as wx;
import 'package:blockle_app/multichain/chains/utxo.dart';
import 'package:blockle_app/multichain/chains/chain_adapter.dart';
const _m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
void main() { test('p', () async {
  final a = await UtxoAdapter('meowcoin').deriveAccount(RootSecret(seed: wx.fromMnemonic(_m).seed));
  print('MEWCADDR ${a.address}');
}); }
