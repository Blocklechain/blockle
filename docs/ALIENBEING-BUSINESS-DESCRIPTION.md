# Alienbeing LLC — Description of Business Activities

**Prepared:** November 23, 2026
**Purpose:** Know-Your-Business (KYB) / institutional onboarding / banking and
custody-provider diligence.

> **Fill-in-required fields.** The items below are facts only the company's
> records establish, and they are deliberately left blank rather than guessed.
> Complete them before sending this to any counterparty:
>
> - State of formation, formation date, and entity file number
> - EIN
> - Principal place of business (physical address) and mailing address
> - Registered agent
> - Beneficial ownership (names, %, roles) — BitGo and any bank will require 25%+ UBOs
> - Headcount (employees vs. contractors)
> - FinCEN MSB registration number, if registered
> - Prior-year revenue and expected monthly transaction volume
> - Bank(s) of record

---

## 1. Overview

Alienbeing LLC is a software company that designs, builds, and operates
consumer and developer products in the blockchain and digital-security sector,
trading publicly under the **Blockle** brand at `blockle.org`.

The company's activities fall into five lines:

1. **Blockchain protocol development and network operations** — Alienbeing
   develops and operates the Blockle blockchain (ticker **BLOCK**), a
   proof-of-work layer-1 network, together with its public nodes, block
   explorer, and mining-pool infrastructure.
2. **Non-custodial wallet software** — Four client applications (browser
   extension, desktop, mobile, and web) that let users hold and transact their
   own digital assets across approximately fifteen blockchain networks.
3. **Trading-automation software (SaaS)** — A subscription strategy-automation
   product sold through the Apple App Store and Google Play.
4. **Digital-security software** — *Blockle Protect*, a post-quantum
   cryptography cloud-security application for iOS, plus a public web verifier.
5. **Interactive entertainment** — Several mobile and web games monetized
   through in-app purchases.

Revenue is earned from software subscriptions, in-app purchases, protocol and
trading fees, listing and launch fees, retail affiliate commissions, and paid
API usage. The company's products are self-hosted on infrastructure it controls.

---

## 2. Line of business detail

### 2.1 Blockchain protocol and network operations — *operating*

Alienbeing develops the Blockle chain, an independent layer-1 using an Equihash
proof-of-work consensus with a ten-minute target block interval and a
fixed-supply, Bitcoin-style emission schedule. The company:

- maintains the node software and publishes releases;
- operates public seed nodes, a JSON-RPC endpoint, and a block explorer;
- operates mining pools (solo and PPLNS) and a multi-algorithm merged-mining
  ("AuxPoW") facility that lets miners of other proof-of-work chains
  simultaneously secure Blockle;
- maintains two token standards on the chain — **BLOCK-20** (fungible) and
  **BLOCK-721** (non-fungible) — and a native automated-market-maker exchange
  contract.

The network is public and permissionless. Alienbeing does not control user
funds on it.

### 2.2 Non-custodial wallet software — *operating*

Four wallet clients share one cryptographic core:

| Client | Platform |
|---|---|
| Browser extension | Chrome / Chromium |
| Desktop wallet | Windows, macOS, Linux |
| Mobile wallet | iOS, Android |
| Web wallet (PWA) | `blockle.org/wallet` |

**These products are non-custodial.** Private keys are generated on and never
leave the user's device; Alienbeing cannot access, freeze, move, or recover user
funds, and holds no user assets in connection with them. Supported networks
include Bitcoin, Ethereum and EVM-compatible chains, Solana, Tron, TON, XRP,
Stellar, Tezos, Cardano, Bitcoin Cash, Litecoin, Dogecoin, and Blockle.

Fiat on- and off-ramping inside the wallets is provided by **MoonPay**, a
third-party regulated payments provider. MoonPay is the counterparty to the
user for those transactions, performs its own KYC, and handles the funds;
Alienbeing's software passes the user to MoonPay's flow and never touches fiat
or customer funds in that path.

### 2.3 Trading-automation software (SaaS) — *operating*

A strategy-automation product (marketed as *Blockle Alien*) that executes
user-configured trading strategies against decentralized venues. Material
characteristics:

- **Paper-trading by default.** Live execution is opt-in and gated.
- **Non-custodial.** Orders are signed by the user's own key; the company never
  holds the assets traded.
- **Not investment advice.** The product is tooling; it does not provide
  personalized recommendations, and the company is not a registered investment
  adviser or broker-dealer.
- Sold by subscription with a 7-day trial, billed through Apple and Google
  in-app purchase.

### 2.4 Digital-security software — *operating*

**Blockle Protect** is an iOS application and companion web verifier providing
post-quantum-cryptography-based file protection, a device security checkup,
encrypted sharing, and a Safari content blocker. It uses audited cryptographic
libraries and can optionally anchor a file-integrity hash (a SHA-384 Merkle
root, containing no file names, contents, or keys) to the public Blockle chain.
No customer files or keys are transmitted to or stored by the company.

The company also operates a self-hosted language-model inference service used
to explain security findings in plain language, and exposes it as a paid API.

### 2.5 Interactive entertainment — *operating*

Several games distributed on the web and through mobile app stores, monetized
through in-app purchases processed by Apple, Google, and PayPal. Some titles
include optional blockchain-based item ownership.

### 2.6 Retail affiliate — *operating*

A shopping feature that earns commission on qualified referrals to third-party
retailers under standard affiliate programs. Alienbeing is not a merchant of
record for these goods and does not take payment for them.

---

## 3. Planned activity requiring new licensing and partners

### 3.1 Custodial digital-asset exchange — *in development, not launched*

Alienbeing is building a centralized, order-book digital-asset trading venue to
be operated at **`exchange.blockle.org`**. Unlike every product in Section 2,
this venue **would hold customer assets**, which is a materially different
regulatory posture:

- **Customer asset custody** would be provided through a qualified third-party
  custody and wallet provider (**BitGo**), not by keys held by Alienbeing
  staff.
- **Internal ledger.** Customer entitlements tracked in an append-only,
  double-entry ledger, reconciled against custodial balances.
- **Deposits and withdrawals** of digital assets, with policy-based withdrawal
  approval and address allow-listing.
- **Fiat on/off-ramp** via MoonPay as the regulated third-party provider.
- **AML/KYC program** — identity verification at onboarding, sanctions and
  PEP screening, transaction monitoring, recordkeeping, SAR/CTR procedures,
  and a designated compliance officer.
- Assets intended to include major digital assets, EVM-chain assets, BLOCK,
  and BLOCK-20 tokens.

**Status and regulatory position.** This venue is pre-launch and will not
accept customer funds until the required registrations and approvals are in
place. The company understands that operating it is money transmission in the
United States, that **registration as a money services business with FinCEN**
and **state money-transmitter licensing** (or a lawful exemption) are
prerequisites, that custody through BitGo does not itself confer any license on
Alienbeing, and that a legal review and written AML program must be completed
first. The software is being built testnet-first behind an explicit
mainnet-disabled flag that also requires a recorded legal-review sign-off
before it can be lifted.

### 3.2 Previously announced activities currently suspended

For accuracy in diligence, the following were built but have been
**deliberately disabled** pending compliance work, and the company is not
conducting them:

- **Blockle USD (USDB)**, a dollar-referenced token, together with its
  fiat issuance and redemption path — **suspended**.
- **Custodial mining-pool balances** and the **paid token launchpad** —
  **suspended**.
- An in-game currency product — **suspended**.

Geographic restriction (geofencing) is implemented and active across the
company's services.

---

## 4. What the company does *not* do

Stated plainly, because diligence usually asks:

- It does not currently hold, custody, or control customer funds or customer
  digital assets in any live product.
- It does not operate as a broker-dealer, investment adviser, futures
  commission merchant, or money transmitter today.
- It does not offer personalized investment or financial advice, managed
  accounts, lending, margin, yield, or staking-as-a-service.
- It does not issue a live stablecoin (the USDB product is suspended).
- It does not accept fiat payments for digital assets directly; MoonPay,
  Apple, Google, and PayPal are the payment processors of record in their
  respective flows.
- It does not conduct a token sale or public offering of BLOCK.

---

## 5. Third-party providers

| Provider | Role |
|---|---|
| **BitGo** | Digital-asset custody and wallet infrastructure (planned, for the exchange) |
| **MoonPay** | Fiat on/off-ramp; regulated counterparty for fiat-to-crypto |
| **Apple / Google** | App distribution and in-app purchase billing |
| **PayPal** | Payment processing for certain digital goods |
| Cloud/VPS hosting | Node, pool, API, and web hosting |

---

## 6. Contact

- General / support: `support@blockle.org`
- Compliance: `compliance@blockle.org`
- Privacy: `privacy@blockle.org`
- Web: `blockle.org`

---

*This document describes business activities for onboarding and diligence
purposes. It is not legal advice, and the regulatory characterizations in
Section 3 should be confirmed by counsel before the exchange launches.*
