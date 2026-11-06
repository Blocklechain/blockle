// widgets/chain_icon.dart — REAL brand logos for every supported chain + token.
//
// Task #136: every native coin and every default/known token renders a real
// brand MARK (inline SVG, drawn fully OFFLINE by the shared AppIcons SVG engine
// — no bundled image files, no remote fetch, CSP-safe), NOT a generated
// initial-disc. BLOCK + every BLOCK-20 token keep the Blockle mark. The colored
// monogram survives ONLY as the fallback for genuinely-unknown imported tokens.
//
// Resolution order (resolve(asset)):
//   • native coin  → kChainLogos[canonicalChainId]            (brand SVG)
//   • known token  → kTokenLogos['chain:ADDR' | 'chain:SYM' | '*:SYM']
//                    → block chain tokens default to the Blockle BLOCK-20 mark
//   • token w/ logoURI → runtime NetworkImage (graceful monogram fallback)
//   • otherwise    → colored monogram (never a broken icon)
//
// Keys match the other three wallets (extension logos.js canonical, web vendor,
// Qt logos.py): canonical chain id for natives; chain+symbol / chain+contract
// for tokens.
import 'package:flutter/material.dart';

import '../ui/app_icons.dart';

/// Brand identity for one chain: disc color, glyph text color, and the short
/// glyph. Retained for the monogram fallback color + legacy callers; the real
/// marks live in [kChainLogos].
class ChainBrand {
  const ChainBrand(this.color, this.glyph, {this.fg = Colors.white});
  final Color color;
  final String glyph;
  final Color fg;
}

/// Legacy brand-color table (keyed by registry chain id). Still the source of
/// the fallback monogram color and used by [chainBrand].
const Map<String, ChainBrand> kChainBrands = {
  'bitcoin': ChainBrand(Color(0xFFF7931A), '₿'),
  'litecoin': ChainBrand(Color(0xFF345D9D), 'Ł'),
  'dogecoin': ChainBrand(Color(0xFFC2A633), 'Ð', fg: Color(0xFF3B2F0B)),
  'bitcoincash': ChainBrand(Color(0xFF0AC18E), '₿'),
  'solana': ChainBrand(Color(0xFF9945FF), 'S'),
  'tron': ChainBrand(Color(0xFFEC0623), 'T'),
  'ton': ChainBrand(Color(0xFF0098EA), 'T'),
  'xrp': ChainBrand(Color(0xFF23292F), 'X'),
  'stellar': ChainBrand(Color(0xFF1B1B2A), '✦'),
  'tezos': ChainBrand(Color(0xFF2C7DF7), 'ꜩ'),
  'cardano': ChainBrand(Color(0xFF0033AD), '₳'),
  'ethereum': ChainBrand(Color(0xFF627EEA), '⧫'),
  'base': ChainBrand(Color(0xFF0052FF), 'B'),
  'arbitrum': ChainBrand(Color(0xFF28A0F0), 'A'),
  'optimism': ChainBrand(Color(0xFFFF0420), 'O'),
  'polygon': ChainBrand(Color(0xFF8247E5), 'P'),
  'bnb': ChainBrand(Color(0xFFF3BA2F), 'B', fg: Color(0xFF2B2300)),
  'avalanche': ChainBrand(Color(0xFFE84142), 'A'),
  'hyperliquid': ChainBrand(Color(0xFF50D2C1), 'H', fg: Color(0xFF06312C)),
  'block': ChainBrand(Color(0xFF7C5CFF), '◈'),
};

/// The brand-color for [chainId], or null for an unknown / custom network.
ChainBrand? chainBrand(String chainId) => kChainBrands[canonChain(chainId, null)];

// ===========================================================================
// REAL BRAND MARKS — inline SVG (0 0 24 24): a brand-colored disc + a white (or
// brand-fg) vector mark. Rendered by AppIcons.rawSvg (the shared SVG engine).
// ===========================================================================

/// One brand logo: a stable cache [key] + its inline-SVG [svg] body.
class BrandMark {
  const BrandMark(this.key, this.svg);
  final String key;
  final String svg;
}

String _disc(String hex, String body) =>
    '<circle cx="12" cy="12" r="12" fill="$hex"/>$body';

// ---- native-coin marks ----------------------------------------------------
const String _mBtc =
    '<path d="M9 6.8h4.3a2.7 2.7 0 010 5.4H9zM9 12.1h4.7a2.7 2.7 0 010 5.4H9z" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>'
    '<path d="M9 6.8v10.7" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>'
    '<path d="M10.8 5.2v1.6M10.8 17.5v1.6M12.8 5.2v1.6M12.8 17.5v1.6" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round"/>';
const String _mLtc =
    '<path d="M12.9 6l-2 7" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>'
    '<path d="M10.4 13.1l-1 3.9h5.5" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    '<path d="M8.6 12.5l4-1.5" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>';
const String _mDoge =
    '<path d="M8.6 6.5h3.2a5.5 5.5 0 010 11H8.6z" fill="none" stroke="#2b2300" stroke-width="1.7" stroke-linejoin="round"/>'
    '<path d="M6.8 12h4.6" fill="none" stroke="#2b2300" stroke-width="1.7" stroke-linecap="round"/>';
const String _mSol =
    '<path d="M8.4 8h8l-1.7 1.7h-8z" fill="#ffffff"/>'
    '<path d="M6.4 11h8l1.7 1.7h-8z" fill="#ffffff"/>'
    '<path d="M8.4 14h8l-1.7 1.7h-8z" fill="#ffffff"/>';
const String _mTron =
    '<path d="M5.5 7.5l9 1.4 2.9 3.1-7.8 6z" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/>'
    '<path d="M5.5 7.5l4.1 10.5M14.5 8.9l-4.9 9.1" fill="none" stroke="#ffffff" stroke-width="1.1" stroke-linejoin="round"/>';
const String _mTon =
    '<path d="M6.3 8.8h11.4l-5.7 8.4z" fill="#ffffff"/>'
    '<path d="M12 8.8v8.4M9 8.8l3 8.4 3-8.4" fill="none" stroke="#0098ea" stroke-width="1.1" stroke-linejoin="round"/>';
const String _mXrp =
    '<path d="M6.5 7.5l3.8 3.9a2.4 2.4 0 003.4 0l3.8-3.9" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    '<path d="M6.5 16.5l3.8-3.9a2.4 2.4 0 013.4 0l3.8 3.9" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
const String _mXlm =
    '<path d="M12 5c2.2 1.6 3.4 4.1 3.4 7L12 14.6 8.6 12C8.6 9.1 9.8 6.6 12 5z" fill="#ffffff"/>'
    '<circle cx="12" cy="10.2" r="1.2" fill="#1b1b2a"/>'
    '<path d="M9.2 13.6L7.7 17M14.8 13.6L16.3 17" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round"/>';
const String _mXtz =
    '<path d="M9.2 9.3h5.6M12 6v9.2a1.9 1.9 0 002 1.9" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    '<path d="M10 6.2h4" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>';
const String _mAda =
    '<circle cx="12" cy="12" r="2" fill="#ffffff"/>'
    '<circle cx="12" cy="6.4" r="1.1" fill="#ffffff"/><circle cx="12" cy="17.6" r="1.1" fill="#ffffff"/>'
    '<circle cx="7.1" cy="9.2" r="1.1" fill="#ffffff"/><circle cx="16.9" cy="9.2" r="1.1" fill="#ffffff"/>'
    '<circle cx="7.1" cy="14.8" r="1.1" fill="#ffffff"/><circle cx="16.9" cy="14.8" r="1.1" fill="#ffffff"/>';
const String _mEth =
    '<path d="M12 3.2l5 8.4-5 2.9-5-2.9z" fill="#ffffff"/>'
    '<path d="M7 12.6l5 2.9 5-2.9-5 8.3z" fill="#ffffff" opacity="0.65"/>';
const String _mPolygon =
    '<path d="M12 5l6.1 3.5v7L12 19l-6.1-3.5v-7z" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>'
    '<path d="M12 9l3 1.7v3.6L12 16l-3-1.7v-3.6z" fill="#ffffff"/>';
const String _mAvax =
    '<path d="M12 6l-4.6 11h2.6l1-2.6h2l1 2.6h2.6z" fill="#ffffff"/>'
    '<path d="M11.2 12.3h1.6l-.8-2.1z" fill="#e84142"/>';
const String _mBnb =
    '<path d="M12 6.6l1.9 1.9L12 10.4 10.1 8.5z" fill="#2b2300"/>'
    '<path d="M8.2 10.4l1.9 1.9-1.9 1.9-1.9-1.9z" fill="#2b2300"/>'
    '<path d="M15.8 10.4l1.9 1.9-1.9 1.9-1.9-1.9z" fill="#2b2300"/>'
    '<path d="M12 13.6l1.9 1.9L12 17.4l-1.9-1.9z" fill="#2b2300"/>'
    '<path d="M12 10.3l1.7 1.7L12 13.7 10.3 12z" fill="#2b2300"/>';
const String _mHype =
    '<path d="M8.5 7v10M15.5 7v10" fill="none" stroke="#06312c" stroke-width="1.8" stroke-linecap="round"/>'
    '<path d="M8.5 12.2c2-2.4 5-2.4 7 0" fill="none" stroke="#06312c" stroke-width="1.8" stroke-linecap="round"/>';
// The Blockle mark (native BLOCK + every BLOCK-20 token).
const String _mBlock =
    '<path d="M12 5.2l6.5 3.65v7.3L12 19.8l-6.5-3.65v-7.3z" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>'
    '<path d="M12 12.4l6.5-3.9M12 12.4v7.3M12 12.4L5.5 8.5" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>';

/// Native-coin brand marks, keyed by canonical chain id. EVM L2s reuse the ETH
/// diamond on their own brand disc so they are distinguishable at a glance.
final Map<String, BrandMark> kChainLogos = {
  'bitcoin': BrandMark('brand:bitcoin', _disc('#f7931a', _mBtc)),
  'litecoin': BrandMark('brand:litecoin', _disc('#345d9d', _mLtc)),
  'dogecoin': BrandMark('brand:dogecoin', _disc('#c2a633', _mDoge)),
  'bitcoincash': BrandMark('brand:bitcoincash', _disc('#0ac18e', _mBtc)),
  'solana': BrandMark('brand:solana', _disc('#9945ff', _mSol)),
  'tron': BrandMark('brand:tron', _disc('#ef0027', _mTron)),
  'ton': BrandMark('brand:ton', _disc('#0098ea', _mTon)),
  'xrp': BrandMark('brand:xrp', _disc('#23292f', _mXrp)),
  'stellar': BrandMark('brand:stellar', _disc('#1b1b2a', _mXlm)),
  'tezos': BrandMark('brand:tezos', _disc('#2c7df7', _mXtz)),
  'cardano': BrandMark('brand:cardano', _disc('#0033ad', _mAda)),
  'ethereum': BrandMark('brand:ethereum', _disc('#627eea', _mEth)),
  'base': BrandMark('brand:base', _disc('#0052ff', _mEth)),
  'arbitrum': BrandMark('brand:arbitrum', _disc('#28a0f0', _mEth)),
  'optimism': BrandMark('brand:optimism', _disc('#ff0420', _mEth)),
  'polygon': BrandMark('brand:polygon', _disc('#8247e5', _mPolygon)),
  'bnb': BrandMark('brand:bnb', _disc('#f3ba2f', _mBnb)),
  'avalanche': BrandMark('brand:avalanche', _disc('#e84142', _mAvax)),
  'hyperliquid': BrandMark('brand:hyperliquid', _disc('#50d2c1', _mHype)),
  'block': BrandMark('brand:block', _disc('#7c5cff', _mBlock)),
};

// ---- token marks -----------------------------------------------------------
const String _mUsdt =
    '<path d="M7.5 8.2h9" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>'
    '<path d="M12 8.2v2.2" fill="none" stroke="#ffffff" stroke-width="1.5"/>'
    '<ellipse cx="12" cy="11.6" rx="3.6" ry="1.5" fill="none" stroke="#ffffff" stroke-width="1.3"/>'
    '<path d="M12 11.9v4.9" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>';
const String _mUsdc =
    '<circle cx="12" cy="12" r="5.6" fill="none" stroke="#ffffff" stroke-width="1.3"/>'
    '<path d="M12 8v8" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>'
    '<path d="M13.6 9.8c-.4-.7-1-1-1.8-1-1 0-1.8.6-1.8 1.5 0 2 3.6 1 3.6 3 0 .9-.8 1.5-1.8 1.5-.8 0-1.5-.3-1.9-1" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
const String _mLink =
    '<path d="M12 6.4l4.4 2.55v5.1L12 16.6l-4.4-2.55v-5.1z" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>';
const String _mDai =
    '<path d="M8.4 6.5h3.4a5.5 5.5 0 010 11H8.4z" fill="none" stroke="#6b4e00" stroke-width="1.7" stroke-linejoin="round"/>'
    '<path d="M6.6 12h5" fill="none" stroke="#6b4e00" stroke-width="1.7" stroke-linecap="round"/>';
const String _mXaut =
    '<path d="M6.5 14.5l1.4-3.2h8.2l1.4 3.2z" fill="#ffffff"/>'
    '<path d="M9.3 11.3l-.8 3.2M14.7 11.3l.8 3.2M11.2 11.3l-.3 3.2M12.8 11.3l.3 3.2" fill="none" stroke="#d4af37" stroke-width="0.8"/>';
const String _mUsdb =
    '<path d="M12 6.5v11" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>'
    '<path d="M14.4 8.6c-.5-.9-1.4-1.3-2.4-1.3-1.3 0-2.4.8-2.4 2 0 2.6 4.9 1.4 4.9 4 0 1.2-1.1 2-2.5 2-1.1 0-2-.5-2.5-1.4" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const String _mWorld =
    '<circle cx="12" cy="12" r="5.6" fill="none" stroke="#ffffff" stroke-width="1.3"/>'
    '<path d="M6.4 12h11.2M12 6.4c2 2.2 2 9 0 11.2M12 6.4c-2 2.2-2 9 0 11.2" fill="none" stroke="#ffffff" stroke-width="1.2"/>';

/// Known-token brand marks. Keyed `chain:SYMBOL` / `chain:0xADDR` (contract
/// specific) and `*:SYMBOL` (any chain). BLOCK-chain tokens without a specific
/// mark fall through to the Blockle BLOCK-20 mark (`block:*`).
final Map<String, BrandMark> kTokenLogos = {
  // real-oracle stables + known ERC-20s — same brand mark on every chain.
  '*:USDT': BrandMark('token:usdt', _disc('#26a17b', _mUsdt)),
  '*:USDC': BrandMark('token:usdc', _disc('#2775ca', _mUsdc)),
  '*:USDC.E': BrandMark('token:usdc', _disc('#2775ca', _mUsdc)),
  '*:USDBC': BrandMark('token:usdc', _disc('#2775ca', _mUsdc)),
  '*:DAI': BrandMark('token:dai', _disc('#f4b731', _mDai)),
  '*:LINK': BrandMark('token:link', _disc('#2a5ada', _mLink)),
  '*:XAUT': BrandMark('token:xaut', _disc('#d4af37', _mXaut)),
  '*:POL': BrandMark('token:pol', _disc('#8247e5', _mPolygon)),
  '*:MATIC': BrandMark('token:pol', _disc('#8247e5', _mPolygon)),
  // Blockle-chain tokens keep the Blockle marks (never a BLOCK-derived $).
  'block:USDB': BrandMark('token:usdb', _disc('#7c5cff', _mUsdb)),
  'block:WORLD': BrandMark('token:world', _disc('#7c5cff', _mWorld)),
  'block:*': BrandMark('brand:block', _disc('#7c5cff', _mBlock)),
  // WBLOCK (Solana wrap) + bare BLOCK keep the Blockle mark on any chain.
  '*:WBLOCK': BrandMark('brand:block', _disc('#7c5cff', _mBlock)),
  '*:BLOCK': BrandMark('brand:block', _disc('#7c5cff', _mBlock)),
};

/// Canonical chain id for [chainId] (a registry id or an adapter id/ticker),
/// optionally disambiguated by a native [symbol]. Mirrors the JS CHAIN_ALIAS.
String canonChain(String chainId, String? symbol) {
  final c = chainId.toLowerCase();
  if (kChainLogos.containsKey(c)) return c;
  const alias = {
    'btc': 'bitcoin', 'xbt': 'bitcoin',
    'ltc': 'litecoin',
    'doge': 'dogecoin',
    'bch': 'bitcoincash', 'bitcoin-cash': 'bitcoincash',
    'sol': 'solana',
    'trx': 'tron',
    'xlm': 'stellar',
    'xtz': 'tezos',
    'ada': 'cardano',
    'eth': 'ethereum',
    'matic': 'polygon', 'pol': 'polygon',
    'avax': 'avalanche',
    'bsc': 'bnb', 'binance': 'bnb',
    'hype': 'hyperliquid', 'hyperevm': 'hyperliquid',
  };
  return alias[c] ?? alias[(symbol ?? '').toLowerCase()] ?? c;
}

/// The SPECIFIC known-token brand mark for a token on [chain] (canonical) with
/// [symbol] and optional contract [address], or null when the token has no
/// specific mark. The generic BLOCK-20 Blockle fallback (`block:*`) is applied
/// by [AssetIcon] only AFTER a runtime logoURI, so custom BLOCK-20 logos survive.
BrandMark? tokenMark(String chain, String symbol, {String? address}) {
  final s = symbol.toUpperCase();
  if (address != null && address.isNotEmpty) {
    final byAddr = kTokenLogos['$chain:${address.toLowerCase()}'];
    if (byAddr != null) return byAddr;
  }
  return kTokenLogos['$chain:$s'] ?? kTokenLogos['*:$s'];
}

/// Deterministic, pleasant fallback color for a token (or unknown chain) with
/// no logo — derived from its symbol so the same token always gets the same
/// color across the UI.
Color monogramColor(String seed) {
  var h = 0;
  for (final cu in seed.toUpperCase().codeUnits) {
    h = (h * 31 + cu) & 0x7fffffff;
  }
  const palette = [
    Color(0xFF7C5CFF),
    Color(0xFF37E0C8),
    Color(0xFF4ADE80),
    Color(0xFFFB7185),
    Color(0xFFF7931A),
    Color(0xFF627EEA),
    Color(0xFFF3BA2F),
    Color(0xFF9945FF),
  ];
  return palette[h % palette.length];
}

String _initial(String s) => s.trim().isNotEmpty ? s.trim()[0].toUpperCase() : '?';

Widget _monogram(String label, double radius, {FontWeight weight = FontWeight.w800}) =>
    CircleAvatar(
      radius: radius,
      backgroundColor: monogramColor(label),
      child: Text(_initial(label),
          style: TextStyle(
              color: Colors.white, fontWeight: weight, fontSize: radius * 0.9)),
    );

/// The icon for a CHAIN (native asset). A real brand mark for every supported
/// chain, rendered fully offline; an unknown / custom network falls back to a
/// colored monogram of the chain symbol/id.
class ChainIcon extends StatelessWidget {
  const ChainIcon(this.chainId, {super.key, this.symbol, this.radius = 14});
  final String chainId;
  final String? symbol;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final mark = kChainLogos[canonChain(chainId, symbol)];
    if (mark != null) {
      return AppIcons.rawSvg(mark.key, mark.svg, size: radius * 2);
    }
    return _monogram(symbol ?? chainId, radius);
  }
}

/// The icon for an ASSET — a native chain coin or a token. A known token renders
/// its real brand mark; otherwise a token with a [logoUri] renders it at runtime
/// (NetworkImage) with a graceful colored-monogram fallback; a genuinely-unknown
/// token with no logo falls back to a monogram. Never a broken/placeholder icon.
class AssetIcon extends StatelessWidget {
  const AssetIcon({
    super.key,
    required this.chainId,
    required this.symbol,
    this.isToken = false,
    this.logoUri,
    this.address,
    this.radius = 14,
  });

  final String chainId;
  final String symbol;
  final bool isToken;
  final String? logoUri;
  final String? address;
  final double radius;

  @override
  Widget build(BuildContext context) {
    if (!isToken) {
      return ChainIcon(chainId, symbol: symbol, radius: radius);
    }
    final canon = canonChain(chainId, symbol);
    final mark = tokenMark(canon, symbol, address: address);
    if (mark != null) {
      return AppIcons.rawSvg(mark.key, mark.svg, size: radius * 2);
    }
    final uri = logoUri;
    if (uri == null || uri.isEmpty) {
      // BLOCK-20 tokens with no logo + no specific mark keep the Blockle mark
      // (they are Blockle-chain assets); other unknown tokens get a monogram.
      if (canon == 'block') {
        final b = kTokenLogos['block:*']!;
        return AppIcons.rawSvg(b.key, b.svg, size: radius * 2);
      }
      return _monogram(symbol, radius, weight: FontWeight.w700);
    }
    return CircleAvatar(
      radius: radius,
      backgroundColor: monogramColor(symbol),
      // foregroundImage draws over the monogram; on load error it is simply not
      // shown, leaving the monogram fallback visible (never a broken icon).
      foregroundImage: NetworkImage(uri),
      child: Text(_initial(symbol),
          style: TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w700,
              fontSize: radius * 0.85)),
    );
  }
}
