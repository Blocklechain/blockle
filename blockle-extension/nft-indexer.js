// nft-indexer.js — WALLET NFT LIVE INDEXER (the injected `ctx.indexer` that
// nft.js calls as getNFTsForOwner(chain, owner) -> raw items).
//
// nft.js is PURE given this indexer: it normalizes the RAW items we return (never
// fabricating metadata). THIS module does the real network reads:
//   • EVM (ethereum/base/arbitrum/optimism/polygon/bnb/avalanche) via the Alchemy
//     NFT API v3 getNFTsForOwner (operator-configurable key + base url).
//   • Solana via a DAS indexer (Helius getAssetsByOwner).
//
// HONEST-OR-NOTHING: a missing key / unconfigured endpoint / HTTP or parse error
// returns `null` — so nft.js records the account as `unavailable` and NEVER a
// fabricated empty inventory. We only ever return an ARRAY when a real indexer
// actually answered (that array may legitimately be empty).
//
// Global `WalletNftIndexer`; module.exports for node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  // CAIP-ish chain -> Alchemy NFT v3 network subdomain.
  const ALCHEMY_NET = {
    ethereum: 'eth-mainnet', base: 'base-mainnet', arbitrum: 'arb-mainnet',
    optimism: 'opt-mainnet', polygon: 'polygon-mainnet', bnb: 'bnb-mainnet',
    avalanche: 'avax-mainnet',
  };
  const EVM_CHAINS = new Set(Object.keys(ALCHEMY_NET));
  const DEFAULT_HELIUS_BASE = 'https://mainnet.helius-rpc.com';

  function firstNonEmpty() {
    for (let i = 0; i < arguments.length; i++) { const v = arguments[i]; if (v != null && v !== '') return v; }
    return undefined;
  }

  // ---- map ONE Alchemy NFT v3 ownedNfts entry -> a raw nft.js item -----------
  // Alchemy v3: { contract:{address,tokenType}, tokenId, balance, name,
  //   image:{cachedUrl,originalUrl,thumbnailUrl}, raw:{metadata,tokenUri},
  //   collection:{name}, tokenUri }
  function mapAlchemyItem(chain, nft) {
    const contract = (nft.contract && nft.contract.address) || nft.contractAddress || null;
    const tokenType = ((nft.contract && nft.contract.tokenType) || nft.tokenType || nft.id && nft.id.tokenMetadata && nft.id.tokenMetadata.tokenType || '').toString().toLowerCase();
    const standard = tokenType === 'erc1155' ? 'erc1155' : (tokenType === 'erc721' ? 'erc721' : undefined);
    const rawMeta = (nft.raw && nft.raw.metadata) || nft.metadata || {};
    const img = nft.image || {};
    const image = firstNonEmpty(img.cachedUrl, img.originalUrl, img.pngUrl, img.thumbnailUrl, rawMeta.image, rawMeta.image_url);
    const animation = firstNonEmpty(img.originalUrl && undefined, rawMeta.animation_url, (nft.animation && nft.animation.cachedUrl));
    const collection = firstNonEmpty(nft.collection && nft.collection.name, nft.contractMetadata && nft.contractMetadata.name, nft.contract && nft.contract.name);
    const name = firstNonEmpty(nft.name, nft.title, rawMeta.name);
    const metadataUri = firstNonEmpty(nft.tokenUri, nft.raw && nft.raw.tokenUri, (nft.tokenUri && nft.tokenUri.raw));
    // metadata resolved iff we actually got a name or an image; else flag it.
    const metadataOk = !!(name || image);
    const out = {
      chain: chain,
      contract: contract,
      tokenId: nft.tokenId != null ? String(nft.tokenId) : (nft.id && nft.id.tokenId != null ? String(nft.id.tokenId) : undefined),
      standard: standard,
      balance: nft.balance != null ? String(nft.balance) : '1',
      metadataOk: metadataOk,
    };
    if (name != null) out.name = name;
    if (collection != null) out.collection = collection;
    if (image != null) out.image = image;
    if (animation != null) out.animation = animation;
    if (metadataUri != null) out.metadataUri = metadataUri;
    if (Array.isArray(rawMeta.attributes)) out.attributes = rawMeta.attributes;
    return out;
  }

  // ---- map ONE DAS (Helius getAssetsByOwner) asset -> a raw nft.js item ------
  // DAS: { id, content:{ metadata:{name,symbol,attributes}, links:{image},
  //   json_uri }, grouping:[{group_key:'collection',group_value}],
  //   token_info:{supply}, compression:{...} }
  function mapDasItem(asset) {
    const content = asset.content || {};
    const meta = content.metadata || {};
    const links = content.links || {};
    let collection = null;
    for (const g of (asset.grouping || [])) { if (g && g.group_key === 'collection') { collection = g.collection_metadata && g.collection_metadata.name || g.group_value; break; } }
    if (collection == null) collection = meta.symbol || null;
    const image = firstNonEmpty(links.image, meta.image, (content.files && content.files[0] && (content.files[0].cdn_uri || content.files[0].uri)));
    const name = firstNonEmpty(meta.name, content.metadata && content.metadata.name);
    const metadataUri = firstNonEmpty(content.json_uri, asset.json_uri);
    const metadataOk = !!(name || image);
    const out = {
      chain: 'solana',
      contract: asset.id,
      standard: 'metaplex',
      balance: '1',
      metadataOk: metadataOk,
    };
    if (name != null) out.name = name;
    if (collection != null) out.collection = collection;
    if (image != null) out.image = image;
    if (metadataUri != null) out.metadataUri = metadataUri;
    if (Array.isArray(meta.attributes)) out.attributes = meta.attributes;
    return out;
  }

  // ---- native BLOCK-721 item ------------------------------------------------
  // The node index only knows ownership (contract + token id); it carries no
  // on-chain metadata yet, so we flag metadataOk:false rather than invent a
  // name/image. The UI renders an honest "metadata unavailable" tile.
  function mapBlockItem(n) {
    return {
      chain: 'block',
      standard: 'block721',
      contract: n && n.contract != null ? String(n.contract) : undefined,
      tokenId: n && n.tokenId != null ? String(n.tokenId) : undefined,
      metadataOk: false,
    };
  }

  // ---- the factory ----------------------------------------------------------
  // createIndexer({ alchemy:{apiKey,baseUrl?}, helius:{apiKey,baseUrl?} | das:{url},
  //   fetchImpl? }) -> { getNFTsForOwner(chain, owner) -> raw[] | null }
  function createIndexer(opts) {
    opts = opts || {};
    const alchemy = opts.alchemy || {};
    const das = opts.das || opts.helius || {};
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    // Native BLOCK-721 NFTs come from the node's ownership index (built from the
    // on-chain Transfer events); no third-party key needed.
    const blockApi = (opts.blockApi || 'https://blockle.org/api/explorer').replace(/\/+$/, '');

    function alchemyUrl(chain) {
      const net = ALCHEMY_NET[chain];
      if (!net) return null;
      if (alchemy.baseUrl) return alchemy.baseUrl.replace(/\/+$/, '') + '/getNFTsForOwner';
      if (!alchemy.apiKey) return null;
      return 'https://' + net + '.g.alchemy.com/nft/v3/' + encodeURIComponent(alchemy.apiKey) + '/getNFTsForOwner';
    }
    function dasUrl() {
      if (das.url) return das.url;
      if (!das.apiKey) return null;
      return (das.baseUrl || DEFAULT_HELIUS_BASE).replace(/\/+$/, '') + '/?api-key=' + encodeURIComponent(das.apiKey);
    }

    async function getNFTsForOwner(chain, owner) {
      if (!fetchImpl) return null; // no transport -> unavailable (never a fake [])
      try {
        if (EVM_CHAINS.has(chain)) {
          const base = alchemyUrl(chain);
          if (!base) return null; // no key/endpoint -> unavailable
          const url = base + '?owner=' + encodeURIComponent(owner) + '&withMetadata=true&pageSize=100';
          const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
          if (!res || !res.ok) return null;
          const body = await res.json();
          const list = body && (body.ownedNfts || body.nfts || body.ownedNftsV3) || [];
          if (!Array.isArray(list)) return null;
          return list.map(function (n) { return mapAlchemyItem(chain, n); });
        }
        if (chain === 'solana') {
          const url = dasUrl();
          if (!url) return null; // no key/endpoint -> unavailable
          const res = await fetchImpl(url, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'nfts', method: 'getAssetsByOwner', params: { ownerAddress: owner, page: 1, limit: 1000, displayOptions: { showCollectionMetadata: true } } }),
          });
          if (!res || !res.ok) return null;
          const body = await res.json();
          if (body && body.error) return null;
          const items = body && body.result && body.result.items;
          if (!Array.isArray(items)) return null;
          // non-fungible assets only (DAS also returns fungibles for some owners)
          return items
            .filter(function (a) { const iface = String(a.interface || ''); return iface !== 'FungibleToken' && iface !== 'FungibleAsset'; })
            .map(mapDasItem);
        }
        if (chain === 'block') {
          // Native Blockle L1: the node indexes BLOCK-721 ownership from Transfer
          // events. Returns { address, count, nfts:[{contract, tokenId}] }.
          const url = blockApi + '/nfts/' + encodeURIComponent(owner);
          const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
          if (!res || !res.ok) return null;
          const body = await res.json();
          const list = body && body.nfts;
          if (!Array.isArray(list)) return null;
          return list.map(function (n) { return mapBlockItem(n); });
        }
        return null; // unsupported chain -> unavailable (honest)
      } catch (_) {
        return null; // any error -> unavailable (NEVER a fabricated empty inventory)
      }
    }

    return { getNFTsForOwner: getNFTsForOwner, ALCHEMY_NET: ALCHEMY_NET };
  }

  const API = {
    createIndexer,
    // exposed for the mapping tests + ports
    mapAlchemyItem, mapDasItem, ALCHEMY_NET, EVM_CHAINS,
  };
  global.WalletNftIndexer = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
