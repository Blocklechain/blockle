// widgets/chain_icon.dart — correct per-chain / per-token logos in the UI.
//
// FEATURE B (docs/AGENT-SCAN.md / wallet-features): show the right icon for
// every chain and token in the balances list, portfolio, send/receive and
// token rows.
//
//   • Chains: recognizable BRAND-COLORED marks for every supported chain
//     (BTC, ETH/EVM, SOL, DOGE, LTC, BLOCK, BNB, Base, Arbitrum, Optimism,
//     Polygon, Avalanche). Rendered fully OFFLINE — pure Flutter painting, no
//     bundled image files and NO remote fetch. Each is a brand-colored disc
//     with the chain's glyph, instantly recognizable by color + letter.
//   • Tokens: render the discovery/auto-import metadata `logoURI` at runtime
//     (NetworkImage), with a graceful colored-monogram fallback when it is
//     absent or fails to load. Never a broken/placeholder icon.
import 'package:flutter/material.dart';

/// Brand identity for one chain: disc color, glyph text color, and the short
/// glyph drawn on the disc. Colors are the chains' recognizable brand colors.
class ChainBrand {
  const ChainBrand(this.color, this.glyph, {this.fg = Colors.white});
  final Color color;
  final String glyph;
  final Color fg;
}

/// The supported chains + their EVM L2s. Keyed by the registry chain id. EVM L2s
/// keep ETH's silhouette but take their own brand color so they are
/// distinguishable at a glance.
const Map<String, ChainBrand> kChainBrands = {
  'bitcoin': ChainBrand(Color(0xFFF7931A), '₿'), // ₿
  'litecoin': ChainBrand(Color(0xFF345D9D), 'Ł'), // Ł
  'dogecoin': ChainBrand(Color(0xFFC2A633), 'Ð', fg: Color(0xFF3B2F0B)),
  'solana': ChainBrand(Color(0xFF9945FF), 'S'),
  'ethereum': ChainBrand(Color(0xFF627EEA), '⧫'), // ⧫ diamond
  'base': ChainBrand(Color(0xFF0052FF), 'B'),
  'arbitrum': ChainBrand(Color(0xFF28A0F0), 'A'),
  'optimism': ChainBrand(Color(0xFFFF0420), 'O'),
  'polygon': ChainBrand(Color(0xFF8247E5), 'P'),
  'bnb': ChainBrand(Color(0xFFF3BA2F), 'B', fg: Color(0xFF2B2300)),
  'avalanche': ChainBrand(Color(0xFFE84142), 'A'),
  'block': ChainBrand(Color(0xFF7C5CFF), '◈'), // ◈ Blockle accent
};

/// The brand for [chainId], or null for an unknown / user-added custom network
/// (which gets a neutral monogram fallback instead).
ChainBrand? chainBrand(String chainId) => kChainBrands[chainId];

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

/// The icon for a CHAIN (native asset). Always offline, always a recognizable
/// brand-colored mark; unknown chains fall back to a colored monogram of the
/// chain symbol/id.
class ChainIcon extends StatelessWidget {
  const ChainIcon(this.chainId, {super.key, this.symbol, this.radius = 14});
  final String chainId;
  final String? symbol;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final brand = chainBrand(chainId);
    if (brand != null) {
      return CircleAvatar(
        radius: radius,
        backgroundColor: brand.color,
        child: Text(
          brand.glyph,
          style: TextStyle(
              color: brand.fg,
              fontWeight: FontWeight.w800,
              fontSize: radius * 0.95),
        ),
      );
    }
    final label = symbol ?? chainId;
    return CircleAvatar(
      radius: radius,
      backgroundColor: monogramColor(label),
      child: Text(_initial(label),
          style: TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w800,
              fontSize: radius * 0.9)),
    );
  }
}

/// The icon for an ASSET — a native chain coin or a token. A token with a
/// [logoUri] renders it at runtime and gracefully falls back to a colored
/// monogram if it is absent or fails to load. A native asset defers to
/// [ChainIcon]. Never shows a broken/placeholder image.
class AssetIcon extends StatelessWidget {
  const AssetIcon({
    super.key,
    required this.chainId,
    required this.symbol,
    this.isToken = false,
    this.logoUri,
    this.radius = 14,
  });

  final String chainId;
  final String symbol;
  final bool isToken;
  final String? logoUri;
  final double radius;

  @override
  Widget build(BuildContext context) {
    if (!isToken) {
      return ChainIcon(chainId, symbol: symbol, radius: radius);
    }
    final fallback = CircleAvatar(
      radius: radius,
      backgroundColor: monogramColor(symbol),
      child: Text(_initial(symbol),
          style: TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w700,
              fontSize: radius * 0.85)),
    );
    final uri = logoUri;
    if (uri == null || uri.isEmpty) return fallback;
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
