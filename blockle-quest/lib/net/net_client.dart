import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// Another player's last-known presence.
class RemoteState {
  double x;
  double y;
  int lvl;
  String name;
  RemoteState(this.x, this.y, this.lvl, this.name);
}

/// Thin realtime client for the Blocklings presence relay. Best-effort: if the
/// server is unreachable the game simply runs single-player. Non-custodial — the
/// relay carries presence/chat only, never keys or value.
class NetClient {
  WebSocketChannel? _ch;
  bool connected = false;
  String myId = '';
  final Map<String, RemoteState> remotes = {};
  void Function(String name, String msg)? onChat;

  /// Default endpoint (served via nginx -> the relay service). Overridable.
  static const String defaultUrl = 'wss://blockle.org/blocklings/ws';

  Future<void> connect(String url, {String name = 'wanderer'}) async {
    try {
      final ch = WebSocketChannel.connect(Uri.parse(url));
      _ch = ch;
      connected = true;
      ch.stream.listen(_onData, onError: (_) => _down(), onDone: _down, cancelOnError: true);
      _send({'t': 'join', 'name': name});
    } catch (_) {
      _down();
    }
  }

  void _down() {
    connected = false;
    _ch = null;
    remotes.clear();
  }

  void _send(Map<String, dynamic> m) {
    try {
      _ch?.sink.add(jsonEncode(m));
    } catch (_) {/* dropped */}
  }

  void sendPos(double x, double y, int lvl) {
    if (connected) _send({'t': 'pos', 'x': x, 'y': y, 'lvl': lvl});
  }

  void sendChat(String msg) {
    if (connected) _send({'t': 'chat', 'msg': msg});
  }

  void _onData(dynamic raw) {
    Map<String, dynamic> m;
    try {
      m = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (m['t']) {
      case 'welcome':
        myId = (m['id'] ?? '').toString();
      case 'pos':
        final id = (m['id'] ?? '').toString();
        if (id.isEmpty || id == myId) return;
        final r = remotes.putIfAbsent(id, () => RemoteState(0, 0, 1, ''));
        r.x = (m['x'] as num).toDouble();
        r.y = (m['y'] as num).toDouble();
        r.lvl = (m['lvl'] as num?)?.toInt() ?? r.lvl;
        r.name = (m['name'] ?? r.name).toString();
      case 'left':
        remotes.remove((m['id'] ?? '').toString());
      case 'chat':
        onChat?.call((m['name'] ?? '').toString(), (m['msg'] ?? '').toString());
    }
  }

  void dispose() {
    try {
      _ch?.sink.close();
    } catch (_) {}
    _down();
  }
}
