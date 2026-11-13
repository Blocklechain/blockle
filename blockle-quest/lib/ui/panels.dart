import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../economy/economy.dart';
import '../game/blocklings_game.dart';
import '../models/blockling.dart';
import '../models/item.dart';
import '../theme.dart';

final _econ = EconomyService.instance;

Future<void> _open(Uri url) async {
  try {
    await launchUrl(url, mode: LaunchMode.externalApplication);
  } catch (_) {/* no-op if no handler */}
}

/// The item's AI-generated sprite (assets/items/<catalogIndex>.png), with a
/// rarity-tinted fallback for items not yet generated.
class ItemSprite extends StatelessWidget {
  final Item item;
  final double size;
  const ItemSprite(this.item, {super.key, this.size = 52});
  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Image.asset(
          'assets/items/${item.catalogIndex}.png',
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => Container(
            width: size,
            height: size,
            color: item.rarityColor.withValues(alpha: 0.22),
            alignment: Alignment.center,
            child: Text(item.slot.label[0],
                style: TextStyle(color: item.rarityColor, fontWeight: FontWeight.w800)),
          ),
        ),
      );
}

/// Shared sheet chrome: dim background, titled card, close button that resumes.
class _Panel extends StatelessWidget {
  final String title;
  final Widget child;
  final BlocklingsGame? game;
  const _Panel({required this.title, required this.child, this.game});

  @override
  Widget build(BuildContext context) {
    void close() {
      final g = game;
      if (g != null) {
        for (final name in const ['inventory', 'wallet', 'market']) {
          g.overlays.remove(name);
        }
        g.resumeEngine();
      }
    }

    return Material(
      color: Colors.black.withValues(alpha: 0.6),
      child: SafeArea(
        child: Center(
          child: Container(
            constraints: const BoxConstraints(maxWidth: 440, maxHeight: 620),
            margin: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: Bq.panel, borderRadius: BorderRadius.circular(18)),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
                  child: Row(children: [
                    Text(title, style: const TextStyle(color: Bq.text, fontSize: 18, fontWeight: FontWeight.w800)),
                    const Spacer(),
                    IconButton(onPressed: close, icon: const Icon(Icons.close, color: Bq.dim)),
                  ]),
                ),
                Expanded(child: child),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ---- Inventory -------------------------------------------------------------
class InventoryPanel extends StatefulWidget {
  final BlocklingsGame game;
  const InventoryPanel({super.key, required this.game});
  @override
  State<InventoryPanel> createState() => _InventoryPanelState();
}

class _InventoryPanelState extends State<InventoryPanel> {
  @override
  Widget build(BuildContext context) {
    return _Panel(
      title: 'Bag',
      game: widget.game,
      child: AnimatedBuilder(
        animation: _econ,
        builder: (_, __) {
          final items = _econ.items;
          return ListView(
            padding: const EdgeInsets.all(12),
            children: [
              if (_econ.blocklings.isNotEmpty) ...[
                const _SectionLabel('Blocklings'),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [for (final b in _econ.blocklings) _blockling(b)],
                ),
                const SizedBox(height: 14),
              ],
              _SectionLabel('Items (${items.length})'),
              if (items.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('Defeat Blocklings to find gear.', style: TextStyle(color: Bq.dim)),
                ),
              GridView.count(
                crossAxisCount: 5,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 8,
                crossAxisSpacing: 8,
                children: [
                  for (final it in items)
                    GestureDetector(
                      onTap: () => _itemSheet(it),
                      child: Stack(children: [
                        ItemSprite(it, size: 60),
                        if (_econ.isEquipped(it))
                          const Positioned(right: 2, top: 2, child: Icon(Icons.check_circle, size: 14, color: Bq.hpGood)),
                        if (it.minted)
                          const Positioned(left: 2, bottom: 2, child: Icon(Icons.verified, size: 13, color: Bq.accent2)),
                      ]),
                    ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _blockling(Blockling b) => Container(
        width: 96,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(color: Bq.panel2, borderRadius: BorderRadius.circular(10)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(width: 18, height: 18, decoration: BoxDecoration(color: b.element.color, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Expanded(child: Text(b.name, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Bq.text, fontSize: 12, fontWeight: FontWeight.w700))),
          ]),
          const SizedBox(height: 4),
          Text('Lv ${b.level} · ${b.rarityName}${b.shiny ? ' ✦' : ''}', style: TextStyle(color: b.rarityColor, fontSize: 10)),
          const SizedBox(height: 6),
          _miniBtn(b.minted ? 'List' : 'Mint', () => b.minted ? _listBlockling(b) : _mintBlockling(b)),
        ]),
      );

  Widget _miniBtn(String t, VoidCallback f) => SizedBox(
        height: 26,
        child: FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Bq.accent, padding: const EdgeInsets.symmetric(horizontal: 10), minimumSize: const Size(0, 26)),
          onPressed: f,
          child: Text(t, style: const TextStyle(fontSize: 11)),
        ),
      );

  void _itemSheet(Item it) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Bq.panel2,
      builder: (_) => Padding(
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ItemSprite(it, size: 64),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(it.name, style: const TextStyle(color: Bq.text, fontWeight: FontWeight.w700)),
                Text('${it.rarityName} · ${it.slot.label}', style: TextStyle(color: it.rarityColor, fontSize: 12)),
                Text('ATK ${it.atk}  DEF ${it.def}  HP ${it.hp}  ·  ${it.valueBlock.toStringAsFixed(1)} BLOCK',
                    style: const TextStyle(color: Bq.dim, fontSize: 11)),
              ]),
            ),
          ]),
          const SizedBox(height: 14),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (it.slot == Slot.consumable)
              _act('Use', () {
                final heal = _econ.useConsumable(it);
                widget.game.player.heal(heal);
                Navigator.pop(context);
                setState(() {});
              })
            else if (_econ.canEquip(it))
              _act(_econ.isEquipped(it) ? 'Unequip' : 'Equip', () {
                _econ.isEquipped(it) ? _econ.unequip(it.slot) : _econ.equip(it);
                Navigator.pop(context);
                setState(() {});
              }),
            if (!it.minted) _act('Mint NFT', () { Navigator.pop(context); _mintItem(it); }),
            if (it.minted) _act('List on market', () { Navigator.pop(context); _listItem(it); }),
          ]),
        ]),
      ),
    );
  }

  Widget _act(String t, VoidCallback f) => FilledButton(
        style: FilledButton.styleFrom(backgroundColor: Bq.accent),
        onPressed: f,
        child: Text(t),
      );

  Future<void> _mintItem(Item it) async {
    final chain = await _pickChain('Mint on which chain?');
    if (chain == null) return;
    final intent = _econ.mintItem(it, chain);
    await _open(intent.url); // wallet signs (non-custodial)
    // Demo: reflect the mint locally; production confirms via the wallet callback.
    _econ.confirmItemMint(it, 'local-${it.catalogIndex}');
    if (mounted) setState(() {});
  }

  Future<void> _mintBlockling(Blockling b) async {
    final chain = await _pickChain('Mint on which chain?');
    if (chain == null) return;
    final intent = _econ.mintBlockling(b, chain);
    await _open(intent.url);
    _econ.confirmBlocklingMint(b, 'local-${b.seed.hashCode}');
    if (mounted) setState(() {});
  }

  Future<void> _listItem(Item it) async {
    final price = await _askPrice(it.valueBlock);
    if (price == null) return;
    final err = _econ.listItem(it, price, Chain.values.byName(it.nftChain ?? 'blockle'));
    _snack(err ?? 'Listed ${it.name} for $price BLOCK');
    setState(() {});
  }

  Future<void> _listBlockling(Blockling b) async {
    final price = await _askPrice((b.powerScore / 3).roundToDouble());
    if (price == null) return;
    final err = _econ.listBlockling(b, price, Chain.values.byName(b.nftChain ?? 'blockle'));
    _snack(err ?? 'Listed ${b.name} for $price BLOCK');
    setState(() {});
  }

  Future<Chain?> _pickChain(String title) => showDialog<Chain>(
        context: context,
        builder: (_) => SimpleDialog(
          backgroundColor: Bq.panel2,
          title: Text(title, style: const TextStyle(color: Bq.text, fontSize: 15)),
          children: [
            for (final c in EconomyService.kMintChains)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(context, c),
                child: Row(children: [
                  Container(width: 12, height: 12, decoration: BoxDecoration(color: c.color, shape: BoxShape.circle)),
                  const SizedBox(width: 10),
                  Text(c.label, style: const TextStyle(color: Bq.text)),
                ]),
              ),
          ],
        ),
      );

  Future<double?> _askPrice(double suggested) async {
    final ctrl = TextEditingController(text: suggested.toStringAsFixed(1));
    return showDialog<double>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bq.panel2,
        title: const Text('List price (BLOCK)', style: TextStyle(color: Bq.text, fontSize: 16)),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          style: const TextStyle(color: Bq.text),
          decoration: const InputDecoration(prefixText: 'BLOCK '),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(context, double.tryParse(ctrl.text) ?? suggested),
            child: const Text('List'),
          ),
        ],
      ),
    );
  }

  void _snack(String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 4),
        child: Text(text.toUpperCase(),
            style: const TextStyle(color: Bq.dim, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1)),
      );
}

// ---- Wallet ---------------------------------------------------------------
class WalletPanel extends StatelessWidget {
  final BlocklingsGame game;
  const WalletPanel({super.key, required this.game});
  @override
  Widget build(BuildContext context) => _Panel(
        title: 'Wallet',
        game: game,
        child: AnimatedBuilder(
          animation: _econ,
          builder: (_, __) => ListView(
            padding: const EdgeInsets.all(14),
            children: [
              for (final c in EconomyService.kCurrencies)
                Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(color: Bq.panel2, borderRadius: BorderRadius.circular(12)),
                  child: Column(children: [
                    Row(children: [
                      Container(width: 14, height: 14, decoration: BoxDecoration(color: c.color, shape: BoxShape.circle)),
                      const SizedBox(width: 8),
                      Text(c.label, style: const TextStyle(color: Bq.text, fontWeight: FontWeight.w700)),
                      const Spacer(),
                      Text('${_econ.balance(c).toStringAsFixed(4)} ${c.symbol}',
                          style: const TextStyle(color: Bq.text, fontWeight: FontWeight.w700)),
                    ]),
                    const SizedBox(height: 10),
                    Row(children: [
                      _wbtn('Buy', () => _open(_econ.moonpayBuy(c))),
                      const SizedBox(width: 8),
                      _wbtn('Sell', () => _open(_econ.moonpaySell(c))),
                      const SizedBox(width: 8),
                      _wbtn('Swap', () => _open(_econ.liquiditySwap(to: c))),
                    ]),
                  ]),
                ),
              const SizedBox(height: 6),
              const Text('Buy/Sell via MoonPay and Swap via Blockle Liquidity open your non-custodial Blockle wallet.',
                  style: TextStyle(color: Bq.dim, fontSize: 11)),
            ],
          ),
        ),
      );

  Widget _wbtn(String t, VoidCallback f) => Expanded(
        child: FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Bq.accent, padding: const EdgeInsets.symmetric(vertical: 10)),
          onPressed: f,
          child: Text(t),
        ),
      );
}

// ---- Marketplace ----------------------------------------------------------
class MarketPanel extends StatefulWidget {
  final BlocklingsGame game;
  const MarketPanel({super.key, required this.game});
  @override
  State<MarketPanel> createState() => _MarketPanelState();
}

class _MarketPanelState extends State<MarketPanel> {
  @override
  Widget build(BuildContext context) => _Panel(
        title: 'NFT Market',
        game: widget.game,
        child: AnimatedBuilder(
          animation: _econ,
          builder: (_, __) => ListView(
            padding: const EdgeInsets.all(12),
            children: [
              const _SectionLabel('Listings'),
              const Text('Only minted NFTs trade here — on Blockle, Ethereum or Solana.',
                  style: TextStyle(color: Bq.dim, fontSize: 11)),
              const SizedBox(height: 8),
              for (final l in _econ.market) _listingRow(l),
            ],
          ),
        ),
      );

  Widget _listingRow(Listing l) => Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: Bq.panel2, borderRadius: BorderRadius.circular(10)),
        child: Row(children: [
          if (l.item != null) ItemSprite(l.item!, size: 44)
          else Container(width: 44, height: 44, decoration: BoxDecoration(color: (l.blockling?.rarityColor ?? Bq.accent).withValues(alpha: 0.25), borderRadius: BorderRadius.circular(8)), child: const Icon(Icons.pets, color: Bq.accent, size: 20)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(l.title, style: const TextStyle(color: Bq.text, fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
              Row(children: [
                Container(width: 8, height: 8, decoration: BoxDecoration(color: l.chain.color, shape: BoxShape.circle)),
                const SizedBox(width: 5),
                Text('${l.chain.symbol} · ${l.rarity} · @${l.seller}', style: const TextStyle(color: Bq.dim, fontSize: 11)),
              ]),
            ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('${l.priceBlock.toStringAsFixed(1)} BLOCK', style: const TextStyle(color: Bq.text, fontSize: 12, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            l.mine
                ? _smallBtn('Cancel', Bq.panel, () { _econ.cancelListing(l); setState(() {}); })
                : _smallBtn('Buy', Bq.accent, () {
                    final err = _econ.buyListing(l);
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err ?? 'Bought ${l.title}')));
                    setState(() {});
                  }),
          ]),
        ]),
      );

  Widget _smallBtn(String t, Color bg, VoidCallback f) => SizedBox(
        height: 28,
        child: FilledButton(
          style: FilledButton.styleFrom(backgroundColor: bg, padding: const EdgeInsets.symmetric(horizontal: 12), minimumSize: const Size(0, 28)),
          onPressed: f,
          child: Text(t, style: const TextStyle(fontSize: 11)),
        ),
      );
}
