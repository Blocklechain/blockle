// agent/providers.dart — LLM provider adapters for the in-wallet agent (Dart
// port of blockle-extension/agent/providers.js).
//
// One interface, three implementations: Claude (Anthropic Messages API), OpenAI
// (Chat Completions function-calling), and a Copilot subclass (OpenAI-
// compatible). Each normalizes the provider's native tool-call format to the
// internal shape so agent/runner.dart stays provider-agnostic.
//
// CREDENTIAL HANDLING: the apiKey comes from the encrypted vault only. It is
// used solely to call the chosen provider's own API over TLS, and is NEVER
// written to disk unencrypted or sent to any Blockle server. Wiped from memory
// on lock/kill.
//
// Internal interface:
//   provider.turn({ system, messages, tools }) -> { text?, toolCalls? }
//   messages: [{role:'user', text} |
//              {role:'assistant', text?, toolCalls?} |
//              {role:'tool', results:[{id,name,content,isError}]}]
//   tools:    [{ name, description, parameters /* JSON schema */ }]
//   toolCalls:[{ id, name, arguments /* object */ }]

import 'dart:convert';

const int _defaultMaxTokens = 4096;

/// Operator-overridable default for the keyless hosted-agent gateway.
const String defaultGatewayUrl = 'https://agent.blockle.org';

/// A minimal `fetch`-style HTTP response (keeps providers testable).
class ProviderResponse {
  final bool ok;
  final int status;
  final String body;
  const ProviderResponse(this.ok, this.status, this.body);
}

/// Injectable HTTP transport. Mirrors `fetch(url, {method, headers, body})`.
typedef ProviderFetch = Future<ProviderResponse> Function(
  String url, {
  required String method,
  required Map<String, String> headers,
  required String body,
});

/// Common provider surface.
abstract class LlmProvider {
  String get name;
  Future<Map<String, dynamic>> turn({
    String? system,
    required List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
  });
}

String? _asString(dynamic v) => v == null ? null : '$v';

/// Claude — Anthropic Messages API (native tools / tool_use / tool_result).
class ClaudeProvider implements LlmProvider {
  @override
  final String name = 'claude';
  final String apiKey;
  final String model;
  final String baseUrl;
  final int maxTokens;
  final String version;
  final ProviderFetch fetch;

  ClaudeProvider({
    required this.apiKey,
    required this.fetch,
    String? model,
    String? baseUrl,
    int? maxTokens,
    String? anthropicVersion,
  })  : model = model ?? 'claude-sonnet-4-5',
        baseUrl = (baseUrl ?? 'https://api.anthropic.com')
            .replaceAll(RegExp(r'/$'), ''),
        maxTokens = maxTokens ?? _defaultMaxTokens,
        version = anthropicVersion ?? '2023-06-01';

  List<Map<String, dynamic>> _messages(List<Map<String, dynamic>> messages) {
    final out = <Map<String, dynamic>>[];
    for (final m in messages) {
      final role = m['role'];
      if (role == 'user') {
        out.add({
          'role': 'user',
          'content': [
            {'type': 'text', 'text': m['text']}
          ]
        });
      } else if (role == 'assistant') {
        final content = <Map<String, dynamic>>[];
        if (m['text'] != null) content.add({'type': 'text', 'text': m['text']});
        for (final tc in (m['toolCalls'] as List? ?? const [])) {
          content.add({
            'type': 'tool_use',
            'id': tc['id'],
            'name': tc['name'],
            'input': tc['arguments'] ?? {},
          });
        }
        out.add({'role': 'assistant', 'content': content});
      } else if (role == 'tool') {
        final content = [
          for (final r in (m['results'] as List? ?? const []))
            {
              'type': 'tool_result',
              'tool_use_id': r['id'],
              'content': r['content'] is String
                  ? r['content']
                  : jsonEncode(r['content']),
              'is_error': r['isError'] == true,
            }
        ];
        out.add({'role': 'user', 'content': content});
      }
    }
    return out;
  }

  @override
  Future<Map<String, dynamic>> turn({
    String? system,
    required List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
  }) async {
    final body = <String, dynamic>{
      'model': model,
      'max_tokens': maxTokens,
      'messages': _messages(messages),
    };
    if (system != null) body['system'] = system;
    if (tools != null && tools.isNotEmpty) {
      body['tools'] = tools
          .map((t) => {
                'name': t['name'],
                'description': t['description'],
                'input_schema':
                    t['parameters'] ?? {'type': 'object', 'properties': {}},
              })
          .toList();
    }
    final r = await fetch(
      '$baseUrl/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: jsonEncode(body),
    );
    if (!r.ok) {
      throw StateError('Claude API ${r.status}: ${_clip(r.body)}');
    }
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    var text = '';
    final toolCalls = <Map<String, dynamic>>[];
    for (final b in (j['content'] as List? ?? const [])) {
      if (b['type'] == 'text') {
        text += (b['text'] as String? ?? '');
      } else if (b['type'] == 'tool_use') {
        toolCalls.add({'id': b['id'], 'name': b['name'], 'arguments': b['input'] ?? {}});
      }
    }
    return {
      'text': text.isNotEmpty ? text : null,
      'toolCalls': toolCalls.isNotEmpty ? toolCalls : null,
    };
  }
}

/// OpenAI — Chat Completions function-calling.
class OpenAIProvider implements LlmProvider {
  @override
  final String name;
  final String apiKey;
  final String model;
  final String baseUrl;
  final int maxTokens;
  final Map<String, String> extraHeaders;
  final ProviderFetch fetch;

  OpenAIProvider({
    required this.apiKey,
    required this.fetch,
    String? name,
    String? model,
    String? baseUrl,
    int? maxTokens,
    Map<String, String>? extraHeaders,
  })  : name = name ?? 'openai',
        model = model ?? 'gpt-4.1',
        baseUrl =
            (baseUrl ?? 'https://api.openai.com').replaceAll(RegExp(r'/$'), ''),
        maxTokens = maxTokens ?? _defaultMaxTokens,
        extraHeaders = extraHeaders ?? const {};

  List<Map<String, dynamic>> _messages(
      String? system, List<Map<String, dynamic>> messages) {
    final out = <Map<String, dynamic>>[];
    if (system != null) out.add({'role': 'system', 'content': system});
    for (final m in messages) {
      final role = m['role'];
      if (role == 'user') {
        out.add({'role': 'user', 'content': m['text']});
      } else if (role == 'assistant') {
        final msg = <String, dynamic>{'role': 'assistant', 'content': m['text']};
        final tcs = m['toolCalls'] as List? ?? const [];
        if (tcs.isNotEmpty) {
          msg['tool_calls'] = tcs
              .map((tc) => {
                    'id': tc['id'],
                    'type': 'function',
                    'function': {
                      'name': tc['name'],
                      'arguments': jsonEncode(tc['arguments'] ?? {}),
                    },
                  })
              .toList();
        }
        out.add(msg);
      } else if (role == 'tool') {
        for (final r in (m['results'] as List? ?? const [])) {
          out.add({
            'role': 'tool',
            'tool_call_id': r['id'],
            'content':
                r['content'] is String ? r['content'] : jsonEncode(r['content']),
          });
        }
      }
    }
    return out;
  }

  @override
  Future<Map<String, dynamic>> turn({
    String? system,
    required List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
  }) async {
    final body = <String, dynamic>{
      'model': model,
      'max_tokens': maxTokens,
      'messages': _messages(system, messages),
    };
    if (tools != null && tools.isNotEmpty) {
      body['tools'] = tools
          .map((t) => {
                'type': 'function',
                'function': {
                  'name': t['name'],
                  'description': t['description'],
                  'parameters':
                      t['parameters'] ?? {'type': 'object', 'properties': {}},
                },
              })
          .toList();
    }
    final r = await fetch(
      '$baseUrl/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer $apiKey',
        ...extraHeaders,
      },
      body: jsonEncode(body),
    );
    if (!r.ok) {
      throw StateError('$name API ${r.status}: ${_clip(r.body)}');
    }
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    final choices = j['choices'] as List? ?? const [];
    final msg = (choices.isNotEmpty ? choices[0]['message'] : null) as Map? ?? {};
    final toolCalls = <Map<String, dynamic>>[];
    for (final tc in (msg['tool_calls'] as List? ?? const [])) {
      dynamic args = {};
      try {
        args = jsonDecode(tc['function']['arguments'] as String? ?? '{}');
      } catch (_) {
        args = {'_raw': tc['function']['arguments']};
      }
      toolCalls.add({'id': tc['id'], 'name': tc['function']['name'], 'arguments': args});
    }
    return {
      'text': _asString(msg['content']),
      'toolCalls': toolCalls.isNotEmpty ? toolCalls : null,
    };
  }
}

/// GitHub Copilot — OpenAI-compatible tool calls, own base URL + headers.
class CopilotProvider extends OpenAIProvider {
  CopilotProvider({
    required super.apiKey,
    required super.fetch,
    String? model,
    String? baseUrl,
    Map<String, String>? extraHeaders,
  }) : super(
          name: 'copilot',
          baseUrl: baseUrl ?? 'https://api.githubcopilot.com',
          model: model ?? 'gpt-4.1',
          extraHeaders: {
            'editor-version': 'blockle-wallet/0.1',
            'copilot-integration-id': 'blockle-wallet',
            ...?extraHeaders,
          },
        );
}

String _clip(String s) => s.length > 500 ? s.substring(0, 500) : s;

String _stripTrailingSlash(String s) => s.replaceAll(RegExp(r'/$'), '');

/// Blockle HOSTED gateway (keyless). The BRAIN lives on Blockle's server; this
/// provider is a thin transport. It POSTs the agent conversation to
/// `${gatewayUrl}/agent/turn` with a SESSION TOKEN (NOT an apiKey — the wallet
/// never holds the upstream LLM key) and returns the ALREADY-normalized
/// { text?, toolCalls? } the gateway produces. The runner and the client policy
/// gate are UNCHANGED: a hosted proposal is gated client-side exactly like a
/// BYO-key proposal — the gateway/LLM can never move funds.
///
/// Short-lived sessions are transparently refreshed: on a 401 we call the
/// injected [refresh] once (which re-signs the gateway challenge) and retry.
class HostedProvider implements LlmProvider {
  @override
  final String name = 'hosted';
  final String gatewayUrl;

  /// The short-lived bearer session token. Mutated in place on a transparent
  /// refresh. This is NOT an upstream LLM key — the wallet never holds that.
  String sessionToken;
  final String? model;
  final ProviderFetch fetch;

  /// Re-signs the gateway challenge on expiry; returns a fresh session token (or
  /// null to give up). Null disables transparent refresh.
  final Future<String?> Function()? refresh;

  HostedProvider({
    required String gatewayUrl,
    required String? sessionToken,
    required this.fetch,
    this.model,
    this.refresh,
  })  : gatewayUrl = _stripTrailingSlash(gatewayUrl.isEmpty
            ? (throw ArgumentError('hosted provider requires a gatewayUrl'))
            : gatewayUrl),
        sessionToken = (sessionToken == null || sessionToken.isEmpty)
            ? (throw ArgumentError(
                'hosted provider requires a sessionToken (no apiKey)'))
            : sessionToken;

  Future<Map<String, dynamic>> _post(
    String? system,
    List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
    int attempt,
  ) async {
    // NOTE: we send ONLY sessionToken + the conversation. Never an apiKey, never
    // any wallet key/seed. The gateway injects the upstream key server-side.
    final body = <String, dynamic>{'sessionToken': sessionToken};
    if (system != null) body['system'] = system;
    body['messages'] = messages;
    if (tools != null) body['tools'] = tools;
    if (model != null) body['model'] = model;

    final r = await fetch(
      '$gatewayUrl/agent/turn',
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    if (r.status == 401 && refresh != null && attempt < 1) {
      final tok = await refresh!();
      if (tok != null) {
        sessionToken = tok;
        return _post(system, messages, tools, attempt + 1);
      }
    }
    if (!r.ok) {
      throw StateError('hosted agent gateway ${r.status}: ${_clip(r.body)}');
    }
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    // The gateway already returns the common shape; re-normalize defensively so
    // the runner always sees { text?, toolCalls? } with the exact field names.
    final rawCalls = j['toolCalls'];
    final toolCalls = <Map<String, dynamic>>[];
    if (rawCalls is List) {
      for (final tc in rawCalls) {
        toolCalls.add({
          'id': tc['id'],
          'name': tc['name'],
          'arguments': tc['arguments'] ?? {},
        });
      }
    }
    final t = j['text'];
    return {
      'text': (t == null || t == '') ? null : t,
      'toolCalls': toolCalls.isNotEmpty ? toolCalls : null,
    };
  }

  @override
  Future<Map<String, dynamic>> turn({
    String? system,
    required List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
  }) =>
      _post(system, messages, tools, 0);
}

/// The stored hosted connection record (vault-sealed by the wallet). Holds NO
/// upstream LLM key — only a short-lived [sessionToken] + non-secret transport
/// metadata. Transparently refreshed via [applyRefresh] on expiry. Mirrors the
/// `provider:'hosted'` record in agent-store.js.
class HostedConnection {
  final String credRef;
  final String gatewayUrl;
  String sessionToken;
  int? expiresAt;
  final String? address;
  final String? chain;
  final String? publicKey;
  final String? model;
  final String label;
  final int createdAt;

  HostedConnection({
    required this.credRef,
    required String gatewayUrl,
    required String sessionToken,
    this.expiresAt,
    this.address,
    this.chain,
    this.publicKey,
    this.model,
    String? label,
    int? createdAt,
  })  : gatewayUrl = _stripTrailingSlash(gatewayUrl.isEmpty
            ? (throw ArgumentError(
                'a gatewayUrl is required for a hosted connection'))
            : gatewayUrl),
        sessionToken = sessionToken.isEmpty
            ? (throw ArgumentError(
                'a sessionToken is required for a hosted connection'))
            : sessionToken,
        label = label ?? 'Blockle hosted agent',
        createdAt = createdAt ?? DateTime.now().millisecondsSinceEpoch;

  /// Build from the result of [hostedSession].
  factory HostedConnection.fromSession(
    Map<String, dynamic> sess, {
    String? credRef,
    String? model,
  }) =>
      HostedConnection(
        credRef: credRef ?? _rid(),
        gatewayUrl: sess['gatewayUrl'] as String,
        sessionToken: sess['sessionToken'] as String,
        expiresAt: (sess['expiresAt'] as num?)?.toInt(),
        address: sess['address'] as String?,
        chain: sess['chain'] as String?,
        publicKey: sess['publicKey'] as String?,
        model: model,
        label: sess['label'] as String?,
      );

  /// Transparent refresh: update the session token (and expiry) in place after a
  /// re-sign. The wallet re-seals the record afterwards.
  void applyRefresh(String newSessionToken, [int? newExpiresAt]) {
    sessionToken = newSessionToken;
    if (newExpiresAt != null) expiresAt = newExpiresAt;
  }

  /// Secret-free view for the UI: the short-lived [sessionToken] is NEVER
  /// included — only non-secret transport metadata.
  Map<String, dynamic> secretFreeView() => {
        'credRef': credRef,
        'provider': 'hosted',
        'gatewayUrl': gatewayUrl,
        'expiresAt': expiresAt,
        'model': model,
        'label': label,
        'createdAt': createdAt,
      };

  /// The full transport credential (incl. the session token) handed to the
  /// provider at run time. There is NO apiKey — a hosted cred never holds one.
  Map<String, dynamic> resolve() => {
        'provider': 'hosted',
        'gatewayUrl': gatewayUrl,
        'sessionToken': sessionToken,
        'expiresAt': expiresAt,
        'model': model,
        'address': address,
        'chain': chain,
        'publicKey': publicKey,
      };

  /// Full serialization for the vault seal (round-trips with [fromSealed]).
  Map<String, dynamic> toSealed() => {
        'credRef': credRef,
        'provider': 'hosted',
        'gatewayUrl': gatewayUrl,
        'sessionToken': sessionToken,
        'expiresAt': expiresAt,
        'address': address,
        'chain': chain,
        'publicKey': publicKey,
        'model': model,
        'label': label,
        'createdAt': createdAt,
      };

  factory HostedConnection.fromSealed(Map<String, dynamic> m) =>
      HostedConnection(
        credRef: m['credRef'] as String,
        gatewayUrl: m['gatewayUrl'] as String,
        sessionToken: m['sessionToken'] as String,
        expiresAt: (m['expiresAt'] as num?)?.toInt(),
        address: m['address'] as String?,
        chain: m['chain'] as String?,
        publicKey: m['publicKey'] as String?,
        model: m['model'] as String?,
        label: m['label'] as String?,
        createdAt: (m['createdAt'] as num?)?.toInt(),
      );
}

int _ridCounter = 0;
String _rid() =>
    'cr_${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}_${(_ridCounter++).toRadixString(36)}';

/// Wallet-signature session handshake against the gateway. [sign] is the
/// wallet's own signer — it returns { signature, publicKey } and proves control
/// of an address (NOT a spend). Returns the stored hosted connection fields as a
/// plain map (feed it to [HostedConnection.fromSession]). Mirrors
/// `AgentProviders.hostedSession`.
///
/// The wallet sends NO apiKey / private key / seed — only a signature over a
/// server nonce + the public key. The upstream LLM key stays server-side.
Future<Map<String, dynamic>> hostedSession({
  required ProviderFetch fetch,
  String? gatewayUrl,
  String? address,
  String? chain,
  String? publicKey,
  String? label,
  bool anon = false,
  Future<dynamic> Function(String challenge)? sign,
}) async {
  final base = _stripTrailingSlash(gatewayUrl ?? '');
  if (base.isEmpty) throw ArgumentError('hostedSession requires a gatewayUrl');
  final ch = chain ?? 'block';

  Future<Map<String, dynamic>> postJson(Map<String, dynamic> bodyObj) async {
    final r = await fetch(
      '$base/agent/session',
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: jsonEncode(bodyObj),
    );
    Map<String, dynamic> j;
    try {
      j = jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      j = {};
    }
    if (!r.ok) {
      throw StateError('hosted session ${r.status}: ${j['error'] ?? ''}');
    }
    return j;
  }

  // Anonymous fallback: no address/signer -> rate-limited free-tier token.
  if (anon || sign == null) {
    final a = await postJson({'step': 'anon'});
    return {
      'gatewayUrl': base,
      'sessionToken': a['sessionToken'],
      'expiresAt': a['expiresAt'],
      'quota': a['quota'],
      'chain': 'anon',
      'label': label ?? 'Blockle hosted (anon)',
    };
  }

  final chResp =
      await postJson({'step': 'challenge', 'address': address, 'chain': ch});
  final challenge = chResp['challenge'];
  final signed = await sign('$challenge');
  String signature;
  String pub;
  if (signed is String) {
    signature = signed;
    pub = publicKey ?? '';
  } else if (signed is Map) {
    signature = '${signed['signature'] ?? signed['sig'] ?? ''}';
    pub = '${signed['publicKey'] ?? publicKey ?? ''}';
  } else {
    signature = '';
    pub = publicKey ?? '';
  }
  final v = await postJson({
    'step': 'verify',
    'address': address,
    'chain': ch,
    'challenge': challenge,
    'signature': signature,
    'publicKey': pub,
  });
  return {
    'gatewayUrl': base,
    'sessionToken': v['sessionToken'],
    'expiresAt': v['expiresAt'],
    'quota': v['quota'],
    'address': address,
    'chain': ch,
    'publicKey': pub,
    'label': label ?? 'Blockle hosted agent',
  };
}

/// Factory mirroring `AgentProviders.create`.
///
/// The HOSTED provider is keyless: it needs a [gatewayUrl] + [sessionToken], NOT
/// an [apiKey]. Every other (BYO-key) provider still requires an apiKey from the
/// vault. This is the ONLY place a provider is instantiated.
LlmProvider createProvider({
  required String? provider,
  String? apiKey,
  required ProviderFetch fetch,
  String? model,
  String? baseUrl,
  int? maxTokens,
  String? gatewayUrl,
  String? sessionToken,
  Future<String?> Function()? refresh,
}) {
  if (provider == 'hosted') {
    return HostedProvider(
      gatewayUrl: gatewayUrl ?? defaultGatewayUrl,
      sessionToken: sessionToken,
      fetch: fetch,
      model: model,
      refresh: refresh,
    );
  }
  if (apiKey == null || apiKey.isEmpty) {
    throw ArgumentError('provider requires an apiKey (from the vault)');
  }
  switch (provider) {
    case 'claude':
      return ClaudeProvider(
          apiKey: apiKey, fetch: fetch, model: model, baseUrl: baseUrl, maxTokens: maxTokens);
    case 'openai':
      return OpenAIProvider(
          apiKey: apiKey, fetch: fetch, model: model, baseUrl: baseUrl, maxTokens: maxTokens);
    case 'copilot':
      return CopilotProvider(
          apiKey: apiKey, fetch: fetch, model: model, baseUrl: baseUrl);
    default:
      throw ArgumentError('unknown provider: $provider');
  }
}
