// test/agent/hosted_evm_test.dart — FIX-401: the keyless hosted connect must use
// a scheme the gateway VERIFIES so it NEVER 401s. The wallet PREFERS signing the
// gateway challenge with the EVM key via EIP-191 personal_sign (chain "evm" + the
// 0x address + signature), and falls back to the anonymous session when no EVM
// signer is available. These tests prove:
//
//   * evm.personalSign produces a canonical EIP-191 signature that RECOVERS to
//     the signer's 0x address — the exact check the gateway performs
//     (verifyEvmPersonalSign), so a "evm" verify can never 401 for a good sig.
//   * hostedSession(chain:'evm', sign:…) sends the 0x address + "evm" + signature
//     on the verify hop (and NEVER an apiKey / privateKey / seed), and yields a
//     per-address session token.
//   * with no signer it falls back to the anon session (step "anon", no sig).

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/providers.dart';
import 'package:blockle_app/multichain/chains/evm.dart' as evm;
import 'package:blockle_app/multichain/crypto/address.dart' as addr;
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/secp256k1.dart' as s;

class _Call {
  final String url;
  final Map<String, dynamic> body;
  _Call(this.url, this.body);
}

(ProviderFetch, List<_Call>) mockFetch(
    (int, Map<String, dynamic>) Function(Map<String, dynamic> body) router) {
  final calls = <_Call>[];
  Future<ProviderResponse> f(String url,
      {required String method,
      required Map<String, String> headers,
      required String body}) async {
    final parsed = body.isNotEmpty
        ? (jsonDecode(body) as Map<String, dynamic>)
        : <String, dynamic>{};
    calls.add(_Call(url, parsed));
    final (status, json) = router(parsed);
    return ProviderResponse(
        status >= 200 && status < 300, status, jsonEncode(json));
  }

  return (f, calls);
}

/// Recover the signer address from an EIP-191 personal_sign signature exactly as
/// the gateway's verifyEvmPersonalSign does, and return the 0x address.
String _recoverEvm(String message, String signature) {
  final sig = c.hexToBytes(signature);
  expect(sig.length, 65, reason: 'EIP-191 sig is r(32)||s(32)||v(1)');
  final r = BigInt.parse(c.bytesToHex(sig.sublist(0, 32)), radix: 16);
  final ss = BigInt.parse(c.bytesToHex(sig.sublist(32, 64)), radix: 16);
  var v = sig[64];
  if (v >= 27) v -= 27;
  final msg = c.utf8Bytes(message);
  final prefix = [0x19, ...c.utf8Bytes('Ethereum Signed Message:\n${msg.length}')];
  final digest = c.keccak256(c.concatBytes([prefix, msg]));
  final pub = s.recover(digest, r, ss, v, false);
  return addr.evmAddress(pub);
}

void main() {
  // A deterministic secp256k1 private key + its EVM address.
  final priv = c.hexToBytes(
      '4646464646464646464646464646464646464646464646464646464646464646');
  final address = addr.evmAddress(s.publicKey(priv));

  group('EIP-191 personal_sign (what the gateway verifies)', () {
    test('a signed challenge RECOVERS to the signer 0x address', () {
      const challenge = 'blockle-agent login: deadbeefcafe';
      final sig = evm.personalSign(challenge, priv);
      expect(sig.startsWith('0x'), isTrue);
      final recovered = _recoverEvm(challenge, sig);
      expect(recovered.toLowerCase(), address.toLowerCase(),
          reason: 'the gateway derives the address from the sig — a good sig never 401s');
    });

    test('a signature over a DIFFERENT message does NOT recover to the address', () {
      final sig = evm.personalSign('challenge-A', priv);
      final recovered = _recoverEvm('challenge-B', sig);
      expect(recovered.toLowerCase(), isNot(address.toLowerCase()));
    });
  });

  group('hostedSession — EVM EIP-191 handshake', () {
    test('sends chain "evm" + the 0x address + signature, never a key/seed', () async {
      final (fetch, calls) = mockFetch((body) {
        if (body['step'] == 'challenge') {
          return (200, {'challenge': 'nonce-xyz', 'expiresAt': 1000});
        }
        if (body['step'] == 'verify') {
          // the verify hop must be a real "evm" proof that recovers to address
          expect(body['chain'], 'evm');
          expect(body['address'], address);
          expect(_recoverEvm('nonce-xyz', '${body['signature']}').toLowerCase(),
              address.toLowerCase());
          return (200, {'sessionToken': 'evm-tok', 'expiresAt': 900000});
        }
        return (400, {'error': 'unexpected'});
      });

      final sess = await hostedSession(
        fetch: fetch,
        gatewayUrl: 'https://gw.test',
        address: address,
        chain: 'evm',
        sign: (m) async => {'signature': evm.personalSign(m, priv)},
      );
      expect(sess['sessionToken'], 'evm-tok');
      expect(sess['chain'], 'evm');
      expect(sess['address'], address);
      // no secret ever left the device
      for (final call in calls) {
        expect(call.body.containsKey('apiKey'), isFalse);
        expect(call.body.containsKey('privateKey'), isFalse);
        expect(call.body.containsKey('seed'), isFalse);
      }
    });

    test('no signer -> anon fallback (step "anon", no signature)', () async {
      final (fetch, calls) = mockFetch((body) {
        expect(body['step'], 'anon');
        expect(body.containsKey('signature'), isFalse);
        return (200, {'sessionToken': 'anon-tok', 'expiresAt': 123});
      });
      final sess = await hostedSession(fetch: fetch, gatewayUrl: 'https://gw.test');
      expect(sess['sessionToken'], 'anon-tok');
      expect(sess['chain'], 'anon');
      expect(calls.length, 1);
    });
  });
}
