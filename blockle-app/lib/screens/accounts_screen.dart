// accounts_screen.dart — the multi-chain ACCOUNTS screen (PASS 2 #1).
//
// Lists every chain's address + live balances (incl. ERC-20 USDC/USDT), a
// per-chain Send flow (adapter.buildSend -> review fee/txid -> confirm ->
// broadcast), add-token, and an endpoints settings panel. BLOCK is the only
// chain labelled post-quantum; every other chain is honestly labelled classical
// (secp256k1 / ed25519).

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:provider/provider.dart';

import '../multichain/chains/chain_adapter.dart';
import '../multichain/chains/registry.dart' show CustomNetwork, slugifyNetworkName;
import '../services/moonpay.dart';
import '../services/open_url.dart';
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
    for (final chain in c.displayChains()) {
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
            for (final chain in c.displayChains())
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
    final label = c.chainLabel(chain);
    final ticker = c.chainTicker(chain);
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
            ...bals.map((b) => _balanceRow(c, chain, addr, b)),
            if (isPq) _blockBuyNote(),
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
                if (c.isEvmChain(chain)) ...[
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

  Widget _balanceRow(
      MultichainController c, String chain, String addr, Balance b) {
    final err = b.error != null;
    final logo = b.asset.logo;
    final isToken = b.asset.kind != 'native';
    // "Buy with card" is offered per asset that MoonPay supports — never for
    // BLOCK, and only when we have a receive address to deliver to.
    final moonpaySupported = !moonpayIsBlock(chain) &&
        moonpayCurrencyCode(chain, kind: b.asset.kind, symbol: b.asset.symbol) !=
            null;
    final canBuy = addr.isNotEmpty && moonpaySupported;
    // "Sell for cash" (off-ramp) is offered for the same supported asset set;
    // the address is the source/refund address MoonPay shows the user.
    final canSell = addr.isNotEmpty && moonpaySupported;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          if (isToken) ...[
            CircleAvatar(
              radius: 9,
              backgroundColor: Bk.surface2,
              foregroundImage: (logo != null && logo.isNotEmpty)
                  ? NetworkImage(logo)
                  : null,
              child: Text(
                  b.asset.symbol.isNotEmpty ? b.asset.symbol[0] : '?',
                  style: const TextStyle(fontSize: 9, color: Bk.muted)),
            ),
            const SizedBox(width: 6),
          ],
          Flexible(
            child: Text(b.asset.symbol,
                overflow: TextOverflow.ellipsis,
                style:
                    const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          ),
          if (isToken) ...[
            const SizedBox(width: 6),
            const Text('token', style: TextStyle(color: Bk.muted, fontSize: 10)),
          ],
          const Spacer(),
          if (err)
            const Text('unavailable',
                style: TextStyle(color: Bk.bad, fontSize: 12))
          else
            Text(b.display, style: kMono.copyWith(fontSize: 13)),
          if (canBuy) ...[
            const SizedBox(width: 8),
            _buyChip(() => _buyWithCard(c, chain, addr, b.asset)),
          ],
          if (canSell) ...[
            const SizedBox(width: 6),
            _sellChip(() => _sellForCash(c, chain, addr, b.asset)),
          ],
        ],
      ),
    );
  }

  Widget _buyChip(VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Bk.accent.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(8),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.credit_card, size: 12, color: Bk.accent),
            SizedBox(width: 4),
            Text('Buy',
                style: TextStyle(
                    color: Bk.accent,
                    fontSize: 11,
                    fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }

  Widget _sellChip(VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Bk.muted.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(8),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.account_balance_outlined, size: 12, color: Bk.muted),
            SizedBox(width: 4),
            Text('Sell',
                style: TextStyle(
                    color: Bk.muted,
                    fontSize: 11,
                    fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }

  /// BLOCK is not on MoonPay — show a short swap note instead of a Buy button.
  Widget _blockBuyNote() {
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Bk.surface2,
        borderRadius: BorderRadius.circular(10),
      ),
      child: const Text(
        'BLOCK isn’t available to buy with a card. Buy a supported asset '
        '(ETH, USDC, BTC…) with a card, then swap it to BLOCK on the '
        'exchange or via the /buy curve.',
        style: TextStyle(color: Bk.muted, fontSize: 11),
      ),
    );
  }

  /// Build the MoonPay widget URL for [asset] on [chain] and open it — the
  /// in-app webview on mobile/desktop, a new browser tab on web. MoonPay hosts
  /// the KYC + payment flow; this wallet never sees card data.
  Future<void> _buyWithCard(
      MultichainController c, String chain, String addr, AssetRef asset) async {
    final url = await moonpayBuyUrl(
      config: c.moonpayConfig,
      chain: chain,
      walletAddress: addr,
      kind: asset.kind,
      symbol: asset.symbol,
      baseCurrencyCode: 'usd',
      theme: 'dark',
      colorCode: '#7C5CFF',
    );
    if (url == null) {
      _snack('Buying ${asset.symbol} with a card isn’t available yet.');
      return;
    }
    if (!mounted) return;
    if (kIsWeb) {
      openExternal(url);
      return;
    }
    await Navigator.push(
      context,
      MaterialPageRoute(
          builder: (_) =>
              MoonPayBuyScreen(url: url, assetLabel: asset.symbol)),
    );
  }

  /// Build the MoonPay SELL (off-ramp) widget URL for [asset] on [chain] and
  /// open it — the in-app webview on mobile/desktop, a new browser tab on web.
  /// MoonPay hosts the KYC + payout flow and shows the user a deposit address;
  /// this wallet never handles PII or banking details.
  Future<void> _sellForCash(
      MultichainController c, String chain, String addr, AssetRef asset) async {
    final url = await moonpaySellUrl(
      config: c.moonpayConfig,
      chain: chain,
      walletAddress: addr,
      kind: asset.kind,
      symbol: asset.symbol,
      quoteCurrencyCode: 'usd',
      theme: 'dark',
      colorCode: '#7C5CFF',
    );
    if (url == null) {
      _snack('Selling ${asset.symbol} for cash isn’t available yet.');
      return;
    }
    if (!mounted) return;
    if (kIsWeb) {
      openExternal(url);
      return;
    }
    await Navigator.push(
      context,
      MaterialPageRoute(
          builder: (_) =>
              MoonPaySellScreen(url: url, assetLabel: asset.symbol)),
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
        title: Text('Add ${c.chainLabel(chain)} token'),
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
    final label = c.chainLabel(widget.chain);
    final feeHint = _feeHint(widget.chain, c.isEvmChain(widget.chain));

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

  String _feeHint(String chain, bool isEvm) {
    switch (chain) {
      case 'bitcoin':
      case 'litecoin':
      case 'dogecoin':
        return 'Fee rate (sat/vB, optional)';
      case 'block':
        return 'Network fee (base units, optional)';
      default:
        return isEvm
            ? 'Max fee per gas (wei, optional)'
            : 'Fee (optional)';
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
          const SizedBox(height: 20),
          Row(
            children: [
              const Expanded(
                child: Text('Custom networks',
                    style: TextStyle(fontWeight: FontWeight.w700)),
              ),
              TextButton.icon(
                onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                        builder: (_) => const CustomNetworkEditScreen())),
                icon: const Icon(Icons.add, size: 16),
                label: const Text('Add network'),
              ),
            ],
          ),
          const Text(
              'Add any EVM network by chain ID + RPC URL. It uses the same '
              'account/address as your other EVM chains. Network definitions are '
              'configuration, not secrets.',
              style: TextStyle(color: Bk.muted, fontSize: 12)),
          const SizedBox(height: 8),
          if (c.customNetworks.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 6),
              child: Text('No custom networks yet.',
                  style: TextStyle(color: Bk.muted, fontSize: 12)),
            )
          else
            for (final n in c.customNetworks) _customNetTile(c, n),
          const SizedBox(height: 20),
          const Text('Token auto-detect (Alchemy)',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text(
              'Paste a read-only Alchemy indexer URL (with key) per network to '
              'auto-list every ERC-20 you hold. Off until set — no key is ever '
              'logged. BNB Chain and Avalanche are not covered and use the known '
              'token list.',
              style: TextStyle(color: Bk.muted, fontSize: 12)),
          const SizedBox(height: 8),
          for (final chain in kAlchemyChains) _alchemyTile(c, chain),
          const SizedBox(height: 20),
          const Text('Buy & sell with card (MoonPay)',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text(
              'Buy crypto with a card or bank, or sell it back to cash, via '
              'MoonPay. The publishable key below is client-side and safe. '
              'MoonPay handles KYC, payment and payout — this wallet never sees '
              'card or banking data. BLOCK is not on MoonPay; buy/sell a '
              'supported asset and swap to or from BLOCK.',
              style: TextStyle(color: Bk.muted, fontSize: 12)),
          const SizedBox(height: 8),
          _moonpayTile(c),
          _moonpaySignerTile(c),
        ],
      ),
    );
  }

  Widget _moonpayTile(MultichainController c) {
    final cfg = c.moonpayConfig;
    final live = cfg.isLive;
    return Card(
      child: ListTile(
        title: const Text('MoonPay publishable key'),
        subtitle: Text(
            '${c.hasMoonpayApiKeyOverride ? 'custom' : 'default'} · '
            '${live ? 'LIVE' : 'sandbox'}\n${cfg.apiKey}',
            style: kMono.copyWith(
                fontSize: 11, color: live ? Bk.good : Bk.muted),
            maxLines: 2,
            overflow: TextOverflow.ellipsis),
        isThreeLine: true,
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (c.hasMoonpayApiKeyOverride)
              IconButton(
                icon: const Icon(Icons.restore, size: 18, color: Bk.muted),
                onPressed: () => c.setMoonpayApiKey(null),
              ),
            IconButton(
              icon: const Icon(Icons.edit, size: 18, color: Bk.muted),
              onPressed: () => _editMoonpayKeyDialog(c),
            ),
          ],
        ),
      ),
    );
  }

  Widget _moonpaySignerTile(MultichainController c) {
    final signer = c.moonpayConfig.signerUrl ?? '';
    return Card(
      child: ListTile(
        title: const Text('MoonPay URL signer (optional)'),
        subtitle: Text(
            signer.isEmpty
                ? 'not set — unsigned sandbox URLs (production needs a signer)'
                : signer,
            style: kMono.copyWith(fontSize: 11),
            maxLines: 1,
            overflow: TextOverflow.ellipsis),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (signer.isNotEmpty)
              IconButton(
                icon: const Icon(Icons.clear, size: 18, color: Bk.muted),
                onPressed: () => c.setMoonpaySignerUrl(null),
              ),
            IconButton(
              icon: const Icon(Icons.edit, size: 18, color: Bk.muted),
              onPressed: () => _editMoonpaySignerDialog(c),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _editMoonpayKeyDialog(MultichainController c) async {
    final ctrl = TextEditingController(
        text: c.hasMoonpayApiKeyOverride ? c.moonpayConfig.apiKey : '');
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('MoonPay publishable key'),
        content: TextField(
          controller: ctrl,
          decoration: const InputDecoration(
              labelText: 'pk_test_… or pk_live_…',
              hintText: 'leave blank to use the default'),
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
    await c.setMoonpayApiKey(ctrl.text.trim());
  }

  Future<void> _editMoonpaySignerDialog(MultichainController c) async {
    final ctrl = TextEditingController(text: c.moonpayConfig.signerUrl ?? '');
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('MoonPay URL signer'),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
              labelText: 'Signer endpoint URL',
              hintText: 'https://…/moonpay/sign'),
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
    await c.setMoonpaySignerUrl(ctrl.text.trim());
  }

  Widget _customNetTile(MultichainController c, CustomNetwork n) {
    return Card(
      child: ListTile(
        title: Text(n.name),
        subtitle: Text(
            'chain ${n.chainId} · ${n.nativeSymbol}\n${n.rpcUrl}',
            style: kMono.copyWith(fontSize: 11),
            maxLines: 2,
            overflow: TextOverflow.ellipsis),
        isThreeLine: true,
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              icon: const Icon(Icons.edit, size: 18, color: Bk.muted),
              onPressed: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) =>
                          CustomNetworkEditScreen(existing: n))),
            ),
            IconButton(
              icon: const Icon(Icons.delete_outline, size: 18, color: Bk.bad),
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (_) => AlertDialog(
                    backgroundColor: Bk.surface,
                    title: Text('Remove ${n.name}?'),
                    content: const Text(
                        'This removes the network definition from this wallet. '
                        'Your funds are unaffected.'),
                    actions: [
                      TextButton(
                          onPressed: () => Navigator.pop(context, false),
                          child: const Text('Cancel')),
                      FilledButton(
                          onPressed: () => Navigator.pop(context, true),
                          child: const Text('Remove')),
                    ],
                  ),
                );
                if (ok == true) await c.removeCustomNetwork(n.id);
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _alchemyTile(MultichainController c, String chain) {
    final on = c.alchemyEnabled(chain);
    return Card(
      child: ListTile(
        title: Text(kChainLabels[chain] ?? chain),
        subtitle: Text(on ? 'auto-detect ON' : 'auto-detect off (known list)',
            style: TextStyle(
                color: on ? Bk.good : Bk.muted, fontSize: 11)),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (on)
              IconButton(
                icon: const Icon(Icons.clear, size: 18, color: Bk.muted),
                onPressed: () => c.setAlchemy(chain, null),
              ),
            IconButton(
              icon: const Icon(Icons.key, size: 18, color: Bk.muted),
              onPressed: () => _editAlchemyDialog(c, chain),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _editAlchemyDialog(
      MultichainController c, String chain) async {
    final ctrl = TextEditingController(
        text: c.effectiveEndpoint(chain).alchemyUrl ?? '');
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: Text('${kChainLabels[chain]} Alchemy URL'),
        content: TextField(
          controller: ctrl,
          decoration: const InputDecoration(
              labelText: 'Alchemy URL (with read-only key)',
              hintText: 'https://<net>.g.alchemy.com/v2/<key>'),
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
    await c.setAlchemy(chain, ctrl.text.trim());
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

/// Add / edit a user-added EVM network (MetaMask-style). Validates inputs and,
/// on save, optionally probes `eth_chainId` to WARN (non-blocking) on a chainId
/// mismatch before persisting.
class CustomNetworkEditScreen extends StatefulWidget {
  const CustomNetworkEditScreen({super.key, this.existing});
  final CustomNetwork? existing;
  @override
  State<CustomNetworkEditScreen> createState() =>
      _CustomNetworkEditScreenState();
}

class _CustomNetworkEditScreenState extends State<CustomNetworkEditScreen> {
  late final TextEditingController _name;
  late final TextEditingController _chainId;
  late final TextEditingController _rpc;
  late final TextEditingController _symbol;
  late final TextEditingController _decimals;
  late final TextEditingController _explorer;
  late final TextEditingController _indexer;

  bool _busy = false;
  String? _error;
  String? _warn;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _name = TextEditingController(text: e?.name ?? '');
    _chainId = TextEditingController(text: e?.chainId.toString() ?? '');
    _rpc = TextEditingController(text: e?.rpcUrl ?? '');
    _symbol = TextEditingController(text: e?.nativeSymbol ?? 'ETH');
    _decimals = TextEditingController(text: (e?.decimals ?? 18).toString());
    _explorer = TextEditingController(text: e?.explorerUrl ?? '');
    _indexer = TextEditingController(text: e?.tokenIndexerUrl ?? '');
  }

  @override
  void dispose() {
    for (final c in [
      _name,
      _chainId,
      _rpc,
      _symbol,
      _decimals,
      _explorer,
      _indexer
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  CustomNetwork _draft() {
    final indexer = _indexer.text.trim();
    return CustomNetwork(
      id: _isEdit ? widget.existing!.id : slugifyNetworkName(_name.text),
      name: _name.text.trim(),
      chainId: int.tryParse(_chainId.text.trim()) ?? -1,
      rpcUrl: _rpc.text.trim(),
      nativeSymbol:
          _symbol.text.trim().isEmpty ? 'ETH' : _symbol.text.trim(),
      decimals: int.tryParse(_decimals.text.trim()) ?? 18,
      explorerUrl: _explorer.text.trim(),
      tokenIndexerUrl: indexer.isEmpty ? null : indexer,
    );
  }

  Future<void> _save() async {
    final c = context.read<MultichainController>();
    setState(() {
      _busy = true;
      _error = null;
      _warn = null;
    });
    final net = _draft();
    // Non-blocking chainId probe: WARN only, never prevents the add.
    final probed = await c.probeChainId(net.rpcUrl);
    if (probed != null && probed != net.chainId) {
      setState(() => _warn =
          'The RPC reports chain ID $probed, but you entered ${net.chainId}. '
          'Saving anyway — double-check the chain ID.');
    }
    try {
      await c.addCustomNetwork(net,
          replacingId: _isEdit ? widget.existing!.id : null);
      if (!mounted) return;
      if (_warn == null) {
        Navigator.pop(context);
      } else {
        // Keep the screen up so the user sees the mismatch warning; it is
        // already persisted. Offer an explicit done.
        setState(() => _busy = false);
      }
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
          title: Text(_isEdit ? 'Edit network' : 'Add custom network')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(
            controller: _name,
            decoration: const InputDecoration(
                labelText: 'Network name', hintText: 'My EVM Network'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _chainId,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
                labelText: 'Chain ID', hintText: '1'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _rpc,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
                labelText: 'RPC URL', hintText: 'https://…'),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _symbol,
                  decoration: const InputDecoration(
                      labelText: 'Native symbol', hintText: 'ETH'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  controller: _decimals,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Decimals'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _explorer,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
                labelText: 'Explorer tx base (optional)',
                hintText: 'https://etherscan.io/tx/'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _indexer,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
                labelText: 'Token indexer URL (optional)',
                hintText: 'https://<net>.g.alchemy.com/v2/<key>'),
          ),
          const SizedBox(height: 6),
          const Text(
              'An Alchemy-style indexer URL enables ERC-20 auto-detect. It may '
              'embed a read-only key — it is stored in settings and never logged.',
              style: TextStyle(color: Bk.muted, fontSize: 11)),
          if (_error != null) ...[
            const SizedBox(height: 14),
            Text(_error!, style: const TextStyle(color: Bk.bad)),
          ],
          if (_warn != null) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Bk.accent.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Bk.accent.withValues(alpha: 0.4)),
              ),
              child: Text(_warn!,
                  style: const TextStyle(fontSize: 12)),
            ),
          ],
          const SizedBox(height: 22),
          if (_warn == null)
            FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      height: 22,
                      width: 22,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(_isEdit ? 'Save network' : 'Add network'),
            )
          else
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Done'),
            ),
        ],
      ),
    );
  }
}

/// Hosts the MoonPay hosted buy widget in an in-app webview (mobile/desktop).
/// MoonPay runs the entire KYC + card/bank payment flow inside this webview and
/// delivers the purchased crypto to the wallet address baked into the URL — the
/// wallet itself never sees card numbers or PII.
class MoonPayBuyScreen extends StatelessWidget {
  const MoonPayBuyScreen(
      {super.key, required this.url, required this.assetLabel});
  final String url;
  final String assetLabel;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Buy $assetLabel with card')),
      body: InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri(url)),
        initialSettings: InAppWebViewSettings(
          javaScriptEnabled: true,
          // MoonPay's card flow may hand off to the bank's 3-D Secure page.
          useOnLoadResource: false,
        ),
      ),
    );
  }
}

/// Hosts the MoonPay hosted SELL (off-ramp) widget in an in-app webview
/// (mobile/desktop). MoonPay runs the entire KYC + payout flow inside this
/// webview: it shows the user a deposit address to send the crypto to and pays
/// fiat out to their bank — this wallet never handles PII or banking details.
class MoonPaySellScreen extends StatelessWidget {
  const MoonPaySellScreen(
      {super.key, required this.url, required this.assetLabel});
  final String url;
  final String assetLabel;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Sell $assetLabel for cash')),
      body: InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri(url)),
        initialSettings: InAppWebViewSettings(
          javaScriptEnabled: true,
          useOnLoadResource: false,
        ),
      ),
    );
  }
}
