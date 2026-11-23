# TradeXPro: Laravel 8.65 → 12, in house

**Decision:** upgrade the framework ourselves and fork from vendor updates.
Recorded 2026-11-23.

TradeXPro 3.2.0 — the current release — ships `laravel/framework: ^8.65`.
Laravel 8's **security** support ended January 2023, and the vendor has shipped
three years of releases without touching it. There is no upstream fix to wait
for.

---

## 0. The two things that decide whether this works

### Git baseline — do this first, before any edit

The tree is **not a git repository**. Run
`./deploy/exchange/vendor-baseline.sh` before changing a line. It commits the
pristine 3.2.0 release on a `vendor` branch and branches `main` off it, so a
future 3.3.0 is a three-way merge instead of a manual diff of two
independently-moved trees. That second thing is where forks get abandoned.

### Test coverage — 7 files for 2,661

This is the real risk, and it is much larger than any individual dependency
bump. TradeXPro ships **7 test files**. Upgrading a framework across 2,661 files
with no coverage is "change everything and hope": the code will still boot, and
you will not find out that a fee is computed wrong, a balance is rounded, or an
order fills at the wrong price until a customer does.

**So: characterization tests on the money paths come before the framework
touch.** Not aspirational coverage — pin the CURRENT behaviour of the paths
that move money, on Laravel 8, so that after each upgrade step you can prove
behaviour did not change:

| Path | Pin |
|---|---|
| `OrderService` / `OrderValidationService` | an order of each type → resulting fills, fees, rejections |
| `OrderCostService` | fee and cost arithmetic at boundary amounts |
| `FundTransferService` (`SpotFundTaker` / `SpotFundGiver`) | balances before/after, and that the row lock holds |
| `WithdrawHistory` + `WithdrawalProcessJob` | state transitions, amounts at 18 decimals |
| `User2FARepositorie` / `TwoFactorController` | enrolment and verification |
| Deposit crediting | idempotency on a replayed callback |

Where behaviour is already wrong (the `decimal(19,8)` truncation, for one), pin
the wrong behaviour **and mark the test** — the upgrade must not silently change
it, and fixing it is a separate, deliberate commit.

> Write these against Laravel 8 and keep them green through every step below.
> A step that turns one red is a step that changed behaviour, which is exactly
> what you need to know.

---

## 1. Dependencies — measured, not guessed

Good news first: three of the four feared blockers are not blockers.

| Package | Pinned | Reality | Action |
|---|---|---|---|
| `nwidart/laravel-modules` | **`6.0`** exact | **`Modules/` does not exist — unused** | **Remove it.** The hardest-looking pin dissolves. |
| `laravelcollective/html` | `^6.2` | abandoned, no L10+ — but only **11 of 356** blade files use `Form::`/`Html::` | Rewrite those 11 to plain HTML + `@csrf` |
| `laravel/legacy-factories` | `^1.3` | **3 factory files, 0 using `$factory->define`** | Remove it |
| PHP | `^8.0` | box already runs **8.3.6** | Nothing to do |

The genuine bumps:

| Package | From | To | Note |
|---|---|---|---|
| `laravel/framework` | `^8.65` | `^12.0` | one major at a time |
| `laravel/sanctum` | `^2.11` | `^4.0` | token model changed in 3.x |
| `laravel/passport` | `^10.2` | `^12.0` | **Keep it — measured: 7 files reference Passport, 0 reference Sanctum.** API auth runs on Passport, so it must survive all four majors. Do not "simplify" to Sanctum mid-upgrade. |
| `laravel/horizon` | `^5.9` | `^5.24+` | Redis queue dashboard |
| `laravel/telescope` | `^5.7` | — | **Remove from production entirely.** Config already defaults `enabled => env('TELESCOPE_ENABLED', false)`, so it is off unless switched on — but a package that can be enabled by one env var is one env var away from recording order flow. Move it to `require-dev`. |
| `yajra/laravel-datatables-oracle` | `~9.0` | `^11.0` | admin tables |
| `fruitcake/laravel-cors` | `^3.0` | **removed** | merged into Laravel core in 9.x as `HandleCors` |
| `doctrine/dbal` | `^3.4` | `^4.0` or drop | L11 only needs it for legacy column changes |
| `pragmarx/google2fa-laravel` | `^0.2.0` | `^2.0` | **this is the 2FA the venue depends on — test it hardest** |
| `maatwebsite/excel` | `^3.1` | `^3.1` (latest) | exports |
| `intervention/image` | `^3.6` | fine | — |

---

## 2. The upgrade, one major at a time

Never two at once. Each step gets its own branch, its own commit, and the
characterization suite green before moving on.

### 8 → 9 — the hard one

- Symfony 5 → 6 underneath
- Flysystem 1 → 3: `Storage` return values and exceptions change
- `fruitcake/laravel-cors` **removed**, replaced by core `HandleCors`
- `$dates` → `$casts`
- Custom casts, `Str`/`Arr` signature tightening
- Drop `laravel/legacy-factories`

### 9 → 10

- PHP ≥ 8.1 (satisfied)
- Type declarations added throughout — **anything overriding a framework method
  breaks on signature mismatch**. Measured: **266 classes** extend
  `Controller`, `Model`, `Middleware`, `FormRequest`, `Command`, `Job`,
  `Notification` or `Mailable`. Expect this step to be wide but shallow — many
  small signature fixes rather than a few deep ones.
- `dispatchNow()` removed → `dispatchSync()`

### 10 → 11 — structural

- New slim skeleton: `bootstrap/app.php`, no `Http/Kernel.php`,
  `Console/Kernel.php` gone
- Config files consolidated; `config/*.php` now opt-in via `config:publish`
- Middleware registration moves
- **This is the step most likely to need the skeleton adopted by hand** rather
  than by any automated tool

### 11 → 12

Minor by comparison. Mostly dependency alignment.

### Tooling

**Laravel Shift** ($) automates most of 8→9→10→11 mechanically and is worth it
here — it is cheaper than the hours and more consistent than hand-editing 2,661
files. It will not do the skeleton migration judgement calls, and it will not
tell you whether a fee still computes correctly. That is what §0's tests are
for.

---

## 3. Order of work

1. **`vendor-baseline.sh`** — git baseline. Nothing else until this is done.
2. **Characterization tests** on the money paths, green on Laravel 8.
3. **Strip what we are not keeping**: `nwidart/laravel-modules` (unused),
   `laravel/legacy-factories` (3 factories, none legacy-style),
   `fruitcake/laravel-cors` (in core since 9.x), and Telescope → `require-dev`.
   **Passport stays** — it is the API auth. Fewer packages to carry through
   four majors.
4. **Rewrite the 11 `laravelcollective` blades.**
5. **8 → 9**, suite green, commit.
6. **9 → 10**, suite green, commit.
7. **10 → 11**, suite green, commit. Expect the skeleton work here.
8. **11 → 12**, suite green, commit.
9. **Then** the custody integration from `docs/CEX-ARCHITECTURE.md` — the
   `wallet_key` removal, the `decimal(36,18)` widening, BitGo.
10. Separately: **Next.js 12 → 15 and React 17 → 19** for the UserPortal. Lower
    risk (client-side, no funds, no DB), so it need not block the backend.

Steps 1–4 are a day or two. Steps 5–8 are the bulk. Step 9 is what we have
already built and tested.

---

## 4. Two things to decide along the way

**Telescope must not reach production.** It records requests and payloads; on
an exchange that means order flow and potentially credentials, in a database
anyone with admin access can read. Config already defaults it off
(`TELESCOPE_ENABLED`, false) — but "off by an env var" is one misconfigured
deploy from on. Move it to `require-dev` so production cannot enable it at all.

**The fork is now yours to maintain.** Every future vendor release is a merge
you perform, and vendor support no longer covers a modified tree. That was
already true the moment the schema changed — but after four framework majors it
is emphatically true. `vendor-baseline.sh` is what keeps it a merge rather than
an archaeology exercise.
