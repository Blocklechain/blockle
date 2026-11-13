import 'package:flutter/material.dart';

import '../models/blockling.dart';
import '../models/item.dart';

/// Chains the in-game economy spans. BLOCK is the native game currency; the
/// others are first-class because items/Blocklings can be minted as NFTs on the
/// player's chosen chain and bought/sold via MoonPay.
enum Chain { blockle, ethereum, solana, bnb, polygon, tron, ton, bitcoin }

extension ChainX on Chain {
  String get symbol => switch (this) {
        Chain.blockle => 'BLOCK',
        Chain.ethereum => 'ETH',
        Chain.solana => 'SOL',
        Chain.bnb => 'BNB',
        Chain.polygon => 'POL',
        Chain.tron => 'TRX',
        Chain.ton => 'TON',
        Chain.bitcoin => 'BTC',
      };
  String get label => switch (this) {
        Chain.blockle => 'Blockle',
        Chain.ethereum => 'Ethereum',
        Chain.solana => 'Solana',
        Chain.bnb => 'BNB Chain',
        Chain.polygon => 'Polygon',
        Chain.tron => 'Tron',
        Chain.ton => 'TON',
        Chain.bitcoin => 'Bitcoin',
      };
  Color get color => switch (this) {
        Chain.blockle => const Color(0xFF7C5CFF),
        Chain.ethereum => const Color(0xFF8A92B2),
        Chain.solana => const Color(0xFF14F195),
        Chain.bnb => const Color(0xFFF3BA2F),
        Chain.polygon => const Color(0xFF8247E5),
        Chain.tron => const Color(0xFFEB0029),
        Chain.ton => const Color(0xFF0098EA),
        Chain.bitcoin => const Color(0xFFF7931A),
      };
}

/// A minting intent handed to the wallet. The game NEVER holds keys — minting an
/// item/Blockling as an NFT opens the Blockle wallet, which signs + broadcasts;
/// the game records the result when the wallet returns.
class MintIntent {
  final String kind; // 'item' | 'blockling'
  final String name;
  final Chain chain;
  final Uri url;
  const MintIntent({required this.kind, required this.name, required this.chain, required this.url});
}

/// A marketplace listing. Only NFTs trade here — you must mint an item/Blockling
/// before it can be listed — and only on the three marketplace chains.
class Listing {
  final String id;
  final String seller; // 'you' or another player's handle
  final Chain chain; // one of EconomyService.kMintChains
  final double priceBlock;
  final Item? item;
  final Blockling? blockling;
  Listing({
    required this.id,
    required this.seller,
    required this.chain,
    required this.priceBlock,
    this.item,
    this.blockling,
  });
  bool get mine => seller == 'you';
  String get title => item?.name ?? blockling?.name ?? 'NFT';
  String get rarity => item?.rarityName ?? blockling?.rarityName ?? '';
}

/// The single hub for everything crypto in Blocklings: a multi-chain wallet,
/// MoonPay buy/sell/convert, Blockle Liquidity swaps, the owned item + Blockling
/// inventory, and per-chain NFT minting. Non-custodial: on-chain actions
/// deep-link to the Blockle wallet at [origin].
class EconomyService extends ChangeNotifier {
  EconomyService._();
  static final EconomyService instance = EconomyService._();

  /// The only currencies in the game, and the only chains an item/Blockling can
  /// be minted + traded on: Blockle, Ethereum, Solana.
  static const List<Chain> kCurrencies = [Chain.blockle, Chain.ethereum, Chain.solana];
  static const List<Chain> kMintChains = kCurrencies;

  /// Blockle account/wallet origin the deep-links target.
  String origin = 'https://blockle.org';

  /// The in-app NFT marketplace listings (yours + other players').
  final List<Listing> market = [];
  int _listingSeq = 0;

  // ---- On-chain settlement round-trip ---------------------------------- //
  // Real mints / vendor payments deep-link to the non-custodial wallet, which
  // signs + broadcasts and then calls back via blocklings://settle?req=…&status=
  // ok&tx=…&nftId=…. Each request registers a confirm callback keyed by req id.
  static const String callbackScheme = 'blocklings';
  int _reqSeq = 0;
  final Map<String, void Function(Map<String, String> q)> _pending = {};

  String _newReq(String kind, void Function(Map<String, String>) onConfirm) {
    final req = '$kind${_reqSeq++}';
    _pending[req] = onConfirm;
    return req;
  }

  Uri _settleReturn(String req) => Uri.parse('$callbackScheme://settle?req=$req');

  /// Called by the deep-link handler with the wallet's settlement result.
  void onSettlement(Uri uri) {
    final q = uri.queryParameters;
    final req = q['req'];
    if (req == null) return;
    _pending.remove(req)?.call(q);
  }

  /// Number of settlements awaiting a wallet callback (for a "pending" badge).
  int get pendingCount => _pending.length;

  final Map<Chain, double> balances = {
    for (final c in Chain.values) c: 0.0,
  };

  final List<Item> items = [];
  final List<Blockling> blocklings = [];

  /// Currently equipped gear by slot (consumables/materials are never equipped).
  final Map<Slot, Item> equipped = {};

  bool _seeded = false;

  // ---- equipment + usability ------------------------------------------- //
  bool isEquipped(Item i) => equipped[i.slot] == i;

  bool canEquip(Item i) => !(i.slot == Slot.consumable || i.slot == Slot.material);

  /// Equip an item (swapping out whatever occupied the slot). Equipment stays in
  /// [items]; [equipped] just references it.
  void equip(Item i) {
    if (!canEquip(i)) return;
    equipped[i.slot] = i;
    notifyListeners();
  }

  void unequip(Slot s) {
    equipped.remove(s);
    notifyListeners();
  }

  /// Consume a consumable; returns the HP it restores (0 if not usable). Removes
  /// one from the inventory. The caller applies the heal to the player.
  int useConsumable(Item i) {
    if (i.slot != Slot.consumable) return 0;
    final heal = i.hp;
    items.remove(i);
    equipped.removeWhere((_, v) => v == i);
    notifyListeners();
    return heal;
  }

  int get bonusAtk => equipped.values.fold(0, (a, i) => a + i.atk);
  int get bonusDef => equipped.values.fold(0, (a, i) => a + i.def);
  int get bonusHp => equipped.values.fold(0, (a, i) => a + i.hp);

  /// Fresh save: a new account starts with ZERO of every currency — balances
  /// reflect what you've actually earned (or hold in your linked wallet), never
  /// a phantom gift.
  void seed() {
    if (_seeded) return;
    _seeded = true;
    // no starting funds
  }

  double balance(Chain c) => balances[c] ?? 0.0;

  void credit(Chain c, double amount) {
    balances[c] = balance(c) + amount;
    notifyListeners();
  }

  bool debit(Chain c, double amount) {
    if (balance(c) < amount) return false;
    balances[c] = balance(c) - amount;
    notifyListeners();
    return true;
  }

  void addItem(Item i) {
    items.add(i);
    notifyListeners();
  }

  void addBlockling(Blockling b) {
    blocklings.add(b);
    notifyListeners();
  }

  // ---- MoonPay (buy / sell off-ramp / convert) -------------------------- //
  // These open the real wallet's MoonPay flow (KYC, geofencing, signing all live
  // there). The game only hands off the intent.
  Uri moonpayBuy(Chain c) => _wallet({'action': 'buy', 'chain': c.name});
  Uri moonpaySell(Chain c) => _wallet({'action': 'sell', 'chain': c.name}); // off-ramp
  Uri moonpayConvert(Chain from, Chain to) =>
      _wallet({'action': 'convert', 'from': from.name, 'to': to.name});

  // ---- Blockle Liquidity (BLOCK <-> coin bonding-curve swap) ------------- //
  Uri liquiditySwap({Chain to = Chain.solana}) =>
      _wallet({'action': 'liquidity', 'to': to.name});

  // ---- Per-chain NFT minting (Blockle / Ethereum / Solana only) --------- //
  MintIntent mintItem(Item item, Chain chain) {
    if (!kMintChains.contains(chain)) chain = Chain.blockle;
    item.nftChain = chain.name; // pending until the wallet confirms
    final req = _newReq('mint', (q) {
      if (q['status'] == 'ok') {
        item.nftId = q['nftId'] ?? q['tx'] ?? 'onchain';
        notifyListeners();
      }
    });
    notifyListeners();
    final url = _wallet({
      'action': 'mint',
      'kind': 'item',
      'chain': chain.name,
      'name': item.name,
      'rarity': item.rarityName,
      'cat': item.catalogIndex.toString(),
      'req': req,
      'return': _settleReturn(req).toString(),
    });
    return MintIntent(kind: 'item', name: item.name, chain: chain, url: url);
  }

  MintIntent mintBlockling(Blockling b, Chain chain) {
    if (!kMintChains.contains(chain)) chain = Chain.blockle;
    b.nftChain = chain.name;
    final req = _newReq('mint', (q) {
      if (q['status'] == 'ok') {
        b.nftId = q['nftId'] ?? q['tx'] ?? 'onchain';
        notifyListeners();
      }
    });
    notifyListeners();
    final url = _wallet({
      'action': 'mint',
      'kind': 'blockling',
      'chain': chain.name,
      'name': b.name,
      'seed': b.seed,
      'rarity': b.rarityName,
      'req': req,
      'return': _settleReturn(req).toString(),
    });
    return MintIntent(kind: 'blockling', name: b.name, chain: chain, url: url);
  }

  /// Called when the wallet returns a confirmed mint (via deep-link callback).
  void confirmItemMint(Item item, String nftId) {
    item.nftId = nftId;
    notifyListeners();
  }

  void confirmBlocklingMint(Blockling b, String nftId) {
    b.nftId = nftId;
    notifyListeners();
  }

  // ---- Marketplace (mint-to-trade; the ONLY way to trade) --------------- //
  // You can only list an item/Blockling that has been minted as an NFT, and only
  // on Blockle/Ethereum/Solana. Settlement is non-custodial — a buy opens the
  // wallet to pay; the local state mirrors the result.

  /// Seed the market with other players' listings so it isn't empty.
  void seedMarket() {
    if (market.isNotEmpty) return;
    const handles = ['astra', 'gwei_goblin', 'solflare', 'blocksmith', 'nyx'];
    for (var i = 0; i < 12; i++) {
      final chain = kMintChains[i % kMintChains.length];
      if (i.isEven) {
        final it = Item.at(i * 937 + 11);
        it.nftId = 'seed-$i';
        it.nftChain = chain.name;
        market.add(Listing(
          id: 'm${_listingSeq++}', seller: handles[i % handles.length],
          chain: chain, priceBlock: (it.valueBlock * 1.3).roundToDouble(), item: it));
      } else {
        final b = Blockling.fromSeed('market:$i');
        b.nftId = 'seed-$i';
        b.nftChain = chain.name;
        market.add(Listing(
          id: 'm${_listingSeq++}', seller: handles[i % handles.length],
          chain: chain, priceBlock: (b.powerScore / 3).roundToDouble(), blockling: b));
      }
    }
    notifyListeners();
  }

  /// List an owned item. Returns an error string if it can't be listed.
  String? listItem(Item item, double priceBlock, Chain chain) {
    if (!item.minted) return 'Mint it as an NFT first — only NFTs can be traded.';
    if (!kMintChains.contains(chain)) return 'Marketplace supports Blockle, Ethereum and Solana only.';
    items.remove(item);
    equipped.removeWhere((_, v) => v == item);
    market.add(Listing(id: 'm${_listingSeq++}', seller: 'you', chain: chain, priceBlock: priceBlock, item: item));
    notifyListeners();
    return null;
  }

  String? listBlockling(Blockling b, double priceBlock, Chain chain) {
    if (!b.minted) return 'Mint it as an NFT first — only NFTs can be traded.';
    if (!kMintChains.contains(chain)) return 'Marketplace supports Blockle, Ethereum and Solana only.';
    blocklings.remove(b);
    market.add(Listing(id: 'm${_listingSeq++}', seller: 'you', chain: chain, priceBlock: priceBlock, blockling: b));
    notifyListeners();
    return null;
  }

  /// Cancel your own listing — returns the NFT to your inventory.
  void cancelListing(Listing l) {
    if (!l.mine) return;
    market.remove(l);
    if (l.item != null) items.add(l.item!);
    if (l.blockling != null) blocklings.add(l.blockling!);
    notifyListeners();
  }

  /// Buy a listing. Price is paid in the listing's chain currency. Returns an
  /// error string on insufficient funds. (Non-custodial settlement deep-links to
  /// the wallet in the UI; this mirrors ownership locally.)
  String? buyListing(Listing l) {
    if (l.mine) return 'This is your own listing.';
    if (!debit(l.chain, l.priceBlock)) {
      return 'Not enough ${l.chain.symbol}. Buy more with MoonPay or swap via Liquidity.';
    }
    market.remove(l);
    if (l.item != null) items.add(l.item!);
    if (l.blockling != null) blocklings.add(l.blockling!);
    notifyListeners();
    return null;
  }

  // ---- Vendors (buy non-NFT items for crypto; revenue backs BLOCK) ------ //
  /// Dedicated per-chain treasury wallets that receive vendor crypto sales.
  /// These are YOUR wallets (you hold the keys) — set each to the real address.
  final Map<Chain, String> treasuryAddresses = {
    Chain.blockle: 'block1yyvhau7c2kwy4s60kqrysz6prf2k693kvyx94h9ve4qa8fulwy8q99vvdh',
    Chain.ethereum: '0x8f55FbeDb99389aADa2B06f12c9567552C7892F5',
    Chain.solana: 'CHxVpuE297p7YLttya8vLrxrfFNKXp8SRk4rfVd48PdM',
  };

  /// The treasury address for a given chain (falls back to the BLOCK treasury).
  String treasuryFor(Chain c) => treasuryAddresses[c] ?? treasuryAddresses[Chain.blockle]!;

  /// Share of vendor sales routed to back BLOCK via the Blockle Liquidity pool.
  static const double vendorBackingPct = 0.90;

  /// Gross vendor sales received at the treasury, per currency.
  final Map<Chain, double> treasury = {for (final c in Chain.values) c: 0.0};

  /// Amount of each currency routed into Liquidity to back BLOCK (90% of sales).
  final Map<Chain, double> blockBacking = {for (final c in Chain.values) c: 0.0};

  /// Buy an item from an in-game vendor for crypto. The item is a normal
  /// inventory item (NOT an NFT — you can mint it later). The payment goes to
  /// the treasury wallet and 90% is used to back BLOCK through Liquidity.
  ///
  /// The in-game balance is debited here; real on-chain settlement to
  /// [treasuryAddress] + the liquidity backing happen via the wallet / server
  /// (see [vendorPayUrl]) and stay non-custodial.
  String? buyFromVendor(Item item, Chain chain, double price) {
    if (!kCurrencies.contains(chain)) return 'Unsupported currency.';
    if (!debit(chain, price)) {
      return 'Not enough ${chain.symbol}. Buy more with MoonPay or swap via Liquidity.';
    }
    items.add(item); // unminted
    treasury[chain] = (treasury[chain] ?? 0) + price;
    blockBacking[chain] = (blockBacking[chain] ?? 0) + price * vendorBackingPct;
    notifyListeners();
    return null;
  }

  /// Real vendor purchase: deep-link the wallet to pay the treasury in crypto.
  /// The item is delivered and the 90% BLOCK-backing is booked only when the
  /// wallet confirms the on-chain payment (via onSettlement). Non-custodial —
  /// the wallet signs/broadcasts; the game never holds keys.
  Uri payVendor(Item item, Chain chain, double price) {
    final req = _newReq('pay', (q) {
      if (q['status'] != 'ok') return;
      items.add(item); // delivered after on-chain payment
      treasury[chain] = (treasury[chain] ?? 0) + price;
      blockBacking[chain] = (blockBacking[chain] ?? 0) + price * vendorBackingPct;
      notifyListeners();
    });
    return _wallet({
      'action': 'pay',
      'chain': chain.name,
      'amount': price.toString(),
      'to': treasuryFor(chain),
      'memo': 'blocklings-vendor',
      'cat': item.catalogIndex.toString(),
      'backing': vendorBackingPct.toString(),
      'req': req,
      'return': _settleReturn(req).toString(),
    });
  }

  Uri _wallet(Map<String, String> q) =>
      Uri.parse('$origin/wallet').replace(queryParameters: {'app': 'blocklings', ...q});
}
