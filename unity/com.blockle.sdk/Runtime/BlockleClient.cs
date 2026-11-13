using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

namespace Blockle
{
    /// <summary>
    /// The Blockle integration surface for a Unity game. NON-CUSTODIAL: the game
    /// never holds the player's keys. Sign-in and any signed action deep-link out
    /// to the Blockle wallet, which signs/broadcasts and returns the result; reads
    /// (balance, owned assets) are plain HTTPS against the player's public address.
    ///
    /// Attach to a GameObject (or call <see cref="Create"/>) once at startup.
    /// Game-awarded assets (minting a BLOCK-721 to the player as a reward) are a
    /// SERVER-SIDE concern — your game backend holds the award key and calls the
    /// chain; the client reads the result via <see cref="GetOwnedAssets"/>.
    /// </summary>
    public class BlockleClient : MonoBehaviour
    {
        public static BlockleClient Instance { get; private set; }

        public BlockleConfig Config = new BlockleConfig();
        public BlockleAccount Account { get; private set; } = new BlockleAccount();

        /// <summary>Fires when a connect deep-link completes with an address.</summary>
        public event Action<BlockleAccount> OnConnected;

        Action<BlockleResult<BlockleAccount>> _pendingConnect;

        public static BlockleClient Create(BlockleConfig config = null)
        {
            if (Instance != null) return Instance;
            var go = new GameObject("BlockleClient");
            DontDestroyOnLoad(go);
            var c = go.AddComponent<BlockleClient>();
            if (config != null) c.Config = config;
            return c;
        }

        void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            Application.deepLinkActivated += HandleDeepLink;
            // A cold start via deep link delivers the URL here.
            if (!string.IsNullOrEmpty(Application.absoluteURL)) HandleDeepLink(Application.absoluteURL);
        }

        void OnDestroy()
        {
            Application.deepLinkActivated -= HandleDeepLink;
            if (Instance == this) Instance = null;
        }

        // ---- Sign-in (deep-link to the wallet) --------------------------------
        /// <summary>
        /// Open the Blockle wallet to connect. The wallet returns the player's
        /// address + a read session to the game's callback URL, completing the
        /// task passed here (or the <see cref="OnConnected"/> event).
        /// </summary>
        public void Connect(Action<BlockleResult<BlockleAccount>> onDone = null)
        {
            _pendingConnect = onDone;
            var ret = string.IsNullOrEmpty(Config.CallbackScheme)
                ? Config.Url("/games/connected")                 // https return fallback
                : Config.CallbackScheme + "://blockle-connect";  // custom-scheme return
            var url = Config.Url(Config.ConnectPath)
                + "?app=" + UnityWebRequest.EscapeURL(Application.productName)
                + "&return=" + UnityWebRequest.EscapeURL(ret);
            Application.OpenURL(url);
        }

        /// <summary>Call from your own deep-link handler too, if you route URLs yourself.</summary>
        public void HandleDeepLink(string url)
        {
            if (string.IsNullOrEmpty(url)) return;
            var q = ParseQuery(url);
            if (q.TryGetValue("address", out var addr) && !string.IsNullOrEmpty(addr))
            {
                Account = new BlockleAccount { address = addr };
                q.TryGetValue("sessionToken", out Account.sessionToken);
                var r = BlockleResult<BlockleAccount>.Ok(Account);
                _pendingConnect?.Invoke(r);
                _pendingConnect = null;
                OnConnected?.Invoke(Account);
            }
        }

        public void Disconnect() => Account = new BlockleAccount();

        // ---- Reads (plain HTTPS, no signing) ----------------------------------
        /// <summary>Confirmed BLOCK balance of the connected player.</summary>
        public void GetBalance(Action<BlockleResult<BlockleBalance>> onDone)
        {
            if (!Account.IsConnected) { onDone(BlockleResult<BlockleBalance>.Fail("not connected")); return; }
            StartCoroutine(GetJson(Config.Url(Config.AddressPath + UnityWebRequest.EscapeURL(Account.address)),
                (ok, body, err) =>
                {
                    if (!ok) { onDone(BlockleResult<BlockleBalance>.Fail(err)); return; }
                    try
                    {
                        var a = JsonUtility.FromJson<AddressResp>(body);
                        onDone(BlockleResult<BlockleBalance>.Ok(new BlockleBalance { baseUnits = a.balance }));
                    }
                    catch (Exception e) { onDone(BlockleResult<BlockleBalance>.Fail(e.Message)); }
                }));
        }

        /// <summary>
        /// BLOCK-721 game assets owned by the player. NOTE: confirm the exact
        /// owner->NFTs endpoint against the live explorer before shipping; the
        /// default below is the expected path and is easy to change in config.
        /// </summary>
        public void GetOwnedAssets(Action<BlockleResult<List<BlockleAsset>>> onDone)
        {
            if (!Account.IsConnected) { onDone(BlockleResult<List<BlockleAsset>>.Fail("not connected")); return; }
            var path = Config.AddressPath + UnityWebRequest.EscapeURL(Account.address) + "/nfts";
            StartCoroutine(GetJson(Config.Url(path), (ok, body, err) =>
            {
                if (!ok) { onDone(BlockleResult<List<BlockleAsset>>.Fail(err)); return; }
                try
                {
                    var wrap = JsonUtility.FromJson<AssetsResp>(body);
                    var list = new List<BlockleAsset>(wrap != null && wrap.assets != null ? wrap.assets : new BlockleAsset[0]);
                    onDone(BlockleResult<List<BlockleAsset>>.Ok(list));
                }
                catch (Exception e) { onDone(BlockleResult<List<BlockleAsset>>.Fail(e.Message)); }
            }));
        }

        // ---- Signed actions (deep-link to the wallet) -------------------------
        /// <summary>
        /// Ask the wallet to sign + broadcast a player action (spend BLOCK, transfer
        /// a token, list an asset on the marketplace). The game builds the intent;
        /// the WALLET shows it, signs it, and broadcasts it — the game never sees a
        /// key. Result returns via the deep-link callback. `action` is the wallet
        /// action name; `paramsJson` its parameters.
        /// </summary>
        public void RequestSignedAction(string action, string paramsJson)
        {
            var ret = string.IsNullOrEmpty(Config.CallbackScheme)
                ? Config.Url("/games/signed")
                : Config.CallbackScheme + "://blockle-signed";
            var url = Config.Url("/sign")
                + "?action=" + UnityWebRequest.EscapeURL(action)
                + "&params=" + UnityWebRequest.EscapeURL(paramsJson ?? "{}")
                + "&return=" + UnityWebRequest.EscapeURL(ret);
            Application.OpenURL(url);
        }

        // ---- helpers ----------------------------------------------------------
        IEnumerator GetJson(string url, Action<bool, string, string> cb)
        {
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = Config.TimeoutSeconds;
                req.SetRequestHeader("accept", "application/json");
                yield return req.SendWebRequest();
#if UNITY_2020_1_OR_NEWER
                bool failed = req.result != UnityWebRequest.Result.Success;
#else
                bool failed = req.isNetworkError || req.isHttpError;
#endif
                if (failed) cb(false, null, req.error ?? ("http " + req.responseCode));
                else cb(true, req.downloadHandler.text, null);
            }
        }

        static Dictionary<string, string> ParseQuery(string url)
        {
            var d = new Dictionary<string, string>();
            int q = url.IndexOf('?');
            if (q < 0 || q == url.Length - 1) return d;
            foreach (var pair in url.Substring(q + 1).Split('&'))
            {
                var kv = pair.Split(new[] { '=' }, 2);
                if (kv.Length == 2) d[UnityWebRequest.UnEscapeURL(kv[0])] = UnityWebRequest.UnEscapeURL(kv[1]);
            }
            return d;
        }
    }
}
