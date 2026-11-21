// A bad URL scheme in Info.plist blocks every TestFlight upload, silently.
//
// THE BUG THIS EXISTS FOR. A `blockle_app` scheme was added to Info.plist
// "for backward compatibility" alongside the real `blockle` one. Underscores
// are not legal in a URL scheme — RFC1738 allows an alphabetic first
// character then alphanumerics, '.', '-' and '+' — so Apple rejected every
// upload with ITMS-90158.
//
// What made it expensive is WHERE it failed. The app compiled, the archive
// exported, the IPA was produced and uploaded as a CI artifact, and the whole
// test suite passed. The rejection happened in altool, fifteen minutes into
// the job, in the last step. Two releases were lost to it before anyone read
// far enough into the log.
//
// Nothing here needs a device or a Mac: it is a regex over a plist. That is
// precisely why it belongs in the suite rather than in the build.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// RFC1738: scheme = alpha *( alpha | digit | "+" | "-" | "." )
final _validScheme = RegExp(r'^[A-Za-z][A-Za-z0-9.+-]*$');

/// Minimal plist reader for the one array we care about. Avoids adding a
/// plist dependency to the app for a test.
List<String> _urlSchemes(String xml) {
  final out = <String>[];
  // Each <key>CFBundleURLSchemes</key> is followed by its <array>.
  final re = RegExp(
      r'<key>CFBundleURLSchemes</key>\s*<array>(.*?)</array>', dotAll: true);
  for (final m in re.allMatches(xml)) {
    for (final s
        in RegExp(r'<string>(.*?)</string>').allMatches(m.group(1)!)) {
      out.add(s.group(1)!.trim());
    }
  }
  return out;
}

void main() {
  final plist = File('ios/Runner/Info.plist');

  test('Info.plist exists and declares the dApp scheme', () {
    expect(plist.existsSync(), isTrue);
    final schemes = _urlSchemes(plist.readAsStringSync());
    // dapp_link.dart acts on exactly this one; losing it breaks the Idle
    // game's mint handshake.
    expect(schemes, contains('blockle'));
  });

  test('EVERY URL scheme is one Apple will accept', () {
    final schemes = _urlSchemes(plist.readAsStringSync());
    expect(schemes, isNotEmpty);
    for (final s in schemes) {
      expect(_validScheme.hasMatch(s), isTrue,
          reason: 'URL scheme "$s" is not RFC1738-legal, so App Store '
              'Connect will reject the upload with ITMS-90158. Schemes must '
              'start with a letter and contain only letters, digits, ".", '
              '"-" or "+". Underscores are the usual culprit.');
    }
  });

  test('specifically, no underscores — the mistake that actually shipped', () {
    final schemes = _urlSchemes(plist.readAsStringSync());
    expect(schemes.where((s) => s.contains('_')), isEmpty,
        reason: 'an underscored scheme blocked two releases at the altool '
            'step, after a successful build and archive');
  });
}
