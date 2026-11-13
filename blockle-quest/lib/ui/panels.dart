import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../account/account_service.dart';
import '../economy/economy.dart';
import '../game/blocklings_game.dart';
import '../models/blockling.dart';
import '../models/item.dart';
import '../quests/quests.dart';
import '../skills/skills.dart';
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
        for (final name in const ['inventory', 'wallet', 'market', 'skills', 'quests']) {
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
    QuestLog.instance.onMint();
    SkillsState.instance.addXp('Blockchain', 50);
    if (mounted) setState(() {});
  }

  Future<void> _mintBlockling(Blockling b) async {
    final chain = await _pickChain('Mint on which chain?');
    if (chain == null) return;
    final intent = _econ.mintBlockling(b, chain);
    await _open(intent.url);
    _econ.confirmBlocklingMint(b, 'local-${b.seed.hashCode}');
    QuestLog.instance.onMint();
    SkillsState.instance.addXp('Blockchain', 50);
    if (mounted) setState(() {});
  }

  Future<void> _listItem(Item it) async {
    final price = await _askPrice(it.valueBlock);
    if (price == null) return;
    final err = _econ.listItem(it, price, Chain.values.byName(it.nftChain ?? 'blockle'));
    if (err == null) QuestLog.instance.onTrade();
    _snack(err ?? 'Listed ${it.name} for $price BLOCK');
    setState(() {});
  }

  Future<void> _listBlockling(Blockling b) async {
    final price = await _askPrice((b.powerScore / 3).roundToDouble());
    if (price == null) return;
    final err = _econ.listBlockling(b, price, Chain.values.byName(b.nftChain ?? 'blockle'));
    if (err == null) QuestLog.instance.onTrade();
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
              _accountCard(context),
              const SizedBox(height: 12),
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

// ---- Shared Blockle account (SSO) -----------------------------------------
Widget _accountCard(BuildContext context) {
  final acc = AccountService.instance;
  return AnimatedBuilder(
    animation: acc,
    builder: (_, __) {
      final tierLabel = acc.tier == 'free' ? 'Free' : (acc.tier == 'copilot' ? 'Blockle Alien' : 'Blockle Alien Pro');
      return Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          gradient: const LinearGradient(colors: [Bq.panel2, Bq.panel]),
          border: Border.all(color: Bq.accent.withValues(alpha: 0.4)),
        ),
        child: Row(children: [
          const Icon(Icons.account_circle, color: Bq.accent, size: 34),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(acc.signedIn ? (acc.handle ?? 'Blockle account') : 'Not signed in',
                  style: const TextStyle(color: Bq.text, fontWeight: FontWeight.w700)),
              Text(acc.signedIn ? 'Blockle account · $tierLabel' : 'One account for wallet, game & economy',
                  style: const TextStyle(color: Bq.dim, fontSize: 11)),
            ]),
          ),
          acc.signedIn
              ? TextButton(onPressed: acc.signOut, child: const Text('Sign out'))
              : FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: Bq.accent),
                  onPressed: () => _signInDialog(context),
                  child: const Text('Sign in'),
                ),
        ]),
      );
    },
  );
}

Future<void> _signInDialog(BuildContext context) async {
  final email = TextEditingController();
  final pass = TextEditingController();
  final totp = TextEditingController();
  var creating = false;
  var busy = false;
  String? error;

  await showDialog<void>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setLocal) {
        Future<void> submit() async {
          setLocal(() { busy = true; error = null; });
          try {
            if (creating) {
              final msg = await AccountService.instance.register(email.text.trim(), pass.text, username: email.text.split('@').first);
              if (ctx.mounted) {
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
              }
            } else {
              await AccountService.instance.signIn(email.text.trim(), pass.text, totp: totp.text.trim());
              if (ctx.mounted) Navigator.pop(ctx);
            }
          } catch (e) {
            setLocal(() { error = e.toString().replaceFirst('Exception: ', ''); busy = false; });
          }
        }

        return AlertDialog(
          backgroundColor: Bq.panel2,
          title: Text(creating ? 'Create Blockle account' : 'Sign in with Blockle', style: const TextStyle(color: Bq.text, fontSize: 17)),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: email, keyboardType: TextInputType.emailAddress, style: const TextStyle(color: Bq.text), decoration: const InputDecoration(labelText: 'Email')),
            TextField(controller: pass, obscureText: true, style: const TextStyle(color: Bq.text), decoration: const InputDecoration(labelText: 'Password')),
            if (!creating)
              TextField(controller: totp, keyboardType: TextInputType.number, style: const TextStyle(color: Bq.text), decoration: const InputDecoration(labelText: '2FA code (if enabled)')),
            if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: Bq.hpBad, fontSize: 12))),
          ]),
          actions: [
            TextButton(onPressed: busy ? null : () => setLocal(() => creating = !creating), child: Text(creating ? 'Have an account?' : 'Create account')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Bq.accent),
              onPressed: busy ? null : submit,
              child: busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : Text(creating ? 'Create' : 'Sign in'),
            ),
          ],
        );
      },
    ),
  );
}

// ---- Skills (RuneScape-style) ---------------------------------------------
class SkillsPanel extends StatelessWidget {
  final BlocklingsGame game;
  const SkillsPanel({super.key, required this.game});

  @override
  Widget build(BuildContext context) {
    final st = SkillsState.instance;
    return _Panel(
      title: 'Skills · total ${st.totalLevel}',
      game: game,
      child: AnimatedBuilder(
        animation: st,
        builder: (_, __) => GridView.count(
          crossAxisCount: 3,
          padding: const EdgeInsets.all(12),
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          childAspectRatio: 1.9,
          children: [
            for (var i = 0; i < kSkills.length; i++)
              GestureDetector(
                onTap: () => _tree(context, i),
                child: Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: Bq.panel2, borderRadius: BorderRadius.circular(10)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
                    Row(children: [
                      Container(width: 10, height: 10, decoration: BoxDecoration(color: kSkills[i].color, shape: BoxShape.circle)),
                      const SizedBox(width: 5),
                      Expanded(child: Text(kSkills[i].name, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Bq.text, fontSize: 12, fontWeight: FontWeight.w700))),
                      Text('${st.level(i)}', style: const TextStyle(color: Bq.text, fontSize: 13, fontWeight: FontWeight.w800)),
                    ]),
                    const SizedBox(height: 6),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(4),
                      child: LinearProgressIndicator(value: st.progress(i), minHeight: 5, backgroundColor: Bq.bg, color: kSkills[i].color),
                    ),
                  ]),
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _tree(BuildContext context, int i) {
    final s = kSkills[i];
    final lvl = SkillsState.instance.level(i);
    showModalBottomSheet(
      context: context,
      backgroundColor: Bq.panel2,
      builder: (_) => ListView(
        padding: const EdgeInsets.all(16),
        shrinkWrap: true,
        children: [
          Text('${s.name} — Lv $lvl', style: const TextStyle(color: Bq.text, fontSize: 16, fontWeight: FontWeight.w800)),
          const SizedBox(height: 10),
          for (final a in s.tree)
            Opacity(
              opacity: lvl >= a.level ? 1 : 0.45,
              child: Row(children: [
                Icon(lvl >= a.level ? Icons.lock_open : Icons.lock, size: 15, color: lvl >= a.level ? s.color : Bq.dim),
                const SizedBox(width: 8),
                Expanded(child: Text(a.name, style: const TextStyle(color: Bq.text))),
                Text('Lv ${a.level}', style: const TextStyle(color: Bq.dim, fontSize: 12)),
              ]),
            ),
        ],
      ),
    );
  }
}

// ---- Quests ---------------------------------------------------------------
class QuestsPanel extends StatelessWidget {
  final BlocklingsGame game;
  const QuestsPanel({super.key, required this.game});

  @override
  Widget build(BuildContext context) {
    final log = QuestLog.instance;
    return _Panel(
      title: 'Quests · ${log.completedCount}/${log.quests.length}',
      game: game,
      child: AnimatedBuilder(
        animation: log,
        builder: (_, __) {
          final active = log.active.toList();
          return ListView(
            padding: const EdgeInsets.all(12),
            children: [
              const _SectionLabel('Active'),
              for (final q in active)
                Container(
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: Bq.panel2, borderRadius: BorderRadius.circular(10)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text(q.title, style: const TextStyle(color: Bq.text, fontWeight: FontWeight.w700))),
                      Text('+${q.rewardBlock} BLOCK', style: const TextStyle(color: Bq.accent2, fontSize: 11, fontWeight: FontWeight.w700)),
                    ]),
                    Text(q.desc, style: const TextStyle(color: Bq.dim, fontSize: 11)),
                    const SizedBox(height: 6),
                    Row(children: [
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: LinearProgressIndicator(value: q.frac, minHeight: 5, backgroundColor: Bq.bg, color: Bq.accent),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text('${q.progress}/${q.target}', style: const TextStyle(color: Bq.dim, fontSize: 11)),
                    ]),
                  ]),
                ),
            ],
          );
        },
      ),
    );
  }
}
