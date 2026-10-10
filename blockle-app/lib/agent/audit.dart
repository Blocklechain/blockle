// agent/audit.dart — append-only, local, tamper-evident action log for the agent
// (Dart port of blockle-extension/agent/audit.js). Records every prompt, tool
// call (args + result + decision), confirmation, cap check, kill, and broadcast
// txid. Nothing here is ever sent to a Blockle server.
//
// Tamper-evidence: each entry is chained with a SHA-256 head hash
//   head_n = sha256(head_{n-1} + canonical(entry_n))
// so any later edit/removal/reorder of a past entry breaks verify().

import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

/// Minimal key/value store shim (the chrome.storage get/set shape).
abstract class AuditStore {
  Future<void> set(Map<String, dynamic> obj);
}

String _sha256hex(String s) {
  final out = SHA256Digest().process(Uint8List.fromList(utf8.encode(s)));
  return out.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

dynamic _sortedForHash(dynamic v) {
  if (v is Map) {
    final keys = v.keys.map((k) => '$k').toList()..sort();
    final out = <String, dynamic>{};
    for (final k in keys) {
      out[k] = _sortedForHash(v[k]);
    }
    return out;
  }
  if (v is List) return v.map(_sortedForHash).toList();
  if (v is BigInt) return v.toString();
  return v;
}

/// Stable stringify: sort keys recursively so the hash is deterministic.
String canonical(Map<String, dynamic> entry) => jsonEncode(_sortedForHash(entry));

class Audit {
  final List<Map<String, dynamic>> entries = [];
  String head = 'genesis';
  // The hash the retained window chains FROM: 'genesis' until the log is first
  // trimmed, then the head hash of the last entry dropped off the front. verify()
  // starts here so a trimmed log still verifies instead of reporting a false
  // 'tampered' at the (now-missing) genesis prefix.
  String anchor = 'genesis';
  int seq = 0;
  final AuditStore? store;
  final String storeKey;
  final void Function(Map<String, dynamic> entry)? sink;
  final int max;

  Audit({this.store, String? key, this.sink, int? max})
      : storeKey = key ?? 'agentAuditLog',
        max = max ?? 2000;

  Future<Map<String, dynamic>> record(Map<String, dynamic> data) async {
    final entry = <String, dynamic>{
      'seq': seq++,
      'ts': DateTime.now().millisecondsSinceEpoch,
      ...data,
    };
    head = _sha256hex(head + canonical(entry));
    entry['hash'] = head;
    entries.add(entry);
    if (entries.length > max) {
      final drop = entries.length - max;
      // The new chain anchor is the hash of the LAST entry we are dropping — the
      // head of the removed prefix — so verify() can resume from a real hash.
      anchor = entries[drop - 1]['hash'] as String;
      entries.removeRange(0, drop);
    }
    if (sink != null) {
      try {
        sink!(entry);
      } catch (_) {}
    }
    if (store != null) {
      try {
        await store!.set({
          storeKey: {'head': head, 'anchor': anchor, 'entries': entries}
        });
      } catch (_) {}
    }
    return entry;
  }

  /// Recompute the chain and confirm it matches the stored head hashes.
  Future<Map<String, dynamic>> verify() async {
    var h = anchor;
    for (final e in entries) {
      final rest = Map<String, dynamic>.from(e)..remove('hash');
      h = _sha256hex(h + canonical(rest));
      if (h != e['hash']) return {'ok': false, 'at': e['seq']};
    }
    return {'ok': h == head, 'head': h};
  }

  List<Map<String, dynamic>> list() => List.unmodifiable(entries);

  String export() => const JsonEncoder.withIndent('  ')
      .convert({'head': head, 'entries': _sortedForHash(entries)});

  void clear() {
    entries.clear();
    head = 'genesis';
    anchor = 'genesis';
    seq = 0;
  }
}
