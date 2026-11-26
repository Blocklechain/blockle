// screens/exchange/section_table.dart — ONE table for the whole exchange tab.
//
// The web exchange generates its left rail, its router and its count badges
// from a single `SCREENS` array (exchange.js:191-238). This is the Flutter
// equivalent, and it exists for the same reason: a section that is in the
// content switch but missing from the rail is unreachable, and a badge that is
// computed somewhere else than the rail it is drawn on can disagree with the
// screen behind it. One list, four consumers:
//
//   * the rail items + their groups             (exchange_rail.dart)
//   * the content pane's switch                 (exchange_screen.dart)
//   * the attention dots                        ([ExchangeSection.badge])
//   * deep links `blockle://exchange/<id>`      ([parseExchangeDeepLink])
//
// NOTHING HERE IMPORTS THE CONTROLLER. Badge selectors read a plain
// [ExchangeBadgeState] the shell assembles, so this table stays unit-testable
// and cannot drag the whole screen into a test that only wants to check that
// the rail and the router agree.

import 'package:flutter/material.dart';

/// The three bands the rail separates with a hairline rule.
///
/// 60pt cannot hold the word "FUNDS" legibly, so on a phone the grouping is
/// carried as rhythm — the names are only drawn in the >=900pt expanded rail
/// and spoken by VoiceOver.
enum ExchangeGroup {
  trade('Trade'),
  funds('Funds'),
  venue('Venue');

  const ExchangeGroup(this.label);
  final String label;
}

/// How loud a rail dot is. Never a third tone: more than two and the dot stops
/// meaning anything.
enum RailBadgeTone {
  /// Something is in flight or resting and wants an eye on it.
  warn,

  /// Something is BLOCKED — the section cannot do its job in this state.
  bad,
}

class RailBadge {
  const RailBadge(this.tone, {this.count});
  final RailBadgeTone tone;

  /// The figure, where there is one. The phone rail draws a dot and never a
  /// number (two digits collide with a 20pt glyph, and the count is of no use
  /// until you are in the section anyway); the expanded iPad rail draws the
  /// number. The exact figure always also appears in the section's own header.
  final int? count;
}

/// Everything the rail needs to decide which dots to light, assembled by the
/// shell from the same reads the sections themselves use.
///
/// A FIELD THAT IS NULL IS NOT KNOWN, and an unknown gate draws no dot at all.
/// Rendering "blocked" for a check that has not run yet is a false alarm;
/// rendering nothing when it has not run is simply silence, which is the only
/// honest thing a rail can say about a question it has not asked.
class ExchangeBadgeState {
  const ExchangeBadgeState({
    this.ordersWorking = 0,
    this.depositsConfirming = 0,
    this.laddersResting = 0,
    this.liveApiKeys = 0,
    this.twoFactorEnrolled,
    this.allowlistRequired,
    this.allowlistEntries,
  });

  /// Open orders across every market.
  final int ordersWorking;

  /// Deposits the venue has seen but not yet credited.
  final int depositsConfirming;

  /// Maker-ladder positions with orders still on the book.
  final int laddersResting;

  /// Live (unrevoked) API keys.
  final int liveApiKeys;

  /// Whether an authenticator is enrolled. Null until `/v1/2fa` has answered.
  final bool? twoFactorEnrolled;

  /// Whether the venue insists on an allowlisted destination. Null until
  /// `/v1/allowlist` has answered. True on the live venue.
  final bool? allowlistRequired;

  /// How many destinations are allowlisted. Null until read.
  final int? allowlistEntries;

  /// THE STATE IN WHICH A WITHDRAWAL CANNOT SUCCEED, whatever the user types.
  ///
  /// Both halves are server-side gates (per-request TOTP; an allowlisted
  /// destination with a 24h cooling-off period). The app offers no path around
  /// either, so the useful thing a rail can do is say so before the user fills
  /// in a form that is going to be refused.
  bool get withdrawalBlocked =>
      twoFactorEnrolled == false ||
      (allowlistRequired == true && (allowlistEntries ?? -1) == 0);
}

typedef RailBadgeSelector = RailBadge? Function(ExchangeBadgeState s);

/// One sub-tab of the exchange tab.
@immutable
class ExchangeSection {
  const ExchangeSection({
    required this.id,
    required this.icon,
    required this.selectedIcon,
    required this.short,
    required this.name,
    required this.group,
    this.authRequired = false,
    this.badge,
  });

  /// Stable id. It is the deep-link path segment, so it never changes.
  final String id;

  final IconData icon;
  final IconData selectedIcon;

  /// The rail label, drawn only on the selected item. Capped at 8 glyphs so it
  /// cannot ellipsize in the 48pt of inner width a 60pt rail leaves — it is a
  /// locator, not a title. [name] is the title, and the content pane's own
  /// header carries it.
  final String short;

  /// The full human name: the content header, the tooltip and the VoiceOver
  /// label all use this.
  final String name;

  final ExchangeGroup group;

  /// Whether the section's content needs a Blockle account session. The rail
  /// stays tappable either way — the section itself shows the inline gate card,
  /// which is deliberately not the web's full-screen curtain, so that the rail
  /// keeps working while signed out.
  final bool authRequired;

  final RailBadgeSelector? badge;
}

/// The exchange tab's sub-tabs — A MIRROR OF THE WEBSITE'S OWN TABLE.
///
/// exchange.blockle.org builds its rail, its routes and its screen ids from one
/// array (`SCREENS` in deploy/exchange/frontpage/exchange.js). This is that
/// array: same ids, same labels, same groups, same order, same auth flags. A
/// user who knows one surface knows the other, and a URL from the web
/// (`#/liquidity`) names the same screen here.
///
/// IT USED TO DIVERGE IN FOUR PLACES, which is what made the tab read as a
/// different, thinner product even though every screen's content was built:
///
///   * `liquidity` was called "Maker ladders" and sat under Funds; the web has
///     it under Trade, third, as "Liquidity".
///   * `balances` was "Exchange balance" (singular) and `orders` was "Your
///     orders".
///   * `listing` and `api` HAD NO RAIL ITEM AT ALL. Both were built, and both
///     were buried — the listing form inside a "The venue" screen, the API
///     keys inside Account — so neither was reachable the way the web makes
///     them reachable, which is as their own screen.
///   * there was a "The venue" screen the web does not have. Its content is
///     not dropped: the web carries the reserves statement and the venue's
///     own pages inside Account (app.html:782-806), and so now does this.
///
/// ONE NAME IS A KNOWN COLLISION, flagged rather than quietly resolved. This
/// app has its OWN top-level "Liquidity" tab — the Blockle Liquidity treasury
/// AMM — and the exchange's maker-ladder screen is a different thing entirely.
/// The web's name wins here because the instruction was parity with the web,
/// but the glyph stays `view_week` (the ladder) rather than the water drop, so
/// the two are never confusable at a glance in the rail.
const List<ExchangeSection> kExchangeSections = <ExchangeSection>[
  // ---------------------------------------------------------------- Trade
  ExchangeSection(
    id: 'markets',
    icon: Icons.format_list_bulleted,
    selectedIcon: Icons.list_alt,
    short: 'MARKETS',
    name: 'Markets',
    group: ExchangeGroup.trade,
  ),
  ExchangeSection(
    id: 'trade',
    icon: Icons.candlestick_chart_outlined,
    selectedIcon: Icons.candlestick_chart,
    short: 'TRADE',
    name: 'Trade',
    group: ExchangeGroup.trade,
  ),
  ExchangeSection(
    id: 'liquidity',
    // The LADDER glyph, not the water drop: see the collision note above.
    icon: Icons.view_week_outlined,
    selectedIcon: Icons.view_week,
    short: 'LIQUID',
    name: 'Liquidity',
    group: ExchangeGroup.trade,
    authRequired: true,
    badge: _laddersBadge,
  ),
  ExchangeSection(
    id: 'orders',
    icon: Icons.receipt_long_outlined,
    selectedIcon: Icons.receipt_long,
    short: 'ORDERS',
    name: 'Orders',
    group: ExchangeGroup.trade,
    authRequired: true,
    badge: _ordersBadge,
  ),
  // ---------------------------------------------------------------- Funds
  ExchangeSection(
    id: 'balances',
    icon: Icons.pie_chart_outline_rounded,
    selectedIcon: Icons.pie_chart_rounded,
    short: 'BALANCE',
    name: 'Balances',
    group: ExchangeGroup.funds,
    authRequired: true,
  ),
  ExchangeSection(
    id: 'deposit',
    icon: Icons.call_received,
    selectedIcon: Icons.call_received,
    short: 'DEPOSIT',
    name: 'Deposit',
    group: ExchangeGroup.funds,
    authRequired: true,
    badge: _depositBadge,
  ),
  ExchangeSection(
    id: 'withdraw',
    icon: Icons.call_made,
    selectedIcon: Icons.call_made,
    short: 'WITHDRAW',
    name: 'Withdraw',
    group: ExchangeGroup.funds,
    authRequired: true,
    badge: _withdrawBadge,
  ),
  // ---------------------------------------------------------------- Venue
  ExchangeSection(
    id: 'fees',
    icon: Icons.percent,
    selectedIcon: Icons.percent,
    short: 'FEES',
    name: 'Fees',
    group: ExchangeGroup.venue,
  ),
  ExchangeSection(
    id: 'listing',
    icon: Icons.playlist_add_outlined,
    selectedIcon: Icons.playlist_add,
    short: 'LISTING',
    name: 'List a coin',
    group: ExchangeGroup.venue,
  ),
  ExchangeSection(
    id: 'api',
    icon: Icons.key_outlined,
    selectedIcon: Icons.key,
    short: 'API',
    name: 'API',
    group: ExchangeGroup.venue,
    authRequired: true,
  ),
  ExchangeSection(
    id: 'account',
    icon: Icons.person_outline,
    selectedIcon: Icons.person,
    short: 'ACCOUNT',
    name: 'Account',
    group: ExchangeGroup.venue,
  ),
];

/// Ids this table USED to use, mapped to the web-parity ids above.
///
/// A deep link is a promise: `blockle://exchange/ladders` is in release notes
/// and in at least one shipped build, so it has to keep landing on the same
/// screen rather than falling back to Markets. The old "venue" screen's
/// content now lives in Account, so that is where its link goes.
const Map<String, String> kExchangeSectionAliases = <String, String>{
  'ladders': 'liquidity',
  'balance': 'balances',
  'venue': 'account',
};

RailBadge? _ordersBadge(ExchangeBadgeState s) => s.ordersWorking > 0
    ? RailBadge(RailBadgeTone.warn, count: s.ordersWorking)
    : null;

RailBadge? _depositBadge(ExchangeBadgeState s) => s.depositsConfirming > 0
    ? RailBadge(RailBadgeTone.warn, count: s.depositsConfirming)
    : null;

RailBadge? _laddersBadge(ExchangeBadgeState s) => s.laddersResting > 0
    ? RailBadge(RailBadgeTone.warn, count: s.laddersResting)
    : null;

RailBadge? _withdrawBadge(ExchangeBadgeState s) =>
    s.withdrawalBlocked ? const RailBadge(RailBadgeTone.bad) : null;

/// The section a cold open lands on. Public, and no account needed to read it.
const String kDefaultExchangeSection = 'markets';

ExchangeSection? exchangeSectionById(String? id) {
  if (id == null) return null;
  // An old id resolves to its replacement before the lookup, so a shipped
  // deep link keeps working. See [kExchangeSectionAliases].
  final wanted = kExchangeSectionAliases[id] ?? id;
  for (final s in kExchangeSections) {
    if (s.id == wanted) return s;
  }
  return null;
}

/// The section a given id resolves to, falling back to Markets — the web does
/// the same (exchange.js:244) so a stale bookmark lands somewhere public
/// rather than on an error.
ExchangeSection exchangeSectionOrDefault(String? id) =>
    exchangeSectionById(id) ?? exchangeSectionById(kDefaultExchangeSection)!;

/// A resolved `blockle://exchange/...` link.
class ExchangeDeepLink {
  const ExchangeDeepLink(this.section, {this.market});
  final ExchangeSection section;

  /// Only `trade` carries one: `blockle://exchange/trade/RTM-USDT`.
  final String? market;
}

/// Resolve a deep link against THIS table, so a link can never name a section
/// the rail does not have.
///
/// THE SCHEME IS `blockle` AND NOTHING ELSE. Underscores are illegal in a
/// CFBundleURLScheme and an underscored scheme (`blockle_app`) cost two
/// releases at the altool step with ITMS-90158 — see
/// test/ios_url_schemes_test.dart, which guards the plist. Nothing here adds a
/// scheme; it only parses the one that is already registered.
ExchangeDeepLink? parseExchangeDeepLink(Uri uri) {
  if (uri.scheme.toLowerCase() != 'blockle') return null;
  if (uri.host.toLowerCase() != 'exchange') return null;
  final parts = uri.pathSegments.where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) {
    return ExchangeDeepLink(exchangeSectionOrDefault(kDefaultExchangeSection));
  }
  final sec = exchangeSectionById(parts.first.toLowerCase());
  if (sec == null) return null;
  // A market only means anything on the trade section; carrying one anywhere
  // else would be a link that silently did half of what it said.
  final market = sec.id == 'trade' && parts.length > 1
      ? Uri.decodeComponent(parts[1]).toUpperCase()
      : null;
  return ExchangeDeepLink(sec, market: market);
}
