// screens/exchange/sections/panel_kit.dart — the loader and the two-shape table
// that the money sections share.
//
// exchange_ui.dart holds the LOOK (card, pill, header, tone). This holds the
// two BEHAVIOURS the money-facing sections cannot be trusted to re-implement
// one at a time:
//
//   [ExAsyncPanel] — the only loader the deposit / withdraw / ladder / account
//   panels use. Its whole job is a rule the venue's own front-end is built
//   around: a failed read prints its error and KEEPS whatever it had. Replacing
//   a list of withdrawal destinations with an empty one because a request timed
//   out would tell a customer their allowlist is gone, and someone acting on
//   that will re-add an address and wait another 24 hours for no reason.
//
//   [ExDataRows] — one widget, two layouts, one breakpoint. Above 340pt it is a
//   real table; below it each row becomes a card with a key/value body, because
//   a six-column fee schedule in 299pt of content width is either unreadable or
//   a horizontal scroll nested inside a vertical one, and nesting those on a
//   phone is a gesture trap.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../theme.dart';
import '../exchange_ui.dart';

/// Below this content width a table becomes one card per row.
const double kExTableBreakpoint = 340;

/// THE ONE LOADER the money sections use.
///
/// Guarantees, each because of a specific way this goes wrong:
///
///   * A FAILURE NEVER CLEARS A GOOD VALUE — see the header.
///   * AN ERROR IS ALWAYS ON SCREEN. There is no silent catch anywhere in this
///     widget; [what] makes the message name the read that failed, so "could
///     not read your allowlist" is never mistaken for "you have no addresses".
///   * IT RE-READS ON THE SECTION'S TICK, not on a timer of its own, so the
///     open section polls and the other nine do not.
///   * A REFRESH NEVER TAKES THE SCREEN AWAY. The last value keeps rendering
///     while the next read is in flight, so a 3s tick cannot replace a panel
///     the user is reading — or mid-copy — with a spinner.
class ExAsyncPanel<T> extends StatefulWidget {
  const ExAsyncPanel({
    super.key,
    required this.load,
    required this.builder,
    required this.what,
    this.reloadOn,
    this.paused = false,
  });

  final Future<T> Function() load;

  /// [reload] re-runs [load]; panels call it after a mutation so the list and
  /// the server agree without waiting for the next tick.
  final Widget Function(
      BuildContext context, T value, Future<void> Function() reload) builder;

  /// What failed, in the user's words: "your withdrawal addresses".
  final String what;

  /// The controller's poll tick. Null loads once.
  final Listenable? reloadOn;

  /// Suspend ticking. Set while a once-only secret is on screen, so a refresh
  /// cannot pull the rug out from under someone copying it.
  final bool paused;

  @override
  State<ExAsyncPanel<T>> createState() => _ExAsyncPanelState<T>();
}

class _ExAsyncPanelState<T> extends State<ExAsyncPanel<T>> {
  T? _value;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.reloadOn?.addListener(_tick);
    _run();
  }

  @override
  void didUpdateWidget(ExAsyncPanel<T> old) {
    super.didUpdateWidget(old);
    if (old.reloadOn != widget.reloadOn) {
      old.reloadOn?.removeListener(_tick);
      widget.reloadOn?.addListener(_tick);
    }
  }

  @override
  void dispose() {
    widget.reloadOn?.removeListener(_tick);
    super.dispose();
  }

  void _tick() {
    // One read at a time: a 3s tick over an 8s request queues requests faster
    // than the venue answers them.
    if (!_busy && !widget.paused) _run();
  }

  Future<void> _run() async {
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      final v = await widget.load();
      if (!mounted) return;
      setState(() {
        _value = v;
        _error = null;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        // _value DELIBERATELY UNTOUCHED.
        _error = exSay(e);
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = _value;
    final err = _error;
    if (v == null) {
      if (err != null) return ExError(what: widget.what, message: err);
      return const ExCard(
        child: Center(
          child: Padding(
              padding: EdgeInsets.all(10), child: CircularProgressIndicator()),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (err != null) ...[
          ExError(what: widget.what, message: err),
          const SizedBox(height: 10),
        ],
        widget.builder(context, v, _run),
      ],
    );
  }
}

/// The venue's message, not a Dart exception's toString.
String exSay(Object e) {
  final s = e.toString();
  return s
      .replaceFirst('ExchangeException', '')
      .replaceFirst(RegExp(r'^\(\d*\):\s*'), '')
      .replaceFirst('Exception: ', '')
      .trim();
}

/// A figure, right-aligned, monospace, em dash when unknown.
class ExNum extends StatelessWidget {
  const ExNum(this.value, {super.key, this.color, this.align = TextAlign.left});
  final Object? value;
  final Color? color;
  final TextAlign align;

  @override
  Widget build(BuildContext context) => Text(
        fig(value),
        textAlign: align,
        style: kMono.copyWith(fontSize: 12.5, color: color ?? Bk.text),
      );
}

/// A label/value line inside a card.
class ExField extends StatelessWidget {
  const ExField(this.label, this.value, {super.key, this.labelWidth = 108});
  final String label;
  final Widget value;
  final double labelWidth;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: labelWidth,
            child: Text(label,
                style: const TextStyle(fontSize: 12.5, color: Bk.muted)),
          ),
          const SizedBox(width: 8),
          Expanded(child: value),
        ],
      ),
    );
  }
}

/// Text in a field, so a caller can write `ExField('Fee', ExText(q.fee))`.
class ExText extends StatelessWidget {
  const ExText(this.value, {super.key, this.tone, this.bold = false});
  final Object? value;
  final Color? tone;
  final bool bold;

  @override
  Widget build(BuildContext context) => Text(
        fig(value),
        style: TextStyle(
          fontSize: 13.5,
          height: 1.35,
          color: tone ?? Bk.text,
          fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
        ),
      );
}

/// One row of a list that is a table on a wide screen and a card on a phone.
class ExDataRow {
  const ExDataRow({
    required this.title,
    this.leading,
    this.subtitle,
    this.fields = const <(String, Widget)>[],
    this.trailing,
    this.onTap,
    this.dim = false,
    this.footer,
  });

  final String title;
  final Widget? leading;
  final String? subtitle;

  /// Label → value, in the SAME ORDER for every row so the wide layout can
  /// take its column headings from the first one.
  final List<(String, Widget)> fields;
  final Widget? trailing;
  final VoidCallback? onTap;

  /// Revoked keys, unavailable chains: present, inactive, never hidden.
  final bool dim;

  /// A full-width line under the fields — the place a reason goes, because a
  /// reason truncated into a table cell is a reason nobody reads.
  final Widget? footer;
}

/// One widget, two layouts, one breakpoint. See the file header.
class ExDataRows extends StatelessWidget {
  const ExDataRows(
      {super.key, required this.rows, this.empty = 'Nothing here.'});
  final List<ExDataRow> rows;

  /// What to say when there is genuinely nothing — never shown in place of an
  /// error, which [ExAsyncPanel] renders separately and above.
  final String empty;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return ExCard(
          child: Text(empty, style: const TextStyle(color: Bk.muted)));
    }
    return LayoutBuilder(
      builder: (context, box) =>
          box.maxWidth >= kExTableBreakpoint ? _wide() : _narrow(),
    );
  }

  Widget _narrow() => Column(
        children: [
          for (final r in rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Opacity(
                opacity: r.dim ? 0.55 : 1,
                child: InkWell(
                  onTap: r.onTap,
                  borderRadius: BorderRadius.circular(Bk.rMd),
                  child: ExCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            if (r.leading != null) ...[
                              r.leading!,
                              const SizedBox(width: 8)
                            ],
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(r.title,
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w700,
                                          fontSize: 14)),
                                  if (r.subtitle != null)
                                    Text(r.subtitle!,
                                        style: const TextStyle(
                                            fontSize: 12, color: Bk.muted)),
                                ],
                              ),
                            ),
                            if (r.trailing != null) r.trailing!,
                          ],
                        ),
                        if (r.fields.isNotEmpty) const SizedBox(height: 8),
                        for (final f in r.fields) ExField(f.$1, f.$2),
                        if (r.footer != null) ...[
                          const SizedBox(height: 8),
                          r.footer!,
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      );

  Widget _wide() {
    final labels = rows.first.fields.map((f) => f.$1).toList();
    return ExCard(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                const Expanded(flex: 3, child: SizedBox.shrink()),
                for (final l in labels)
                  Expanded(
                    flex: 2,
                    child: Text(l.toUpperCase(),
                        style: const TextStyle(
                            fontSize: 10,
                            letterSpacing: 0.5,
                            fontWeight: FontWeight.w700,
                            color: Bk.faint)),
                  ),
                const SizedBox(width: 40),
              ],
            ),
          ),
          const Divider(height: 1),
          for (final r in rows)
            Opacity(
              opacity: r.dim ? 0.55 : 1,
              child: InkWell(
                onTap: r.onTap,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  child: Column(
                    children: [
                      Row(
                        children: [
                          Expanded(
                            flex: 3,
                            child: Row(
                              children: [
                                if (r.leading != null) ...[
                                  r.leading!,
                                  const SizedBox(width: 6),
                                ],
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(r.title,
                                          style: const TextStyle(
                                              fontWeight: FontWeight.w600,
                                              fontSize: 13)),
                                      if (r.subtitle != null)
                                        Text(r.subtitle!,
                                            style: const TextStyle(
                                                fontSize: 11, color: Bk.muted)),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                          for (final f in r.fields)
                            Expanded(flex: 2, child: f.$2),
                          SizedBox(
                              width: 40,
                              child: r.trailing ?? const SizedBox.shrink()),
                        ],
                      ),
                      if (r.footer != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Align(
                              alignment: Alignment.centerLeft,
                              child: r.footer!),
                        ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A reason, a caveat, or a warning. The TEXT carries the message; the colour
/// only says how loud it is.
class ExAdvice extends StatelessWidget {
  const ExAdvice(this.text, {super.key, this.tone = ExTone.plain, this.icon});
  final String text;
  final ExTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = toneColor(tone);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.09),
        borderRadius: BorderRadius.circular(Bk.rSm),
        border: Border.all(color: c.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: c),
            const SizedBox(width: 8)
          ],
          Expanded(
            child: Text(text,
                style: TextStyle(
                    fontSize: 12.5,
                    height: 1.4,
                    color: tone == ExTone.plain ? Bk.muted : Bk.text)),
          ),
        ],
      ),
    );
  }
}

/// A monospace address with a copy button.
///
/// Wrapping, never ellipsised: a 95-character address that is cut off is an
/// address nobody can check against their own wallet, and checking it is the
/// only defence against a clipboard-swapping attack.
class ExAddressBox extends StatelessWidget {
  const ExAddressBox(this.value,
      {super.key, this.label, this.copyLabel = 'Copy'});
  final String value;
  final String? label;
  final String copyLabel;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null) ...[
          Text(label!, style: const TextStyle(fontSize: 12, color: Bk.muted)),
          const SizedBox(height: 4),
        ],
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: Bk.bg2,
            borderRadius: BorderRadius.circular(Bk.rSm),
            border: Border.all(color: Bk.line),
          ),
          child: SelectableText(value, style: kMono),
        ),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: () {
            Clipboard.setData(ClipboardData(text: value));
            ScaffoldMessenger.of(context)
                .showSnackBar(const SnackBar(content: Text('Copied.')));
          },
          icon: const Icon(Icons.copy, size: 16),
          label: Text(copyLabel),
        ),
      ],
    );
  }
}

/// A short, shoulder-safe rendering of a long address for a list row: enough of
/// both ends to recognise, never enough to retype from.
String exShortAddress(String a) =>
    a.length <= 18 ? a : '${a.substring(0, 10)}…${a.substring(a.length - 6)}';

/// An ISO timestamp as something a person reads. Unknown stays an em dash.
String exWhen(String? iso) {
  if (iso == null || iso.isEmpty) return kEmDash;
  final t = DateTime.tryParse(iso);
  if (t == null) return iso;
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}';
}

/// "in 23 hours", for a cooling-off period. The point of the sentence is how
/// long is LEFT, which a timestamp alone does not say.
String exUntil(String? iso) {
  if (iso == null || iso.isEmpty) return kEmDash;
  final t = DateTime.tryParse(iso);
  if (t == null) return iso;
  final d = t.difference(DateTime.now());
  if (d.isNegative) return 'now';
  if (d.inHours >= 1) return 'in ${d.inHours}h ${d.inMinutes % 60}m';
  return 'in ${d.inMinutes}m';
}
