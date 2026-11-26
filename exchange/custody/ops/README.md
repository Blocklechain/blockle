# Operator runbooks and one-shots

Run from `/opt/blockle/exchange-custody` on the box, where `better-sqlite3` and
`dist/` live.

## Ledger corrections

**Dry-run by default** — each needs `--apply` — and idempotent, so a second run
finds nothing to do.

| script | what it does |
|---|---|
| `reverse-faucet.js <owner>` | Reverses the faucet-minted liabilities for one owner. |
| `clear-seeded.js` | Rejects pending withdrawals, then reverses every remaining deposit and trade. |
| `unbook-unattributed.js` | Un-books the XRP activation reserve, which the watcher parked in `__unattributed__`. **XRP-hardcoded.** |

## Deposit rails

| file | what it is |
|---|---|
| [`bitgo-deposit-rails.md`](bitgo-deposit-rails.md) | **Why BNB, ETH and SOL have no deposit address**, with the measured evidence, whose decision each one is, and the exact action for each. Start here. |
| `activate-sol-wallet.sh` | Verifies the Solana custody wallet's activation. **Read-only** unless `--mint-test`. Never moves funds. |
| `activate-sol-wallet.js` | The program half of the above. Run the `.sh`. |

`src/settlement.ts` is the machine-readable half of the markdown: `RAIL_BLOCKERS`
carries the same evidence, `RAIL_REFUSALS` is the sentence the customer reads,
and `SOL_ACTIVATION` holds the funding figures. `test/settlement.test.ts`
asserts they agree with each other — and that **every `ops/` path named anywhere
in `src/` actually exists**, because two of them once did not, in an error
message an operator reads while deposits are broken.

### These are not deployed by default

`/opt/blockle/exchange-custody/ops/` does not exist on the box today. Ship it
with the next deploy, or run the activation script from a checkout with
`APP_DIR=/opt/blockle/exchange-custody` so it can still find
`dist/src/ipv4.js` — IPv4 pinning is mandatory, because the BitGo token is
IP-restricted and an IPv6 egress returns a 401 that reads exactly like a bad
token.

## Why the ledger scripts reverse rather than delete

The ledger is append-only and hash-chained *because it is meant to be
evidence*. They all go through `Ledger.reverse()`, which posts an
equal-and-opposite `CORRECTION` naming the transaction it corrects and leaves
the original untouched. Nothing here edits history, and the idempotency key is
`correction:<txId>`, so re-running cannot double-reverse.

## Two ordering rules that are not optional

1. **A pending withdrawal goes through its state machine, not the ledger.**
   `reject()` refunds the customer and releases INFLIGHT in one transaction and
   leaves the withdrawal row terminal. Reversing the posting instead balances
   the books while leaving a withdrawal row that still believes it is owed —
   books and state machine disagreeing is the one break reconciliation cannot
   explain.

2. **Everything else unwinds newest-first.** A trade spent coins a deposit
   provided; reversing the deposit first drives the account negative and the
   ledger correctly refuses. Undoing history backwards keeps every account
   solvent at every intermediate step.

## Back up first

```sh
cd /var/lib/exchange-custody
sqlite3 ledger.db 'PRAGMA wal_checkpoint(TRUNCATE);'   # or the copy is not a snapshot
cp -a ledger.db "ledger.db.bak-$(date +%Y%m%d-%H%M%S)"
```
