// multichain/denomination.dart — the SINGLE guard that decides whether an asset
// is "BLOCK-denominated": priced ONLY in BLOCK, never in USD.
//
// There is NO BLOCK/USD oracle. So for the native BLOCK coin and for every
// BLOCK-20 / BLOCK-20S token (standard on the BLOCK chain, incl. the USD-pegged
// USDB), we must NEVER synthesize or display a USD price / USD value — a figure
// that would need BLOCK→USD is shown in BLOCK units instead, or omitted. Real
// oracle chains (ETH/SOL/BTC/EVM/…) are UNAFFECTED.
//
// Semantics are shared verbatim with the other three wallets (extension JS
// canonical, web vendor, Qt python):
//
//   isBlockDenominated(asset) := lc(asset.chain) == 'block'
//                                 || up(asset.symbol) in {'BLOCK','WBLOCK'}
//
// chain=='block' already tags native BLOCK + every BLOCK-20 + BLOCK-20S/USDB
// (there is no separate `standard` field — registry rows + token-lists NATIVE
// all carry chain:'block'). WBLOCK (the Solana wrap) is added by symbol because
// its only price source is the BLOCK mark.
library;

/// True when [asset] (or the given [chain]/[symbol]) must be priced in BLOCK,
/// never USD. Accepts a Map asset ({chain, symbol, …}), a bare symbol String,
/// or explicit [chain]/[symbol] named args (any of which may be null/absent).
bool isBlockDenominated({dynamic asset, String? chain, String? symbol}) {
  String? c = chain;
  String? s = symbol;
  if (asset is Map) {
    c ??= asset['chain']?.toString();
    s ??= asset['symbol']?.toString();
  } else if (asset is String) {
    s ??= asset;
  }
  if ((c ?? '').toLowerCase() == 'block') return true;
  final up = (s ?? '').toUpperCase();
  return up == 'BLOCK' || up == 'WBLOCK';
}
