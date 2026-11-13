using UnityEditor;
using UnityEngine;

namespace Blockle.Editor
{
    /// <summary>
    /// Blender -> Unity pipeline: any character model (FBX/glTF) imported under a
    /// folder named "BlockleCharacters" is auto-configured game-ready — Humanoid
    /// rig (so Mixamo / retargeted clips just work), real-world scale, and tangents
    /// for normal maps. Keeps artists from hand-fixing import settings per asset.
    ///
    /// Convention (match this in your Blender export, see tools/blender_export_gltf.py):
    ///   • 1 Blender unit = 1 meter, transforms applied, -Z forward / +Y up
    ///   • characters go in Assets/.../BlockleCharacters/
    ///   • animation-only clips in a sibling "Animations" folder are left as Generic/none
    /// </summary>
    public class BlockleAssetPostprocessor : AssetPostprocessor
    {
        const string CharacterMarker = "/BlockleCharacters/";

        void OnPreprocessModel()
        {
            if (!assetPath.Contains(CharacterMarker)) return;
            var importer = (ModelImporter)assetImporter;

            // Humanoid so Mixamo and any retargeted clips share one avatar.
            importer.animationType = ModelImporterAnimationType.Human;
            importer.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;

            // Use the exported (metric) scale instead of Unity's FBX fudge factor.
            importer.useFileScale = true;
            importer.importBlendShapes = true;

            // Normal maps need tangents; calculate if the mesh lacks them.
            importer.importTangents = ModelImporterTangents.CalculateMikk;
            importer.importNormals = ModelImporterNormals.Import;

            // Mobile: keep optimized meshes + read-disabled to save memory.
            importer.optimizeMeshPolygons = true;
            importer.optimizeMeshVertices = true;
            importer.isReadable = false;

            Debug.Log($"[Blockle] Auto-configured character import (Humanoid): {assetPath}");
        }
    }
}
