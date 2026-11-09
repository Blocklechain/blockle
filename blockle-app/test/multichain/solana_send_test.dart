// solana_send_test.dart — native SOL send (System-program transfer) built and
// signed by the Solana adapter: the message layout, the fee payer, the lamport
// amount, and an ed25519 signature that verifies under the sender's key. This
// is the deposit leg the Liquidity SOL ↔ BLOCK swap broadcasts from the app.
import 'dart:convert';
import 'dart:typed_data';

import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/solana.dart' as sol;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:flutter_test/flutter_test.dart';

void main() {
  final seed = Uint8List.fromList(List<int>.generate(32, (i) => (i * 7 + 3) & 0xff));
  final pub = ed.publicKey(seed);
  final from = c.base58encode(pub);
  final to = c.base58encode(Uint8List.fromList(List<int>.filled(32, 0x42)));
  final blockhash = c.base58encode(Uint8List.fromList(List<int>.filled(32, 0x11)));

  sol.SolanaAdapter adapter() {
    final a = sol.SolanaAdapter(rpc: (method, params) async {
      if (method == 'getLatestBlockhash') return {'value': {'blockhash': blockhash, 'lastValidBlockHeight': 1}};
      if (method == 'sendTransaction') return 'SIG';
      return null;
    });
    a.unlock(RootSecret(importedEd25519: seed));
    return a;
  }

  final acct = DerivedAccount(chain: 'solana', index: 0, address: from, publicKey: from, scheme: 'ed25519');

  test('systemTransferIx encodes index 2 + u64 LE lamports', () {
    final ix = sol.systemTransferIx(pub, c.base58decode(to), '250000000');
    expect(c.base58encode(ix.programId), '11111111111111111111111111111111');
    expect(ix.data, [2, 0, 0, 0, 0x80, 0xB2, 0xE6, 0x0E, 0, 0, 0, 0]);
    expect(ix.keys.first.isSigner, isTrue);
    expect(ix.keys.last.isWritable, isTrue);
  });

  test('buildSend signs a native SOL transfer the sender key verifies', () async {
    final built = await adapter().buildSend(acct, SendRequest(to: to, amount: '250000000'));
    expect(built.chain, 'solana');
    expect(built.fee, '5000');
    final tx = base64.decode(built.raw);
    expect(tx[0], 1); // one signature slot
    final sig = tx.sublist(1, 65);
    final msg = tx.sublist(65);
    expect(ed.verify(msg, sig, pub), isTrue);
    expect(built.txid, c.base58encode(sig));
    // message: header 1/0/1, three keys (from, to, system), blockhash, 1 ix
    expect(msg.sublist(0, 3), [1, 0, 1]);
    expect(msg[3], 3);
    expect(c.base58encode(msg.sublist(4, 36)), from);
    expect(c.base58encode(msg.sublist(36, 68)), to);
    expect(c.base58encode(msg.sublist(68, 100)), '11111111111111111111111111111111');
    expect(c.base58encode(msg.sublist(100, 132)), blockhash);
    expect(msg[132], 1); // one instruction
    expect(msg[133], 2); // program index
    expect(msg.sublist(134, 137), [2, 0, 1]); // 2 accounts: from, to
    expect(msg[137], 12); // data length
    expect(msg.sublist(138, 142), [2, 0, 0, 0]);
  });

  test('buildSend signs an SPL TransferChecked (creating the recipient ATA)', () async {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    final srcAcct = c.base58encode(Uint8List.fromList(List<int>.filled(32, 0x55)));
    final calls = <String>[];
    final a = sol.SolanaAdapter(rpc: (method, params) async {
      calls.add(method);
      if (method == 'getTokenAccountsByOwner') {
        return {
          'value': [
            {'pubkey': srcAcct, 'account': {'data': {'parsed': {'info': {'tokenAmount': {'amount': '5000000'}}}}}}
          ]
        };
      }
      if (method == 'getAccountInfo') return {'value': null}; // recipient ATA missing
      if (method == 'getLatestBlockhash') return {'value': {'blockhash': blockhash}};
      return null;
    });
    a.unlock(RootSecret(importedEd25519: seed));
    final built = await a.buildSend(acct, SendRequest(to: to, amount: '2500000',
        asset: const AssetRef(chain: 'solana', kind: 'spl', symbol: 'USDC', decimals: 6, address: usdc)));
    final tx = base64.decode(built.raw);
    final sig = tx.sublist(1, 65), msg = tx.sublist(65);
    expect(ed.verify(msg, sig, pub), isTrue);
    expect(built.txid, c.base58encode(sig));
    expect(calls, containsAll(['getTokenAccountsByOwner', 'getAccountInfo', 'getLatestBlockhash']));
    // the message carries the source token account and the mint, and TWO
    // instructions (create ATA idempotent + TransferChecked)
    final keysLen = msg[3];
    final keys = [for (var i = 0; i < keysLen; i++) c.base58encode(msg.sublist(4 + i * 32, 36 + i * 32))];
    expect(keys, containsAll([from, srcAcct, usdc, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']));
    final afterKeys = 4 + keysLen * 32 + 32;
    expect(msg[afterKeys], 2); // two instructions
    expect(built.extra?['createsRecipientAccount'], isTrue);
    expect(built.extra?['source'], srcAcct);
  });

  test('buildSend refuses bad input', () async {
    final a = adapter();
    expect(() => a.buildSend(acct, SendRequest(to: to, amount: '0')), throwsArgumentError);
    expect(() => a.buildSend(acct, SendRequest(to: 'not-an-address!', amount: '1')), throwsArgumentError);
    expect(() => a.buildSend(acct, SendRequest(to: from, amount: '1')), throwsArgumentError);
    expect(
        () => a.buildSend(acct, SendRequest(to: to, amount: '1', asset: const AssetRef(chain: 'solana', kind: 'spl', symbol: 'X', decimals: 6))),
        throwsArgumentError); // token asset without a mint
    final locked = sol.SolanaAdapter(rpc: (m, p) async => null);
    expect(() => locked.buildSend(acct, SendRequest(to: to, amount: '1')), throwsStateError);
  });
}
