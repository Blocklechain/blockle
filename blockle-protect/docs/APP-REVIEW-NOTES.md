# Blockle Protect — App Review Notes

Paste-ready answers for the "App Review Information" fields in App Store
Connect. Keep this file in sync with what actually ships — every claim here is
checkable, and an inaccurate note is worse than a missing one.

---

## 2. Purpose, audience, problem solved, value

**Blockle Protect is a personal file-security and family web-filtering app for
iPhone and iPad.** Published by Alienbeing LLC.

**The problem.** Two unrelated worries, both ordinary:

1. *Files you cannot afford to lose or have altered* — passports, deeds,
   contracts, medical records, family photos. People keep these in iCloud and
   have no way to prove later that a copy is the original and unmodified.
   Separately, data harvested today can be decrypted later once a
   cryptographically relevant quantum computer exists ("harvest now, decrypt
   later").
2. *What a household runs into on the web* — gambling, scam/phishing and adult
   sites, including on a child's device.

**What the app does.**

- **Vault** — pick a file or photo; the app encrypts it **on the device** with
  AES-256-GCM, wraps the key with **ML-KEM-768** (NIST FIPS 203) and signs a
  manifest with **ML-DSA-65** (FIPS 204). The original is left untouched. The
  encrypted copy lives in the user's **own iCloud**, not on our servers.
- **iCloud Shield** — the same protection applied to items picked from Files
  and Photos, so an encrypted copy syncs through the user's existing storage.
- **Secure Sharing** — add a recipient to an already-protected file without
  re-encrypting the content.
- **Recovery Key** — a user-held recovery secret. We hold **no** escrow and
  have **no** backdoor; if the user loses both device and recovery key, the
  data is unrecoverable, and the app says so plainly.
- **Family Protection (Safari content blockers)** — system-wide blocking of
  gambling, scam/phishing and adult domains in Safari.
- **Security Checkup** — a local read of device posture (passcode, biometrics,
  backup, filter state) with plain-English fixes.
- **Commitment Lock** — the user can optionally lock themselves out of
  disabling their own filters for a chosen period. Useful for self-control;
  entirely opt-in.
- **Blockle Intelligence** — an optional assistant that explains checkup
  findings in plain language.

**Audience.** Non-technical people who have something worth protecting —
parents, freelancers and small-business owners handling client documents, and
anyone wanting a household web filter. **The app is explicitly designed so the
user never has to understand keys, signatures or quantum computing.**

**Value.** Protection that does not depend on trusting our servers: encryption
happens on the device, the ciphertext goes to storage the user already owns and
pays for, and the integrity record can be verified independently at
`https://protect.blockle.org/verify` — including by someone who does not have
the app and does not trust us.

**What we deliberately do NOT claim** (see `docs/THREAT-MODEL.md`, which bounds
every marketing claim): not "unhackable", not "quantum-proof" — we say
*post-quantum*, meaning algorithms believed resistant to known quantum attacks
under current analysis. A timestamp proves a record existed, not who authored
it.

---

## 3. Setup and access, credentials, sample files

**There is no login. There are no credentials to provide, and none to ask for.**

Blockle Protect has **no user accounts, no username, no password, and no server
sign-in**. The user's identity is a set of cryptographic keys generated on the
device at first launch and held in the Keychain. This is a deliberate design
choice — there is no account database to breach — and it is why the Account
screen explains that "Account" means the on-device identity.

**A demo build with all paid content unlocked has been provided** (see §6
below). Nothing else is needed to reach any feature.

### Walkthrough for the reviewer

1. **Launch** → short onboarding → **Done**. No sign-up, no email, no
   permission prompts yet.
2. **Vault tab → "Protect a file"** → choose any document or photo from Files
   or Photos. *(A sample `review-sample.txt` is included in the TestFlight
   notes; any file works — the app never inspects content.)*
   - The original is left in place; an encrypted copy and a signed manifest are
     created. Face ID is requested only to unlock the vault.
3. **Tap the protected item → "Verify"** → the app re-checks the signature and
   fingerprint and reports tamper-evidence.
4. **Export proof** → produces a portable proof file. Open
   `https://protect.blockle.org/verify` in Safari **on any device**, drop the
   proof in, and it verifies in-browser — demonstrating that verification does
   not require our app or our servers.
5. **Shield tab → enable Family Protection.** iOS will ask you to enable the
   content blockers in **Settings → Safari → Extensions**. Then visit any
   gambling or adult domain in Safari to see it blocked.
6. **Home → Security Checkup** → runs locally, lists findings. **"Explain this"**
   calls the assistant (see §4).
7. **Settings → Recovery Key** → generate and view the recovery secret.
8. **Settings → Family** → create a household and view the invite code.

**Note on Commitment Lock:** this is opt-in and, by design, hard to cancel —
that is its purpose. Please do not start one during review unless you intend to
test it; a short duration can be chosen if you do.

---

## 4. External services, tools and platforms

| Service | Operated by | What it is used for | Data sent |
|---|---|---|---|
| **Apple iCloud** (Files, Photos, CloudKit) | Apple | Stores the user's **encrypted** copies in their own iCloud account | Ciphertext and signed manifests only. Never plaintext, never keys. |
| **Apple StoreKit 2** | Apple | The single one-time unlock and the optional donation | Handled entirely by Apple |
| **Apple Keychain / Secure Enclave** | Apple | Key storage, biometric unlock | Stays on device |
| **`protect.blockle.org`** | **Alienbeing LLC (we operate it)** | Hosts the public verification page, the Safari blocklist files, and the assistant API | See below |
| **Blockle Intelligence assistant** | **Alienbeing LLC — self-hosted** | Plain-language explanation of checkup findings | The user's question plus non-identifying posture signals (e.g. "backup is off"). **No file contents, no file names, no keys.** |
| **blocklistproject** domain lists | Third-party, open source | Source data for the Safari gambling / scam / adult blocklists | Nothing sent — lists are downloaded and compiled into the app's blockers |
| **Blockle chain** (`blockle.org`) | **Alienbeing LLC (we operate it)** | Public chain used for the optional integrity-anchor feature | A SHA-384 Merkle root only — no file names, contents or keys |

**On AI:** the assistant is **not** a third-party AI service. It is a
**self-hosted open-weights model (Qwen2.5-3B via Ollama) running on our own
server**. No data goes to OpenAI, Anthropic, Google or any other AI provider.
The model is also **sandboxed by design**: it can only return a suggestion
referencing a finding the app itself produced, and every action is executed
locally by the app after the user confirms it, so a compromised or manipulated
model cannot cause the app to act on its own (see `docs/AGENT-HARDENING.md`).

**No third-party analytics, advertising, attribution or crash SDKs are
embedded.** There is no payment processor other than Apple.

### Background App Refresh (`UIBackgroundModes: fetch`)

The app declares one background task, `org.blockle.protect.refresh`. It does
exactly one thing: read the on/off state of the app's own Safari content
blockers via `SFContentBlockerManager.getStateOfContentBlocker`, and — **only if
the user has invited an accountability partner or joined a household, both by
double opt-in** — send an email saying which protection was switched off.

This exists because iOS provides no callback when a content blocker is toggled
and blocker state is only readable while the app runs, so without it a filter
disabled in Settings would go unreported until the user next opened the app.
No location, no content, no file data and no advertising identifier is read or
transmitted. The emails carry only the member's chosen alias and the names of
the filters that changed, and every recipient has a one-click unsubscribe.

**We do not claim real-time alerting anywhere in the UI**, because iOS decides
whether and when to grant background time.

---

## 5. Regional differences

**The app functions identically in every region.** There is no
geo-gating, no region-locked feature, no region-varying content, and no
regional pricing tier beyond Apple's standard storefront conversion.

Two honest qualifications:

1. **Blocklist coverage is domain-based, not region-based.** The gambling,
   scam and adult lists are global domain lists; they are not tailored per
   country and do not encode any country's specific legal definition of these
   categories. A site legal in one country and not another is treated the same
   way everywhere.
2. **Language.** The interface is currently **English only**. It is not
   localised, which affects usability in non-English regions but not
   functionality.

The app contains no region-restricted media, no licensed catalogue, and no
feature that is enabled in one territory and disabled in another.

---

## 6. Regulated industry / protected third-party material

### Third-party material — Safari blocklists

The blocked-domain data comes from the open-source **blocklistproject** lists
(`gambling.txt`, `scam.txt`, `porn.txt`), released under the **Unlicense** — a
public-domain dedication permitting unrestricted commercial use and
redistribution. We normalise and de-duplicate the domains and compile them into
Safari content-blocker rules. Provenance and the regeneration command are
documented in `blocklists/README.md`. No proprietary or licensed blocklist is
used.

### Cryptography — standards, not invention

All primitives are published NIST standards implemented by the audited
open-source `@noble` libraries (MIT): ML-KEM-768 (FIPS 203), ML-DSA-65
(FIPS 204), AES-256-GCM (SP 800-38D), SHA-384 (FIPS 180-4), HKDF (RFC 5869).
**No proprietary or home-grown cryptography.** The full algorithm table and the
explicit limits of our claims are in `docs/THREAT-MODEL.md`.

### Not a regulated financial service

The app takes no custody of funds, offers no trading, and is not a financial
product. The optional chain anchor stores a hash; it involves no user-held
cryptocurrency, no wallet, and no purchase of digital currency. Network fees
for anchoring are paid by us, not the user.

### Demo build for review

A build is supplied in which **all paid content is unlocked without a
purchase**, so the full app can be exercised without transacting. It is built
from the dedicated **`Demo` configuration**, is named **"Protect DEMO"** on the
home screen, and displays a permanent **"DEMO: PAID CONTENT UNLOCKED"** banner.
The unlock is behind the `DEMO_UNLOCK` compile flag set only by that
configuration, so it cannot be present in a public release build.

### ⚠️ Export compliance — must be resolved before submission

`INFOPLIST_KEY_ITSAppUsesNonExemptEncryption` is currently set to **`NO`**.
**This is very likely incorrect for this app and should be reviewed with
counsel before submitting.** The common exemptions cover apps that use
encryption only for authentication, only via Apple's operating-system
facilities, or only for copy protection. Blockle Protect ships its own
cryptographic implementation and *file encryption is its primary purpose*,
which is the fact pattern that normally requires `YES`, plus a self-classification
report / Encryption Registration Number with the US Bureau of Industry and
Security, and the French encryption declaration Apple asks about.

This is a legal declaration, not a build setting, so it is deliberately left
unchanged here pending that decision.
