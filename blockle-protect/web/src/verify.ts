/**
 * protect.blockle.org — public verification portal (runs ENTIRELY in the
 * browser). It imports the same audited core the apps use, so a third party can
 * verify a Blockle Protect proof without an account and without trusting our
 * backend. The only network call is an OPTIONAL read of the PUBLIC Blockle chain
 * to confirm the anchor transaction exists.
 */
import { verifyProof, fileMatchesProof, sha384, toBase64Url } from '../../packages/core/src/index.js'
import type { PortableProof, AnchorRef } from '../../packages/core/src/index.js'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

/** Confirm the anchored Merkle root really sits in a Blockle transaction.
 *  Reads the PUBLIC chain via a CORS-open read shim — chain data, not our word. */
async function confirmOnChain(anchor: AnchorRef): Promise<boolean> {
  try {
    const r = await fetch(`/api/anchor/${encodeURIComponent(anchor.txid)}`, { cache: 'no-store' })
    if (!r.ok) return false
    const j = (await r.json()) as { roots?: string[] }
    return Array.isArray(j.roots) && j.roots.includes(anchor.root)
  } catch {
    return false
  }
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

function row(label: string, ok: boolean | 'na', detail = ''): string {
  const mark = ok === 'na' ? '—' : ok ? '✓' : '✕'
  const cls = ok === 'na' ? 'na' : ok ? 'ok' : 'bad'
  return `<div class="vrow ${cls}"><span class="vmark">${mark}</span><span class="vlabel">${label}</span><span class="vdetail">${detail}</span></div>`
}

function short(b64: string, n = 10): string {
  return b64.length > n * 2 ? `${b64.slice(0, n)}…${b64.slice(-n)}` : b64
}

async function run(proof: PortableProof, file: File | null): Promise<void> {
  const out = $('result')
  out.className = 'result show checking'
  out.innerHTML = '<div class="spin"></div><p>Verifying…</p>'

  // Offline cryptographic checks (signature → commitment → inclusion).
  const res = await verifyProof(proof)
  // Optional on-chain anchor confirmation.
  const anchorConfirmed = await confirmOnChain(proof.anchor)
  // Optional: does the uploaded file match the fingerprint?
  let fileMatch: boolean | 'na' = 'na'
  if (file) fileMatch = fileMatchesProof(await readFileBytes(file), proof)

  const fullyValid =
    res.signatureValid && res.commitmentValid && res.inclusionValid && anchorConfirmed &&
    (fileMatch === 'na' || fileMatch === true)

  const m = proof.signed.manifest
  const when = new Date(m.createdAt * 1000).toISOString().replace('T', ' ').replace(/\..+/, ' UTC')

  out.className = `result show ${fullyValid ? 'valid' : 'invalid'}`
  out.innerHTML = `
    <div class="verdict">
      <div class="vicon">${fullyValid ? '🛡️' : '⚠️'}</div>
      <div>
        <h3>${fullyValid ? 'Verified &amp; anchored' : 'Could not fully verify'}</h3>
        <p class="vsub">${fullyValid
          ? 'This record is authentic, intact, and independently anchored on the Blockle chain.'
          : (res.reason ?? (anchorConfirmed ? 'See the checks below.' : 'The anchor transaction was not found on-chain.'))}</p>
      </div>
    </div>
    <div class="vrows">
      ${row('Post-quantum signature (ML-DSA-65)', res.signatureValid, 'manifest signed by its key')}
      ${row('Commitment matches signed record (SHA-384)', res.commitmentValid)}
      ${row('Merkle inclusion proof', res.inclusionValid, 'resolves to the anchored root')}
      ${row('Anchored on the Blockle chain', anchorConfirmed, anchorConfirmed ? `tx ${short(proof.anchor.txid, 8)}` : 'not found')}
      ${row('Uploaded file matches fingerprint', fileMatch, file ? (fileMatch ? 'exact match' : 'does NOT match') : 'no file provided')}
    </div>
    <dl class="vmeta">
      <dt>File fingerprint</dt><dd class="mono">${short(m.fingerprint, 16)}</dd>
      <dt>Signing key</dt><dd class="mono">${short(m.signerPublicKey, 16)}</dd>
      <dt>Anchored root</dt><dd class="mono">${short(proof.anchor.root, 16)}</dd>
      <dt>Recorded at</dt><dd>${when} <span class="hint">(when the record was made — not proof of authorship)</span></dd>
      <dt>Algorithms</dt><dd class="mono">ML-DSA-65 · ML-KEM-768 · AES-256-GCM · SHA-384</dd>
    </dl>`
}

function parseProof(text: string): PortableProof {
  const p = JSON.parse(text) as PortableProof
  if (!p || typeof p !== 'object' || !p.signed || !p.anchor || !p.merkleProof) {
    throw new Error('That does not look like a Blockle Protect proof.')
  }
  return p
}

export function init(): void {
  const proofInput = $<HTMLTextAreaElement>('proof')
  const fileInput = $<HTMLInputElement>('file')
  const btn = $<HTMLButtonElement>('verifyBtn')
  const err = $('error')
  let picked: File | null = null

  fileInput.addEventListener('change', () => {
    picked = fileInput.files?.[0] ?? null
    $('fileName').textContent = picked ? picked.name : 'Optional: upload the original file to confirm it matches'
  })

  // Proof file drop onto the textarea loads its JSON.
  const proofFile = $<HTMLInputElement>('proofFile')
  proofFile.addEventListener('change', async () => {
    const f = proofFile.files?.[0]
    if (f) proofInput.value = await f.text()
  })

  btn.addEventListener('click', async () => {
    err.textContent = ''
    try {
      const proof = parseProof(proofInput.value.trim())
      btn.disabled = true
      await run(proof, picked)
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : 'Verification failed.'
      $('result').className = 'result'
    } finally {
      btn.disabled = false
    }
  })

  // Expose a tiny helper for people computing a fingerprint by hand.
  ;(window as unknown as { blockleFingerprint?: unknown }).blockleFingerprint = async (f: File) =>
    toBase64Url(sha384(await readFileBytes(f)))
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
