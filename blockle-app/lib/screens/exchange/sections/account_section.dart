// screens/exchange/sections/account_section.dart — the session, the second
// factor, and the programmatic keys.
//
// THE SECOND FACTOR IS THE REASON THIS SECTION MATTERS. Without an enrolled
// authenticator the venue refuses every withdrawal and refuses to add a
// withdrawal address, so a user with money on the venue and no authenticator
// cannot get it out. Enrolment lives here and WITHDRAW points at it.
//
// AND IT IS NEVER REPORTED OPTIMISTICALLY. "on" / "not set up" /
// "unavailable — <reason>" are three different states and the third is NOT the
// second: a failed check must never render as "off", because a user told their
// money is unprotected when it is will turn protection off and on again, and a
// user told it IS protected when the check failed will skip enrolling.
//
// WHAT THE PHONE DOES BETTER THAN THE WEB, FOR FREE. `POST /v1/2fa/begin`
// already returns an `otpauth://` URI that exchange.js throws away. Here it is
// offered as a one-tap handoff to whatever authenticator is already installed,
// which is the single biggest ergonomic win this surface has over a desktop.
//
// API KEYS ARE KEPT BUT SUBORDINATE. They are a legitimate feature — read or
// read+trade only, never withdrawal, and the venue says so on the route that
// lists them — and revoking one from a phone is exactly the thing you want to
// do away from your desk. What is NOT ported is the HMAC signing spec and the
// three-tab Node/Python/bash samples: reading a signing spec and pasting a
// Node snippet into a VPS on a 390pt screen is a desktop task, and the same
// document is one tap away on the venue's own site.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../../services/exchange_client.dart';
import '../../../services/open_url.dart';
import '../../../state/exchange_controller.dart';
import '../../../state/multichain_controller.dart';
import '../../../theme.dart';
import '../exchange_ui.dart';
import 'panel_kit.dart';
import 'pending_sections.dart';
import 'venue_extras.dart';

class AccountSection extends StatelessWidget {
  const AccountSection({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExBody(children: [
      const ExHeader(
        title: 'Account',
        note: 'The exchange has no login of its own — it uses the Blockle '
            'account this app signs in to.',
      ),
      _SessionPanel(c: c),
      const SizedBox(height: 22),
      TwoFactorPanel(c: c),
      const SizedBox(height: 22),
      // THE VENUE'S OWN DISCLOSURES LIVE HERE, where the web puts them
      // (app.html:782-806 — the reserves table sits inside the Account
      // screen). The app used to carry them on a separate "The venue" screen
      // the web does not have. The API keys that used to be below them have
      // moved to their own screen, again as on the web.
      //
      // The gate flags come first because they qualify everything under them:
      // if the venue is not live, the reserves below are a testnet statement.
      // The LIVE/TESTNET pill itself is NOT repeated here: the tab's
      // persistent status row shows it on every section already, which is the
      // app's equivalent of the web's page-header badge (app.html:53).
      VenueStatusCard(c: c),
      const SizedBox(height: 22),
      VenueDisclosures(c: c),
    ]);
  }
}

class _SessionPanel extends StatelessWidget {
  const _SessionPanel({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    if (!c.signedIn) {
      return const ExCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Not signed in', style: TextStyle(fontWeight: FontWeight.w700)),
          SizedBox(height: 6),
          Text(
            'Markets, prices, fees and the venue\'s own figures are public and '
            'work as they are. Balances, orders, deposits and withdrawals need '
            'your Blockle account.',
            style: TextStyle(fontSize: 13, color: Bk.muted, height: 1.4),
          ),
        ]),
      );
    }
    return ExAsyncPanel<ExchangeMe>(
      what: 'your session',
      load: c.client.me,
      builder: (context, me, reload) => ExCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ExField('Email', ExText(me.email)),
            ExField(
                'Account id', SelectableText(fig(me.accountId), style: kMono)),
            ExField(
              'Two-factor',
              // NULL IS "not reported", a third state. See the file header.
              me.twoFactor == null
                  ? const ExPill('not reported', tone: ExTone.warn)
                  : me.twoFactor!
                      ? const ExPill('on', tone: ExTone.good)
                      : const ExPill('off', tone: ExTone.bad),
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => openExternal('https://blockle.org/account'),
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: const Text('Manage'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _signOut(context),
                  icon: const Icon(Icons.logout, size: 16),
                  label: const Text('Sign out'),
                ),
              ),
            ]),
          ],
        ),
      ),
    );
  }

  Future<void> _signOut(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out of your Blockle account?'),
        content: const Text(
          'Your exchange balance stays exactly where it is — signing out only '
          'ends this session. The wallet on this device is separate and is not '
          'touched.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Sign out')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final mc = context.read<MultichainController>();
    final ex = context.read<ExchangeController>();
    // The accounts service owns the session; this drops the token the app
    // holds for it. Doing it through MultichainController rather than reaching
    // into the exchange keeps ONE place that knows how this app is signed in.
    if (mc.agentReady) mc.agent.disconnectCopilotAccount();
    await ex.loadAccount();
    await ex.loadBadges();
  }
}

/// Enrol, replace or turn off the authenticator the venue gates withdrawals on.
class TwoFactorPanel extends StatefulWidget {
  const TwoFactorPanel({super.key, required this.c});
  final ExchangeController c;

  @override
  State<TwoFactorPanel> createState() => _TwoFactorPanelState();
}

class _TwoFactorPanelState extends State<TwoFactorPanel> {
  final _confirm = TextEditingController();
  final _current = TextEditingController();

  /// The secret, held only while enrolment is in progress and never stored.
  ({String secret, String uri, String note})? _enrol;

  bool _busy = false;
  String? _error;
  String? _notice;

  @override
  void dispose() {
    _confirm.dispose();
    _current.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.c.signedIn) return const SizedBox.shrink();
    return ExAsyncPanel<bool>(
      what: 'whether a second factor is enrolled',
      // PAUSED while a secret is on screen: a refresh tick must not rebuild
      // this panel out from under someone typing their first code.
      paused: _enrol != null,
      reloadOn: widget.c.refreshTick,
      load: widget.c.client.twoFactorEnrolled,
      builder: (context, enrolled, reload) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ExHeader(
            title: 'Authenticator',
            note: 'The venue will not pay anything out, and will not let you '
                'add a withdrawal address, without a code from this.',
            trailing: enrolled
                ? const ExPill('on', tone: ExTone.good)
                : const ExPill('not set up', tone: ExTone.bad),
          ),
          if (_enrol != null)
            _EnrolCard(
              enrol: _enrol!,
              code: _confirm,
              busy: _busy,
              error: _error,
              onCancel: () => setState(() {
                _enrol = null;
                _error = null;
                _confirm.clear();
              }),
              onConfirm: () => _doConfirm(reload),
            )
          else
            ExCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (!enrolled)
                    const ExAdvice(
                      'Nothing is protecting withdrawals on this account yet. '
                      'Set one up and the venue starts refusing payouts that '
                      'do not carry a fresh code.',
                      tone: ExTone.warn,
                      icon: Icons.lock_open,
                    )
                  else
                    const ExAdvice(
                      'A code is required on EACH withdrawal, not once per '
                      'session, and is spent when used. One code cannot buy a '
                      'window in which an unattended session keeps paying out.',
                      icon: Icons.lock_outline,
                    ),
                  if (enrolled) ...[
                    const SizedBox(height: 12),
                    TextField(
                      controller: _current,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      autofillHints: const [AutofillHints.oneTimeCode],
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      decoration: const InputDecoration(
                        labelText: 'Current code',
                        isDense: true,
                        counterText: '',
                        helperText: 'Needed to replace or turn off the one you '
                            'have — proving you still hold it.',
                        helperMaxLines: 3,
                      ),
                    ),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 10),
                    ExAdvice(_error!,
                        tone: ExTone.bad, icon: Icons.error_outline),
                  ],
                  if (_notice != null) ...[
                    const SizedBox(height: 10),
                    ExAdvice(_notice!,
                        tone: ExTone.good, icon: Icons.check_circle_outline),
                  ],
                  const SizedBox(height: 12),
                  if (!enrolled)
                    FilledButton(
                      onPressed: _busy ? null : () => _begin(null),
                      child: Text(_busy ? 'Asking the venue…' : 'Set one up'),
                    )
                  else
                    Row(children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed:
                              _busy ? null : () => _begin(_current.text.trim()),
                          child: const Text('Replace'),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _busy ? null : () => _disable(reload),
                          child: const Text('Turn it off'),
                        ),
                      ),
                    ]),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _begin(String? currentCode) async {
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final r = await widget.c.client.beginTwoFactor(currentCode: currentCode);
      if (!mounted) return;
      setState(() {
        _enrol = r;
        _busy = false;
      });
      _current.clear();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
      });
    }
  }

  Future<void> _doConfirm(Future<void> Function() reload) async {
    final code = _confirm.text.trim();
    if (code.length != 6) {
      setState(() => _error = 'Enter the 6-digit code your app is showing.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.c.client.confirmTwoFactor(code);
      if (!mounted) return;
      setState(() {
        _enrol = null;
        _busy = false;
        _notice = 'Armed. Withdrawals will ask for a code from now on.';
      });
      _confirm.clear();
      await reload();
      await widget.c.loadBadges();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
      });
    }
  }

  Future<void> _disable(Future<void> Function() reload) async {
    final code = _current.text.trim();
    if (code.length != 6) {
      setState(() => _error =
          'Turning it off needs a current code — otherwise anyone holding your '
              'session could remove the thing that stops them withdrawing.');
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Turn off your authenticator?'),
        content: const Text(
          'You will not be able to withdraw anything, or add a withdrawal '
          'address, until you set one up again. The venue refuses both without '
          'a code.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Keep it')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Turn it off')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.c.client.disableTwoFactor(code);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _notice = 'Off. Withdrawals are refused until you set one up again.';
      });
      _current.clear();
      await reload();
      await widget.c.loadBadges();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
      });
    }
  }
}

/// The secret, shown once, with the otpauth handoff the web leaves on the floor.
class _EnrolCard extends StatelessWidget {
  const _EnrolCard({
    required this.enrol,
    required this.code,
    required this.busy,
    required this.error,
    required this.onCancel,
    required this.onConfirm,
  });

  final ({String secret, String uri, String note}) enrol;
  final TextEditingController code;
  final bool busy;
  final String? error;
  final VoidCallback onCancel;
  final VoidCallback onConfirm;

  @override
  Widget build(BuildContext context) {
    return ExCard(
      tone: ExTone.warn,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Shown once',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Text(
            enrol.note.isEmpty
                ? 'Put this into an authenticator app, then confirm a code to '
                    'arm it. Until you confirm, it is protecting nothing.'
                : enrol.note,
            style: const TextStyle(fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 12),
          if (enrol.uri.isNotEmpty)
            FilledButton.icon(
              // ONE TAP, instead of transcribing 32 characters. The URI is the
              // same one a QR code would encode; on a phone the app that reads
              // it is already here, so there is nothing to scan.
              onPressed: () => openExternal(enrol.uri),
              icon: const Icon(Icons.app_shortcut, size: 18),
              label: const Text('Open in my authenticator app'),
            ),
          const SizedBox(height: 10),
          ExAddressBox(enrol.secret,
              label: 'Or type this in by hand', copyLabel: 'Copy secret'),
          const SizedBox(height: 12),
          TextField(
            controller: code,
            keyboardType: TextInputType.number,
            maxLength: 6,
            autofillHints: const [AutofillHints.oneTimeCode],
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(
              labelText: 'Code from the app',
              isDense: true,
              counterText: '',
            ),
          ),
          if (error != null) ...[
            const SizedBox(height: 10),
            ExAdvice(error!, tone: ExTone.bad, icon: Icons.error_outline),
          ],
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: OutlinedButton(
                  onPressed: busy ? null : onCancel,
                  child: const Text('Cancel')),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton(
                onPressed: busy ? null : onConfirm,
                child: Text(busy ? 'Arming…' : 'Arm it'),
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

/// Programmatic keys: list, create, revoke. No key can ever withdraw.
class ApiKeysPanel extends StatefulWidget {
  const ApiKeysPanel({super.key, required this.c});
  final ExchangeController c;

  @override
  State<ApiKeysPanel> createState() => _ApiKeysPanelState();
}

class _ApiKeysPanelState extends State<ApiKeysPanel> {
  final _label = TextEditingController();
  String _scopes = 'read';
  int _rate = 120;
  bool _creating = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _label.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.c.signedIn) return const SizedBox.shrink();
    return ExAsyncPanel<ApiKeyList>(
      what: 'your API keys',
      reloadOn: widget.c.refreshTick,
      load: widget.c.client.apiKeys,
      builder: (context, v, reload) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ExHeader(
            title: 'API keys',
            note: v.cannotWithdraw
                ? 'Read and trade only — withdrawal is not on the list and '
                    'cannot be added, so a leaked key cannot move money.'
                : null,
            trailing: ExPill('${v.liveCount} live'),
          ),
          ExDataRows(
            empty: 'No keys. Nothing but this app can act on your account.',
            rows: [
              for (final k in v.keys)
                ExDataRow(
                  title: k.label.isEmpty ? k.keyId : k.label,
                  subtitle: k.keyId,
                  dim: k.revoked,
                  fields: [
                    ('Access', ExText(k.scopes.join(', '))),
                    ('Rate', ExText('${k.ratePerMin}/min')),
                    (
                      'Last used',
                      // "never" is the useful answer here, not an em dash: a
                      // key that has never been used is a key to revoke.
                      ExText(k.lastUsedAt == null
                          ? 'never'
                          : exWhen(k.lastUsedAt)),
                    ),
                  ],
                  trailing: k.revoked
                      ? const ExPill('revoked')
                      : IconButton(
                          tooltip: 'Revoke',
                          icon: const Icon(Icons.delete_outline, size: 18),
                          onPressed: _busy ? null : () => _revoke(k, reload),
                        ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          if (!_creating)
            OutlinedButton.icon(
              onPressed: () => setState(() => _creating = true),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('Create a key'),
            )
          else
            ExCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('New key',
                      style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _label,
                    maxLength: 64,
                    decoration: const InputDecoration(
                        labelText: 'Label', isDense: true, counterText: ''),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<String>(
                    isExpanded: true,
                    initialValue: _scopes,
                    decoration: const InputDecoration(
                        labelText: 'Access', isDense: true),
                    items: const [
                      DropdownMenuItem(value: 'read', child: Text('read')),
                      DropdownMenuItem(
                          value: 'read,trade', child: Text('read + trade')),
                    ],
                    onChanged: (v) => setState(() => _scopes = v ?? 'read'),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Withdrawal is not on this list and cannot be added. That '
                    'is the point of keys existing at all.',
                    style:
                        TextStyle(fontSize: 12, color: Bk.muted, height: 1.35),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    initialValue: '$_rate',
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(
                      labelText: 'Requests a minute',
                      isDense: true,
                      helperText: '1 to 1200. A per-key runaway stop, not a '
                          'performance setting.',
                      helperMaxLines: 2,
                    ),
                    onChanged: (s) => _rate = int.tryParse(s) ?? 120,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 10),
                    ExAdvice(_error!,
                        tone: ExTone.bad, icon: Icons.error_outline),
                  ],
                  const SizedBox(height: 12),
                  Row(children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _busy
                            ? null
                            : () => setState(() {
                                  _creating = false;
                                  _error = null;
                                }),
                        child: const Text('Cancel'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: _busy ? null : () => _create(reload),
                        child: Text(_busy ? 'Creating…' : 'Create'),
                      ),
                    ),
                  ]),
                ],
              ),
            ),
          const SizedBox(height: 10),
          ExAdvice(
            'Signing a request (the HMAC headers, the string to sign, the '
            'worked examples) is documented on the venue\'s own site — it is a '
            'desk job, not a phone one.'
            '${v.stringToSign == null ? '' : ' The string to sign is: ${v.stringToSign}.'}',
            icon: Icons.menu_book_outlined,
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () =>
                  openExternal('https://exchange.blockle.org/app.html#/api'),
              icon: const Icon(Icons.open_in_new, size: 16),
              label: const Text('Open the signing docs'),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _create(Future<void> Function() reload) async {
    if (_label.text.trim().isEmpty) {
      setState(() => _error = 'Give the key a label you will recognise later.');
      return;
    }
    if (_rate < 1 || _rate > 1200) {
      setState(() => _error = 'Requests a minute must be between 1 and 1200.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final k = await widget.c.client.createApiKey(
        label: _label.text.trim(),
        scopes: _scopes.split(','),
        ratePerMin: _rate,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _creating = false;
      });
      _label.clear();
      // A FULL-SCREEN ROUTE, not a bottom sheet. A sheet can be dismissed by an
      // accidental drag, and this secret does not exist anywhere else — the
      // venue will not show it again.
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => _SecretScreen(key_: k),
        fullscreenDialog: true,
      ));
      await reload();
      await widget.c.loadBadges();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
      });
    }
  }

  Future<void> _revoke(ApiKeyRow k, Future<void> Function() reload) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // NO CONFIRM DIALOG, deliberately, matching the web: revoking is the
      // safe direction. The only thing a mistaken revoke costs is making
      // another key, and the thing it prevents is a leaked key still trading.
      await widget.c.client.revokeApiKey(k.keyId);
      if (!mounted) return;
      setState(() => _busy = false);
      await reload();
      await widget.c.loadBadges();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
      });
    }
  }
}

/// The only time the secret exists outside the venue.
class _SecretScreen extends StatelessWidget {
  // ignore: library_private_types_in_public_api
  const _SecretScreen({required this.key_});
  final NewApiKey key_;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Your new key'),
        automaticallyImplyLeading: false,
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 40),
        children: [
          ExCard(
            tone: ExTone.warn,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Copy the secret now',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 6),
                Text(
                  key_.warning.isEmpty
                      ? 'This is the only time the secret is shown. It is not '
                          'stored anywhere this app or the venue can read it '
                          'back.'
                      : key_.warning,
                  style: const TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 14),
                ExAddressBox(key_.keyId,
                    label: 'Key id', copyLabel: 'Copy key id'),
                const SizedBox(height: 14),
                ExAddressBox(key_.secret,
                    label: 'Secret', copyLabel: 'Copy secret'),
                const SizedBox(height: 10),
                ExField('Access', ExText(key_.scopes.join(', '))),
                ExField('Rate', ExText('${key_.ratePerMin}/min')),
              ],
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('I have saved it'),
          ),
        ],
      ),
    );
  }
}
