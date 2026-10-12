# Wallet dApp Connect (WalletConnect v2) — spec

One spec, three identical implementations: `blockle-extension` (JS, reference),
`blockle-app/lib` (Dart), `python/blockle` (Python). Shared vectors:
`docs/walletconnect-vectors.json` (extension authors; ports assert against it).

Lets the wallet connect to external dApps over WalletConnect v2 (Sign API) and approve/sign
their requests. The **session + request state machine + the security integration** are
identical across wallets and are what this spec pins; the **relay transport + WC crypto** are
abstracted behind an injected `relay` client (real SDK per platform — see §6). The core is
**pure given the injected relay**, so it is fully testable headless.

Trust model: an **external dApp is untrusted**. Unlike the user's own bots (which may run
auto within an allocation), **every dApp signing request requires explicit human approval**
and runs through the security pre-sign gate (`docs/WALLET-SECURITY.md`). No dApp request ever
auto-approves. The wallet signs with the vault only after approval; sessions never persist key
material.

## 1. Pairing

```
parsePairingUri(uri) -> { protocol:'wc', topic, version, relayProtocol, symKey } | throws
```
- Accept only **v2** URIs (`wc:<topic>@2?relay-protocol=irn&symKey=<hex>`). **Reject v1**
  (`@1`) and malformed URIs with a clear error (v1 is deprecated + insecure).
- `pair(uri, ctx)` hands the parsed pairing to the injected relay to establish the pairing
  topic; it does NOT yet grant anything — a session proposal follows.

## 2. Session proposal → approve / reject

```
reviewProposal(proposal) -> ProposalReview
ProposalReview = {
  dapp: { name, url, icons, description },
  requiredNamespaces, optionalNamespaces,   // chains/methods/events the dApp asks for
  chains: [caip2...], methods: [...], events: [...],
  warnings: [ Warning ],   // e.g. dapp-domain-denylisted, requests-unsupported-chain, requests-eth_sign
}
approveProposal(proposal, { accounts }) -> SettledSession | throws
rejectProposal(proposal, reason) -> void
```
- `reviewProposal` surfaces the dApp's CLAIMED metadata (never trusted) + exactly what it is
  requesting, with warnings: dApp url on the configurable **denylist** (`dapp-domain-denylisted`,
  danger), a requested chain the wallet doesn't have (`requests-unsupported-chain`), a requested
  method that is unsafe/unsupported (e.g. `eth_sign` → `requests-eth_sign`, warn).
- `approveProposal` builds the settled namespace from ONLY the chains/accounts the wallet
  actually controls and the **supported+safe** method set (§3). A dApp requiredNamespace that
  includes an unsupported chain is rejected (fail-closed) unless the user drops it to optional.
  Approval requires explicit user action (host-provided).

## 3. Request routing (the signing surface)

```
handleRequest({ topic, chainId, method, params }, ctx) -> JsonRpcResult | JsonRpcError
```
- **Namespace enforcement first:** if `chainId`/`method` is outside the session's approved
  namespace → reject `{code: 3001, message:'unauthorized method/chain'}`. No exceptions.
- **Signing methods (explicit approval + security gate each time):**
  - `eth_sendTransaction` → run `security.inspectTransaction` on the tx; show the preview +
    warnings; on approval sign+send via the wallet signer; a DANGER forces the extra confirm
    (fail-closed). Return the tx hash.
  - `eth_signTypedData_v4`/`_v3` → decode the EIP-712 domain + message; **detect Permit /
    Permit2 approvals** and flag unlimited/long-deadline ones as **danger** (off-chain approval
    phishing is a top drainer vector). Show the decoded struct; sign only on approval.
  - `personal_sign` → decode the UTF-8 message and show it (flag if it looks like a
    transaction/EIP-712 smuggled as text); sign on approval.
  - `eth_sign` → **refused by default** (`config.allowEthSign=false`) — the blind-sign legacy
    method is a classic phishing vector; return an error explaining why.
  - `wallet_switchEthereumChain`/`wallet_addEthereumChain` → require approval; only switch to a
    chain the wallet has.
  - Solana: `solana_signTransaction`, `solana_signAndSendTransaction` (inspect + approve + sign),
    `solana_signMessage` (show + approve).
  - Read methods (`eth_accounts`, `eth_chainId`) → answer from session state (no prompt).
- Every signing path is the SAME security + approval gate; a dApp can never cause an unprompted
  or danger-auto-approved signature.

## 4. Sessions

`listSessions()/getSession(topic)/disconnect(topic)` — persist active sessions (dApp metadata,
topic, approved namespace, expiry) via the injected encrypted store; **no key material**.
Honor session expiry (reject requests on an expired session). A `session_request` on an unknown
topic is rejected.

## 5. Parity + tests

`docs/walletconnect-vectors.json`:
- pairing URI: a valid v2 parse; reject a v1 URI; reject a malformed URI.
- proposal review: dApp metadata surfaced; `requests-unsupported-chain` + `requests-eth_sign`
  warnings; denylisted dApp → danger.
- approval: settled namespace is the intersection of requested ∩ wallet-controlled (a requested
  unsupported chain is dropped/rejected, never fabricated).
- request routing: an out-of-namespace method/chain → 3001 unauthorized; `eth_sendTransaction`
  routes through the security inspect (a danger tx forces confirm, a declined approval returns
  the user-rejected error 4001); `eth_signTypedData_v4` Permit-unlimited → danger; `eth_sign` →
  refused by default; `personal_sign` decodes the message.
- expiry: a request on an expired session is rejected.

Read-only except the explicit, approved signatures (which reuse the existing signer — the WC
core never holds keys). Reuses the security decoder/gate; never auto-approves an external dApp.
Keep all existing tests green.

## 6. Transport (per-platform integration, documented)

The core takes an injected `relay` client: `{ pair(uri), subscribeRequests(onRequest),
respond(topic, response), publishProposalResponse(...), disconnect(topic) }` plus the WC v2
crypto (x25519 + chacha20-poly1305) handled by the platform SDK. Integration targets:
extension → `@walletconnect/sign-client` (loaded on demand; the no-bundler MV3 host inlines the
UMD build); Flutter → `walletconnect_flutter_v2`; Python/Qt → a thin relay client over the WC
relay WS. A project id + relay URL are config. The transport is NOT reimplemented here — these
tests inject a fake relay. The real SDK wiring + a live pairing smoke test are the final
integration step (noted, like the HTLC transport, as the operator/runtime-dependent piece).
