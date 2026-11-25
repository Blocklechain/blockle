// Golden-vector gate for the Blockle-listed small PoW coins.
//
// WHY THESE NUMBERS ARE FROZEN. A wrong address version byte produces an
// address that looks plausible, satisfies no checksum anyone else recognises,
// and loses whatever is sent to it. A wrong derivation path produces valid
// addresses that simply are not the holder's — their funds stay on-chain
// somewhere this wallet will never look, which to them is indistinguishable
// from us losing them. Neither failure announces itself.
//
// HOW THE EXPECTATIONS WERE OBTAINED, which is the part that gives them
// authority. Each address below was derived by this adapter from the canonical
// BIP39 "abandon…about" mnemonic, and then handed to that coin's OWN running
// daemon via `validateaddress`. Every one came back isvalid=true. The negative
// direction was checked too: the Pepecoin address is rejected by Dingocoin and
// the Raptoreum address is rejected by Pepecoin, so the test is not passing
// because everything accepts everything.
//
// Provenance for every byte and path, including the conflict on RTM, is in
// deploy/exchange/nodes/address-params.json.
//
// Meowcoin is absent on purpose: its daemon was mid initial-block-download and
// could not be used to verify anything. It is exchange-held only until it can.
import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/wallet_export.dart' as wx;
import 'package:blockle_app/multichain/chains/utxo.dart';
import 'package:blockle_app/multichain/chains/chain_adapter.dart';

const _mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon '
    'abandon abandon abandon about';

/// (chain id, symbol, expected path, expected address) — daemon-verified.
const _vectors = <List<String>>[
  ['raptoreum', 'RTM', "m/44'/200'/0'/0", 'RASnNhEeAfsrepCLefsugW57A5A1ZLSMW9'],
  ['pepecoin', 'PEP', "m/44'/3434'/0'/0", 'PsGyoVVSD9VTYoDZGp5FmRB2BSoE69f9ZV'],
  ['neoxa', 'NEOX', "m/44'/1668'/0'/0", 'GddwJKkPxARviA6BmWbuyamqC5kT6SDNzm'],
  ['dingocoin', 'DINGO', "m/44'/3'/0'/0", 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'],
  ['perbug', 'PERBUG', "m/84'/0'/0'/0", 'pb1qcr8te4kr609gcawutmrza0j4xv80jy8zpdnqlw'],
];

void main() {
  final seed = wx.fromMnemonic(_mnemonic).seed;

  for (final v in _vectors) {
    final id = v[0], symbol = v[1], path = v[2], address = v[3];
    test('$symbol derives the daemon-verified address ($path)', () async {
      final net = networks[id]!;
      expect(net.symbol, symbol);
      expect(net.path, path, reason: 'the preferred derivation path changed');
      final acct = await UtxoAdapter(id).deriveAccount(RootSecret(seed: seed));
      expect(acct.address, address,
          reason: 'this exact address was accepted by $id\'s own daemon; a '
              'change here means the wallet now derives something else');
    });
  }

  test('PERBUG shares its key with Bitcoin BIP84, differing only in the hrp', () {
    // AN INDEPENDENT CHECK ON THE PATH, not a restatement of it. Perbug is an
    // unpatched Bitcoin Core fork, so its own wallet derives under coin type 0
    // — which means at m/84'/0'/0'/0 it must produce the SAME hash160 as
    // Bitcoin's widely-published first address for this mnemonic
    // (bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu), with only the bech32 prefix
    // different. If the path were wrong, this would not hold.
    const btcBody = 'cr8te4kr609gcawutmrza0j4xv80jy8z';
    final perbug = _vectors.last[3];
    expect(perbug.startsWith('pb1q'), isTrue);
    expect(perbug.contains(btcBody), isTrue,
        reason: 'perbug must encode the same key as Bitcoin at m/84\'/0\'/0\'/0');
    expect(networks['perbug']!.hrp, 'pb');
    expect(networks['perbug']!.segwit, isTrue);
  });

  test('every new coin has its endpoint and its alternate paths declared', () {
    for (final v in _vectors) {
      final net = networks[v[0]]!;
      expect(net.esplora, startsWith('https://coin.blockle.org/'),
          reason: '${v[1]} must be served from our own node');
      // The preferred path must never also appear as an alternate, or
      // discovery scans it twice and a duplicate account can surface.
      expect(net.pathAlternates.contains(net.path), isFalse,
          reason: '${v[1]}: preferred path duplicated in pathAlternates');
    }
    // The coins with no authoritative path MUST carry alternates, because a
    // single guess there is what strands a holder's existing seed.
    expect(networks['raptoreum']!.pathAlternates, isNotEmpty,
        reason: 'RTM conflicts with SLIP-44; both must be scanned');
    expect(networks['pepecoin']!.pathAlternates, isNotEmpty);
    expect(networks['dingocoin']!.pathAlternates, isNotEmpty);
  });

  test('DINGO and DOGE share address bytes and must not be conflated', () {
    // The hazard: Dingocoin kept Dogecoin's version bytes, so a DOGE address
    // passes Dingocoin's checksum and vice versa. Nothing in the encoding can
    // tell them apart — only the chain the user picked can — so this is
    // recorded as a known, deliberate collision rather than a bug to look for
    // later when someone has already lost coins to it.
    expect(networks['dingocoin']!.p2pkh, networks['dogecoin']!.p2pkh);
    expect(networks['dingocoin']!.wif, networks['dogecoin']!.wif);
    // They must at least be distinct chains with distinct endpoints.
    expect(networks['dingocoin']!.id, isNot(networks['dogecoin']!.id));
    expect(networks['dingocoin']!.esplora, isNot(networks['dogecoin']!.esplora));
  });
}
