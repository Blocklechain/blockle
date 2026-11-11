// alien_chat_screen.dart — BLOCKLE ALIEN CHAT: the in-app AI, for real.
//
// Two brains, both private-by-design:
//   • ON-DEVICE — download Gemma 3 1B (int4, ~550 MB) through the app and chat
//     with it fully offline; nothing you type leaves the phone.
//   • HOSTED (free) — Blockle's keyless gateway (anonymous, rate-limited
//     session; no API key, no account required).
//
// Every reply is grounded with the wallet's built-in RAG corpus (rag.dart), so
// the Alien actually knows Blockle: the gate, bots, Blockshot, the Drip,
// liquidity, security. It can RECOMMEND and suggest SMALL ACTIONS — rendered
// as tappable chips (open a tab, start a PAPER bot). Actions only ever run on
// YOUR tap, and the only bot it can create is paper + within the normal engine
// rules. The LLM can never move funds (the gate is not reachable from here).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../agent/on_device_llm.dart';
import '../agent/providers.dart' as pv;
import '../agent/rag.dart' as rag;
import '../services/agent_service.dart' show httpProviderFetch;
import '../state/app_state.dart';
import '../state/bots_controller.dart';
import '../theme.dart';

enum _Brain { onDevice, hosted }

class _Msg {
  _Msg(this.role, this.text, {this.actions = const []});
  final String role; // 'user' | 'alien' | 'info'
  final String text;
  final List<String> actions;
}

const _kActions = {
  'open_bots': ('Open Bots', 2),
  'open_blockshot': ('Open Blockshot', 7),
  'open_drip': ('Open the Drip', -1), // via settings route; handled specially
  'open_liquidity': ('Open Liquidity', 6),
  'open_portfolio': ('Open Portfolio', 5),
  'open_wallet': ('Open Wallet', 0),
};

const _system = '''
You are Blockle Alien, the in-wallet AI of the Blockle non-custodial wallet.
Be concise, concrete and friendly. Ground every answer in the CONTEXT below;
if the context does not cover it, say so honestly. NEVER ask for or accept a
seed phrase, password or private key. You cannot move funds: every value move
needs the user's explicit confirmation through the wallet's security gate.
Prices of BLOCK and BLOCK-20 tokens are quoted in BLOCK, never USD.

When (and only when) an action genuinely helps, end your reply with one or two
of these tags on their own line, nothing else on it:
ACTION:open_bots  ACTION:open_blockshot  ACTION:open_drip  ACTION:open_liquidity
ACTION:open_portfolio  ACTION:open_wallet  ACTION:paper_dca
(paper_dca starts a PAPER-money DCA bot — never real funds.)
''';

class AlienChatScreen extends StatefulWidget {
  const AlienChatScreen({super.key});
  @override
  State<AlienChatScreen> createState() => _AlienChatScreenState();
}

class _AlienChatScreenState extends State<AlienChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<_Msg> _msgs = [
    _Msg('alien',
        "Hey — I'm the Blockle Alien. Ask me anything about this wallet: bots, "
        'Blockshot launches, the daily Drip, liquidity, security. I can also '
        'take you places or spin up a paper bot to practice with.'),
  ];
  _Brain _brain = _Brain.hosted;
  bool _busy = false;
  pv.HostedProvider? _hosted;

  @override
  void initState() {
    super.initState();
    OnDeviceLlm.instance.init();
    OnDeviceLlm.instance.addListener(_onLlm);
  }

  void _onLlm() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    OnDeviceLlm.instance.removeListener(_onLlm);
    super.dispose();
  }

  Future<pv.HostedProvider> _hostedProvider() async {
    if (_hosted != null) return _hosted!;
    // Anonymous keyless session: rate-limited free tier, no account, no key.
    final sess = await pv.hostedSession(
        fetch: httpProviderFetch, gatewayUrl: pv.defaultGatewayUrl, anon: true);
    _hosted = pv.HostedProvider(
      gatewayUrl: pv.defaultGatewayUrl,
      sessionToken: '${sess['sessionToken']}',
      fetch: httpProviderFetch,
      refresh: () async {
        final s = await pv.hostedSession(
            fetch: httpProviderFetch, gatewayUrl: pv.defaultGatewayUrl, anon: true);
        return '${s['sessionToken']}';
      },
    );
    return _hosted!;
  }

  String _grounding(String query) {
    final docs = rag.retrieve(query, k: 4);
    final b = StringBuffer('CONTEXT (Blockle wallet facts):\n');
    for (final d in docs) {
      b.writeln('- ${d['title']}: ${d['text']}');
    }
    return b.toString();
  }

  (String, List<String>) _parseActions(String out) {
    final actions = <String>[];
    final lines = out.split('\n').where((l) {
      final m = RegExp(r'^\s*ACTION:([a-z_]+)\s*$').firstMatch(l);
      if (m == null) return true;
      final a = m.group(1)!;
      if (_kActions.containsKey(a) || a == 'paper_dca') actions.add(a);
      return false;
    }).toList();
    return (lines.join('\n').trim(), actions);
  }

  Future<void> _send() async {
    final q = _input.text.trim();
    if (q.isEmpty || _busy) return;
    _input.clear();
    setState(() {
      _msgs.add(_Msg('user', q));
      _busy = true;
    });
    _autoScroll();
    try {
      final context6 = _msgs
          .where((m) => m.role != 'info')
          .toList()
          .reversed
          .take(7)
          .toList()
          .reversed
          .map((m) => '${m.role == 'user' ? 'User' : 'Alien'}: ${m.text}')
          .join('\n');
      final prompt = '${_grounding(q)}\nRecent conversation:\n$context6\nUser: $q\nAlien:';
      String out;
      if (_brain == _Brain.onDevice) {
        out = await OnDeviceLlm.instance.generate(system: _system, prompt: prompt);
      } else {
        final p = await _hostedProvider();
        final r = await p.turn(system: '$_system\n${_grounding(q)}', messages: [
          for (final m in _msgs.where((m) => m.role != 'info').toList().reversed.take(7).toList().reversed)
            {'role': m.role == 'user' ? 'user' : 'assistant', 'content': m.text},
        ]);
        out = '${r['text'] ?? ''}';
        if (out.isEmpty) throw Exception('the hosted brain returned nothing — try again');
      }
      final (text, actions) = _parseActions(out);
      setState(() {
        _msgs.add(_Msg('alien', text.isEmpty ? '…' : text, actions: actions));
        _busy = false;
      });
    } catch (e) {
      setState(() {
        _msgs.add(_Msg('info',
            'That brain had a problem: ${e.toString().replaceFirst('Exception: ', '')}'
            '${_brain == _Brain.onDevice ? ' — you can switch to the free hosted brain above.' : ''}'));
        _busy = false;
      });
    }
    _autoScroll();
  }

  void _runAction(String a) {
    HapticFeedback.selectionClick();
    final app = context.read<AppState>();
    if (a == 'paper_dca') {
      final bots = context.read<BotsController>();
      try {
        final bot = bots.createFromTemplate('conservative_dca', pair: 'SOL/USDC');
        bots.enablePaper(bot.id, allocationUsd: 100);
        setState(() => _msgs.add(_Msg('info',
            'Started a PAPER DCA bot on SOL/USDC with a \$100 practice allocation — '
            'no real funds. Watch it on the Bots tab.')));
        app.setTab(2);
      } catch (e) {
        setState(() => _msgs.add(_Msg('info', 'Could not start the paper bot: $e')));
      }
      return;
    }
    final t = _kActions[a];
    if (t == null) return;
    if (a == 'open_drip') {
      app.setTab(4); // Settings hosts the Drip entry
      setState(() => _msgs.add(_Msg('info', 'The Drip lives in Settings — tap "Blockle Drip".')));
      return;
    }
    app.setTab(t.$2);
  }

  void _autoScroll() {
    Future.delayed(const Duration(milliseconds: 80), () {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent + 120,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final llm = OnDeviceLlm.instance;
    return Scaffold(
      backgroundColor: Bk.bg,
      body: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: Row(children: [
              const Icon(Icons.auto_awesome_rounded, color: Bk.accent, size: 20),
              const SizedBox(width: 8),
              const Text('Blockle Alien',
                  style: TextStyle(fontSize: 19, fontWeight: FontWeight.w900, color: Bk.text)),
              const Spacer(),
              _brainBtn('On-device', _Brain.onDevice),
              const SizedBox(width: 6),
              _brainBtn('Hosted · free', _Brain.hosted),
            ]),
          ),
          if (_brain == _Brain.onDevice && !llm.hasModelFile) _downloadCard(llm),
          if (_brain == _Brain.onDevice && llm.status == OnDeviceStatus.downloading)
            _progressCard(llm),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              itemCount: _msgs.length + (_busy ? 1 : 0),
              itemBuilder: (_, i) {
                if (i == _msgs.length) return _typing();
                return _bubble(_msgs[i]);
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 4, 14, 12),
            child: Row(children: [
              Expanded(
                child: TextField(
                  controller: _input,
                  onSubmitted: (_) => _send(),
                  textInputAction: TextInputAction.send,
                  style: const TextStyle(color: Bk.text),
                  decoration: InputDecoration(
                    hintText: _brain == _Brain.onDevice && !llm.hasModelFile
                        ? 'Download the model above, or use Hosted'
                        : 'Ask the Alien anything about Blockle…',
                    hintStyle: const TextStyle(color: Bk.faint, fontSize: 13.5),
                    filled: true,
                    fillColor: Bk.surface,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                    border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(22), borderSide: BorderSide.none),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              GestureDetector(
                onTap: _send,
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(colors: [Bk.accent, Bk.accent2]),
                    borderRadius: BorderRadius.circular(22),
                  ),
                  child: const Icon(Icons.arrow_upward_rounded, color: Colors.white, size: 22),
                ),
              ),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _brainBtn(String label, _Brain b) {
    final on = _brain == b;
    return GestureDetector(
      onTap: () => setState(() => _brain = b),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
        decoration: BoxDecoration(
          color: on ? Bk.accent.withValues(alpha: 0.18) : Bk.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: on ? Bk.accent : Bk.border),
        ),
        child: Text(label,
            style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                color: on ? Bk.accent : Bk.muted)),
      ),
    );
  }

  Widget _downloadCard(OnDeviceLlm llm) => Container(
        margin: const EdgeInsets.fromLTRB(16, 6, 16, 4),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Bk.accent.withValues(alpha: 0.4)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.download_rounded, color: Bk.accent, size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Text('${llm.model.name} · ~${llm.model.sizeMb} MB',
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w800, color: Bk.text)),
            ),
          ]),
          const SizedBox(height: 4),
          const Text(
              'Runs entirely on this phone — nothing you type leaves the device. '
              'Download once over Wi-Fi; delete it anytime from this card.',
              style: TextStyle(fontSize: 11.5, color: Bk.muted, height: 1.4)),
          if (llm.error != null) ...[
            const SizedBox(height: 6),
            Text(llm.error!, style: const TextStyle(fontSize: 11.5, color: Bk.bad)),
          ],
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: () => llm.download(),
            style: FilledButton.styleFrom(
                backgroundColor: Bk.accent, minimumSize: const Size.fromHeight(42)),
            icon: const Icon(Icons.download_rounded, size: 17),
            label: const Text('Download the model',
                style: TextStyle(fontWeight: FontWeight.w800)),
          ),
        ]),
      );

  Widget _progressCard(OnDeviceLlm llm) => Container(
        margin: const EdgeInsets.fromLTRB(16, 6, 16, 4),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Bk.border),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Downloading ${llm.model.name} — ${(llm.progress * 100).toStringAsFixed(0)}%',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: Bk.text)),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: llm.progress,
              minHeight: 8,
              backgroundColor: Bk.bg2,
              valueColor: const AlwaysStoppedAnimation(Bk.accent),
            ),
          ),
        ]),
      );

  Widget _typing() => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: Bk.surface,
              borderRadius: BorderRadius.circular(16),
            ),
            child: const SizedBox(
                width: 28,
                height: 12,
                child: _Dots()),
          ),
        ]),
      );

  Widget _bubble(_Msg m) {
    if (m.role == 'info') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Text(m.text,
            style: const TextStyle(fontSize: 11.5, color: Bk.faint, height: 1.4)),
      );
    }
    final mine = m.role == 'user';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          Container(
            constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.82),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: mine ? Bk.accent.withValues(alpha: 0.22) : Bk.surface,
              borderRadius: BorderRadius.only(
                topLeft: const Radius.circular(16),
                topRight: const Radius.circular(16),
                bottomLeft: Radius.circular(mine ? 16 : 4),
                bottomRight: Radius.circular(mine ? 4 : 16),
              ),
              border: Border.all(color: mine ? Bk.accent.withValues(alpha: 0.4) : Bk.border),
            ),
            child: SelectableText(m.text,
                style: const TextStyle(fontSize: 13.5, color: Bk.text, height: 1.45)),
          ),
          if (m.actions.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Wrap(spacing: 6, runSpacing: 6, children: [
                for (final a in m.actions)
                  ActionChip(
                    backgroundColor: Bk.accent2.withValues(alpha: 0.12),
                    side: BorderSide(color: Bk.accent2.withValues(alpha: 0.5)),
                    label: Text(
                        a == 'paper_dca' ? 'Start a paper DCA bot' : (_kActions[a]?.$1 ?? a),
                        style: const TextStyle(fontSize: 11.5, color: Bk.accent2)),
                    onPressed: () => _runAction(a),
                  ),
              ]),
            ),
        ],
      ),
    );
  }
}

class _Dots extends StatefulWidget {
  const _Dots();
  @override
  State<_Dots> createState() => _DotsState();
}

class _DotsState extends State<_Dots> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (_, __) => Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: List.generate(3, (i) {
            final t = ((_c.value * 3 - i) % 3).clamp(0.0, 1.0);
            return Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Bk.muted.withValues(alpha: 0.35 + 0.65 * (1 - (t - 0.5).abs() * 2).clamp(0.0, 1.0)),
              ),
            );
          }),
        ),
      );
}
