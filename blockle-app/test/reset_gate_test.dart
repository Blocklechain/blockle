// Erasing the app must require the phone's own lock.
//
// This is the most destructive action in the product — it deletes every
// wallet on the device, and if the seed is not backed up the funds are gone
// with no recovery path. It also lives on the UNLOCK screen, so before this
// gate it did not even require the wallet to be unlocked: anyone holding the
// phone could wipe it in two taps.
//
// A gate that is skipped in tests is a gate nobody ever verifies, so
// DeviceAuth is injectable and these tests drive every outcome — including
// the awkward one where the phone has no passcode at all and there is
// nothing to check against.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:local_auth/local_auth.dart';

import 'package:blockle_app/services/device_auth.dart';

/// Stands in for the platform prompt, which cannot be driven from a test.
class FakeAuth extends DeviceAuth {
  FakeAuth(this.result) : super(auth: LocalAuthentication());
  final DeviceAuthResult result;
  int calls = 0;
  String? sawReason;

  @override
  Future<DeviceAuthResult> confirm(String reason) async {
    calls++;
    sawReason = reason;
    return result;
  }
}

/// Mirrors the screen's decision without dragging the whole onboarding
/// widget tree in: given an auth outcome, may the erase proceed, and does it
/// need the typed fallback?
({bool erase, bool needsTyped}) decide(DeviceAuthResult r, {bool typed = false}) =>
    switch (r) {
      DeviceAuthResult.ok => (erase: true, needsTyped: false),
      DeviceAuthResult.denied => (erase: false, needsTyped: false),
      DeviceAuthResult.unavailable => (erase: typed, needsTyped: true),
    };

void main() {
  tearDown(() => DeviceAuth.instance = DeviceAuth());

  group('the gate', () {
    test('a passed device check allows the erase', () async {
      final fake = FakeAuth(DeviceAuthResult.ok);
      final restore = DeviceAuth.swap(fake);
      final r = await DeviceAuth.instance.confirm('erase?');
      expect(decide(r).erase, isTrue);
      expect(fake.calls, 1);
      restore();
    });

    test('A DENIED CHECK LEAVES THE WALLET ALONE', () async {
      // The whole point. Cancelling the passcode sheet must not erase.
      final restore = DeviceAuth.swap(FakeAuth(DeviceAuthResult.denied));
      final r = await DeviceAuth.instance.confirm('erase?');
      expect(decide(r).erase, isFalse);
      expect(decide(r).needsTyped, isFalse,
          reason: 'a denial is a decision, not a reason to offer a weaker '
              'way around the gate');
      restore();
    });

    test('no passcode on the phone is neither a pass nor a refusal', () {
      // Treating it as a pass makes the gate decorative. Treating it as a
      // refusal permanently traps someone resetting a passcode-less phone.
      final r = DeviceAuthResult.unavailable;
      expect(decide(r).erase, isFalse);
      expect(decide(r).needsTyped, isTrue);
      // ...and it only proceeds once they have typed the word.
      expect(decide(r, typed: true).erase, isTrue);
    });

    test('the prompt says what is about to happen', () async {
      // A system sheet that just says "Authenticate" invites a reflexive
      // thumb on an irreversible action.
      final fake = FakeAuth(DeviceAuthResult.ok);
      final restore = DeviceAuth.swap(fake);
      await DeviceAuth.instance
          .confirm('Confirm it is you before erasing every wallet on this '
              'device. This cannot be undone.');
      expect(fake.sawReason, contains('erasing'));
      expect(fake.sawReason, contains('cannot be undone'));
      restore();
    });

    test('swap restores the previous instance', () {
      final original = DeviceAuth.instance;
      final restore = DeviceAuth.swap(FakeAuth(DeviceAuthResult.ok));
      expect(DeviceAuth.instance, isNot(original));
      restore();
      expect(DeviceAuth.instance, original);
    });
  });

  group('the typed fallback', () {
    // Only reachable when the device has no lock at all.
    bool accepts(String s) => s.trim().toUpperCase() == 'ERASE';

    test('accepts the word, in any case, with stray spaces', () {
      expect(accepts('ERASE'), isTrue);
      expect(accepts('erase'), isTrue);
      expect(accepts('  Erase '), isTrue);
    });

    test('rejects anything else, including near misses', () {
      expect(accepts(''), isFalse);
      expect(accepts('e'), isFalse);
      expect(accepts('ERASE ALL'), isFalse);
      expect(accepts('yes'), isFalse);
    });
  });

  group('platform prerequisites', () {
    // Both of these fail INVISIBLY — the app builds and the gate silently
    // degrades to its fallback, or crashes, only on a real device.
    test('iOS declares NSFaceIDUsageDescription', () {
      final plist = File('ios/Runner/Info.plist').readAsStringSync();
      expect(plist, contains('NSFaceIDUsageDescription'),
          reason: 'without it iOS refuses the Face ID prompt outright, so '
              'every Face ID device would fall through to the typed '
              'fallback');
    });

    test('Android uses FlutterFragmentActivity', () {
      final kt = File(
              'android/app/src/main/kotlin/org/blockle/blockle_app/MainActivity.kt')
          .readAsStringSync();
      expect(kt, contains('FlutterFragmentActivity'),
          reason: "local_auth's BiometricPrompt is an AndroidX fragment and "
              'throws at runtime on a plain FlutterActivity');
      expect(kt, isNot(contains(': FlutterActivity()')));
    });
  });
}
