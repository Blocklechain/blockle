using System;

namespace Blockle
{
    /// <summary>The connected player: their BLOCK address + a read-scoped session.</summary>
    [Serializable]
    public class BlockleAccount
    {
        public string address;       // block1… (bech32m)
        public string sessionToken;  // read-scoped token from the wallet connect flow
        public bool IsConnected => !string.IsNullOrEmpty(address);
    }

    /// <summary>A BLOCK balance in whole BLOCK (converted from 1e8 base units).</summary>
    [Serializable]
    public class BlockleBalance
    {
        public long baseUnits;             // raw, 1 BLOCK = 100,000,000 base units
        public double Block => baseUnits / 100_000_000.0;
    }

    /// <summary>A BLOCK-721 game asset owned by the player (item / skin / character).</summary>
    [Serializable]
    public class BlockleAsset
    {
        public string contract;   // BLOCK-721 contract id (hex)
        public string tokenId;    // token id within the contract
        public string name;
        public string image;      // metadata image URL/URI (may be empty)
        public string metadata;   // raw metadata JSON (may be empty)
    }

    // JsonUtility needs concrete wrapper types for arrays at the top level.
    [Serializable] internal class AddressResp { public long balance; public long spendable; }
    [Serializable] internal class ConnectResp { public string address; public string sessionToken; }
    [Serializable] internal class AssetsResp { public BlockleAsset[] assets; }

    /// <summary>Result wrapper so callers don't deal with exceptions in coroutines.</summary>
    public struct BlockleResult<T>
    {
        public bool ok;
        public T value;
        public string error;
        public static BlockleResult<T> Ok(T v) => new BlockleResult<T> { ok = true, value = v };
        public static BlockleResult<T> Fail(string e) => new BlockleResult<T> { ok = false, error = e };
    }
}
