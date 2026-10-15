// command_bar.dart — the NATURAL-LANGUAGE COMMAND BAR surface for the Dart
// wallet (port of blockle-extension/command-ui.js).
//
// A single text input, surfaced in the agent screen ALONGSIDE the existing
// agent channels cockpit. It drives agent/command.dart (the CommandRouter) and
// renders, inline:
//   • the interpreted INTENT (action vs query),
//   • for an ACTION, the proposed PLAN (one row per step) and, per step, the
//     RESOLVED recipient (name -> address) and the step outcome
//     (committed / declined / error),
//   • for a QUERY, the answer text.
//
// It adds NO new power and owns NO gate. Every value-moving step is confirmed by
// the HOST's shared security confirm sheet — the SAME modal the agent cockpit
// already wires into policy.gateConfirm (reached via the router the host builds,
// whose policy.confirm is the shared AgentConfirmDialog). This widget never
// signs, never broadcasts, and never shows its own "approve" button; it only
// shows what the router reports.
//
// Decoupled by construction: the host passes [buildRouter], which wires the
// provider / tools / policy / confirm / name-resolver / engines for the active
// wallet and returns a [CommandRouter] (or null when no channel is running).
// The bar subscribes to that router's events.

import 'package:flutter/material.dart';

import '../../agent/command.dart' show CommandRouter;
import '../../theme.dart';

// ---- pure renderers (unit-tested; mirror command-ui.js) --------------------

/// A rendered transcript fragment produced from ONE router event (or a locally
/// generated line like the user's own input / a thrown error). The UI turns
/// each fragment into a styled row — the fragment itself carries no widgets so
/// the mapping stays pure and testable.
class CmdFragment {
  /// one of: you | intent | plan | resolved | answer | outcome | error
  final String kind;
  final String text;

  /// For `outcome`: committed | declined | error.
  final String? status;

  /// For `plan`: one human line per proposed step.
  final List<String> planLines;

  const CmdFragment(this.kind, this.text, {this.status, this.planLines = const []});
}

/// Shorten a long address for display (8…6), leaving short strings intact.
String cmdShort(dynamic addr) {
  final s = '${addr ?? ''}';
  return s.length > 14 ? '${s.substring(0, 8)}…${s.substring(s.length - 6)}' : s;
}

/// The intent badge label.
String cmdIntentLabel(String? intent) => intent == 'action' ? 'ACTION' : 'QUERY';

/// One human line for a proposed plan step. Mirrors command-ui.js:planHtml.
String cmdPlanLine(Map<String, dynamic> step) {
  final a = (step['args'] as Map?)?.cast<String, dynamic>() ?? const {};
  final action = '${step['action'] ?? ''}';
  if (action == 'send') {
    final asset = a['asset'];
    final sym = asset is Map && asset['symbol'] != null
        ? '${asset['symbol']}'
        : (a['chain'] != null ? '${a['chain']}'.toUpperCase() : '');
    return 'send ${a['amount'] ?? ''} $sym → ${cmdShort(a['to'])}';
  }
  if (action == 'swap') {
    return 'swap ${a['amount'] ?? ''} ${a['from'] ?? ''} → ${a['to'] ?? ''}';
  }
  return action;
}

/// The name → resolved-address line (anti-spoofing). Mirrors resolvedHtml.
String cmdResolvedText(Map<String, dynamic> ev) =>
    'Resolved ${ev['input']} → ${ev['address']} (${ev['source'] ?? 'raw'})';

/// The human label for a value-moving step's outcome. Mirrors stepOutcomeHtml.
String cmdStepOutcomeLabel(String status) {
  switch (status) {
    case 'committed':
      return 'confirmed & sent';
    case 'declined':
      return 'declined';
    case 'error':
      return 'blocked';
    default:
      return status;
  }
}

/// Turn ONE router event into a transcript fragment (or null to ignore).
/// Centralized so the widget and the tests share the EXACT same mapping —
/// mirrors command-ui.js:eventHtml.
CmdFragment? cmdEventFragment(Map<String, dynamic>? ev) {
  if (ev == null || ev['type'] == null) return null;
  switch (ev['type']) {
    case 'intent':
      return CmdFragment('intent', cmdIntentLabel(ev['intent'] as String?));
    case 'plan':
      final steps = (ev['steps'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
      return CmdFragment('plan', 'Plan — each step needs your confirmation',
          planLines: [for (final s in steps) cmdPlanLine(s)]);
    case 'resolved':
      return CmdFragment('resolved', cmdResolvedText(ev));
    case 'text':
      return CmdFragment('answer', '${ev['text'] ?? ''}');
    case 'declined':
      return CmdFragment('outcome', '${ev['name']}: ${cmdStepOutcomeLabel('declined')}',
          status: 'declined');
    case 'executed':
      final txid = ev['txid'];
      final detail = txid != null ? ' — ${cmdShort(txid)}' : '';
      return CmdFragment(
          'outcome', '${ev['name']}: ${cmdStepOutcomeLabel('committed')}$detail',
          status: 'committed');
    case 'step_error':
    case 'tool_error':
      final prefix = ev['name'] != null ? '${ev['name']}: ' : '';
      return CmdFragment('error', '$prefix${ev['error']}');
    case 'killed':
      return CmdFragment('error', 'killed — ${ev['reason'] ?? ''}');
    default:
      return null;
  }
}

// ---- the command bar widget ------------------------------------------------

/// Builds a [CommandRouter] wired to the active wallet, subscribing [onEvent] to
/// its event stream. Returns null when no channel/provider is available (the bar
/// then tells the user to connect one). The host owns ALL wiring — provider,
/// tools, the ONE policy/gate, the name resolver, and the read engines.
typedef CommandRouterBuilder = CommandRouter? Function(
    {void Function(Map<String, dynamic> ev)? onEvent});

class CommandBar extends StatefulWidget {
  const CommandBar({super.key, required this.buildRouter, this.enabled = true});

  final CommandRouterBuilder buildRouter;
  final bool enabled;

  @override
  State<CommandBar> createState() => _CommandBarState();
}

class _CommandBarState extends State<CommandBar> {
  final _ctrl = TextEditingController();
  final _scroll = ScrollController();
  final List<CmdFragment> _transcript = [];
  bool _busy = false;

  @override
  void dispose() {
    _ctrl.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _append(CmdFragment? f) {
    if (f == null) return;
    setState(() => _transcript.add(f));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  Future<void> _submit() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty || _busy || !widget.enabled) return;
    setState(() => _busy = true);
    _append(CmdFragment('you', text));
    _ctrl.clear();
    try {
      final router = widget.buildRouter(onEvent: (ev) => _append(cmdEventFragment(ev)));
      if (router == null) {
        _append(const CmdFragment(
            'error', 'Connect an agent channel first to run commands.'));
      } else {
        final r = await router.run(text);
        // The final query answer / closing note, if the router returned text
        // without a trailing 'text' event.
        if (r.text != null && r.text!.isNotEmpty) {
          final last = _transcript.isNotEmpty ? _transcript.last : null;
          if (last == null || last.kind != 'answer' || last.text != r.text) {
            _append(CmdFragment('answer', r.text!));
          }
        }
      }
    } catch (e) {
      _append(CmdFragment('error', e.toString().replaceFirst('Exception: ', '')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _ctrl,
                enabled: widget.enabled && !_busy,
                decoration: const InputDecoration(
                  hintText:
                      'Try: send 0.1 ETH to alice.eth · swap 100 USDC to SOL · what is my net worth?',
                  isDense: true,
                ),
                onSubmitted: (_) => _submit(),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(
              onPressed: (widget.enabled && !_busy) ? _submit : null,
              style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 44),
                  padding: const EdgeInsets.symmetric(horizontal: 16)),
              child: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Run'),
            ),
          ],
        ),
        const SizedBox(height: 6),
        const Text(
          'The agent only proposes actions. Every fund move is capped and needs your confirmation.',
          style: TextStyle(color: Bk.muted, fontSize: 11),
        ),
        if (_transcript.isNotEmpty) ...[
          const SizedBox(height: 10),
          Container(
            constraints: const BoxConstraints(maxHeight: 260),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Bk.surface2,
              borderRadius: BorderRadius.circular(12),
            ),
            child: ListView.builder(
              controller: _scroll,
              shrinkWrap: true,
              itemCount: _transcript.length,
              itemBuilder: (_, i) => _row(_transcript[i]),
            ),
          ),
        ],
      ],
    );
  }

  Widget _row(CmdFragment f) {
    switch (f.kind) {
      case 'you':
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text('“${f.text}”',
              style: const TextStyle(
                  fontWeight: FontWeight.w600, fontStyle: FontStyle.italic)),
        );
      case 'intent':
        final isAction = f.text == 'ACTION';
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: (isAction ? Bk.accent : Bk.muted).withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(f.text,
                  style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: isAction ? Bk.accent : Bk.muted)),
            ),
          ),
        );
      case 'plan':
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(f.text,
                  style: const TextStyle(
                      fontWeight: FontWeight.w700, fontSize: 12, color: Bk.muted)),
              const SizedBox(height: 4),
              for (var i = 0; i < f.planLines.length; i++)
                Padding(
                  padding: const EdgeInsets.only(top: 2, left: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${i + 1}. ',
                          style: const TextStyle(fontSize: 12, color: Bk.muted)),
                      Expanded(
                        child: Text(f.planLines[i],
                            style: const TextStyle(fontSize: 12)),
                      ),
                      const Text('awaiting confirm',
                          style: TextStyle(fontSize: 10, color: Bk.muted)),
                    ],
                  ),
                ),
            ],
          ),
        );
      case 'resolved':
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(f.text,
              style: const TextStyle(
                  fontSize: 12, fontFamily: 'monospace', color: Bk.muted)),
        );
      case 'outcome':
        final color = f.status == 'committed'
            ? Bk.good
            : f.status == 'error'
                ? Bk.bad
                : Bk.muted;
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(f.text,
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: color)),
        );
      case 'error':
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(f.text, style: const TextStyle(fontSize: 12, color: Bk.bad)),
        );
      case 'answer':
      default:
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(f.text, style: const TextStyle(fontSize: 13)),
        );
    }
  }
}
