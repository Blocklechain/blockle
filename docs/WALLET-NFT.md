# Wallet NFT Support — spec

One spec, three identical implementations: `blockle-extension` (JS, reference),
`blockle-app/lib` (Dart), `python/blockle` (Python). Shared vectors:
`docs/nft-vectors.json` (extension authors; ports assert against it).

View + send NFTs across EVM (ERC-721 / ERC-1155) and Solana (Metaplex). READ-ONLY except
the explicit, approved **send**, which builds calldata and routes through the EXISTING signer
AND the security pre-sign gate (`docs/WALLET-SECURITY.md`) — the NFT module never signs. Never
fabricate ownership/metadata: an unresolvable item is shown with what's known and flagged
`metadata-unavailable`, never invented.

## 1. Inventory (read-only)

```
nfts(accounts, ctx) -> { items: [Nft], unavailable: [{chain, reason}] }
Nft = {
  chain, standard:'erc721'|'erc1155'|'metaplex', contract, tokenId, balance,  // 1155/metaplex may be >1
  name?, collection?, image?, animation?, attributes?,  // from metadata; absent => unknown (not guessed)
  metadataUri?, metadataOk,                              // metadataOk=false when it couldn't be fetched
  spam?,                                                 // heuristic flag (see §3), never a safety claim
}
```
- Sources via injected indexer (EVM: Alchemy/`getNFTsForOwner`; Solana: a Metaplex/DAS
  indexer), grouped by `collection`. An unavailable indexer adds to `unavailable` with a note
  (never a fabricated empty inventory). Media URLs are normalized (ipfs:// → a configured
  gateway); nothing is fetched by the core (the UI loads media), and media hosts are left to
  the UI's CSP — the core only passes through normalized URIs.

## 2. Send (builds calldata; routes through the signer + security gate)

```
buildNftTransfer({chain, standard, contract, tokenId, from, to, amount?}) -> tx   // calldata only
```
- EVM ERC-721: `safeTransferFrom(from, to, tokenId)` (selector 42842e0e).
- EVM ERC-1155: `safeTransferFrom(from, to, id, amount, 0x)` (selector f242432a); `amount`
  required, must be ≤ owned balance.
- Solana: a Metaplex transfer instruction (built via the existing Solana adapter).
- The built tx is handed to the SAME flow as a normal send: `security.inspectTransaction`
  runs first (the security decoder already recognizes `setApprovalForAll` /
  `safeTransferFrom`); a danger forces the extra confirm; the user approves; the existing
  signer signs + broadcasts. The NFT module never holds keys or signs.
- Guard: refuse a transfer whose `from` ≠ the wallet's address for that chain, or whose
  `amount` (1155) exceeds the owned balance (fail-closed, never a partial/overdraw).

## 3. Spam / scam heuristics (flag, never fabricate)

`spam` flag (configurable, off a conservative heuristic set): zero-floor airdropped
collections, a contract on the configurable NFT denylist, a name/URL containing a known
phishing pattern (e.g. "claim rewards at …"), or metadata whose only content is an external
link. Flag only — the UI can hide/segregate spam; the module never asserts an NFT is
safe/valuable.

## 4. Approval awareness (reuse §security)

`setApprovalForAll` grants a contract control of an ENTIRE collection — a top NFT-drain
vector. The security suite already flags `setApprovalForAll-true` as danger; this module
surfaces per-collection operator approvals in the inventory view (via the approval manager's
listing) so the user can revoke, and a send/approval that would grant operator rights is
shown with the danger. No new approval path — reuse the security + approval-manager pieces.

## 5. Parity + tests

`docs/nft-vectors.json`: inventory grouping (erc721 + erc1155 balance>1 + a metaplex item +
a metadata-unavailable item), ipfs:// URI normalization, ERC-721 `safeTransferFrom` calldata
(exact), ERC-1155 `safeTransferFrom` calldata with amount (exact), the overdraw/wrong-from
fail-closed guards, and a spam-flag case. Assert identically in all three languages.

Read-only except the explicit approved send (reusing the signer + security gate). All
amounts base-unit/BigInt-exact. Keep all existing tests green.
