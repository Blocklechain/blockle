// Open an external URL in a new tab on web; no-op on native.
export 'open_url_stub.dart' if (dart.library.js_interop) 'open_url_web.dart';
