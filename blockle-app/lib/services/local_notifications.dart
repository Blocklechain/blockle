// services/local_notifications.dart — a thin wrapper around
// flutter_local_notifications that turns an agent [AgentNotification] into an OS
// banner (iOS UNUserNotificationCenter + Android channel). Kept deliberately
// small and FAIL-SOFT: every method swallows its errors so a missing permission
// or an uninitialized plugin can never break a bot tick or the money path.
//
// It carries only already-public figures (a realized-profit headline) — never
// keys, seeds, or balances. Initialize once from main(); the agent/bot layers
// just call [show] through the controller's notification sink.

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../agent/notify.dart' show AgentNotification;

class LocalNotifications {
  LocalNotifications._();
  static final LocalNotifications instance = LocalNotifications._();

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  bool _ready = false;
  int _id = 0;

  static const AndroidNotificationChannel _channel = AndroidNotificationChannel(
    'blockle_bots',
    'Trading bots',
    description: 'Alerts when a Blockle bot realizes a profit.',
    importance: Importance.high,
  );

  /// Initialize the plugin and request permission. Safe to call more than once;
  /// a failure leaves the service disabled (show() becomes a no-op), never throws.
  Future<void> init() async {
    if (_ready) return;
    try {
      const android = AndroidInitializationSettings('@mipmap/ic_launcher');
      // Don't pop the iOS permission prompt at init — request it explicitly below
      // so the ask is deliberate and we know the outcome.
      const darwin = DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      );
      await _plugin.initialize(const InitializationSettings(
        android: android,
        iOS: darwin,
        macOS: darwin,
      ));
      await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(_channel);
      _ready = true;
    } catch (e) {
      if (kDebugMode) debugPrint('LocalNotifications.init failed: $e');
      _ready = false;
    }
  }

  /// Ask the user for notification permission (iOS alert/badge/sound, Android 13+
  /// POST_NOTIFICATIONS). Returns true if granted (best-effort; false on any error).
  Future<bool> requestPermission() async {
    try {
      final ios = await _plugin
          .resolvePlatformSpecificImplementation<
              IOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, badge: true, sound: true);
      final android = await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
      return (ios ?? android ?? false);
    } catch (e) {
      if (kDebugMode) debugPrint('LocalNotifications.requestPermission failed: $e');
      return false;
    }
  }

  /// Show an OS banner for [n]. No-op (never throws) when the plugin is not ready.
  Future<void> show(AgentNotification n) async {
    if (!_ready) return;
    try {
      const details = NotificationDetails(
        android: AndroidNotificationDetails(
          'blockle_bots', 'Trading bots',
          channelDescription: 'Alerts when a Blockle bot realizes a profit.',
          importance: Importance.high, priority: Priority.high,
        ),
        iOS: DarwinNotificationDetails(presentAlert: true, presentSound: true),
        macOS: DarwinNotificationDetails(presentAlert: true, presentSound: true),
      );
      await _plugin.show(_id++ & 0x7fffffff, n.title, n.subtitle, details,
          payload: n.tag);
    } catch (e) {
      if (kDebugMode) debugPrint('LocalNotifications.show failed: $e');
    }
  }
}
