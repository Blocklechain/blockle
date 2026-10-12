// multichain/security_test.dart — the WALLET SECURITY SUITE (security.dart),
// Dart port of blockle-extension/security.js. Asserts, byte-for-byte, against
// the AUTHORITATIVE shared fixture docs/security-vectors.json (consumed, never
// edited). Proves:
//   • inspectTransaction decodes EVM (transfer/approve/transferFrom/
//     setApprovalForAll/native/unknown), Solana, UTXO and BLOCK txs identically
//     to the reference, with the exact decoded fields;
//   • the unlimited-approval threshold flag;
//   • every warning rule (unlimited / eoa / known-drainer / send-to-flagged /
//     unknown-spender / setApprovalForAll-true / new-address / large-share /
//     mismatch-currency) fires on the exact SORTED code set + max severity;
//   • a clean tx => warnings:[] + severity none + a "which checks ran / skipped"
//     list (NEVER a fabricated "safe");
//   • buildRevoke emits approve(spender,0) calldata EXACTLY;
//   • listApprovals with no indexer => empty + an audited "NOT a safety claim"
//     note (never an all-clear);
//   • gate composition: a danger inspection forces a human confirm even within
//     allocation / under autoApproveUnderUsd, and can never grant approval.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/security.dart' as sec;
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/runner.dart' show dispatchValueMoving;
import 'package:blockle_app/agent/tools.dart'
    show Tool, ToolRegistry, PreparedAction;

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/security-vectors.json',
    'docs/security-vectors.json',
    '../../docs/security-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('security-vectors.json not found (cwd=${Directory.current.path})');
}

final V = _loadVectors();

void main() {
  group('inspectTransaction — shared vectors (docs/security-vectors.json)', () {
    // default threshold must equal the fixture's canonical 2^255.
    test('unlimited threshold matches the fixture', () {
      expect(sec.kDefaultUnlimitedThreshold.toString(), V['unlimitedThreshold']);
    });

    for (final raw in (V['cases'] as List)) {
      final c = (raw as Map).cast<String, dynamic>();
      final name = c['name'] as String;
      test(name, () async {
        final tx = (c['tx'] as Map).cast<String, dynamic>();
        final ctxSpec = (c['ctxSpec'] as Map).cast<String, dynamic>();
        final expect_ = (c['expect'] as Map).cast<String, dynamic>();

        final ctx = sec.SecCtx.fromSpec(ctxSpec);
        final insp = await sec.inspectTransaction(tx, ctx);

        // kind
        expect(insp.kind, expect_['kind'], reason: 'kind for $name');

        // severity
        expect(insp.severity, expect_['severity'], reason: 'severity for $name');

        // warnings: exact SORTED code set
        final wantWarnings = ((expect_['warnings'] as List?) ?? const [])
            .map((e) => '$e')
            .toList();
        expect(insp.warningCodes, wantWarnings, reason: 'warnings for $name');

        // decoded fields (label -> value)
        final fields = (expect_['fields'] as Map?)?.cast<String, dynamic>();
        if (fields != null) {
          fields.forEach((label, value) {
            final d = insp.field(label);
            expect(d, isNotNull, reason: 'missing field "$label" for $name');
            expect(d!['value'], value, reason: 'field "$label" for $name');
          });
        }

        // which checks RAN (subset — the fixture may pin only the salient ones)
        final wantRan = ((expect_['checksRan'] as List?) ?? const [])
            .map((e) => '$e')
            .toList();
        if (wantRan.isNotEmpty) {
          expect(insp.checks.ran, containsAll(wantRan),
              reason: 'checksRan for $name');
        }

        // which checks were SKIPPED (subset)
        final wantSkipped = ((expect_['checksSkipped'] as List?) ?? const [])
            .map((e) => '$e')
            .toList();
        if (wantSkipped.isNotEmpty) {
          expect(insp.checks.skippedCodes, containsAll(wantSkipped),
              reason: 'checksSkipped for $name');
        }

        // a clean result is warnings:[] + severity none — NEVER a "safe" claim.
        if (wantWarnings.isEmpty) {
          expect(insp.warnings, isEmpty);
          expect(insp.severity, 'none');
        }
      });
    }
  });

  group('approval manager', () {
    test('buildRevoke emits approve(spender,0) calldata EXACTLY', () {
      final r = (V['revoke'] as Map).cast<String, dynamic>();
      final exp = (r['expect'] as Map).cast<String, dynamic>();
      final tx = sec.buildRevoke(
          r['chain'] as String, r['token'], r['spender'] as String);
      expect(tx['kind'], exp['kind']);
      expect('${tx['to']}'.toLowerCase(), '${exp['to']}'.toLowerCase());
      expect(tx['value'], exp['value']);
      expect('${tx['data']}'.toLowerCase(), '${exp['data']}'.toLowerCase());
    });

    test('buildRevoke rejects a missing token/spender', () {
      expect(() => sec.buildRevoke('ethereum', null, '0xabc'), throwsArgumentError);
      expect(() => sec.buildRevoke('ethereum', '0xtok', null), throwsArgumentError);
    });

    test('listApprovals with no indexer => empty + audited note (never all-clear)',
        () async {
      final want = ((V['listApprovalsUnavailable'] as Map)['expect'] as Map)
          .cast<String, dynamic>();
      final res = await sec.listApprovals('ethereum', '0xowner', const sec.SecCtx());
      expect(res.approvals, isEmpty);
      expect(res.available, want['available']);
      expect(res.note, contains(want['noteMatches'] as String));
    });

    test('listApprovals maps allowances + unlimited flag from the indexer',
        () async {
      final ctx = sec.SecCtx(indexer: _FakeIndexer([
        {
          'token': '0xtok',
          'symbol': 'USDC',
          'spender': '0xspender',
          'allowanceBase': '100',
        },
        {
          'token': '0xtok2',
          'spender': '0xspender2',
          'allowanceBase': sec.kMaxUint256.toString(),
        },
      ]));
      final res = await sec.listApprovals('ethereum', '0xowner', ctx);
      expect(res.available, true);
      expect(res.approvals.length, 2);
      expect(res.approvals[0].unlimited, false);
      expect(res.approvals[0].allowanceBase, '100');
      expect(res.approvals[1].unlimited, true);
    });
  });

  group('pre-sign gate', () {
    test('danger inspection with no confirm handler fails closed (blocked)',
        () async {
      // send-to-flagged recipient => danger.
      final tx = {
        'chain': 'ethereum',
        'to': '0x000000000000000000000000000000000000dEaD',
        'value': '1',
      };
      const ctx = sec.SecCtx(config: {
        'denylist': ['0x000000000000000000000000000000000000dEaD']
      });
      await expectLater(
        sec.presign(tx: tx, ctx: ctx),
        throwsA(isA<sec.PresignBlocked>()
            .having((e) => e.blocked, 'blocked', true)),
      );
    });

    test('non-danger inspection clears without a confirm handler', () async {
      final res = await sec.presign(
          tx: {'chain': 'ethereum', 'to': '0x2222222222222222222222222222222222222222', 'value': '1'});
      expect(res.cleared, true);
      expect(res.inspection.severity, isNot('danger'));
    });

    test('danger inspection with a declining confirm handler is declined', () async {
      final tx = {
        'chain': 'ethereum',
        'to': '0x000000000000000000000000000000000000dEaD',
        'value': '1',
      };
      const ctx = sec.SecCtx(config: {
        'denylist': ['0x000000000000000000000000000000000000dEaD']
      });
      await expectLater(
        sec.presign(tx: tx, ctx: ctx, confirm: (_) async => false),
        throwsA(isA<sec.PresignBlocked>()
            .having((e) => e.declined, 'declined', true)),
      );
    });
  });

  group('gate composition (docs/security-vectors.json#gateComposition)', () {
    final g = (V['gateComposition'] as Map).cast<String, dynamic>();
    final scenario = (g['scenario'] as Map).cast<String, dynamic>();
    final expect_ = (g['expect'] as Map).cast<String, dynamic>();
    final autoUsd = (scenario['autoApproveUnderUsd'] as num);
    final actionUsd = (scenario['actionUsd'] as num);

    test('without security: an action under autoApproveUnderUsd auto-approves', () async {
      var called = false;
      final p = Policy.create(
          autoApproveUnderUsd: autoUsd, confirm: (_) async => (called = true));
      final gate = await p.gateConfirm({}, {'usd': actionUsd});
      final want = (expect_['withoutSecurity'] as Map).cast<String, dynamic>();
      expect(gate.approved, want['approved']);
      expect(gate.auto, want['auto']);
      expect(called, false, reason: 'no human confirm on an auto-approved action');
    });

    test('with danger forceConfirm: forces a human confirm (no auto), approves on OK',
        () async {
      var called = false;
      final p = Policy.create(
          autoApproveUnderUsd: autoUsd, confirm: (_) async => (called = true));
      final gate =
          await p.gateConfirm({}, {'usd': actionUsd, 'forceConfirm': true});
      final want =
          (expect_['withDangerForceConfirm'] as Map).cast<String, dynamic>();
      expect(gate.auto, want['auto']);
      expect(called, want['humanConfirmCalled']);
      expect(gate.approved, true);
    });

    test('with danger forceConfirm declined: not approved (gate never grants)',
        () async {
      final p = Policy.create(
          autoApproveUnderUsd: autoUsd, confirm: (_) async => false);
      final gate =
          await p.gateConfirm({}, {'usd': actionUsd, 'forceConfirm': true});
      final want = (expect_['withDangerForceConfirm_declined'] as Map)
          .cast<String, dynamic>();
      expect(gate.approved, want['approved']);
    });
  });

  // Fix #3 — the shipped default knownSpenders allowlist makes
  // approval-to-unknown-spender run (and fire) in PRODUCTION by default, while
  // the pure vector path (SecCtx.fromSpec) stays default-free (asserted above).
  group('default knownSpenders (production config)', () {
    // approve(unknownSpender, 100000000) — a sized approval to a spender NOT on
    // the shipped router allowlist.
    const approveUnknown = {
      'chain': 'ethereum',
      'to': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      'data':
          '0x095ea7b300000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000005f5e100',
    };

    test('ships the spec §3 routers (non-empty, lowercased)', () {
      expect(sec.kDefaultKnownSpenders, isNotEmpty);
      expect(sec.kDefaultKnownSpenders,
          contains('0x7a250d5630b4cf539739df2c5dacb4c659f2488d')); // Uniswap V2
    });

    test('default config => approval-to-unknown-spender RUNS and FIRES', () async {
      final ctx = sec.SecCtx(config: sec.defaultSecurityConfig());
      final insp = await sec.inspectTransaction(approveUnknown, ctx);
      expect(insp.checks.ran, contains('approval-to-unknown-spender'));
      expect(insp.warningCodes, contains('approval-to-unknown-spender'));
      expect(insp.severity, 'warn');
    });

    test('a known default router does NOT fire unknown-spender', () async {
      // approve(Uniswap V2 router, sized) — on the shipped allowlist.
      const approveKnown = {
        'chain': 'ethereum',
        'to': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        'data':
            '0x095ea7b30000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d0000000000000000000000000000000000000000000000000000000005f5e100',
      };
      final ctx = sec.SecCtx(config: sec.defaultSecurityConfig());
      final insp = await sec.inspectTransaction(approveKnown, ctx);
      expect(insp.checks.ran, contains('approval-to-unknown-spender'));
      expect(insp.warningCodes, isNot(contains('approval-to-unknown-spender')));
    });

    test('operator knownSpenders are unioned with the defaults', () async {
      final cfg = sec.defaultSecurityConfig({
        'knownSpenders': ['0x2222222222222222222222222222222222222222']
      });
      final insp = await sec.inspectTransaction(approveUnknown,
          sec.SecCtx(config: cfg));
      // 0x2222… is now known => no unknown-spender warning.
      expect(insp.warningCodes, isNot(contains('approval-to-unknown-spender')));
    });
  });

  // Fix #4 — an unlimited SPL delegate allowance is detected (>= threshold),
  // exactly like EVM, so a max delegate grant raises unlimited-approval.
  group('Solana SPL approve unlimited detection', () {
    Map<String, dynamic> splApprove(String amount) => {
          'chain': 'solana',
          'instructions': [
            {
              'program': 'spl-token',
              'type': 'approve',
              'info': {
                'delegate': 'Delegate111111111111111111111111111111111',
                'amount': amount,
                'mint': 'Mint1111111111111111111111111111111111111',
              }
            }
          ],
        };

    test('max SPL allowance => unlimited-approval (warn)', () async {
      final insp = await sec.inspectTransaction(
          splApprove(sec.kMaxUint256.toString()), const sec.SecCtx());
      expect(insp.kind, 'token-approval');
      expect(insp.field('Allowance')!['value'], 'UNLIMITED');
      expect(insp.warningCodes, contains('unlimited-approval'));
      expect(insp.severity, 'warn');
    });

    test('a sized SPL allowance is NOT unlimited', () async {
      final insp =
          await sec.inspectTransaction(splApprove('250'), const sec.SecCtx());
      expect(insp.field('Allowance')!['value'], '250');
      expect(insp.warningCodes, isNot(contains('unlimited-approval')));
    });
  });

  // Fix #2 — the signer-level pre-sign guard (presignOutgoing) used by the
  // user-send flow: a danger user tx refuses with no handler and is declinable,
  // and clears on an explicit ack. Read-only (never signs).
  group('signer-level pre-sign guard (presignOutgoing)', () {
    const bad = '0x000000000000000000000000000000000000dEaD';
    final cfg = sec.defaultSecurityConfig({
      'denylist': [bad]
    });

    test('danger user send with NO confirm handler fails closed (blocked)', () async {
      await expectLater(
        sec.presignOutgoing(
          chain: 'ethereum',
          intent: {'to': bad, 'amount': '1', 'asset': null},
          ctx: sec.SecCtx(config: cfg),
        ),
        throwsA(isA<sec.PresignBlocked>()
            .having((e) => e.blocked, 'blocked', true)
            .having((e) => e.inspection.severity, 'severity', 'danger')),
      );
    });

    test('danger user send with a declining handler is declined', () async {
      await expectLater(
        sec.presignOutgoing(
          chain: 'ethereum',
          intent: {'to': bad, 'amount': '1', 'asset': null},
          ctx: sec.SecCtx(config: cfg),
          confirm: (_) async => false,
        ),
        throwsA(isA<sec.PresignBlocked>()
            .having((e) => e.declined, 'declined', true)),
      );
    });

    test('danger user send clears on an explicit human ack', () async {
      var asked = false;
      final res = await sec.presignOutgoing(
        chain: 'ethereum',
        intent: {'to': bad, 'amount': '1', 'asset': null},
        ctx: sec.SecCtx(config: cfg),
        confirm: (_) async {
          asked = true;
          return true;
        },
      );
      expect(asked, true);
      expect(res.cleared, true);
    });

    test('a clean user send clears without any prompt', () async {
      var asked = false;
      final res = await sec.presignOutgoing(
        chain: 'ethereum',
        intent: {
          'to': '0x2222222222222222222222222222222222222222',
          'amount': '1',
          'asset': null
        },
        ctx: sec.SecCtx(config: cfg),
        confirm: (_) async {
          asked = true;
          return true;
        },
      );
      expect(asked, false);
      expect(res.cleared, true);
    });
  });

  // Fix #1 (gate side) — a DANGER security inspection attached to a prepared
  // agent/bot order forces a human confirm through the SHARED value-moving
  // dispatch, even when the order is under autoApproveUnderUsd (within
  // allocation). Without the inspection the identical order auto-approves — the
  // exact regression the production inspect hook closes.
  group('agent/bots dispatch forces confirm on a danger order', () {
    const bad = '0x000000000000000000000000000000000000dEaD';

    Future<sec.Inspection> dangerInsp() => sec.inspectTransaction(
        {'chain': 'ethereum', 'to': bad, 'value': '1'},
        sec.SecCtx(config: sec.defaultSecurityConfig({
          'denylist': [bad]
        })));

    ToolRegistry regWith(sec.Inspection? insp) => ToolRegistry([
          Tool(
            name: 'send',
            description: 'test',
            valueMoving: true,
            parameters: const {},
            prepare: (a) async => PreparedAction(
              summary: const {'action': 'send'},
              value: const SpendValue(asset: 'ETH', amount: '1', usd: 1),
              commit: () async => {'txid': '0xabc'},
            ).withSecurity(insp),
          )
        ]);

    test('danger order under autoApproveUnderUsd STILL forces a human confirm',
        () async {
      final insp = await dangerInsp();
      expect(insp.severity, 'danger');
      var confirmCalled = false;
      final policy = Policy.create(
          autoApproveUnderUsd: 100, confirm: (_) async => (confirmCalled = true));
      final out = await dispatchValueMoving(
          tools: regWith(insp), policy: policy, name: 'send', args: {});
      expect(confirmCalled, true,
          reason: 'danger must force a human confirm despite usd(1) <= auto(100)');
      expect(out.declined, false);
    });

    test('SAME order WITHOUT the inspection auto-approves (the pre-fix behavior)',
        () async {
      var confirmCalled = false;
      final policy = Policy.create(
          autoApproveUnderUsd: 100, confirm: (_) async => (confirmCalled = true));
      final out = await dispatchValueMoving(
          tools: regWith(null), policy: policy, name: 'send', args: {});
      expect(confirmCalled, false, reason: 'no security => auto-approved within allocation');
      expect(out.declined, false);
    });
  });
}

class _FakeIndexer implements sec.ApprovalIndexer {
  final List<Map<String, dynamic>> rows;
  _FakeIndexer(this.rows);
  @override
  Future<List<Map<String, dynamic>>> getApprovals(String chain, String owner) async =>
      rows;
}
