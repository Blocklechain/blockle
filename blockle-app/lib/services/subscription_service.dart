// Blockle Copilot subscription via in-app purchase (Apple StoreKit / Google Play Billing).
//
// Purchases are NEVER trusted on the device: the store receipt is sent to the accounts service
// (/account/api/iap/{apple,google}/verify), which verifies it with the provider and returns the
// authoritative entitlement. The resulting effective tier is handed back via [onEntitlement] so
// the app can unlock live bots (BotsController.setLiveEntitled). The 7-day free trial is a
// separate server call (no payment). Web builds use the PayPal flow instead and never touch this.
import 'dart:async';
import 'dart:io' show Platform;

import 'package:in_app_purchase/in_app_purchase.dart';

import '../multichain/backup_client.dart' as bc;

/// Store product ids — must match App Store Connect / Play Console AND the accounts-service
/// config (APPLE_COPILOT_PRODUCT etc.). Apple uses reverse-DNS ids; Google uses short ids.
class CopilotProducts {
  static const appleCopilot = 'org.blockle.copilot.monthly';
  static const appleCopilotPro = 'org.blockle.copilotpro.monthly';
  static const googleCopilot = 'copilot_monthly';
  static const googleCopilotPro = 'copilotpro_monthly';

  static String copilot() => Platform.isIOS ? appleCopilot : googleCopilot;
  static String copilotPro() => Platform.isIOS ? appleCopilotPro : googleCopilotPro;
  static Set<String> all() => {copilot(), copilotPro()};
}

class SubscriptionService {
  SubscriptionService({
    required this.tokenProvider,
    required this.onEntitlement,
    this.originProvider,
    InAppPurchase? iap,
  }) : _iap = iap ?? InAppPurchase.instance;

  /// Returns the signed-in blockle.org account bearer token (or null if not linked).
  final String? Function() tokenProvider;
  /// Account-service origin (defaults to the shared constant).
  final String? Function()? originProvider;
  /// Called with the server's effective tier ('free'|'copilot'|'copilot_pro') after any change.
  final void Function(String tier) onEntitlement;

  final InAppPurchase _iap;
  StreamSubscription<List<PurchaseDetails>>? _sub;
  String? _lastError;
  String? get lastError => _lastError;

  String? get _origin => originProvider?.call();

  /// Begin listening to the purchase stream. Safe to call once at startup.
  void start() {
    _sub ??= _iap.purchaseStream.listen(
      _onPurchases,
      onError: (Object e) { _lastError = '$e'; },
    );
  }

  Future<bool> available() => _iap.isAvailable();

  /// Fetch displayable product details (price strings, titles) for the paywall.
  Future<List<ProductDetails>> products() async {
    if (!await _iap.isAvailable()) return const [];
    final resp = await _iap.queryProductDetails(CopilotProducts.all());
    return resp.productDetails;
  }

  /// Launch the store purchase sheet for a product. Entitlement arrives asynchronously on the
  /// purchase stream, verified server-side. Returns false if the store is unavailable/unknown.
  Future<bool> buy(String productId) async {
    _lastError = null;
    if (!await _iap.isAvailable()) { _lastError = 'Store unavailable'; return false; }
    final resp = await _iap.queryProductDetails({productId});
    if (resp.productDetails.isEmpty) { _lastError = 'Unknown product: $productId'; return false; }
    final param = PurchaseParam(productDetails: resp.productDetails.first);
    // Subscriptions are modeled as non-consumables by the plugin on both stores.
    return _iap.buyNonConsumable(purchaseParam: param);
  }

  /// Restore previous purchases (required by App Store review). Verified entries re-entitle.
  Future<void> restore() => _iap.restorePurchases();

  /// Start the one-time 7-day Copilot free trial (server-side, no payment). Returns the tier.
  Future<String> startFreeTrial() async {
    final token = tokenProvider();
    if (token == null) { _lastError = 'Link your blockle.org account first'; return 'free'; }
    final sub = await bc.startTrial(_origin, token);
    final tier = bc.tierOf({'sub': sub});
    onEntitlement(tier);
    return tier;
  }

  Future<void> _onPurchases(List<PurchaseDetails> purchases) async {
    for (final p in purchases) {
      if (p.status == PurchaseStatus.purchased || p.status == PurchaseStatus.restored) {
        await _verify(p);
      } else if (p.status == PurchaseStatus.error) {
        _lastError = p.error?.message ?? 'purchase error';
      }
      // Always finish the transaction so the store stops re-delivering it.
      if (p.pendingCompletePurchase) {
        try { await _iap.completePurchase(p); } catch (_) {}
      }
    }
  }

  Future<void> _verify(PurchaseDetails p) async {
    final token = tokenProvider();
    if (token == null) { _lastError = 'Sign in to activate your purchase'; return; }
    try {
      final sv = p.verificationData.serverVerificationData;
      final sub = Platform.isIOS
          ? await bc.verifyAppleIap(_origin, token, sv)
          : await bc.verifyGoogleIap(_origin, token, p.productID, sv);
      onEntitlement(bc.tierOf({'sub': sub}));
    } catch (e) {
      _lastError = 'Could not activate purchase: $e';
    }
  }

  void dispose() { _sub?.cancel(); _sub = null; }
}
