# Blockle Exchange — custodial CEX architecture

**Status:** design, pre-implementation. Nothing in this document may accept
customer funds until §7 (gating) is satisfied.

---

## 0. Licence status — READ FIRST

Alienbeing LLC holds **ONE REGULAR LICENSE** for *Tradexpro — White Label
Crypto Exchange Script* (Envato/CodeCanyon item 39228546), purchased
2023-07-14. That settles some of what was previously unknown and opens one
genuinely blocking question.

### Settled

- **The licence is real and in the right name** — licensed to Alienbeing LLC,
  which is the entity that would operate the venue. No entity mismatch.
- **Modification is permitted.** Reworking the custody layer, replacing
  NodeWallet, and changing the schema are all within the licence.
- **Running one venue is not redistribution.** We are not reselling the script.

### Blocking: a Regular License covers a FREE end product

Envato's licence comparison is explicit:

| | Covers |
|---|---|
| **Regular** | "Use in a free end product" |
| **Extended** | "Use in an end product that's sold" — end users may be charged |

A custodial exchange charging **trading fees, withdrawal fees, or listing
fees** is charging end users. On the plain reading of those terms that requires
an **Extended License**, which Alienbeing does not currently hold.

There is a counter-argument — that a per-trade fee is payment for a service
rather than for access to the software — and Envato, not this document, is the
authority on it. **Action: confirm with Envato Help before launch**, in
writing, citing the purchase code. Two outcomes, both cheap relative to
discovering it later: buy the Extended License, or get written confirmation
that Regular suffices.

> The purchase code (`7c821d42-…`) is a credential that proves ownership.
> Keep it out of public issues, repos, and support threads that are not
> Envato's own.

### Both licences permit exactly ONE end product

This is why the `blockle.org` hero widget is specified as it is (§8): it
contains **no TradeXPro code**. It is our own markup and JavaScript reading our
own public market-data endpoint, so it is not a second use of the item at all.
That constraint is now load-bearing rather than merely tidy — **do not solve
the widget by embedding any part of the UserPortal.**

### The EOL framework is PERMANENT — corrected 2026-11-23

I initially assumed the on-disk tree was the July 2023 build and that
re-downloading 3.2.0 would resolve the framework problem. **That was wrong.**
The tree has 2,282 files newer than 2024 in AdminPortal alone — it IS 3.2.0,
the current release — and it still pins:

```
"laravel/framework": "^8.65"
"next": "^12.3.1"
"react": "17.0.2"
```

| | Released | Bug fixes until | **Security fixes until** |
|---|---|---|---|
| Laravel 8 | Sep 2020 | Jul 2022 | **Jan 2023** |

So the vendor has bumped product versions for three years without upgrading the
framework, and **no upstream fix is coming**. This is not a wait, it is a
decision — and it is the single most consequential open question in this
document, because it means running a web framework that has had no security
patches for ~3 years underneath customer funds.

### Four options, honestly

1. **Upgrade Laravel in-house (8 → 11/12).** The 8→9 step is the hard one
   (Symfony 5→6, Flysystem 3). Across 2,661 files and 163 migrations this is
   multi-week work, and it **forks you from vendor updates permanently** — every
   future TradeXPro release would conflict with your changes.
2. **Accept it behind compensating controls.** WAF, no public admin surface,
   pinned dependencies, aggressive patch monitoring. Cheapest now, and the
   thing an auditor or insurer will flag first. Document it deliberately rather
   than discovering it in diligence.
3. **TradeXPro for the UI only; money paths on our own stack.** See below.
4. **Don't use TradeXPro for the custodial venue at all.**

### Why option 3 is the recommendation

The EOL risk is concentrated in the **Laravel backend** — the part that touches
the database, holds sessions, and would move funds. The **Next.js frontend** is
also outdated but far less dangerous: it is client-side, holds no funds, and
reaches no database.

And the backend is the part we have least need of. Already built and tested in
this repo:

| Capability | Where | Tests |
|---|---|---|
| Double-entry ledger, hash-chained, append-only | `exchange/custody/src/ledger.ts` | ✅ |
| Reconciliation against custody | `exchange/custody/src/reconcile.ts` | ✅ |
| BitGo adapter (read-only by construction) | `exchange/custody/src/bitgo.ts` | ✅ |
| Withdrawal machine + velocity caps | `exchange/custody/src/withdrawals.ts` | ✅ |
| Order book, matching, pricing, auth, compliance, ws | `exchange/server/src/` (3,677 lines) | ✅ |

**121 tests over the money paths, all mutation-tested.** What TradeXPro
uniquely provides is the trading UI and the admin portal — genuinely valuable,
genuinely tedious to rebuild, and genuinely not funds-critical.

So: keep its Next.js UI, point it at our TypeScript backend, and do not deploy
the Laravel app as the system of record. That removes the EOL exposure from
every path that touches money, keeps the licence intact (one end product), and
keeps the work we have already verified.

The cost is writing an API shim so the UserPortal's calls land on our
endpoints instead of Laravel's — bounded, mechanical work against a known
surface, and far smaller than a Laravel 8→12 migration.

### Also verify what the purchase includes

The current listing sells **futures, P2P, ICO launchpad, and an "EVM network
supported" addon separately** from the base item. The licence certificate's
title mentions those modules, but item titles are marketing copy and are not
the same as entitlement. Since EVM support is explicitly in scope, **confirm
whether the EVM addon is covered or must be bought.** The on-disk tree does
contain `erc20.service.js` and a web3-based `TokenController.js`, so some EVM
capability is present — but no staking, futures, P2P, or ICO controllers were
found.

If staking or futures modules are later enabled, note that both carry
regulatory weight well beyond spot trading (staking-as-a-service, and
derivatives under CFTC jurisdiction) and neither is contemplated by the
business description or §7 of this document.

---

## 1. What TradeXPro actually is

Three separately-deployed apps, read from `/Volumes/ExtremePro/tradexpro`:

| Component | Stack | Size | Role |
|---|---|---|---|
| `Tradexpro-AdminPortal` | Laravel **8.65** (PHP) | 90 MB / 2661 files | Matching engine, ledger, admin, API |
| `Tradexpro-UserPortal` | Next.js **12.3.1** | 29 MB / 1439 files | Trading UI |
| `Tradexpro-NodeWallet` | Node + `web3@1.7`, `tronweb@5` | 724 KB / 34 files | Chain I/O: address gen, balance, send |

163 Laravel migrations. Redis queue. There is no licence file in the package —
only `git_merge.txt`.

### What is worth keeping

The order path is better built than expected, and it is the expensive part to
get right:

- `app/Services/Order/` — `OrderService`, `OrderCostService`,
  `OrderValidationService`, behind `Contracts/OrderServiceInterface`
- `app/Services/FundTransferService/` — with `TakeFund/SpotFundTaker` and
  `GiverFund/SpotFundGiver` separated
- **23 `lockForUpdate` sites** — balance mutation is row-locked inside DB
  transactions, which is the single most important property in a trading venue
- Typed DTOs (`OrderCreationDto`, `TradeFeeInsertDto`, …) and real exception
  types
- A complete admin portal, KYC screens, and trading UI

### What must be removed or replaced

These are not style objections; each one is disqualifying for a venue holding
customer funds.

1. **Private keys in MySQL.** `wallet_address_histories.wallet_key` (a `text`
   column) holds the private key for each user's deposit address;
   `coin_settings.wallet_key` holds the hot-wallet key. A database read — a
   backup, a dump, one SQL injection — is total loss of funds. **This entire
   model is deleted, not encrypted.**
2. **NodeWallet authentication is a static shared secret.**
   `middleware/common/SecurityCheck.js` compares `req.headers.headerkeys` to
   `process.env.APP_KEY` with `===`. No HMAC over the request body, no
   timestamp, no nonce, no replay protection — and this is the only control in
   front of `POST /send-eth` and `POST /send-token`. Also a non-constant-time
   compare. **Replaced wholesale.**
3. **Precision mismatch.** `wallets.balance` is `decimal(29,18)` but
   `withdraw_histories.amount` is `decimal(19,8)`. An 18-decimal ERC-20 or
   BLOCK-20 withdrawal silently truncates at 8 decimals. **Widened to
   `(36,18)` end to end**, with amounts carried as integer base units in the
   custody layer.
4. **Mutable balance column with no journal.** `wallets.balance` is the only
   record of what a customer owns. There is no append-only history from which
   it can be re-derived, so a bug cannot be audited or reversed. **A journal is
   added (§4).**
5. **Framework EOL.** Laravel 8.65 left security support in January 2023;
   Next.js 12 is three majors behind. Running unpatched frameworks while
   holding customer funds is not defensible to an auditor or an insurer.
   **Upgrade is a launch blocker.**
6. `testBitgo` in `TokenController.js` is a stub that returns `"s"`. There is
   **no BitGo integration** in the package and no BitGo SDK in `package.json`.
   All of it is new work.

---

## 2. Decision

**Keep TradeXPro as matching engine + UI + admin. Replace its entire custody
layer with a new service that we own. Never let TradeXPro hold a private key.**

Rejected alternatives:

- *Port TradeXPro's UI onto the existing `exchange/` TypeScript server.* That
  server is documented as, and built as, a non-custodial atomic-swap relay that
  "holds NO user funds, ever." Making it custodial means rewriting its core
  anyway, and we would also be rebuilding a matching engine and admin portal
  that already exist and are row-locked.
- *Three stacks in production* (Next.js UI + TypeScript custody + Laravel
  matching, each a separate deployable with its own release process). The
  hybrid below is already two; a third is operational debt with no payoff.

---

## 3. Component shape

```
                 ┌────────────────────────────┐
  browser  ──────│  UserPortal (Next.js)      │
                 └────────────┬───────────────┘
                              │ session
                 ┌────────────▼───────────────┐
                 │  AdminPortal (Laravel)     │  matching, orders,
                 │  wallets + journal         │  fees, admin, KYC
                 └────────────┬───────────────┘
                              │ mTLS + HMAC-signed, idempotent
                 ┌────────────▼───────────────┐
                 │  Custody service (TS)      │  ← holds NO keys either
                 │  deposits · withdrawals    │
                 │  reconciliation            │
                 └────────────┬───────────────┘
                              │ BitGo API + Express approval policy
                 ┌────────────▼───────────────┐
                 │  BitGo                     │  key shares, policy,
                 └────────────────────────────┘  signing
```

The custody service is the **only** component that talks to BitGo, and it is
the only component that may initiate an outbound transfer. It still holds no
key material: BitGo holds the key shares, and the withdrawal approval policy
lives in BitGo where our application cannot unilaterally override it.

`Tradexpro-NodeWallet` is **retired for custody**. It survives only as a
read-only chain-data helper (confirmations, contract metadata) with its
`/send-eth`, `/send-token`, `/create-wallet`, and `/get-address-by-pk` routes
deleted.

---

## 4. The ledger

Two records, and a reconciler that proves they agree.

**Trading ledger** — TradeXPro's existing `wallets` table stays the balance the
engine reads and locks, because the engine is correct and depends on it. It
gains:

```
ledger_entries        -- append-only, no UPDATE, no DELETE
  id            bigint pk
  wallet_id     bigint        -- (user, coin)
  delta         decimal(36,18)-- signed
  balance_after decimal(36,18)-- what the row-locked balance became
  reason        enum          -- deposit|withdrawal|trade|fee|adjustment|...
  ref_type      varchar       -- order, withdrawal, deposit, ...
  ref_id        bigint
  actor         varchar       -- user id, 'engine', or admin id
  created_at    timestamp
  prev_hash     char(64)      -- hash chain, per wallet
  hash          char(64)      -- H(prev_hash || row)
```

Written inside the *same* transaction and row lock as every `wallets.balance`
mutation — enforced in `FundTransferService`, so the engine cannot move money
without journaling it. `SUM(delta)` must equal `balance` for every wallet; a
scheduled job asserts this and the hash chain.

**Custody ledger** — in the custody service: every on-chain deposit and
withdrawal, in integer base units, keyed by `(chain, txid, vout/logIndex)` so
replay is impossible.

**Reconciliation** — a job proves, per asset:

```
SUM(wallets.balance) + fees_owed  ==  BitGo confirmed balance - pending_withdrawals
```

A mismatch beyond dust halts deposits and withdrawals for that asset and pages
an operator. **This is not optional; it is the control that catches everything
else.**

---

## 5. Deposits and withdrawals

**Deposit.** BitGo webhook → custody service verifies the webhook signature →
records `(chain, txid, index)` idempotently → waits the per-asset confirmation
count → calls AdminPortal's internal credit endpoint (HMAC-signed, idempotency
key = the deposit's unique chain reference) → AdminPortal credits inside a
transaction and writes a `ledger_entries` row. A duplicate webhook is a no-op
at two independent layers.

**Withdrawal — fully automatic, no operator in the loop.** User requests →
limits and allow-list validated → trading balance debited *first*, inside the
row lock, journaled → custody service screens the destination →
**auto-approved** → submitted to BitGo → on confirmation the row settles; on
failure the debit is reversed by a compensating journal entry, never by editing
the original.

Nothing waits for a human at any point. The human approver is replaced by three
machine controls, all enforced in code, all **failing closed** (an asset with
no limit configured cannot be withdrawn at all):

| Control | Bounds |
|---|---|
| `maxPerRequest` | any single withdrawal |
| `velocityCap24h` | the rolling-day total **per account, per asset** |
| Reconciliation `Interlock` | refuses payouts for any asset whose books and custody disagree |

The velocity cap is the one that matters: a per-request limit alone is
trivially defeated by issuing many requests, so without it a stolen session
empties the venue at machine speed. A breach **auto-rejects and refunds**
rather than queueing — queueing for a person is precisely what automation
removes. Screening still runs first, and `REQUESTED` has no edge to
`SUBMITTED`, so skipping it is structurally impossible.

Debit-before-send is deliberate: the alternative loses money to concurrent
withdrawal requests.

> **Two things that follow from automation, and are easy to miss.**
>
> 1. **The velocity caps are now the only brake, so whoever can edit them can
>    drain the venue.** That makes the admin portal (§10) a funds-critical
>    surface even though it no longer approves withdrawals. Policy changes must
>    require a fresh 2FA challenge and be written to the append-only audit log.
> 2. **Set BitGo's own wallet policy limits too.** Configured at the custodian,
>    outside our code, they cost nothing operationally and are the only control
>    that still holds if this service is itself compromised. This is not
>    operator oversight — no human approves anything — it is a second
>    enforcement point for the same automatic rules.

---

## 6. New assets

- **BLOCK** — native Blockle. BitGo does not support it, so BLOCK custody uses
  our own chain integration behind the *same* custody-service interface, with
  keys in an HSM/offline signer rather than MySQL, and the same journal,
  reconciliation, and approval policy. It is explicitly documented as
  self-custodied rather than BitGo-custodied.
- **BLOCK-20 tokens** — same custody path as BLOCK, with a per-token
  allow-list; no token trades until an operator enables it.
- **EVM assets** — BitGo-custodied, per-chain (Ethereum, and additional EVM
  chains behind individual flags).
- **Fiat** — MoonPay only. The venue never holds fiat; MoonPay is the
  counterparty and performs its own KYC.

`coins` / `coin_settings` already carry `contract_address`, `chain_id`,
`contract_decimal`, and `gas_limit`, so the asset model extends without
schema churn — but `wallet_key` and `wallet_address_histories.wallet_key` are
**dropped**.

---

## 7. Gating — the venue cannot take real money until all of these are true

Mirrors the existing `exchange/server` pattern (`mainnetEnabled` +
`legalReview.completed`) and is checked at startup, not at the UI:

1. `mainnetEnabled = true` **and** `legalReview.completed = true`, both set
   out-of-band by a human.
2. FinCEN MSB registration in place; state money-transmitter licensing (or a
   documented exemption) resolved by counsel. **BitGo custody confers no
   licence on us.**
3. Written AML/KYC program, named compliance officer, sanctions/PEP screening
   live, transaction monitoring and SAR procedures in place.
4. TradeXPro licensing resolved (§0): either an **Extended License** purchased,
   or written confirmation from Envato that the Regular License covers a
   fee-charging venue. Plus confirmation that the EVM addon is covered.
5. Upgraded to TradeXPro **3.2.0** (already paid for), and Laravel/Next.js on
   supported versions.
6. Every `wallet_key` column and code path deleted; no key material in any
   database.
7. Reconciliation job green for a sustained period on testnet, including
   deliberate fault injection.
8. Third-party security review of the custody and withdrawal path.

Until then: testnets only, with a visible non-production banner.

---

## 8. Placement

- **`exchange.blockle.org`** — the full venue (UserPortal).
- **`blockle.org` hero** — a live market widget (ticker, mini order book,
  depth), read-only, pulling from a public market-data endpoint. It is a
  *display*, carries no session and no trading capability, and degrades to
  static content if the feed is unavailable.

  **The widget must contain no TradeXPro code** — not a component, not a
  stylesheet, not an iframe of the UserPortal. It is first-party markup and
  JavaScript against our own JSON endpoint. This keeps the venue a single
  "end product" under the Envato licence (§0), and it is also the right
  engineering call: the front page should not be able to break because the
  exchange UI changed.

---

## 9. Honest note on the existing non-custodial exchange

`exchange/server/README.md` currently promises, in writing, that the service
holds no user funds, ever — no escrow, no deposits, no withdrawals. If a
custodial venue is launched on the same subdomain, **that promise has to be
rewritten rather than quietly contradicted**, and the two models must be
visibly distinguishable to a user. Conflating them would make a truthful past
statement into a false present one.
