using System;

namespace Blockle
{
    /// <summary>
    /// Connection settings for the Blockle SDK. Create one (ScriptableObject or
    /// plain) and pass it to <see cref="BlockleClient"/>. Defaults point at the
    /// live blockle.org endpoints; override Origin for a staging/dev host.
    /// </summary>
    [Serializable]
    public class BlockleConfig
    {
        /// <summary>Account/explorer origin. No trailing slash.</summary>
        public string Origin = "https://blockle.org";

        /// <summary>
        /// Custom URL scheme your game registers so the Blockle wallet can
        /// deep-link results back after sign-in / signing (e.g. "mygame").
        /// On iOS add it to Info.plist CFBundleURLSchemes; on Android add an
        /// intent-filter. Leave empty to use the https return flow instead.
        /// </summary>
        public string CallbackScheme = "";

        /// <summary>
        /// Where the wallet sends the user to connect. The game opens this; the
        /// wallet authorizes and returns the player's address + a read session
        /// token to the callback. NOTE: confirm the exact connect path/params
        /// against the live wallet's deep-link protocol before shipping.
        /// </summary>
        public string ConnectPath = "/connect";

        /// <summary>Read-API path for an address's confirmed BLOCK balance (base units).</summary>
        public string AddressPath = "/api/explorer/address/";

        /// <summary>Request timeout (seconds) for read calls.</summary>
        public int TimeoutSeconds = 15;

        public string Url(string path) => Origin.TrimEnd('/') + path;
    }
}
