# Operational one-shots

Run from `/opt/blockle/exchange-custody` on the box, where `better-sqlite3` and
`dist/` live. Both are **dry-run by default** and need `--apply`; both are
idempotent, so a second run finds nothing to do.

| script | what it does |
|---|---|
| `reverse-faucet.js <owner>` | Reverses the faucet-minted liabilities for one owner. |
| `clear-seeded.js` | Rejects pending withdrawals, then reverses every remaining deposit and trade. |

## Why they reverse rather than delete

The ledger is append-only and hash-chained *because it is meant to be
evidence*. Both scripts go through `Ledger.reverse()`, which posts an
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
