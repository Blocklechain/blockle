import 'dart:js_interop';

@JS('window.open')
external JSAny? _windowOpen(JSString url, JSString target);

/// Open [url] in a new browser tab (web only).
void openExternal(String url) => _windowOpen(url.toJS, '_blank'.toJS);
