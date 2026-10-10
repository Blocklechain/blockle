# Solana HTLC deployments

`scripts/deploy.sh` writes one `<cluster>.json` here per deploy (devnet,
mainnet-beta). Each record is the **public** program id the relay and each
party's wallet call — no secrets. `localnet.json` is gitignored (throwaway
local-validator runs); `devnet.json` / `mainnet.json` are committed so the
relay config and an auditor can trace the deployed id.

Shape:

```json
{
  "cluster": "devnet",
  "rpcUrl": "https://api.devnet.solana.com",
  "programId": "<base58 program id>",
  "deployer": "<base58 deployer/upgrade-authority pubkey>",
  "deployedAt": "<UTC ISO-8601>",
  "relayConfigPath": "exchange/server/config.json -> htlc.solana.<devnet|mainnet>",
  "note": "initialize(...) still required; mainnet_enabled stays false until set_mainnet after legal review."
}
```

After a deploy, copy `programId` into `exchange/server/config.json` under
`htlc.solana.<devnet|mainnet>` (the relay keys Solana by `devnet` / `mainnet`).
The relay holds no key — it only references this id.
