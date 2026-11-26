// services/exchange_link.dart — `blockle://exchange/...` deep links.
//
// The web exchange is deep-linkable by hash: `#/withdraw` opens the withdrawal
// screen, `#/trade/RTM-USDT` opens a specific market, and both are shareable.
// Losing that on the phone would mean there is no way to hand someone a link
// to a market, so the same thing is expressed as:
//
//   blockle://exchange                  -> the tab, on its default section
//   blockle://exchange/withdraw         -> a named section
//   blockle://exchange/trade/RTM-USDT   -> a section and a market
//
// RESOLVED AGAINST THE SECTION TABLE, never against a hand-written list, so a
// link can only ever name a section the rail actually has.
//
// THE SCHEME IS `blockle` AND CONTAINS NO UNDERSCORE. An underscored scheme
// (`blockle_app`) is illegal in a CFBundleURLScheme and was rejected by App
// Store Connect with ITMS-90158 after a successful build, archive and upload —
// twice. test/ios_url_schemes_test.dart guards the plist; nothing here adds a
// scheme, it only parses the one already registered.

import '../screens/exchange/section_table.dart';
import '../state/app_state.dart';

/// Act on [uri] if it is an exchange link. Returns whether it was ours, so the
/// caller can keep handing unknown links to the other handlers.
bool handleExchangeLink(Uri uri, AppState app) {
  final target = parseExchangeDeepLink(uri);
  if (target == null) return false;
  app.openExchange(target.section.id, market: target.market);
  return true;
}
