import 'package:app_links/app_links.dart';

import '../economy/economy.dart';

/// Receives the wallet's settlement callbacks (blocklings://settle?req=…&status=
/// ok&tx=…&nftId=…) and routes them to the economy to confirm mints / vendor
/// payments. Best-effort: never throws, so the game runs fine with no callbacks.
class DeepLinkService {
  DeepLinkService._();
  static final DeepLinkService instance = DeepLinkService._();

  final AppLinks _appLinks = AppLinks();

  Future<void> init() async {
    try {
      final initial = await _appLinks.getInitialLink();
      if (initial != null) _handle(initial);
    } catch (_) {}
    try {
      _appLinks.uriLinkStream.listen(_handle, onError: (_) {});
    } catch (_) {}
  }

  void _handle(Uri uri) {
    if (uri.scheme != EconomyService.callbackScheme) return;
    EconomyService.instance.onSettlement(uri);
  }
}
