// multichain/addressbook.dart — WALLET ADDRESS BOOK + NAME RESOLUTION
// (docs/WALLET-PORTFOLIO.md §3).
//
// Dart port of blockle-extension/addressbook.js (the JS reference). Behaviourally
// IDENTICAL; asserted against the authoritative docs/portfolio-vectors.json.
//
// READ-ONLY with respect to the chain; the only writes are to the LOCAL labeled-
// contacts store (encrypted-at-rest alongside settings — persistence is delegated
// to the injected Store, the same encrypted settings backend). No key material,
// no money path.
//
// Two parts:
//   1. A local labeled-contacts store: add / edit / remove / list
//      { label, address, chain?, note? }.
//   2. resolveName(input, chain, ctx) -> { address, source:'ens'|'sns'|'book'|'raw' } | null
//      ENS (.eth) via the injected resolver, SNS (.sol) via the injected resolver,
//      the local book by label, else a verbatim raw address — or null. It NEVER
//      returns a guessed address: a name that doesn't resolve returns null, and a
//      raw string that isn't a plausible address for the chain returns null.
//   + reverseName(address, chain, ctx): book label > forward-verified ENS/SNS
//      reverse > null (the caller then shows truncated hex).
//
// The send flow resolves a typed name, SHOWS the resolved address for user
// confirmation (anti-spoofing), and STILL runs the §-security pre-sign inspection
// on the resolved address — this module only resolves; it never signs or sends.

const String kStoreKey = 'addressBook';

// ---- address shape checks (plausibility only; never a guess) ---------------
bool isEvmAddress(dynamic s) => RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch('${s ?? ''}');
bool isSolAddress(dynamic s) =>
    RegExp(r'^[1-9A-HJ-NP-Za-km-z]{32,44}$').hasMatch('${s ?? ''}');
bool isBlockAddress(dynamic s) =>
    RegExp(r'^block1[0-9a-z]{20,}$', caseSensitive: false).hasMatch('${s ?? ''}');
bool isBech32Utxo(dynamic s) =>
    RegExp(r'^(bc1|ltc1)[0-9a-z]{20,}$', caseSensitive: false).hasMatch('${s ?? ''}');
bool isBase58Utxo(dynamic s) =>
    RegExp(r'^[1-9A-HJ-NP-Za-km-z]{25,40}$').hasMatch('${s ?? ''}');

const Set<String> _evmChains = {
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'
};

bool isAddressLike(dynamic input, dynamic chain) {
  final s = '${input ?? ''}';
  if (s.isEmpty) return false;
  if (_evmChains.contains(chain)) return isEvmAddress(s);
  if (chain == 'solana') return isSolAddress(s);
  if (chain == 'block') return isBlockAddress(s);
  if (chain == 'bitcoin' || chain == 'litecoin') return isBech32Utxo(s) || isBase58Utxo(s);
  if (chain == 'dogecoin') return isBase58Utxo(s);
  // unknown chain: accept the broadest set of plausible shapes
  return isEvmAddress(s) || isSolAddress(s) || isBlockAddress(s) || isBech32Utxo(s);
}

// compare addresses: EVM hex case-insensitive; everything else case-sensitive.
bool addrEq(dynamic a, dynamic b) {
  if (a == null || b == null) return false;
  final x = '$a', y = '$b';
  if (RegExp(r'^0x[0-9a-fA-F]+$').hasMatch(x) && RegExp(r'^0x[0-9a-fA-F]+$').hasMatch(y)) {
    return x.toLowerCase() == y.toLowerCase();
  }
  return x == y;
}

String labelKey(dynamic s) => '${s ?? ''}'.trim().toLowerCase();

// ---- pure list operations (the store wrapper persists the result) ----------
Map<String, dynamic> normalizeEntry(Map? e) {
  e = e ?? const {};
  final label = '${e['label'] ?? ''}'.trim();
  final address = '${e['address'] ?? ''}'.trim();
  if (label.isEmpty) throw ArgumentError('address book entry requires a label');
  if (address.isEmpty) throw ArgumentError('address book entry requires an address');
  final out = <String, dynamic>{'label': label, 'address': address};
  if (e['chain'] != null) out['chain'] = '${e['chain']}';
  if (e['note'] != null && '${e['note']}' != '') out['note'] = '${e['note']}';
  return out;
}

// add OR edit (dedup by label, case-insensitive): a matching label is replaced.
List<Map<String, dynamic>> upsertEntry(List? list, Map entry) {
  final e = normalizeEntry(entry);
  final out = <Map<String, dynamic>>[
    for (final x in (list ?? const [])) Map<String, dynamic>.from(x as Map)
  ];
  final i = out.indexWhere((x) => labelKey(x['label']) == labelKey(e['label']));
  if (i >= 0) {
    out[i] = e;
  } else {
    out.add(e);
  }
  out.sort((a, b) {
    final ka = labelKey(a['label']), kb = labelKey(b['label']);
    return ka.compareTo(kb) < 0 ? -1 : (ka.compareTo(kb) > 0 ? 1 : 0);
  });
  return out;
}

List<Map<String, dynamic>> removeEntry(List? list, dynamic label) => [
      for (final x in (list ?? const []))
        if (labelKey((x as Map)['label']) != labelKey(label))
          Map<String, dynamic>.from(x)
    ];

Map<String, dynamic>? findByLabel(List? list, dynamic label) {
  for (final x in (list ?? const [])) {
    if (labelKey((x as Map)['label']) == labelKey(label)) {
      return Map<String, dynamic>.from(x);
    }
  }
  return null;
}

// first book entry matching an address (optionally constrained to a chain).
Map<String, dynamic>? findByAddress(List? list, dynamic address, [dynamic chain]) {
  for (final x in (list ?? const [])) {
    final m = x as Map;
    if (addrEq(m['address'], address) &&
        (chain == null || m['chain'] == null || m['chain'] == chain)) {
      return Map<String, dynamic>.from(m);
    }
  }
  return null;
}

/// The injected read ctx for name resolution. `resolveEns`/`resolveSns` are the
/// injected forward resolvers; `reverseEns`/`reverseSns` the reverse resolvers
/// (trusted only when forward-verified); `book` is the local book list.
class ResolveCtx {
  final List? book;
  final Future<dynamic> Function(String name)? resolveEns;
  final Future<dynamic> Function(String name)? resolveSns;
  final Future<dynamic> Function(String address)? reverseEns;
  final Future<dynamic> Function(String address)? reverseSns;
  const ResolveCtx({
    this.book,
    this.resolveEns,
    this.resolveSns,
    this.reverseEns,
    this.reverseSns,
  });

  ResolveCtx withBook(List newBook) => ResolveCtx(
        book: newBook,
        resolveEns: resolveEns,
        resolveSns: resolveSns,
        reverseEns: reverseEns,
        reverseSns: reverseSns,
      );
}

// ===========================================================================
// resolveName(input, chain, ctx) -> { address, source } | null
// Never returns a guessed address.
// ===========================================================================
Future<Map<String, dynamic>?> resolveName(
    dynamic input, dynamic chain, ResolveCtx? ctx) async {
  ctx = ctx ?? const ResolveCtx();
  final raw = '${input ?? ''}'.trim();
  if (raw.isEmpty) return null;
  final lower = raw.toLowerCase();

  // ENS (.eth) — the injected resolver is the sole authority.
  if (lower.endsWith('.eth')) {
    if (ctx.resolveEns == null) return null;
    dynamic addr;
    try {
      addr = await ctx.resolveEns!(raw);
    } catch (_) {
      addr = null;
    }
    return addr != null ? {'address': '$addr', 'source': 'ens', 'name': raw} : null;
  }
  // SNS (.sol)
  if (lower.endsWith('.sol')) {
    if (ctx.resolveSns == null) return null;
    dynamic addr;
    try {
      addr = await ctx.resolveSns!(raw);
    } catch (_) {
      addr = null;
    }
    return addr != null ? {'address': '$addr', 'source': 'sns', 'name': raw} : null;
  }
  // local book by label
  final hit = findByLabel(ctx.book, raw);
  if (hit != null) {
    return {'address': hit['address'], 'source': 'book', 'label': hit['label']};
  }

  // a verbatim raw address — returned ONLY when it is a plausible address for
  // the chain (never a guess, never a transform of the input).
  if (isAddressLike(raw, chain)) return {'address': raw, 'source': 'raw'};

  return null;
}

// ===========================================================================
// reverseName(address, chain, ctx) -> { label, source } | null
//   preference: book label > forward-verified ENS/SNS reverse > null.
//   each reverse name is only trusted when it FORWARD-verifies.
// ===========================================================================
Future<Map<String, dynamic>?> reverseName(
    dynamic address, dynamic chain, ResolveCtx? ctx) async {
  ctx = ctx ?? const ResolveCtx();
  if (address == null) return null;
  final hit = findByAddress(ctx.book, address, chain);
  if (hit != null) return {'label': hit['label'], 'source': 'book'};

  Future<Map<String, dynamic>?> tryReverse(
      Future<dynamic> Function(String)? revFn,
      Future<dynamic> Function(String)? fwdFn,
      String source) async {
    if (revFn == null) return null;
    dynamic name;
    try {
      name = await revFn('$address');
    } catch (_) {
      name = null;
    }
    if (name == null) return null;
    // forward-verify: the claimed name MUST resolve back to this address.
    if (fwdFn == null) return null;
    dynamic fwd;
    try {
      fwd = await fwdFn('$name');
    } catch (_) {
      fwd = null;
    }
    return (fwd != null && addrEq(fwd, address)) ? {'label': '$name', 'source': source} : null;
  }

  if (_evmChains.contains(chain)) return tryReverse(ctx.reverseEns, ctx.resolveEns, 'ens');
  if (chain == 'solana') return tryReverse(ctx.reverseSns, ctx.resolveSns, 'sns');
  return null;
}

/// The local key/value settings backend the book persists through. In the app
/// this is backed by the same encrypted-at-rest settings store; tests inject an
/// in-memory one. `get` returns the stored value map for the requested keys;
/// `set` merges the given map.
abstract class AddressBookStore {
  Future<Map<String, dynamic>> get(List<String> keys);
  Future<void> set(Map<String, dynamic> obj);
}

// ===========================================================================
// The stateful store wrapper (persists to the injected Store under kStoreKey).
// ===========================================================================
class AddressBook {
  final AddressBookStore store;
  final String key;
  final ResolveCtx _resolvers;

  AddressBook({required this.store, String? key, ResolveCtx? resolvers})
      : key = key ?? kStoreKey,
        _resolvers = resolvers ?? const ResolveCtx();

  Future<List<Map<String, dynamic>>> _load() async {
    final s = await store.get([key]);
    final v = s[key];
    return v is List
        ? [for (final x in v) Map<String, dynamic>.from(x as Map)]
        : <Map<String, dynamic>>[];
  }

  Future<List<Map<String, dynamic>>> _save(List<Map<String, dynamic>> list) async {
    await store.set({key: list});
    return list;
  }

  Future<List<Map<String, dynamic>>> list() => _load();

  Future<List<Map<String, dynamic>>> add(Map entry) async =>
      _save(upsertEntry(await _load(), entry));

  // same dedup-by-label path as add
  Future<List<Map<String, dynamic>>> edit(Map entry) async =>
      _save(upsertEntry(await _load(), entry));

  Future<List<Map<String, dynamic>>> remove(dynamic label) async =>
      _save(removeEntry(await _load(), label));

  Future<Map<String, dynamic>?> get(dynamic label) async =>
      findByLabel(await _load(), label);

  Future<Map<String, dynamic>?> findAddress(dynamic address, [dynamic chain]) async =>
      findByAddress(await _load(), address, chain);

  Future<Map<String, dynamic>?> resolveName(
      dynamic input, dynamic chain, ResolveCtx? ctx) async {
    final base = ctx ?? _resolvers;
    return resolveNameWith(input, chain, base.withBook(await _load()));
  }

  Future<Map<String, dynamic>?> reverseName(
      dynamic address, dynamic chain, ResolveCtx? ctx) async {
    final base = ctx ?? _resolvers;
    return reverseNameWith(address, chain, base.withBook(await _load()));
  }
}

// top-level aliases so the pure functions remain callable without an instance.
Future<Map<String, dynamic>?> resolveNameWith(
        dynamic input, dynamic chain, ResolveCtx? ctx) =>
    resolveName(input, chain, ctx);
Future<Map<String, dynamic>?> reverseNameWith(
        dynamic address, dynamic chain, ResolveCtx? ctx) =>
    reverseName(address, chain, ctx);
