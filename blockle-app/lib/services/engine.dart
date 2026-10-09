// Engine — the Blockle crypto core (WASM ML-DSA-44 signer + password vault).
// Native (Android/iOS/desktop) runs it in a headless WebView; web calls the
// in-page window.Engine. Both expose the identical Engine.instance API.
export 'engine_io.dart' if (dart.library.js_interop) 'engine_web.dart';
