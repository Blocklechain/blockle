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

/// Factory mirroring `AgentProviders.create`.
LlmProvider createProvider({
  required String? provider,
  required String? apiKey,
  required ProviderFetch fetch,
  String? model,
  String? baseUrl,
  int? maxTokens,
}) {
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
