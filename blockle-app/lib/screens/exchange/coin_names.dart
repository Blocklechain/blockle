// screens/exchange/coin_names.dart — ticker -> the coin's actual name.
//
// A ticker is not a name. "MEWC" tells a first-time visitor nothing; "Meowcoin"
// tells them what they are looking at, and it is also the thing people type
// into a search box. The venue's own listing pages carry this table
// (deploy/exchange/frontpage/coins.js:231-253) and this is a straight port of
// it, so the app and the web agree on what a coin is called.
//
// UNKNOWN FALLS BACK TO THE TICKER rather than to "Unknown coin": a newly
// listed asset should read as itself until its name is added here, and the
// venue lists new coins faster than an app ships.

/// Strips a network suffix (`USDT.TRC20` -> `USDT`) before looking up, exactly
/// as the web does.
String coinName(String symbol) {
  var s = symbol.trim().toUpperCase();
  final dot = s.indexOf('.');
  if (dot > 0) s = s.substring(0, dot);
  return kCoinNames[s] ?? s;
}

const Map<String, String> kCoinNames = <String, String>{
  'BTC': 'Bitcoin',
  'ETH': 'Ethereum',
  'USDT': 'Tether',
  'USDC': 'USD Coin',
  'SOL': 'Solana',
  'DOGE': 'Dogecoin',
  'TRX': 'Tron',
  'BNB': 'BNB',
  'XRP': 'XRP',
  'BLOCK': 'Blockle',
  'PERBUG': 'Perbug',
  'RTM': 'Raptoreum',
  'PEP': 'Pepecoin',
  'NEOX': 'Neoxa',
  'MEWC': 'Meowcoin',
  'DINGO': 'Dingocoin',
  'RXD': 'Radiant',
  'XEL': 'Xelis',
  'ZEPH': 'Zephyr Protocol',
  'OCTA': 'OctaSpace',
  'EPIC': 'Epic Cash',
};

/// The network label a chain id renders as on a deposit/withdrawal row.
String networkLabel(String id) {
  final s = id.trim().toUpperCase();
  return const <String, String>{
    'TRC20': 'Tron',
    'ERC20': 'Ethereum',
    'SOL': 'Solana',
    'BEP20': 'BNB Chain',
  }[s] ??
      id;
}
