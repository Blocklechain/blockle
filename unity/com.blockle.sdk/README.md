# Blockle Unity SDK

`com.blockle.sdk` — drop Blockle into a Unity game: non-custodial wallet sign-in,
read a player's BLOCK balance and owned game assets (BLOCK-721 NFTs), and ask the
player's wallet to sign and broadcast on-chain actions. Targets desktop, mobile,
and WebGL.

**Non-custodial by design.** The game never holds the player's keys. Sign-in and
any signed action deep-link out to the Blockle wallet, which shows the intent,
signs/broadcasts it, and returns the result. Reads (balance, owned assets) are
plain HTTPS against the player's public address. Minting a reward NFT to a player
is a *server-side* concern — your game backend holds the award key; the client
only reads the result.

## Install

In Unity: **Window → Package Manager → + → Add package from git URL…**

```
https://github.com/blocklechain/blockle.git?path=/unity/com.blockle.sdk
```

Or add to `Packages/manifest.json`:

```json
"com.blockle.sdk": "https://github.com/blocklechain/blockle.git?path=/unity/com.blockle.sdk"
```

Requires Unity 2021.3 or newer.

## Quick start

```csharp
using Blockle;
using UnityEngine;

public class Boot : MonoBehaviour
{
    BlockleClient blockle;

    void Start()
    {
        blockle = BlockleClient.Create(new BlockleConfig {
            CallbackScheme = "myga me", // your app's custom URL scheme (mobile deep-link return)
        });
        blockle.OnConnected += acc => Debug.Log($"connected {acc.address}");
    }

    public void OnLoginButton()
    {
        blockle.Connect(res => {
            if (!res.ok) { Debug.LogError(res.error); return; }
            blockle.GetBalance(b => {
                if (b.ok) Debug.Log($"{b.value.Block} BLOCK");
            });
            blockle.GetOwnedAssets(a => {
                if (a.ok) foreach (var nft in a.value) Debug.Log(nft.name);
            });
        });
    }

    // Ask the wallet to sign + broadcast an action (spend, transfer, list, pay).
    public void BuyPowerup()
    {
        blockle.RequestSignedAction("token.transfer",
            "{\"to\":\"block1...\",\"amount\":\"5\"}");
    }
}
```

Set up the deep-link return so the wallet can hand control back:

- **iOS/Android:** register `CallbackScheme` as a custom URL scheme (Player
  Settings → Supported URL schemes on iOS; an intent-filter on Android). Unity
  delivers the return URL via `Application.deepLinkActivated`, which the SDK
  already listens for.
- **WebGL / desktop:** if `CallbackScheme` is empty the SDK uses an HTTPS return
  (`/games/connected`, `/games/signed`) you can host.

## Platform — desktop PC

The Blockle Game Hub is a **desktop** store (the crypto-native alternative to
Steam). Ship a native build for the desktop OSes you support:

| Target | Build |
|---|---|
| **Windows** | Unity → Windows build (`.exe`) |
| **macOS** | Unity → macOS build (`.app`) |
| **Linux** | Unity → Linux build (`.x86_64`) |

The hub downloads your build, verifies its SHA-256, installs it, and launches the
entry executable — crypto checkout, NFT items and on-chain payouts all run through
the wallet that's already in the hub. Crypto purchases and selling games for BLOCK
are fully supported on desktop; there are no mobile-store payment restrictions to
work around.

List the platforms you ship in `blockle.toml` under `platform` (`desktop`), and
provide a per-OS build in the submission (`blockle-game` packages each).

## Submitting a game

Use the `blockle-game` CLI (separate crate). Submitting is free; you keep 90% of
paid-game crypto purchases.

```sh
cargo install blockle-game
blockle-game init           # scaffold blockle.toml
blockle-game check ./Build  # same malicious-code + completeness checks we run server-side
blockle-game submit ./Build
```

## Blender → Unity asset pipeline

The 3D pipeline is Blender-authored, exported to glTF, and auto-configured on
import by `Editor/BlockleAssetPostprocessor.cs`.

**Conventions (match these in Blender):**

- **1 Blender unit = 1 meter.** Set the scene to metric.
- **Apply transforms** before export (Object → Apply → All Transforms), so scale
  is 1,1,1 and rotation is clean.
- **-Z forward, +Y up** (Blender's armature-forward convention). glTF export
  with Y-up gives Unity the correct orientation.
- Characters go in a folder named **`BlockleCharacters`** anywhere under
  `Assets/` — the postprocessor keys off the path `/BlockleCharacters/` and
  configures the model as a **Humanoid** rig automatically, so Mixamo clips and
  any retargeted animation share one avatar.
- Keep the armature a standard humanoid bone layout so Unity's avatar mapper
  resolves it without manual bone assignment.

**Export from Blender** with the helper (runs in Blender's Scripting tab, or via
the Blender MCP `execute_blender_code`):

```
unity/tools/blender_export_gltf.py
```

Set `OUT_DIR` to your project's `Assets/.../BlockleCharacters/` and run — it
exports each top-level rigged object to its own `.glb` with metric scale,
transforms applied, skinning and animations included.

## Unity MCP (optional — drives Unity from Claude)

To let Claude create/modify scenes and scripts in the Unity Editor the way the
Blender MCP drives Blender, install a community Unity MCP server. These run
outside this repo and you install/vet them yourself:

1. Install the Unity-side bridge package (one of the community servers, e.g.
   `justinpbarnett/unity-mcp` or `CoderGamester/mcp-unity`) into your Unity
   project via Package Manager → Add from git URL, following that project's
   README.
2. Register its MCP server with Claude Code:

   ```sh
   claude mcp add unity -- <command the chosen server's README specifies>
   ```

   (Each server ships its own launcher — a `uvx`/`npx`/python command — so copy
   the exact one from its README.)
3. Open your Unity project with the bridge package active; Claude can then drive
   the Editor over MCP.

The Blockle SDK itself needs none of this — the MCP is only a convenience for
building games with Claude in the loop.

## API surface

- `BlockleClient.Create(config)` / `.Instance` — singleton MonoBehaviour.
- `.Connect(cb)` — deep-link sign-in; also fires `OnConnected`.
- `.GetBalance(cb)` — confirmed BLOCK balance (`BlockleBalance.Block`).
- `.GetOwnedAssets(cb)` — player's BLOCK-721 game assets.
- `.RequestSignedAction(action, paramsJson)` — wallet signs + broadcasts.
- `.Disconnect()`.

Reads return `BlockleResult<T>` (`.ok`, `.value`, `.error`) so coroutines never
throw at the caller.
