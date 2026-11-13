"""Blockle game-asset export: Blender -> glTF, Unity-ready.

Run inside Blender (Scripting tab, or via the Blender MCP execute_blender_code).
Exports each top-level mesh/armature object in the scene as its own .glb into
OUT_DIR, with the conventions the Unity BlockleAssetPostprocessor expects:
  - metric scale (1 unit = 1 m), transforms applied
  - +Y up (glTF standard; Unity imports it correctly)
  - armature + skinning + animations included (Mixamo clips come across as
    glTF animations, retargetable to the Humanoid avatar in Unity)

Drop the resulting .glb files into Assets/.../BlockleCharacters/ in your Unity
project and the import is auto-configured (Humanoid, metric scale).

Edit OUT_DIR, then run.
"""

import bpy
import os

OUT_DIR = "/tmp/blockle_export"  # <-- set to your Unity project's BlockleCharacters path


def export_all():
    os.makedirs(OUT_DIR, exist_ok=True)
    # Export each top-level armature (a rigged character) and its mesh children.
    roots = [o for o in bpy.context.scene.objects
             if o.parent is None and o.type in {"ARMATURE", "MESH"}]
    exported = 0
    for root in roots:
        bpy.ops.object.select_all(action="DESELECT")
        root.select_set(True)
        for child in root.children_recursive:
            child.select_set(True)
        bpy.context.view_layer.objects.active = root

        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in root.name)
        path = os.path.join(OUT_DIR, safe + ".glb")
        bpy.ops.export_scene.gltf(
            filepath=path,
            use_selection=True,
            export_format="GLB",
            export_yup=True,
            export_apply=True,          # apply modifiers/transforms
            export_skins=True,
            export_animations=True,
            export_anim_single_armature=True,
        )
        exported += 1
        print(f"[blockle] exported {root.name} -> {path}")
    print(f"[blockle] done: {exported} asset(s) to {OUT_DIR}")


export_all()
