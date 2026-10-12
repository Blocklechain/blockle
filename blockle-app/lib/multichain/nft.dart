// nft.dart — WALLET NFT SUPPORT (docs/WALLET-NFT.md).
//
// Dart port of blockle-extension/nft.js (the JS reference), behaviourally
// IDENTICAL and asserted against the AUTHORITATIVE shared fixtures
// docs/nft-vectors.json (consumed, never edited).
//
// View + send NFTs across EVM (ERC-721 / ERC-1155) and Solana (Metaplex).
// READ-ONLY except the explicit, approved SEND — which builds calldata only and
// routes through the SAME flow as a normal send: security.inspectTransaction
// first, a danger forces the extra confirm, then the EXISTING signer signs +
// broadcasts. THIS MODULE NEVER SIGNS AND NEVER HOLDS KEYS.
//
// NEVER fabricates ownership or metadata: an unresolvable item is shown with
// what's known + metadataOk:false / 'metadata-unavailable', never invented. An
// unavailable indexer adds to `unavailable` (never a fabricated empty inventory).
//
// PURE given the injected ctx (indexer / config). All counts + ids are
// base-unit / BigInt-exact. Reuses chains/evm.dart calldata builders and the
// security suite (inspectTransaction + the approval manager) — no new signing or
// approval path.

import 'chains/evm.dart' as evm;
import 'security.dart' as sec;

const Set<String> kNftEvmChains = {
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'
};
const Set<String> kNftEvmStandards = {'erc721', 'erc1155'};
const String kDefaultIpfsGateway = 'https://ipfs.io/ipfs/';

// Conservative phishing signal: a claim/reward/airdrop lure paired with an
// off-platform link (classic "claim your rewards at …" drainer bait). FLAG
// only — never a safety claim, never an assertion of value.
final RegExp _claimWord = RegExp(
    r'\b(claim|rewards?|airdrop|free\s+mint|verify|activate|unlock)\b',
    caseSensitive: false);
final RegExp _urlLike = RegExp(
    r'(https?://|www\.|\.(?:xyz|top|io|co|app|site|click|link|gift|vip|finance)\b)',
    caseSensitive: false);

// ---- small pure helpers -----------------------------------------------------
BigInt toBig(dynamic v) {
  if (v is BigInt) return v;
  if (v == null || v == '') return BigInt.zero;
  final s = '$v'.trim();
  if (RegExp(r'^0x[0-9a-fA-F]+$').hasMatch(s)) {
    return BigInt.parse(s.substring(2), radix: 16);
  }
  if (!RegExp(r'^\d+$').hasMatch(s)) {
    throw ArgumentError('not a base-unit integer: $s');
  }
  return BigInt.parse(s);
}

bool addrEq(String chain, dynamic a, dynamic b) {
  if (a == null || b == null) return false;
  if (kNftEvmChains.contains(chain)) {
    return '$a'.toLowerCase() == '$b'.toLowerCase();
  }
  return '$a' == '$b'; // base58 / others are case-sensitive
}

/// ipfs:// (and ipfs://ipfs/CID) → configured gateway. Everything else passes
/// through UNCHANGED — the core FETCHES NOTHING; the UI loads media under its
/// own CSP. Returns the original value for null / non-string.
String? normalizeUri(dynamic uri, [Map<String, dynamic>? config]) {
  if (uri == null) return null;
  final s = '$uri';
  if (!RegExp(r'^ipfs://', caseSensitive: false).hasMatch(s)) return s;
  final gw = ((config?['ipfsGateway'] as String?) ?? kDefaultIpfsGateway)
      .replaceAll(RegExp(r'/+$'), '');
  final rest = s
      .replaceFirst(RegExp(r'^ipfs://', caseSensitive: false), '')
      .replaceFirst(RegExp(r'^ipfs/', caseSensitive: false), '')
      .replaceFirst(RegExp(r'^/+'), '');
  return '$gw/$rest';
}

// ---- spam / scam heuristics (§3): FLAG only, never assert safe/valuable -----
List<String> spamReasons(
    Map<String, dynamic> raw, Map<String, dynamic> item, Map<String, dynamic> config) {
  final reasons = <String>[];
  final denylist = {
    for (final a in (config['nftDenylist'] as List? ?? const [])) '$a'.toLowerCase()
  };
  final contract = item['contract'] != null ? '${item['contract']}'.toLowerCase() : null;

  if (contract != null && denylist.contains(contract)) reasons.add('denylist');

  // zero-floor airdrop: an item the wallet never bought, with no floor value.
  final airdrop = raw['airdrop'] == true || raw['acquiredVia'] == 'airdrop';
  var floorZero = true;
  try {
    floorZero = toBig(raw['floorBase'] ?? raw['floor'] ?? 0) == BigInt.zero;
  } catch (_) {
    floorZero = true;
  }
  if (airdrop && floorZero) reasons.add('zero-floor-airdrop');

  // phishing name / URL pattern (needs BOTH a lure word and a link to flag).
  final text = [
    item['name'],
    item['collection'],
    item['metadataUri'],
    item['image'],
    raw['description']
  ].where((x) => x != null).map((x) => '$x').join(' ');
  if (_claimWord.hasMatch(text) && _urlLike.hasMatch(text)) {
    reasons.add('phishing-pattern');
  }

  // link-only metadata: no name/collection/attributes, only an external link.
  final attrs = item['attributes'];
  final hasAttrs = attrs is List && attrs.isNotEmpty;
  final linkOnly = (item['name'] == null) &&
      (item['collection'] == null) &&
      !hasAttrs &&
      (_urlLike.hasMatch('${item['image'] ?? ''}') ||
          _urlLike.hasMatch('${item['metadataUri'] ?? ''}') ||
          _urlLike.hasMatch('${raw['externalUrl'] ?? ''}'));
  if (linkOnly) reasons.add('link-only-metadata');

  return reasons;
}

// ---- normalize one raw indexer item (no fabrication) ------------------------
Map<String, dynamic> normalizeItem(Map<String, dynamic> raw, Map<String, dynamic> config) {
  final chain = raw['chain'];
  final standard = raw['standard'] ??
      raw['tokenType'] ??
      (chain == 'solana' ? 'metaplex' : null);
  final item = <String, dynamic>{
    'chain': chain,
    'standard': standard,
    'contract': raw['contract'] != null ? '${raw['contract']}' : null,
  };
  if (raw['tokenId'] != null) item['tokenId'] = '${raw['tokenId']}';

  // balance: erc721 is always 1; 1155/metaplex may be >1. BigInt-exact string.
  BigInt bal;
  try {
    bal = standard == 'erc721' ? BigInt.one : toBig(raw['balance'] ?? 1);
  } catch (_) {
    bal = BigInt.one;
  }
  if (standard == 'erc721') bal = BigInt.one;
  item['balance'] = bal.toString();

  // metadata — present only when the indexer actually resolved it (never guessed)
  if (raw['name'] != null) item['name'] = raw['name'];
  if (raw['collection'] != null) item['collection'] = raw['collection'];
  if (raw['image'] != null) item['image'] = normalizeUri(raw['image'], config);
  if (raw['animation'] != null) {
    item['animation'] = normalizeUri(raw['animation'], config);
  }
  if (raw['attributes'] != null) item['attributes'] = raw['attributes'];
  if (raw['metadataUri'] != null) {
    item['metadataUri'] = normalizeUri(raw['metadataUri'], config);
  }

  // metadataOk: false when the indexer couldn't fetch metadata. We keep what's
  // known and flag it — NEVER invent a name/image for an unresolved item.
  item['metadataOk'] = raw['metadataOk'] != false;
  if (item['metadataOk'] == false) item['metadataNote'] = 'metadata-unavailable';

  final reasons = spamReasons(raw, item, config);
  if (reasons.isNotEmpty) {
    item['spam'] = true;
    item['spamReasons'] = reasons;
  }
  return item;
}

// ---- group by collection (chain + contract) ---------------------------------
List<Map<String, dynamic>> groupByCollection(List<Map<String, dynamic>> items) {
  final byKey = <String, Map<String, dynamic>>{};
  for (final it in items) {
    final key = '${it['chain']}:${'${it['contract'] ?? ''}'.toLowerCase()}';
    var g = byKey[key];
    if (g == null) {
      g = {
        'key': key,
        'chain': it['chain'],
        'contract': it['contract'],
        'standard': it['standard'],
        'name': it['collection'],
        'count': 0,
        'items': <Map<String, dynamic>>[],
      };
      byKey[key] = g;
    }
    if (g['name'] == null && it['collection'] != null) g['name'] = it['collection'];
    (g['items'] as List).add(it);
    g['count'] = (g['count'] as int) + 1;
  }
  return byKey.values.toList();
}

/// The read-only indexer the inventory sources raw items from (EVM
/// getNFTsForOwner / Solana Metaplex-DAS). Injected + mockable; the core never
/// reaches the network itself.
abstract class NftIndexer {
  Future<List<dynamic>?> getNFTsForOwner(String chain, String owner);
}

/// Injected, mockable NFT context. PURE given this ctx — the core fetches
/// nothing (the UI loads media). `addressFor`/`accounts` gate the send guard.
class NftCtx {
  final Map<String, dynamic> config;
  final NftIndexer? indexer;
  final List<Map<String, dynamic>>? accounts;
  final String? Function(String chain)? addressFor;
  const NftCtx({
    this.config = const {},
    this.indexer,
    this.accounts,
    this.addressFor,
  });
}

// =============================================================================
// 1. INVENTORY (read-only) — nfts(accounts, ctx)
// =============================================================================
// accounts: [{chain, address}]. ctx.indexer.getNFTsForOwner(chain, owner) ->
// raw items (EVM getNFTsForOwner / Solana Metaplex-DAS). A missing indexer or a
// failing call for an account adds to `unavailable` (never a fake empty list).
Future<Map<String, dynamic>> nfts(
    List<Map<String, dynamic>> accounts, NftCtx ctx) async {
  final config = ctx.config;
  final indexer = ctx.indexer;
  final items = <Map<String, dynamic>>[];
  final unavailable = <Map<String, dynamic>>[];
  for (final acc in accounts) {
    final chain = acc['chain'] as String;
    final owner = acc['address'] as String;
    if (indexer == null) {
      unavailable.add({
        'chain': chain,
        'address': owner,
        'reason':
            'no NFT indexer configured — NOT a claim the wallet holds no NFTs.'
      });
      continue;
    }
    List<dynamic>? raw;
    try {
      raw = await indexer.getNFTsForOwner(chain, owner);
    } catch (e) {
      unavailable.add({
        'chain': chain,
        'address': owner,
        'reason':
            'indexer error ($e) — NOT a claim the wallet holds no NFTs.'
      });
      continue;
    }
    if (raw == null) {
      unavailable.add({
        'chain': chain,
        'address': owner,
        'reason':
            'indexer returned no result — NOT a claim the wallet holds no NFTs.'
      });
      continue;
    }
    for (final r in raw) {
      final m = (r as Map).cast<String, dynamic>();
      final withChain = m['chain'] != null ? m : {'chain': chain, ...m};
      items.add(normalizeItem(withChain, config));
    }
  }
  return {
    'items': items,
    'collections': groupByCollection(items),
    'unavailable': unavailable,
  };
}

// =============================================================================
// 2. SEND — buildNftTransfer: calldata only, fail-closed guards
// =============================================================================
// req: {chain, standard, contract, tokenId, from, to, amount?, ownedBalance?}
// GUARDS (fail-closed, never partial/overdraw):
//   • `from` MUST equal the wallet's address for that chain (ctx.accounts).
//   • ERC-1155 amount REQUIRED, 1..ownedBalance (ownedBalance required).
// Returns a tx shaped for the normal send flow (inspect → gate → signer). The
// module NEVER signs — the caller runs security.inspectTransaction then hands
// the tx to the existing signer.
Map<String, dynamic> buildNftTransfer(Map<String, dynamic> req,
    [NftCtx? ctx]) {
  ctx ??= const NftCtx();
  final chain = req['chain'] as String?;
  final standard = req['standard'] as String?;
  final contract = req['contract'];
  final tokenId = req['tokenId'];
  final from = req['from'];
  final to = req['to'];
  if (chain == null) throw ArgumentError('buildNftTransfer: missing chain');
  if (standard == null) throw ArgumentError('buildNftTransfer: missing standard');
  if (contract == null) throw ArgumentError('buildNftTransfer: missing contract');
  if (to == null) throw ArgumentError('buildNftTransfer: missing recipient (to)');
  if (from == null) throw ArgumentError('buildNftTransfer: missing from');

  // GUARD: from must be THIS wallet's address for the chain (fail-closed).
  final walletAddr = _addressForChain(chain, ctx);
  if (walletAddr == null) {
    throw StateError(
        'buildNftTransfer: no wallet account for chain $chain — refusing (fail-closed)');
  }
  if (!addrEq(chain, from, walletAddr)) {
    throw StateError(
        "buildNftTransfer: `from` is not this wallet's address for $chain — refusing (fail-closed)");
  }

  if (kNftEvmChains.contains(chain)) {
    if (!kNftEvmStandards.contains(standard)) {
      throw ArgumentError('buildNftTransfer: EVM standard must be erc721|erc1155');
    }
    if (tokenId == null) throw ArgumentError('buildNftTransfer: missing tokenId');
    final idBig = toBig(tokenId);

    if (standard == 'erc721') {
      final data =
          evm.erc721SafeTransferFromData('$from', '$to', idBig.toString());
      return _evmTx(chain, 'erc721', '$contract', '$from', '$to', idBig, BigInt.one, data);
    }
    // erc1155: amount required, 1..ownedBalance (never overdraw / fabricate).
    if (req['amount'] == null) {
      throw ArgumentError('buildNftTransfer: erc1155 requires amount');
    }
    final amt = toBig(req['amount']);
    if (amt <= BigInt.zero) {
      throw ArgumentError('buildNftTransfer: erc1155 amount must be > 0');
    }
    if (req['ownedBalance'] == null) {
      throw StateError(
          'buildNftTransfer: erc1155 requires ownedBalance to guard overdraw (fail-closed)');
    }
    final owned = toBig(req['ownedBalance']);
    if (amt > owned) {
      throw StateError(
          'buildNftTransfer: erc1155 amount $amt exceeds owned balance $owned — refusing (fail-closed)');
    }
    final data = evm.erc1155SafeTransferFromData(
        '$from', '$to', idBig.toString(), amt.toString(), '0x');
    return _evmTx(chain, 'erc1155', '$contract', '$from', '$to', idBig, amt, data);
  }

  if (chain == 'solana') {
    // Metaplex transfer: amount defaults to 1 (pNFT/NFT); editions may be >1.
    final amt = req['amount'] == null ? BigInt.one : toBig(req['amount']);
    if (amt <= BigInt.zero) {
      throw ArgumentError('buildNftTransfer: solana amount must be > 0');
    }
    if (req['ownedBalance'] != null && amt > toBig(req['ownedBalance'])) {
      throw StateError(
          'buildNftTransfer: solana amount exceeds owned balance — refusing (fail-closed)');
    }
    // No calldata is fabricated here: the existing Solana adapter builds +
    // signs the Metaplex transfer instruction. We return a descriptor that
    // routes through that adapter (and inspectTransaction) — the module never signs.
    return {
      'chain': 'solana',
      'kind': 'nft-transfer',
      'standard': 'metaplex',
      'mint': contract,
      'from': from,
      'to': to,
      'amount': amt.toString(),
      'route':
          'build via the existing Solana adapter; inspectTransaction runs first; the signer signs — this module never signs.',
      'summary': 'Transfer Metaplex NFT ${_shorten(contract)} to ${_shorten(to)}',
    };
  }

  throw ArgumentError('buildNftTransfer: unsupported chain $chain');
}

Map<String, dynamic> _evmTx(String chain, String standard, String contract,
    String from, String to, BigInt tokenId, BigInt amount, String data) {
  return {
    'chain': chain,
    'kind': 'nft-transfer',
    'standard': standard,
    'to': contract, // the collection contract is the tx target
    'value': '0',
    'data': data,
    'from': from,
    'nft': {
      'contract': contract,
      'tokenId': tokenId.toString(),
      'amount': amount.toString()
    },
    'route':
        'inspectTransaction runs first (danger forces confirm); the EXISTING signer signs + broadcasts. This module never signs.',
    'summary': (standard == 'erc1155' ? '${amount.toString()}× ' : '') +
        'Transfer NFT #${tokenId.toString()} (${_shorten(contract)}) to ${_shorten(to)}',
  };
}

String? _addressForChain(String chain, NftCtx ctx) {
  if (ctx.addressFor != null) return ctx.addressFor!(chain);
  for (final a in (ctx.accounts ?? const [])) {
    if (a['chain'] == chain) return a['address'] as String?;
  }
  return null;
}

String _shorten(dynamic a) {
  final s = '${a ?? ''}';
  return s.length > 14 ? '${s.substring(0, 8)}…${s.substring(s.length - 4)}' : s;
}

// =============================================================================
// 4. APPROVAL AWARENESS — reuse the security approval manager (no new path)
// =============================================================================
// Surfaces per-collection setApprovalForAll OPERATOR approvals (danger) so the
// user can revoke. Reuses sec.listApprovals (read-only) — no new approval path;
// revocation goes through the normal send flow + security gate.
Future<Map<String, dynamic>> surfaceApprovals(
    String chain, String owner, [sec.SecCtx? ctx]) async {
  final listing = await sec.listApprovals(chain, owner, ctx);
  if (!listing.available) {
    return {
      'chain': chain,
      'owner': owner,
      'approvals': const [],
      'operatorApprovals': const [],
      'available': false,
      'note': listing.note,
    };
  }
  final operatorApprovals = <Map<String, dynamic>>[];
  for (final a in listing.approvals) {
    if (a.operator == true) {
      operatorApprovals.add({
        'collection': a.token,
        'collectionName': a.tokenSymbol,
        'operator': a.spender,
        'operatorLabel': a.spenderLabel,
        'severity': 'danger',
        'revocable': true,
        'lastUpdated': a.lastUpdated,
        'note':
            'setApprovalForAll grants control over your ENTIRE collection — revoke via the normal send flow (the security gate applies). This is NOT a safety claim.',
      });
    }
  }
  return {
    'chain': chain,
    'owner': owner,
    'approvals': listing.approvals.map((a) => a.toMap()).toList(),
    'operatorApprovals': operatorApprovals,
    'available': true,
  };
}
