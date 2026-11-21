package org.blockle.blockle_app

import io.flutter.embedding.android.FlutterFragmentActivity

// FlutterFragmentActivity, NOT FlutterActivity: local_auth's BiometricPrompt
// is an AndroidX fragment and throws at runtime on a plain FlutterActivity.
// The failure is invisible until someone actually taps "Reset app" on a real
// Android device, which is exactly where a wallet-erase gate must not break.
class MainActivity : FlutterFragmentActivity()
