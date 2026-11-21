// The phone's own lock, used to gate the one action that cannot be undone.
//
// WHY ERASING NEEDS THIS. "Reset app" deletes every wallet on the device. If
// the seed is not backed up elsewhere, that is the funds gone — there is no
// support ticket that recovers them. And the button lives on the UNLOCK
// screen, so until now it did not even require the wallet to be unlocked:
// anyone holding the phone for ten seconds could wipe it in two taps.
//
// So the gate is the device credential — Face ID, Touch ID, or the phone
// passcode. `biometricOnly: false` is deliberate and is the whole point: a
// user whose face is not recognised, or whose phone has no biometrics at
// all, must still be able to authenticate with the passcode they already
// know. Requiring biometrics specifically would lock people out of their own
// device.
//
// WHAT HAPPENS WITH NO DEVICE LOCK AT ALL is the case worth thinking about,
// because it is the one that invites a silently-wrong answer. Returning
// "authenticated" would make the gate decorative. Returning "denied" would
// permanently trap someone who genuinely wants to reset a passcode-less
// phone. So it is reported as its OWN outcome and the caller falls back to a
// typed confirmation — see DeviceAuthResult.unavailable.

import 'package:flutter/foundation.dart';
import 'package:local_auth/local_auth.dart';

enum DeviceAuthResult {
  /// The user proved they hold the device.
  ok,

  /// They cancelled, or failed the check.
  denied,

  /// This device has no passcode or biometric set up, so there is nothing to
  /// check against. NOT a pass and NOT a failure — the caller must gate on
  /// something else rather than treating it as either.
  unavailable,
}

/// Wraps the platform biometric/passcode prompt.
///
/// An injectable singleton so screens can be tested without a device: the
/// prompt cannot be driven from a widget test, and a gate that is skipped in
/// tests is a gate nobody ever verifies.
class DeviceAuth {
  DeviceAuth({LocalAuthentication? auth})
      : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  static DeviceAuth instance = DeviceAuth();

  /// Replace for tests. Returns a restore function so a test cannot leak its
  /// fake into the next one.
  @visibleForTesting
  static void Function() swap(DeviceAuth fake) {
    final prev = instance;
    instance = fake;
    return () => instance = prev;
  }

  /// Ask the user to prove they hold this device.
  ///
  /// [reason] is shown in the system sheet, so it must say what is about to
  /// happen in the user's terms — a prompt that just says "Authenticate"
  /// invites a reflexive thumb on a destructive action.
  Future<DeviceAuthResult> confirm(String reason) async {
    try {
      // isDeviceSupported() is false on a device with NO passcode at all,
      // which is exactly the case that must not be mistaken for a pass.
      final supported = await _auth.isDeviceSupported();
      if (!supported) return DeviceAuthResult.unavailable;

      final ok = await _auth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(
          // FALSE ON PURPOSE: accept the phone passcode, not just a face.
          // Biometric-only would lock out anyone whose face is not
          // recognised or whose phone has no biometric hardware.
          biometricOnly: false,
          stickyAuth: true,
          useErrorDialogs: true,
        ),
      );
      return ok ? DeviceAuthResult.ok : DeviceAuthResult.denied;
    } catch (_) {
      // A platform error must never read as success. Treated as unavailable
      // so the caller falls back to a typed confirmation rather than either
      // wiping the wallet or trapping the user.
      return DeviceAuthResult.unavailable;
    }
  }
}
