# Why BNB, ETH and SOL have no deposit address

**Asked and answered three times now.** The answer lives here so it stops being
a chat message. Last re-measured **2026-11-26** against live BitGo, read-only
(`GET` only — no wallet was created, no funds moved, no plan changed).

`src/settlement.ts` is the machine-readable half of this document:
`RAIL_BLOCKERS` carries the same evidence and the same remedies, and
`RAIL_REFUSALS` is the sentence the customer reads. If you change a verdict,
change it there — this file explains, that file enforces.

---

## The one-line answer

| Rail | Open? | Blocked by | Whose call | Cost to clear |
|---|---|---|---|---|
| **ETH** | no | BitGo has no pricing plan on this account | **commercial** (you) | unknown — BitGo must quote |
| **BNB** | no | the same gate, same account | **commercial** (you) | same plan covers both |
| **POLYGON** | no | the same gate | **commercial** (you) | same plan covers all three |
| **SOL** | no | (1) wallet not activated on chain, (2) no consolidation code | **operator**, then **engineering** | ~0.01 SOL, then ~1 week |
| BTC, DOGE, TRX, XRP | **yes** | — | — | — |
| PERBUG, PEP, DINGO, RTM | **yes** (our own nodes) | — | — | — |

**ETH and BNB cannot work until BitGo is paid.** That is the honest sentence.
There is no code change, no workaround and no amount of engineering effort that
opens them, and the next section is the evidence for that claim rather than an
assertion of it.

---

## ETH / BNB / POLYGON — a billing gate, not a bug

### What BitGo actually says

```
POST /api/v2/eth/wallet/6b06f02a69a8a28bfecb0ceae9918fd0/address
403 Forbidden
{"error":"A pricing plan is required to create receive addresses on Wallet
  6b06f02a69a8a28bfecb0ceae9918fd0. Contact BitGo support for more
  information.","name":"Forbidden"}
```

`bsc` wallet `6b06f03a03d8f1befe1f4905652c4503` and `polygon` wallet
`6b06f04bbb1e8eb82776f853a202b954` return the identical 403. **There is no
cheap-EVM escape hatch inside BitGo** — the gate is the EVM family, not
Ethereum's gas price.

### Three independent readings that it is a tier gate and not our request

1. **The account is on BitGo's free self-serve tier.**
   `GET /api/v2/enterprise/64b1f1c10a11d600077a05b9608555d3` reports
   `activePricingType.name "starter"`, `publicLabels ["starterAccount"]`,
   `isContractedClient false`, `accountType "individual"`,
   `kycState "approved"`, `licenses [instantFeeHotWallet, portfolioBasic, link]`.
   So the 403's wording is *literally accurate*: there is no plan at all, not
   the wrong plan.
2. **No EVM receive address has ever existed on this account.** Every EVM
   wallet — ours plus `FROGE ETH`, `asdf` (BSC), `USDT` and `Perbug` (Polygon) —
   reports `lastChainIndex {"0":0,"1":-1}`. Index 0 and nothing else, across
   three years and four unrelated projects. That is a gate, not a transient
   fault.
3. **An equally unprovisioned non-EVM wallet mints on request.** The LTC wallet
   has a derived address at index 1; TRX has one at index 1 and it belongs to a
   real customer. Same token, same code path, same day.

### Our code is already correct

`BitGoDeposits.createReceiveAddress` (`src/bitgodeposits.ts`) sends the right
request and will work **unchanged** the moment a plan exists. Our EVM wallets
are TSS MPCv2, `walletVersion 5`, so per-customer addresses are the CREATE2
forwarders BitGo bills for. Nothing is waiting on engineering here.

### There is no API for this

Every pricing-related `GET` returns a 404 **HTML** page, not a JSON error —
i.e. the route does not exist:

```
/api/v2/pricing                                        404
/api/v2/enterprise/{id}/pricing                        404
/api/v2/enterprise/{id}/pricingPlan                    404
/api/v2/enterprise/{id}/billing                        404
```

The plan cannot be read or changed programmatically. It is a sales action by
construction, which is why the owner of this blocker is commercial.

### THE ACTION: file a free BitGo support ticket

Costs nothing, and it prices every alternative. Ask these three things
specifically — a vague ticket gets a vague answer:

> Enterprise `64b1f1c10a11d600077a05b9608555d3` (starter tier, individual
> account, KYC approved).
>
> 1. Which pricing plan enables **receive-address creation on EVM wallets**
>    (eth, bsc, polygon), and what does it cost for an account of this size?
>    We currently get 403 "A pricing plan is required to create receive
>    addresses" on all three.
> 2. Is receive-address creation on **sol** and **xlm** *also* plan-gated?
>    Both currently answer HTTP 202 `{"error":"wallet pending on-chain
>    initialization"}`. We want to know whether funding the wallet is
>    sufficient, or whether a 403 appears behind the 202 once it is funded.
> 3. Does EVM address creation additionally require a **funded BitGo gas tank**
>    per coin? Your Ethereum documentation says address creation deploys a
>    contract and costs gas.

### Then decide, and the decision has two numbers in it

- **If BitGo quotes a sane self-serve upgrade: pay it.** It is zero new code,
  zero new key material, it fixes ETH + BNB + Polygon at once, and it also
  unblocks the ERC-20/BEP-20 rails that are *separately* shut behind the gas
  gate.
- **If BitGo quotes an institutional contract**, do not pay it to open three
  chains. Third-party sources put custom BitGo contracts in the tens of
  thousands per year; **that figure is unverified and must come from BitGo**,
  not from here.
- **Either way there is a second cost**: BitGo's own docs say EVM address
  creation deploys a contract and costs gas, one gas tank per coin. A plan
  still implies funding an ETH tank and a BNB tank.
- **The plan bills at enterprise level, and this enterprise is shared** with
  Perbug, Froge and a personal account. Wallet-scoped custody
  (`BITGO_WALLETS` / `BITGO_WALLET_PREFIX`) stays mandatory regardless — an
  unscoped balance read makes a shortfall look like a surplus.

### If the quote is unaffordable

In preference order, both documented only so nobody starts the expensive one
first:

1. **A second signer for EVM only** (Turnkey / Dfns / Fordefi class). Mints
   unlimited per-customer addresses, signs sweeps under a policy engine, no raw
   key on the box. Keep BitGo for the six chains that demonstrably work. Real
   cost beyond money: holdings become two-sourced, so `BitGoHoldings` and
   `reconcile.ts` must learn a second custodian, or a shortfall on one hides
   behind a surplus on the other.
2. **Self-custody via xpub-derived addresses.** Viable — secp256k1 *has*
   watch-only derivation, so the venue can hold an xpub, derive
   `m/44'/60'/0'/0/i` per customer online with **zero spending authority**, and
   keep the xprv offline. Sweep destination would be the existing BitGo root
   addresses, so the online key could only ever move in-flight deposits into
   custody, never the treasury. But: 2–4 weeks, it needs a real deposit scanner
   (`EvmRpcAdapter.incoming()` throws today, by design), and sweeping an EOA
   with no gas means either two transactions per deposit or writing and
   auditing a CREATE2 forwarder contract. It also puts a hot signer on the box
   for the first time, which breaks this service's stated "holds no key
   material" property.

---

## SOL — two blockers, and the cheap one is not the whole fix

### Blocker 1 (operator, ~$2): the wallet does not exist on chain

A Solana account does not exist until it is rent-funded, so there is nothing to
derive an address from. BitGo answers the address POST with **HTTP 202** —
a *success* status — and no address:

```
POST /api/v2/sol/wallet/6b06f0530242e6aa1edd125b16f521fe/address
202 Accepted
{"error":"wallet pending on-chain initialization"}
```

That 202 is why this read for a while as "BitGo returned a blank". It was not;
it was telling us plainly what was wrong.

Live wallet record, re-read 2026-11-26:

```
GET /api/v2/sol/wallet/6b06f0530242e6aa1edd125b16f521fe
  coinSpecific.rootAddress               HRdvYQ2StLnLNRHFeyBoDMgBVbCqjAJTm5vAmbmBqEwP
  coinSpecific.pendingChainInitialization true
  coinSpecific.minimumFunding            2447136   (lamports, UNSPENDABLE)
  coinSpecific.lastChainIndex            {"0":0,"1":-1}
  balanceString                          0
```

**This cannot be tested for free.** All four `sol` wallets on the entire
enterprise — ours, `FROGE SOL`, `Perbug Solana`, `epic2epic@gmail.com` — are
`pendingChainInitialization: true` with balance 0. There is no already-activated
Solana wallet anywhere to probe.

**Attribution is safe on SOL**, unlike the memo-less EVM chains: BitGo derives a
*distinct* base58 address per derivation index (ed25519 MPC derivation; there is
no `memoId` in its Solana support at all). SOL therefore behaves like TRX, which
already works here.

#### THE ACTION — exact figures

| | |
|---|---|
| **Send exactly** | **0.01 SOL** (`10000000` lamports) |
| **To** | **`HRdvYQ2StLnLNRHFeyBoDMgBVbCqjAJTm5vAmbmBqEwP`** |
| From | any wallet you control — your own Blockle wallet is fine |
| Wallet this activates | `Blockle Exchange SOL`, id `6b06f0530242e6aa1edd125b16f521fe` |

That address is **the wallet's own root address and the only correct
destination**. Verify it against live BitGo before sending — do not trust this
file, it is a copy:

```sh
exchange/custody/ops/activate-sol-wallet.sh          # read-only preflight
```

**Send 0.01, not the bare 2447136 lamports.** BitGo's `minimumFunding` must
*stay* on the wallet and cannot be spent, so funding the exact minimum activates
a wallet with nothing left to pay a fee with.

After the transfer confirms, the same script verifies the result and — only when
you pass `--mint-test` — makes the one POST that proves the rail:

```sh
exchange/custody/ops/activate-sol-wallet.sh --mint-test
```

A pass is: `pendingChainInitialization` flips to **false**, and the POST returns
**200** with a **new** base58 address at index 1 that is **not** the root. That
single assertion also answers question 2 of the BitGo ticket for free.

### Blocker 2 (engineering, ~1 week): we could not send it back

**Do not open the SOL rail when blocker 1 clears.** Solana is an
account-per-address model: a deposit to a per-customer receive address sits in
*that* account, not in a pooled wallet balance. Getting it out needs an explicit
consolidation — BitGo documents Solana as **manual** consolidation, fees paid in
SOL by each receive address, at most 25 owner addresses per transaction.

This service has no consolidation code. `grep -n consolidat src/` returns
comments and **no call site**. So an activated-but-unconsolidated wallet is a
one-way door: it takes deposits it cannot pay back.

`RAIL_BLOCKERS.SOL` therefore lists both causes, and the rail stays shut while
*either* remains. That is deliberate: funding the wallet makes BitGo mint
addresses and the gas gate already passes (SOL pays its own gas), so a
single-cause design would have opened the rail on the cheaper half of the fix.

Three things to build, before the first SOL deposit and not after:

1. `POST /api/v2/sol/wallet/{id}/consolidateAccount/build`, ≤25 owner addresses
   per transaction, ATAs excluded.
2. **A declared minimum SOL deposit**, above the per-account rent floor. Live
   chain minimums: `650240` lamports for a bare system account, `1056640` for an
   80-byte durable nonce, `1488440` for a 165-byte SPL token account. A deposit
   below the floor lands somewhere that cannot be swept clean.
3. **Settle one measurement that is currently unknown.** `BitGoHoldings.holdings`
   (`src/bitgo.ts`) sums `confirmedBalanceString` *per wallet*. Whether BitGo's
   wallet-level balance **aggregates per-receive-address Solana account
   balances, or reports only the root**, cannot be determined while every
   balance is zero. If it reports only the root, `reconcile.ts` will read real
   customer deposits as a **SHORTFALL** until consolidation runs. That is a
   money-visible bug and it is far cheaper to settle on the day of activation —
   with ~$2 on the wallet and no customer money at risk — than after. The
   `--mint-test` branch of the activation script prints both numbers side by
   side for exactly this reason.

---

### Before you send: the activation payment will be seen as a deposit

**This has already happened once, on XRP, and it halted withdrawals.** Read
`ops/unbook-unattributed.js` — it exists only to clean up the last one.

The deposit watcher polls every asset that appears in a market, and it does
**not** consult `railBlocker`. The watched set is, measured from `MARKETS`:

```
BLOCK BNB BTC DINGO DOGE ETH PEP PERBUG RTM SOL TRX USDC USDT XRP
```

**SOL is in it.** So the moment your 0.01 SOL confirms, the watcher will see an
incoming transfer to the root address, find that no customer was ever issued
that address, and park the credit in `__unattributed__`. Two consequences:

1. **A liability appears that is owed to nobody.** The money is the venue's own.
   That is what `unbook-unattributed.js` reversed for XRP — it is hardcoded to
   XRP, so a SOL equivalent has to be written, and the honest time to write it
   is once the real numbers are visible rather than guessed at now.
2. **Watch for a shortfall.** On XRP the watcher credited the full transfer
   (1,222,500 drops) while BitGo confirmed only 1,200,000 — books above
   custody, reported as a SHORTFALL, which **halted XRP withdrawals**. SOL has
   an unspendable `minimumFunding` of 2,447,136 lamports, so if BitGo's
   `confirmedBalanceString` excludes any part of what you sent, the same
   mismatch follows.

Neither is dangerous — no customer money is involved and the ledger reverses
rather than deletes — but both are confusing if they arrive unannounced, and a
reconciliation alarm on a live venue should never be a surprise. Expect them,
and check `reconcile` after funding.

## XLM — the same shape as SOL, about a dollar, not on the critical path

Not one of the three chains customers asked about, but it is the identical
blocker and worth one sitting:

```
GET /api/v2/xlm/wallet/6b06f07b8c1c57c3f6d7c8f38d0fb5cb
  coinSpecific.rootAddress                GA7LIPAY75JZLBUICBVM65KPGN6QNUTFVMSJBWQTUO74AM2BMJVFQG2Y
  coinSpecific.pendingChainInitialization true
  coinSpecific.lastMemoId                 "0"
  balanceString                           0
  receiveAddress   GA7LIPAY75JZ...FQG2Y?memoId=0
```

**XLM needs no new attribution design.** It is memo-based, `deposits.ts` already
stores a memo and `describeDeposit` already sets `memoRequired: true`. It is
also *not* account-per-address, so it does not inherit SOL's consolidation
problem.

**But do not copy a figure from this file.** Unlike `sol`, BitGo publishes **no
`minimumFunding` for `xlm`** — the field is simply absent from `coinSpecific`.
The required reserve is Stellar's protocol base reserve times the number of
subentries, and a BitGo multisig account has signer subentries, so the real
figure is above the 1 XLM a bare account needs. **Ask BitGo for the number
(question 2 of the ticket) rather than guessing**, or send a deliberately
generous amount and accept that some of it is permanently locked as reserve.

---

## Not an option, at any price: one shared address

It is available **right now**, which is exactly why it is written down as
forbidden. `GET /{coin}/wallet/{id}` already returns a working root address:

- ETH `0xd54e7f761c2ced2041057ec799610debe1e6c08d`
- BSC `0x1f56cbe4bd6b3978dcb5df31a8bd5033235f0e80`
- SOL `HRdvYQ2StLnLNRHFeyBoDMgBVbCqjAJTm5vAmbmBqEwP`

**None of those three chains has any memo or tag mechanism.** Our SOL wallet's
`coinSpecific` is `{rootAddress, minimumFunding, type, pendingChainInitialization,
trustedTokens}` — no `memoId`, in pointed contrast to XLM's `memoId` and XRP's
`?dt=`. So two customers depositing the same asset would be **permanently
indistinguishable**: reconciliation would still balance while attribution was
irrecoverably lost, and the ledger would credit whoever support believed.

The rescue variants are the same failure with extra steps. Unique-amount
matching collides and is trivially griefed. "Send us your transaction hash"
makes attribution a support claim rather than a fact. **Do not implement any of
them, and do not offer one as a stopgap.**

---

## What the customer sees in the meantime

Already live, and it is no longer a blank. `railBlocker()` is consulted
*before* the custodian — which also stopped the deposit page firing three
doomed BitGo requests on every single load — and the sentence reaches both the
web UI (`exchange.js`) and the app (`deposit_section.dart`):

> ETH deposits are not open yet. Our custodian will not issue a per-customer
> Ethereum deposit address on our current plan, and we will not hand everyone
> one shared address — on Ethereum there is no memo or tag, so we could not tell
> whose money had arrived. We are resolving it with the custodian. ETH is
> available on: …

**Reply to the two customers who asked.** The code is honest now; the silence is
the part that was failing them. Tell them the real reason and which chain works
today — USDT over Tron, or BTC / DOGE / XRP. A third unanswered repeat is the
actual damage here.

**MoonPay is a partial answer, stated as such.** It handles "I want to fund my
account" — the card order id attributes the funds, so the memo-less problem
never arises. It does *not* handle "I want to send you the ETH I already hold",
which is what both customers asked for. Geofencing applies.

---

## DEPLOY NOTE — the honest message is not live yet

**Measured on the box, 2026-11-26.** Everything above about what the customer
sees is true of the repository and **not** of production:

```
exchange-public-api.service   active, ExecStart=node dist/src/publicapi.js
/opt/blockle/exchange-custody/dist/src/deposits.js     built 2026-11-25 20:37
/opt/blockle/exchange-custody/dist/src/settlement.js   DOES NOT EXIST
grep "pricing plan" dist/src/*.js                      no match
```

So the live service still composes the old generic paragraph —
`No ${sym} deposit address is provisioned` — which is exactly the sentence both
customers were answered with. **Until this is deployed, nothing they see has
changed.**

```sh
cd exchange/custody
npm test                       # 663 passing
npm run build
# ship dist/ AND ops/ to /opt/blockle/exchange-custody
systemctl restart exchange-public-api
```

Two things that are easy to miss:

- **`src/settlement.ts` is still untracked in git.** `git status` shows it under
  `??`, so a `git commit -a` will not include it and the build will fail on the
  box with an unresolved import. `git add` it explicitly.
- **`ops/` is not deployed today** — `/opt/blockle/exchange-custody/ops/` does
  not exist. The error message in `bitgodeposits.ts` tells an operator to run
  `ops/activate-sol-wallet.sh`, so ship the directory or run the script from a
  checkout with `APP_DIR=/opt/blockle/exchange-custody`.

After the restart, confirm the new wording is actually reaching a customer
rather than assuming it:

```sh
curl -s localhost:3100/v1/deposit-addresses -H 'Authorization: Bearer <key>' \
  | grep -o 'not open yet'
```

## Housekeeping, unrelated to the three rails

A previous diagnostic pass left a real address on the LTC wallet, and it has a
consequence worth knowing:

```
GET /api/v2/ltc/wallet/6b06f06c19290ed5a76cd4e96bd63ebc/addresses
  index 0  MMrQAgkeWDZ7kBA9WNzoPhN4szYaYBrvjS
  index 1  MNuW6ELxeMy1jyLHCsPYXFyRN7vKpLWCWa   label "diag-probe-20261125"
```

It is unfunded and harmless today, **but BitGo now reports that probe address as
the wallet's `receiveAddress`** — the newest address becomes the wallet default.
LTC is not in `PROVEN_RAILS` and is not a listed deposit asset, so no customer
can reach it. If LTC is ever listed, mint a fresh labelled address rather than
taking the wallet root, or a customer deposit lands on an address named after a
diagnostic.
