import 'package:flutter/material.dart';
import 'package:model_viewer_plus/model_viewer_plus.dart';

/// The 3D BLOCKLE mark (GLB built in Blender from the vector logo), shown as an
/// interactive, auto-rotating model the user can also spin by dragging.
///
/// Rendered with Google's <model-viewer> web component inside a webview, so it
/// works on iOS, Android and web with one asset. The model + its JS are bundled
/// (no network needed). Transparent background blends into the splash.
class Blockle3DLogo extends StatelessWidget {
  const Blockle3DLogo({super.key, this.size = 200});
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: const ModelViewer(
        src: 'assets/model/blockle_logo.glb',
        alt: 'BLOCKLE',
        // interactive rotation
        cameraControls: true,
        autoRotate: true,
        autoRotateDelay: 0,
        rotationPerSecond: '28deg',
        // keep it a clean logo: no zoom/pan, no AR, framed tight
        disableZoom: true,
        disablePan: true,
        disableTap: true,
        interactionPrompt: InteractionPrompt.none,
        cameraOrbit: '12deg 78deg auto',
        fieldOfView: '28deg',
        backgroundColor: Color(0x00000000),
        // let the model's own emissive/material carry the look
        exposure: 1.0,
        shadowIntensity: 0.0,
      ),
    );
  }
}
