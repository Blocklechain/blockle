// accounts_screen.dart — the multi-chain ACCOUNTS screen (PASS 2 #1).
//
// Lists every chain's address + live balances (incl. ERC-20 USDC/USDT), a
// per-chain Send flow (adapter.buildSend -> review fee/txid -> confirm ->
// broadcast), add-token, and an endpoints settings panel. BLOCK is the only
// chain labelled post-quantum; every other chain is honestly labelled classical
// (secp256k1 / ed25519).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../multichain/chains/chain_adapter.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';

class AccountsScreen extends StatefulWidget {
  const AccountsScreen({super.key});
  @override
  State<AccountsScreen> createState() => _AccountsScreenState();
}

class _AccountsScreenState extends State<AccountsScreen> {
  final Map<String, DerivedAccount?> _accts = {};
  final Map<String, List<Balance>> _bals = {};
  final Set<String> _loading = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadAll());
  }

  Future<void> _loadAll() async {
    final c = context.read<MultichainController>();
    for (final chain in kDisplayChains) {
      // BLOCK always resolvable; HD chains need the vault unlocked.
      if (chain != 'block' && !c.vaultUnlocked) continue;
      _loadChain(c, chain);
    }
  }

  Future<void> _loadChain(MultichainController c, String chain) async {
    if (_loading.contains(chain)) return;
    setState(() => _loading.add(chain));
    final acct = await c.addressFor(chain);
    final bals = await c.balancesFor(chain);
    if (!mounted) return;
    setState(() {
      _accts[chain] = acct;
      _bals[chain] = bals;
      _loading.remove(chain);
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<MultichainController>();
    return SafeArea(
      child: RefreshIndicator(
        color: Bk.accent,
        backgroundColor: Bk.surface,
        onRefresh: _loadAll,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
          children: [
            Row(
              children: [
                const Text('Accounts',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                const Spacer(),
                IconButton(
                  tooltip: 'Endpoints',
                  onPressed: () => Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const EndpointsScreen())),
                  icon: const Icon(Icons.dns_outlined, color: Bk.muted),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (!c.vaultUnlocked) _vaultBanner(c),
            const SizedBox(height: 8),
            for (final chain in kDisplayChains)
              if (chain == 'block' || c.vaultUnlocked) _chainCard(c, chain),
          ],
        ),
      ),
    );
  }

  Widget _vaultBanner(MultichainController c) {
    final exists = c.vaultExists;
    return Container(
      margin: const EdgeInsets.only(top: 8, bottom: 4),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Bk.accent.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Bk.accent.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(exists ? 'Multi-chain vault locked' : 'Enable multi-chain accounts',
              style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(
              exists
                  ? 'Unlock to show your Ethereum, Base, Bitcoin, Litecoin, Dogecoin and Solana accounts. BLOCK stays available on its own post-quantum key.'
                  : 'Add a single BIP39 recovery phrase to derive your ETH / Base / BTC / LTC / DOGE / SOL accounts. BLOCK remains post-quantum and separate.',
              style: const TextStyle(color: Bk.muted, fontSize: 12)),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () =>
                exists ? _unlockVaultDialog(c) : _setupVaultDialog(c),
            child: Text(exists ? 'Unlock' : 'Set up'),
          ),
        ],
      ),
    );
  }

  Widget _chainCard(MultichainController c, String chain) {
    final label = kChainLabels[chain] ?? chain;
    final ticker = kChainTickers[chain] ?? '';
    final acct = _accts[chain];
    final bals = _bals[chain] ?? const [];
    final isPq = chain == 'block';
    final loading = _loading.contains(chain);
    final addr = acct?.address ?? '';

    return Card(
      margin: const EdgeInsets.only(top: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 16,
                  backgroundColor: Bk.accent.withValues(alpha: 0.18),
                  child: Text(ticker.isNotEmpty ? ticker[0] : '?',
                      style: const TextStyle(
                          color: Bk.accent, fontWeight: FontWeight.w700)),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(label,
                              style: const TextStyle(fontWeight: FontWeight.w700)),
                          const SizedBox(width: 8),
                          _pqBadge(isPq),
                        ],
                      ),
                      Text(ticker, style: const TextStyle(color: Bk.muted, fontSize: 12)),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: loading ? null : () => _loadChain(c, chain),
                  icon: loading
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.refresh, size: 18, color: Bk.muted),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (addr.isEmpty)
              const Text('Address unavailable (unlock required).',
                  style: TextStyle(color: Bk.muted, fontSize: 12))
            else
              InkWell(
                onTap: () {
                  Clipboard.setData(ClipboardData(text: addr));
                  ScaffoldMessenger.of(context)
                      .showSnackBar(const SnackBar(content: Text('Address copied')));
                },
                child: Row(
                  children: [
                    Expanded(
                        child: Text(addr,
                            style: kMono.copyWith(fontSize: 11, color: Bk.muted),
                            overflow: TextOverflow.ellipsis)),
                    const Icon(Icons.copy, size: 14, color: Bk.muted),
                  ],
                ),
              ),
            const SizedBox(height: 10),
            ...bals.map(_balanceRow),
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: addr.isEmpty
                        ? null
                        : () => Navigator.push(
                                context,
                                MaterialPageRoute(
                                    builder: (_) =>
                                        MultiSendScreen(chain: chain)))
                            .then((_) => _loadChain(c, chain)),
                    icon: const Icon(Icons.north_east, size: 16),
                    label: const Text('Send'),
                  ),
                ),
                if (chain == 'ethereum' || chain == 'base') ...[
                  const SizedBox(width: 10),
                  OutlinedButton.icon(
                    onPressed: () => _addTokenDialog(c, chain),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('Token'),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _balanceRow(Balance b) {
    final err = b.error != null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Text(b.asset.symbol,
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          if (b.asset.kind != 'native') ...[
            const SizedBox(width: 6),
            const Text('token', style: TextStyle(color: Bk.muted, fontSize: 10)),
          ],
          const Spacer(),
          if (err)
            const Text('unavailable',
                style: TextStyle(color: Bk.bad, fontSize: 12))
          else
            Text(b.display, style: kMono.copyWith(fontSize: 13)),
        ],
      ),
    );
  }

  Widget _pqBadge(bool isPq) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: (isPq ? Bk.good : Bk.muted).withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        isPq ? 'post-quantum' : 'classical',
        style: TextStyle(
            color: isPq ? Bk.good : Bk.muted,
            fontSize: 9,
            fontWeight: FontWeight.w700),
      ),
    );
  }

  // ---- dialogs -------------------------------------------------------------

  Future<void> _setupVaultDialog(MultichainController c) async {
    final pw = TextEditingController();
    final mnemonic = TextEditingController();
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Set up multi-chain'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
                'Leave the phrase blank to generate a new 12-word recovery phrase, '
                'or paste an existing BIP39 phrase to import.',
                style: TextStyle(color: Bk.muted, fontSize: 12)),
            const SizedBox(height: 12),
            TextField(
              controller: mnemonic,
              minLines: 2,
              maxLines: 3,
              decoration: const InputDecoration(
                  labelText: 'Recovery phrase (optional)',
                  hintText: 'word word word …'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: pw,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Vault password'),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Create')),
        ],
      ),
    );
    if (res != true) return;
    try {
      await c.setupVault(pw.text,
          mnemonic: mnemonic.text.trim().isEmpty ? null : mnemonic.text.trim());
      await _loadAll();
      _snack('Multi-chain accounts enabled');
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _unlockVaultDialog(MultichainController c) async {
    final pw = TextEditingController();
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Unlock multi-chain'),
        content: TextField(
          controller: pw,
          obscureText: true,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Vault password'),
          onSubmitted: (_) => Navigator.pop(context, true),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Unlock')),
        ],
      ),
    );
    if (res != true) return;
    final ok = await c.unlockVault(pw.text);
    if (ok) {
      await _loadAll();
    } else {
      _snack('Wrong password or vault unavailable');
    }
  }

  Future<void> _addTokenDialog(MultichainController c, String chain) async {
    final addr = TextEditingController();
    final sym = TextEditingController();
    final dec = TextEditingController(text: '6');
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: Text('Add ${kChainLabels[chain]} token'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
                controller: addr,
                decoration: const InputDecoration(
                    labelText: 'Contract address', hintText: '0x…')),
            const SizedBox(height: 10),
            TextField(
                controller: sym,
                decoration: const InputDecoration(labelText: 'Symbol')),
            const SizedBox(height: 10),
            TextField(
                controller: dec,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Decimals')),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Add')),
        ],
      ),
    );
    if (res != true) return;
    final a = addr.text.trim();
    if (!RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(a)) {
      _snack('Enter a valid 0x… contract address');
      return;
    }
    await c.addToken(AssetRef(
      chain: chain,
      kind: 'erc20',
      symbol: sym.text.trim().isEmpty ? 'TOKEN' : sym.text.trim(),
      decimals: int.tryParse(dec.text.trim()) ?? 6,
      address: a,
    ));
    await _loadChain(c, chain);
  }

  void _snack(String m) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
    }
  }
}

/// Base-unit conversion helpers (decimal human string <-> base-unit integer).
String humanToBase(String human, int decimals) {
  final s = human.trim();
  if (s.isEmpty) return '0';
  final neg = s.startsWith('-');
  final body = neg ? s.substring(1) : s;
  final parts = body.split('.');
  final intPart = parts[0].isEmpty ? '0' : parts[0];
  var frac = parts.length > 1 ? parts[1] : '';
  if (frac.length > decimals) frac = frac.substring(0, decimals);
  frac = frac.padRight(decimals, '0');
  final combined = BigInt.parse('$intPart$frac');
  return (neg ? -combined : combined).toString();
}

/// Per-chain Send flow: buildSend -> review (fee + txid) -> confirm -> broadcast.
class MultiSendScreen extends StatefulWidget {
  const MultiSendScreen({super.key, required this.chain});
  final String chain;
  @override
  State<MultiSendScreen> createState() => _MultiSendScreenState();
}

class _MultiSendScreenState extends State<MultiSendScreen> {
  final _to = TextEditingController();
  final _amt = TextEditingController();
  final _feeRate = TextEditingController();
  AssetRef? _asset; // null = native
  bool _busy = false;
  String? _error;
  String? _okTxid;
  BuiltTx? _built;

  List<AssetRef> _assets(MultichainController c) {
    final native = c.registry.get(widget.chain).native;
    return [native, ...c.registry.tokensFor(widget.chain)];
  }

  Future<void> _review() async {
    final c = context.read<MultichainController>();
    final to = _to.text.trim();
    if (to.isEmpty) {
      setState(() => _error = 'Enter a recipient address.');
      return;
    }
    final asset = _asset ?? c.registry.get(widget.chain).native;
    final amount = humanToBase(_amt.text, asset.decimals);
    if (BigInt.tryParse(amount) == null || BigInt.parse(amount) <= BigInt.zero) {
      setState(() => _error = 'Enter a valid amount.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _okTxid = null;
      _built = null;
    });
    try {
      final acct = await c.accounts.accountFor(widget.chain);
      final adapter = c.registry.get(widget.chain);
      final built = await adapter.buildSend(
        acct,
        SendRequest(
          to: to,
          amount: amount,
          asset: asset.kind == 'native' ? null : asset,
          feeRate: _feeRate.text.trim().isEmpty ? null : _feeRate.text.trim(),
        ),
      );
      setState(() {
        _built = built;
        _busy = false;
      });
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _broadcast() async {
    final c = context.read<MultichainController>();
    final built = _built;
    if (built == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await c.registry.get(widget.chain).broadcast(built);
      setState(() {
        _busy = false;
        _okTxid = res.txid;
        _built = null;
      });
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<MultichainController>();
    final assets = _assets(c);
    _asset ??= assets.first;
    final label = kChainLabels[widget.chain] ?? widget.chain;
    final feeHint = _feeHint(widget.chain);

    return Scaffold(
      appBar: AppBar(title: Text('Send on $label')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          DropdownButtonFormField<String>(
            initialValue: _asset?.address ?? '@native',
            dropdownColor: Bk.surface2,
            decoration: const InputDecoration(labelText: 'Asset'),
            items: [
              for (final a in assets)
                DropdownMenuItem(
                  value: a.address ?? '@native',
                  child: Text('${a.symbol}${a.kind == 'native' ? '' : ' (token)'}'),
                ),
            ],
            onChanged: (v) => setState(() {
              _asset = assets.firstWhere(
                  (a) => (a.address ?? '@native') == v,
                  orElse: () => assets.first);
            }),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _to,
            decoration: const InputDecoration(labelText: 'Recipient address'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _amt,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: 'Amount (${_asset?.symbol ?? ''})'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _feeRate,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: feeHint),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Bk.bad)),
          ],
          if (_built != null) ...[
            const SizedBox(height: 16),
            _reviewCard(_built!),
          ],
          if (_okTxid != null) ...[
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Bk.good.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Bk.good.withValues(alpha: 0.4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Broadcast ✓',
                      style: TextStyle(
                          color: Bk.good, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text(_okTxid!, style: kMono.copyWith(fontSize: 11)),
                ],
              ),
            ),
          ],
          const SizedBox(height: 22),
          if (_built == null)
            FilledButton(
              onPressed: _busy ? null : _review,
              child: _busy
                  ? const SizedBox(
                      height: 22,
                      width: 22,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Review'),
            )
          else
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy ? null : () => setState(() => _built = null),
                    child: const Text('Back'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _busy ? null : _broadcast,
                    child: _busy
                        ? const SizedBox(
                            height: 22,
                            width: 22,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Confirm & broadcast'),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _reviewCard(BuiltTx b) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Bk.surface2,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Bk.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Review',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          _kv('To', b.summary.to),
          _kv('Amount', b.summary.amount),
          _kv('Network fee', b.fee),
          _kv('Txid', b.txid),
        ],
      ),
    );
  }

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
                width: 90,
                child: Text(k,
                    style: const TextStyle(color: Bk.muted, fontSize: 12))),
            Expanded(child: Text(v, style: kMono.copyWith(fontSize: 11))),
          ],
        ),
      );

  String _feeHint(String chain) {
    switch (chain) {
      case 'bitcoin':
      case 'litecoin':
      case 'dogecoin':
        return 'Fee rate (sat/vB, optional)';
      case 'ethereum':
      case 'base':
        return 'Max fee per gas (wei, optional)';
      case 'block':
        return 'Network fee (base units, optional)';
      default:
        return 'Fee (optional)';
    }
  }
}

/// RPC / Esplora endpoint editor (Accounts settings panel #1).
class EndpointsScreen extends StatefulWidget {
  const EndpointsScreen({super.key});
  @override
  State<EndpointsScreen> createState() => _EndpointsScreenState();
}

class _EndpointsScreenState extends State<EndpointsScreen> {
  @override
  Widget build(BuildContext context) {
    final c = context.watch<MultichainController>();
    return Scaffold(
      appBar: AppBar(title: const Text('Endpoints')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const Text(
              'Override the public default RPC / Esplora endpoints. Endpoints are '
              'configuration only — no key material is stored here.',
              style: TextStyle(color: Bk.muted, fontSize: 12)),
          const SizedBox(height: 14),
          for (final chain in kDisplayChains)
            if (chain != 'block') _endpointTile(c, chain),
        ],
      ),
    );
  }

  Widget _endpointTile(MultichainController c, String chain) {
    final cfg = c.effectiveEndpoint(chain);
    final isUtxo = chain == 'bitcoin' || chain == 'litecoin' || chain == 'dogecoin';
    final value = isUtxo ? (cfg.esplora ?? '') : (cfg.rpcUrl ?? '');
    return Card(
      child: ListTile(
        title: Text(kChainLabels[chain] ?? chain),
        subtitle: Text(value.isEmpty ? 'not configured' : value,
            style: kMono.copyWith(fontSize: 11), maxLines: 1, overflow: TextOverflow.ellipsis),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (c.hasEndpointOverride(chain))
              IconButton(
                icon: const Icon(Icons.restore, size: 18, color: Bk.muted),
                onPressed: () => c.resetEndpoint(chain),
              ),
            IconButton(
              icon: const Icon(Icons.edit, size: 18, color: Bk.muted),
              onPressed: () => _editDialog(c, chain, isUtxo, value),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _editDialog(
      MultichainController c, String chain, bool isUtxo, String current) async {
    final ctrl = TextEditingController(text: current);
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: Text('${kChainLabels[chain]} ${isUtxo ? 'Esplora' : 'RPC'}'),
        content: TextField(
          controller: ctrl,
          decoration: InputDecoration(
              labelText: isUtxo ? 'Esplora base URL' : 'RPC URL',
              hintText: 'https://…'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (res != true) return;
    if (isUtxo) {
      await c.setEndpoint(chain, esplora: ctrl.text.trim());
    } else {
      await c.setEndpoint(chain, rpcUrl: ctrl.text.trim());
    }
  }
}
