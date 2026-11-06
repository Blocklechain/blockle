// Verifies the EIP-712 digest against the CANONICAL example from the spec
// (https://eips.ethereum.org/EIPS/eip-712 — the "Mail" message). The expected
// signing hash 0xbe60…7bd2 is the published value; matching it proves the whole
// encodeType/hashStruct/domainSeparator pipeline is correct.
import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/chains/eip712.dart';
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;

void main() {
  final typedData = {
    'types': {
      'EIP712Domain': [
        {'name': 'name', 'type': 'string'},
        {'name': 'version', 'type': 'string'},
        {'name': 'chainId', 'type': 'uint256'},
        {'name': 'verifyingContract', 'type': 'address'},
      ],
      'Person': [
        {'name': 'name', 'type': 'string'},
        {'name': 'wallet', 'type': 'address'},
      ],
      'Mail': [
        {'name': 'from', 'type': 'Person'},
        {'name': 'to', 'type': 'Person'},
        {'name': 'contents', 'type': 'string'},
      ],
    },
    'primaryType': 'Mail',
    'domain': {
      'name': 'Ether Mail',
      'version': '1',
      'chainId': 1,
      'verifyingContract': '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
    },
    'message': {
      'from': {'name': 'Cow', 'wallet': '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'},
      'to': {'name': 'Bob', 'wallet': '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'},
      'contents': 'Hello, Bob!',
    },
  };

  test('EIP-712 digest matches the canonical spec vector', () {
    final digest = c.bytesToHex(eip712Digest(typedData));
    expect(digest,
        'be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  });
}
