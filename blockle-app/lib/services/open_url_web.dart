import 'dart:js_interop';

@JS('window.open')
external JSAny? _windowOpen(JSString url, JSString target);

/// Open [url] in a new browser tab (web only).
void openExternal(String url) => _windowOpen(url.toJS, '_blank'.toJS);

/// Parity with the native stub (unused on web — links open a browser tab).
void Function(String url)? openExternalHandler;
