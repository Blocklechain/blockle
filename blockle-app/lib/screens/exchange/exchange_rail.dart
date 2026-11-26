// screens/exchange/exchange_rail.dart — the exchange tab's sub-navigation.
//
// A PERMANENT 60pt ICON RAIL, not a collapsed drawer. There is no expanded
// state below iPad width and no hidden state at all, which is the point:
//
//   1. The work here is cross-section by nature — deposit, check the book,
//      place it, check orders, withdraw is ONE task, not five visits. A hidden
//      nav charges two taps and a dismissal per hop.
//   2. The venue is live and custodial, so the rail is also an instrument
//      panel. A bad dot on WITHDRAW because no authenticator is enrolled is
//      information the user must get WITHOUT asking for it; drawn inside a
//      closed drawer it is information nobody receives.
//   3. The app already spends a hamburger at the top level (home.dart's
//      _SideMenu, a 288pt drawer). A second drawer inside tab 9 would be two
//      drawers deep with overlapping edge-swipe zones, and the iOS back-edge
//      gesture would then mean two different things depending on invisible
//      state. A rail has no state to get wrong.
//
// AND IT IS DELIBERATELY QUIETER THAN THE BOTTOM BAR. Two navigation layers are
// visible at once — an L of chrome — so the hierarchy has to read: the bottom
// bar is 24pt icons in Bk.muted, this is 20pt in Bk.faint. Same idiom
// (home.dart's `_BarIcon`), rotated and subordinate.
//
// WHAT IT COSTS, HONESTLY: 61pt, 15.6% of a 390pt screen, on every screen
// forever. The order ticket and the deposit address live in full-bleed bottom
// sheets where the rail costs nothing, wide tables degrade to card-per-row
// rather than pretending to be tables, and the ladder time-shares with the tape
// instead of splitting 299pt in half. What is NOT traded away: hiding the rail
// on scroll. Navigation that vanishes while you read a withdrawal quote and
// reappears under your thumb is a mis-tap generator on a screen that moves real
// money. Persistent means Cancel and Orders are at the same pixel always.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme.dart';
import 'section_table.dart';

/// The rail's own width, before any left safe-area inset is added.
///
/// 60 and not 56 so the selected item's micro-label fits in 48pt of inner
/// width without ellipsizing.
const double kRailWidth = 60;

/// The expanded rail, with full names and numeric badges — iPad and Stage
/// Manager only. It is the web's desktop rail, generated from the same table.
const double kRailWidthExpanded = 200;

/// Layout thresholds. One breakpoint each, and they are the only things that
/// change between phone, landscape and iPad.
const double kExpandedRailMinWidth = 900;
const double kRailLabelMinHeight = 420;

class ExchangeRail extends StatefulWidget {
  const ExchangeRail({
    super.key,
    required this.selectedId,
    required this.onSelect,
    this.badges = const ExchangeBadgeState(),
    this.sections = kExchangeSections,
    this.expanded = false,
  });

  final String selectedId;
  final ValueChanged<ExchangeSection> onSelect;
  final ExchangeBadgeState badges;
  final List<ExchangeSection> sections;

  /// The >=900pt rail: 200pt, full names, group headings, numeric badges.
  final bool expanded;

  @override
  State<ExchangeRail> createState() => _ExchangeRailState();
}

class _ExchangeRailState extends State<ExchangeRail> {
  final _scroll = ScrollController();
  final _itemKeys = <String, GlobalKey>{};

  /// Whether there is more rail in that direction. A fade is the only "there
  /// is more" cue people reliably obey, and it is shown ONLY when true — a
  /// permanent fade teaches nothing.
  bool _fadeTop = false;
  bool _fadeBottom = false;

  @override
  void initState() {
    super.initState();
    for (final s in widget.sections) {
      _itemKeys[s.id] = GlobalKey();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncFades());
  }

  @override
  void didUpdateWidget(ExchangeRail old) {
    super.didUpdateWidget(old);
    if (old.selectedId != widget.selectedId) {
      // Arriving by deep link can select an item that is scrolled out of
      // sight; a selected item you cannot see is worse than no selection.
      WidgetsBinding.instance.addPostFrameCallback((_) => _revealSelected());
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _revealSelected() {
    final ctx = _itemKeys[widget.selectedId]?.currentContext;
    if (ctx == null || !mounted) return;
    Scrollable.ensureVisible(ctx,
        duration: const Duration(milliseconds: 180), alignment: 0.5);
  }

  void _syncFades() {
    if (!mounted || !_scroll.hasClients) return;
    final p = _scroll.position;
    final top = p.pixels > 2;
    final bottom = p.pixels < p.maxScrollExtent - 2;
    if (top != _fadeTop || bottom != _fadeBottom) {
      setState(() {
        _fadeTop = top;
        _fadeBottom = bottom;
      });
    }
  }

  void _tap(ExchangeSection s) {
    if (s.id == widget.selectedId) return;
    HapticFeedback.selectionClick();
    widget.onSelect(s);
  }

  @override
  Widget build(BuildContext context) {
    // LANDSCAPE-LEFT IS THE CASE THAT BITES: the sensor housing eats the
    // LEADING edge, so the rail honours viewPadding.left and nothing else —
    // the bottom bar already pays for the bottom inset (it wraps itself in
    // SafeArea(top: false)), and the app bar pays for the top.
    final inset = MediaQuery.of(context).viewPadding.left;
    final height = MediaQuery.of(context).size.height;
    final labels = widget.expanded || height >= kRailLabelMinHeight;
    final width = (widget.expanded ? kRailWidthExpanded : kRailWidth) + inset;

    Widget list = ListView(
      controller: _scroll,
      padding: EdgeInsets.only(left: inset, top: 6, bottom: 6),
      children: _items(labels),
    );

    if (_fadeTop || _fadeBottom) {
      // ShaderMask over the rail's own ground, so the fade reads as the list
      // running under the chrome rather than as a shadow.
      list = ShaderMask(
        shaderCallback: (rect) => LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            _fadeTop ? Colors.transparent : Colors.white,
            Colors.white,
            Colors.white,
            _fadeBottom ? Colors.transparent : Colors.white,
          ],
          stops: [
            0,
            _fadeTop ? 14 / rect.height : 0,
            _fadeBottom ? 1 - 14 / rect.height : 1,
            1,
          ],
        ).createShader(rect),
        blendMode: BlendMode.dstIn,
        child: list,
      );
    }

    return Container(
      width: width,
      // Bk.bg2 is the chrome colour the bottom bar and the drawer use, so the
      // rail reads as navigation; the content pane sits on Bk.bg.
      color: Bk.bg2,
      child: NotificationListener<ScrollNotification>(
        onNotification: (_) {
          _syncFades();
          return false;
        },
        child: ScrollConfiguration(
          // No scrollbar: a 4pt thumb inside a 60pt rail is noise.
          behavior: const ScrollBehavior().copyWith(scrollbars: false),
          child: list,
        ),
      ),
    );
  }

  List<Widget> _items(bool labels) {
    final out = <Widget>[];
    ExchangeGroup? last;
    for (final s in widget.sections) {
      if (last != null && s.group != last) {
        out.add(_GroupRule(
            label: widget.expanded ? s.group.label : null));
      }
      last = s.group;
      out.add(_RailItem(
        key: _itemKeys[s.id],
        section: s,
        selected: s.id == widget.selectedId,
        badge: s.badge?.call(widget.badges),
        expanded: widget.expanded,
        showLabel: labels,
        onTap: () => _tap(s),
      ));
    }
    return out;
  }
}

/// The band separator. On a phone it is rhythm, not a word: a 12pt gap with a
/// centred 16x1 hairline. The expanded rail gets the actual group name.
class _GroupRule extends StatelessWidget {
  const _GroupRule({this.label});
  final String? label;

  @override
  Widget build(BuildContext context) {
    if (label != null) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 6),
        child: Text(label!.toUpperCase(),
            style: const TextStyle(
                fontSize: 10,
                letterSpacing: 0.9,
                fontWeight: FontWeight.w700,
                color: Bk.faint)),
      );
    }
    return const SizedBox(
      height: 12,
      child: Center(
        child: SizedBox(width: 16, height: 1, child: ColoredBox(color: Bk.line)),
      ),
    );
  }
}

class _RailItem extends StatelessWidget {
  const _RailItem({
    super.key,
    required this.section,
    required this.selected,
    required this.badge,
    required this.expanded,
    required this.showLabel,
    required this.onTap,
  });

  final ExchangeSection section;
  final bool selected;
  final RailBadge? badge;
  final bool expanded;

  /// Suppressed below 420pt of height (landscape): ten items at 52pt will not
  /// fit in 390pt, and a non-scrolling rail beats a scrolling one every time.
  final bool showLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final label = selected && showLabel;
    final height = expanded
        ? 48.0
        : label
            ? 64.0
            : showLabel
                ? 52.0
                : 44.0;

    final icon = Icon(
      selected ? section.selectedIcon : section.icon,
      size: 20,
      color: selected ? Bk.accent : Bk.faint,
    );

    final marked = badge == null
        ? icon
        : Stack(clipBehavior: Clip.none, children: [
            icon,
            Positioned(right: -3, top: -2, child: _Dot(badge!)),
          ]);

    final Widget inner = expanded
        ? Row(children: [
            marked,
            const SizedBox(width: 14),
            Expanded(
              child: Text(section.name,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                    color: selected ? Bk.text : Bk.muted,
                  )),
            ),
            // The expanded rail CAN hold a number, and a number is better than
            // a dot once there is room for it.
            if (badge?.count != null) _Count(badge!),
          ])
        : Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              marked,
              if (label) ...[
                const SizedBox(height: 3),
                Text(section.short,
                    maxLines: 1,
                    style: const TextStyle(
                      fontSize: 9.5,
                      letterSpacing: 0.4,
                      fontWeight: FontWeight.w700,
                      color: Bk.accent,
                    )),
              ],
            ],
          );

    return Semantics(
      // An unlabelled icon is never a mystery to VoiceOver: the full name, the
      // band it sits in, and whether it needs an account.
      label: '${section.name}, ${section.group.label}'
          '${section.authRequired ? ', needs your account' : ''}',
      selected: selected,
      button: true,
      child: Tooltip(
        // Long-press on a phone; hover on iPad. Either way the glyph can
        // always be made to say its own name.
        message: section.name,
        child: InkWell(
          onTap: onTap,
          child: Stack(children: [
            // The accent capsule, flush to the rail's leading edge. Two
            // redundant indicators on purpose — the tint alone fails for a
            // colour-blind user glancing at a 20pt glyph.
            if (selected)
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                child: Center(
                  child: Container(
                    width: 3,
                    height: 24,
                    decoration: BoxDecoration(
                      color: Bk.accent,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              ),
            AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              height: height,
              margin: EdgeInsets.symmetric(
                  horizontal: expanded ? 10 : 6, vertical: 2),
              padding: EdgeInsets.symmetric(horizontal: expanded ? 12 : 0),
              decoration: BoxDecoration(
                // The same _activeTint pill home.dart's drawer and bottom bar
                // use, so "selected" means one thing in this app.
                color: selected ? Bk.accentGhost : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
              ),
              alignment: Alignment.center,
              child: inner,
            ),
          ]),
        ),
      ),
    );
  }
}

/// An 8pt dot, never a number. Two digits in a 60pt rail collide with the
/// glyph, and the figure is of no use until you are in the section anyway — so
/// the exact count lives in the section's own header ("3 waiting to confirm").
class _Dot extends StatelessWidget {
  const _Dot(this.badge);
  final RailBadge badge;

  @override
  Widget build(BuildContext context) {
    final c = badge.tone == RailBadgeTone.bad ? Bk.bad : Bk.warn;
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: c,
        shape: BoxShape.circle,
        // A ring in the rail's own ground, so the dot survives sitting on top
        // of the glyph's stroke.
        border: Border.all(color: Bk.bg2, width: 1),
      ),
    );
  }
}

class _Count extends StatelessWidget {
  const _Count(this.badge);
  final RailBadge badge;

  @override
  Widget build(BuildContext context) {
    final c = badge.tone == RailBadgeTone.bad ? Bk.bad : Bk.warn;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text('${badge.count}',
          style: TextStyle(
              fontSize: 11, fontWeight: FontWeight.w700, color: c)),
    );
  }
}
