// The splash logo must stand up.
//
// The GLB was exported from Blender with the curve lying flat — glTF is Y-up,
// and the mark's thin extrusion axis came out as Y, so the logo rendered
// face-down and model-viewer's auto-rotate spun it flat like a coin on a
// table. It never corrected itself, because autoRotate only moves the
// camera's azimuth; the polar angle stays at 78deg forever.
//
// The fix is baked into the asset (a node rotation) rather than into the
// widget, so every consumer of the GLB gets an upright logo. That makes this
// a test about a BINARY ASSET, which is exactly the kind of thing that
// regresses silently: someone re-exports from Blender six months from now,
// forgets the +Y-up checkbox, the app still builds, every test still passes,
// and the logo is on its side again on the first screen of the app.
//
// So this test reads the actual shipped .glb and checks the geometry.

import 'dart:io';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';

/// Minimal GLB reader — enough to get the JSON chunk and the mesh bounds.
({Map<String, dynamic> json}) _readGlb(File f) {
  final b = f.readAsBytesSync();
  final d = ByteData.sublistView(b);
  expect(d.getUint32(0, Endian.little), 0x46546C67, reason: 'glTF magic');
  expect(d.getUint32(4, Endian.little), 2, reason: 'glTF version 2');
  expect(d.getUint32(8, Endian.little), b.length,
      reason: 'declared GLB length must match the file — a hand-edited GLB '
          'with a stale header fails to load at runtime but not at build');

  Map<String, dynamic>? json;
  var off = 12;
  while (off < b.length) {
    final len = d.getUint32(off, Endian.little);
    final type = d.getUint32(off + 4, Endian.little);
    if (type == 0x4E4F534A) {
      json = jsonDecode(utf8.decode(b.sublist(off + 8, off + 8 + len)));
    }
    // Chunks are 4-byte aligned; a misaligned chunk means a bad rewrite.
    expect(len % 4, 0, reason: 'chunk length must be 4-byte aligned');
    off += 8 + len;
  }
  expect(off, b.length, reason: 'chunk lengths must tile the file exactly');
  return (json: json!);
}

/// Rotate a vector by a glTF quaternion [x, y, z, w].
List<double> _rotate(List<double> q, List<double> v) {
  final x = q[0], y = q[1], z = q[2], w = q[3];
  return [
    (1 - 2 * (y * y + z * z)) * v[0] +
        (2 * (x * y - z * w)) * v[1] +
        (2 * (x * z + y * w)) * v[2],
    (2 * (x * y + z * w)) * v[0] +
        (1 - 2 * (x * x + z * z)) * v[1] +
        (2 * (y * z - x * w)) * v[2],
    (2 * (x * z - y * w)) * v[0] +
        (2 * (y * z + x * w)) * v[1] +
        (1 - 2 * (x * x + y * y)) * v[2],
  ];
}

void main() {
  final file = File('assets/model/blockle_logo.glb');

  test('the logo GLB is a well-formed glTF 2.0 binary', () {
    expect(file.existsSync(), isTrue,
        reason: 'the splash renders this exact path');
    _readGlb(file);
  });

  test('the mark stands upright — its thin axis points at the viewer', () {
    final g = _readGlb(file).json;

    final nodes = (g['nodes'] as List).cast<Map<String, dynamic>>();
    final node = nodes.first;
    final acc = (g['accessors'] as List).cast<Map<String, dynamic>>();
    final prim = ((g['meshes'] as List).first
        as Map<String, dynamic>)['primitives'][0] as Map<String, dynamic>;
    final pos = acc[prim['attributes']['POSITION'] as int];

    final mn = (pos['min'] as List).map((e) => (e as num).toDouble()).toList();
    final mx = (pos['max'] as List).map((e) => (e as num).toDouble()).toList();

    // Orientation may be carried by the node rotation (how we fixed it) or
    // baked into the vertices by a future re-export. Either is fine — the
    // test checks the RESULT, not the mechanism.
    final q = node['rotation'] == null
        ? const [0.0, 0.0, 0.0, 1.0]
        : (node['rotation'] as List).map((e) => (e as num).toDouble()).toList();
    expect(node['matrix'], isNull,
        reason: 'a node matrix would bypass the rotation this test reads');

    // Transform the 8 corners of the local AABB and measure the world extent.
    var lo = [double.infinity, double.infinity, double.infinity];
    var hi = [-double.infinity, -double.infinity, -double.infinity];
    for (final cx in [mn[0], mx[0]]) {
      for (final cy in [mn[1], mx[1]]) {
        for (final cz in [mn[2], mx[2]]) {
          final p = _rotate(q, [cx, cy, cz]);
          for (var i = 0; i < 3; i++) {
            lo[i] = math.min(lo[i], p[i]);
            hi[i] = math.max(hi[i], p[i]);
          }
        }
      }
    }
    final w = hi[0] - lo[0], h = hi[1] - lo[1], depth = hi[2] - lo[2];

    // THE ACTUAL BUG. The mark is a flat extruded curve, so its smallest
    // extent is the extrusion depth. If that smallest axis is Y, the logo is
    // lying on its back on the ground plane — which is precisely what shipped.
    expect(depth, lessThan(w),
        reason: 'the logo is lying down: its thinnest axis is not depth. '
            'Re-export from Blender with +Y up, or restore the node rotation.');
    expect(depth, lessThan(h),
        reason: 'the logo is lying down: its thinnest axis is not depth.');

    // And it must be the right way up, not on its side: the Blockle mark is a
    // pointy-top hexagon, measurably taller than it is wide (the 2D mark is
    // 145x190, w/h 0.76). A 90deg roll would read as 1.29 here and look
    // obviously wrong on the splash.
    expect(w / h, closeTo(0.774, 0.05),
        reason: 'the mark is rolled on its side — width/height should be '
            '~0.77 (taller than wide), got ${(w / h).toStringAsFixed(3)}');
  });
}
