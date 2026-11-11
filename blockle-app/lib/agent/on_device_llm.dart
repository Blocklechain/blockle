// on_device_llm.dart — a REAL on-device LLM for Blockle Alien chat.
//
// The model (Gemma 3 1B instruction-tuned, int4 ~550 MB) is DOWNLOADED through
// the app (manifest fetched from blockle.org so URLs can rotate without an app
// update), stored in the app's documents dir, and run fully on-device via
// MediaPipe LLM inference (flutter_gemma). Nothing the user types leaves the
// phone in this mode. Fail-soft everywhere: any engine error surfaces as a
// chat-visible message, never a crash — and the chat screen offers the keyless
// hosted brain as the no-download alternative.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_gemma/flutter_gemma.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

enum OnDeviceStatus { none, downloading, downloaded, loading, ready, error }

class ModelInfo {
  const ModelInfo(
      {required this.id, required this.name, required this.sizeMb, required this.url, this.type = 'gemma'});
  final String id;
  final String name;
  final int sizeMb;
  final String url;
  final String type; // 'gemma' | 'qwen' | 'llama' | 'deepseek' | 'general'
}

class OnDeviceLlm extends ChangeNotifier {
  OnDeviceLlm._();
  static final OnDeviceLlm instance = OnDeviceLlm._();

  static const _manifestUrl = 'https://blockle.org/assets/wallet-ai-models.json';
  // Baked-in fallback so the feature works even if the manifest is unreachable.
  static const _fallback = ModelInfo(
    id: 'qwen2.5-1.5b-it',
    name: 'Qwen2.5 1.5B (on-device)',
    sizeMb: 1523,
    url: 'https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task',
    type: 'qwen',
  );

  OnDeviceStatus status = OnDeviceStatus.none;
  double progress = 0; // 0..1 while downloading
  String? error;
  ModelInfo model = _fallback;
  InferenceModel? _inference;

  Future<String> _modelPath() async {
    final dir = await getApplicationDocumentsDirectory();
    return '${dir.path}/${model.id}.task';
  }

  Future<void> init() async {
    try {
      final r = await http
          .get(Uri.parse(_manifestUrl))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode == 200) {
        final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
        final m = ((j['models'] as List?) ?? const []).whereType<Map>().firstOrNull;
        if (m != null && m['url'] is String) {
          model = ModelInfo(
            id: '${m['id'] ?? _fallback.id}',
            name: '${m['name'] ?? _fallback.name}',
            sizeMb: (m['sizeMb'] as num?)?.toInt() ?? _fallback.sizeMb,
            url: m['url'] as String,
            type: '${m['type'] ?? _fallback.type}',
          );
        }
      }
    } catch (_) {/* fallback manifest */}
    final f = File(await _modelPath());
    if (await f.exists() && await f.length() > 50 * 1024 * 1024) {
      status = OnDeviceStatus.downloaded;
    }
    notifyListeners();
  }

  bool get isReady => status == OnDeviceStatus.ready;
  bool get hasModelFile =>
      status == OnDeviceStatus.downloaded || status == OnDeviceStatus.loading || isReady;

  /// Stream-download the model with progress. Resumable-naive (restarts on
  /// failure); writes to a .part file and renames only on a complete body.
  Future<bool> download() async {
    if (status == OnDeviceStatus.downloading) return false;
    status = OnDeviceStatus.downloading;
    progress = 0;
    error = null;
    notifyListeners();
    final path = await _modelPath();
    final part = File('$path.part');
    try {
      final req = http.Request('GET', Uri.parse(model.url));
      final resp = await http.Client().send(req).timeout(const Duration(seconds: 30));
      if (resp.statusCode != 200) throw Exception('download failed (HTTP ${resp.statusCode})');
      final total = resp.contentLength ?? (model.sizeMb * 1024 * 1024);
      final sink = part.openWrite();
      var got = 0;
      await for (final chunk in resp.stream) {
        sink.add(chunk);
        got += chunk.length;
        final p = (got / total).clamp(0.0, 1.0);
        if ((p - progress).abs() > 0.005) {
          progress = p;
          notifyListeners();
        }
      }
      await sink.close();
      if (got < 50 * 1024 * 1024) throw Exception('download incomplete');
      await part.rename(path);
      status = OnDeviceStatus.downloaded;
      progress = 1;
      notifyListeners();
      return true;
    } catch (e) {
      try { await part.delete(); } catch (_) {}
      status = OnDeviceStatus.none;
      error = e.toString().replaceFirst('Exception: ', '');
      notifyListeners();
      return false;
    }
  }

  Future<void> deleteModel() async {
    try { await _inference?.close(); } catch (_) {}
    _inference = null;
    try { await File(await _modelPath()).delete(); } catch (_) {}
    status = OnDeviceStatus.none;
    progress = 0;
    notifyListeners();
  }

  Future<void> _ensureLoaded() async {
    if (_inference != null) return;
    status = OnDeviceStatus.loading;
    notifyListeners();
    final path = await _modelPath();
    await FlutterGemmaPlugin.instance.modelManager.setModelPath(path);
    const typeMap = {
      'qwen': ModelType.qwen,
      'llama': ModelType.llama,
      'deepseek': ModelType.deepSeek,
      'general': ModelType.general,
      'gemma': ModelType.gemmaIt,
    };
    _inference = await FlutterGemmaPlugin.instance.createModel(
      modelType: typeMap[model.type] ?? ModelType.gemmaIt,
      maxTokens: 2048,
    );
    status = OnDeviceStatus.ready;
    notifyListeners();
  }

  /// One grounded turn, fully on-device. A FRESH session per turn keeps the
  /// context deterministic: system + RAG grounding + trimmed history + query.
  Future<String> generate({required String system, required String prompt}) async {
    try {
      await _ensureLoaded();
      final session = await _inference!.createSession(temperature: 0.7, topK: 40);
      try {
        await session.addQueryChunk(Message(text: '$system\n\n$prompt', isUser: true));
        final out = await session.getResponse().timeout(const Duration(minutes: 3));
        return out.trim();
      } finally {
        try { await session.close(); } catch (_) {}
      }
    } catch (e) {
      status = hasModelFile ? OnDeviceStatus.downloaded : OnDeviceStatus.none;
      error = e.toString().replaceFirst('Exception: ', '');
      notifyListeners();
      rethrow;
    }
  }
}
