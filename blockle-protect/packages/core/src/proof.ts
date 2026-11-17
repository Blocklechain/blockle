/**
 * The portable proof package — everything a third party needs to verify a
 * protected file's authenticity and integrity WITHOUT a Blockle Protect account
 * and WITHOUT trusting the Blockle Protect backend.
 *
 * Verification is layered:
 *   1. Signature — the manifest is signed by `signerPublicKey` (ML-DSA-65).
 *   2. Commitment — recompute SHA-384(signed manifest); it is the Merkle leaf.
 *   3. Inclusion — the Merkle proof binds the commitment to the anchored root.
 *   4. (optional, online) Anchor — the root is really on the Blockle chain at
 *      `anchor.txid`. This read is done against the PUBLIC chain explorer, not
 *      our server, so trust never routes through Blockle Protect.
 *   5. (optional) File match — SHA-384(file) == manifest.fingerprint.
 */
import { sha384, type Bytes } from './primitives.js'
import { fromBase64Url, toBase64Url, bytesEqual } from './encoding.js'
import { signedManifestBytes, type SignedManifest } from './manifest.js'
import { verifyManifest } from './sign.js'
import { verifyMerkleProof, type MerkleProof } from './merkle.js'

export const PROOF_VERSION = 1

export interface AnchorRef {
  chain: 'blockle'
  txid: string //       chain transaction that carried the Merkle root
  root: string //       base64url SHA-384 Merkle root anchored on-chain
  height?: number //    block height (filled once mined)
  blockTime?: number // unix seconds of the anchoring block
}

export interface PortableProof {
  v: number
  signed: SignedManifest
  /** base64url SHA-384(canonical signed manifest) — the Merkle leaf preimage. */
  commitment: string
  merkleProof: MerkleProof
  anchor: AnchorRef
}

/** The on-chain commitment (Merkle leaf data) for a signed manifest. */
export function commitmentFor(signed: SignedManifest): Bytes {
  return sha384(signedManifestBytes(signed))
}

export interface VerifyResult {
  ok: boolean
  signatureValid: boolean
  commitmentValid: boolean
  inclusionValid: boolean
  /** Only set when a chain-confirm callback was supplied. */
  anchorConfirmed?: boolean
  /** base64url fingerprint from the manifest (SHA-384 of the original plaintext). */
  fingerprint: string
  /** base64url Merkle root the proof resolves to. */
  root: string
  reason?: string
}

/**
 * Verify a portable proof offline (steps 1–3). Pass `confirmAnchor` to also
 * check the root is on-chain (step 4) — that callback should hit the PUBLIC
 * Blockle explorer, independent of any Blockle Protect backend.
 */
export async function verifyProof(
  proof: PortableProof,
  confirmAnchor?: (anchor: AnchorRef) => Promise<boolean>
): Promise<VerifyResult> {
  const fingerprint = proof.signed.manifest.fingerprint
  const root = proof.anchor.root

  const signatureValid = verifyManifest(proof.signed)
  if (!signatureValid) {
    return { ok: false, signatureValid, commitmentValid: false, inclusionValid: false, fingerprint, root, reason: 'invalid manifest signature' }
  }

  const commitment = commitmentFor(proof.signed)
  const commitmentValid = bytesEqual(commitment, fromBase64Url(proof.commitment))
  if (!commitmentValid) {
    return { ok: false, signatureValid, commitmentValid, inclusionValid: false, fingerprint, root, reason: 'commitment does not match signed manifest' }
  }

  const inclusionValid = verifyMerkleProof(commitment, proof.merkleProof, fromBase64Url(root))
  if (!inclusionValid) {
    return { ok: false, signatureValid, commitmentValid, inclusionValid, fingerprint, root, reason: 'Merkle inclusion proof does not resolve to the anchored root' }
  }

  if (confirmAnchor) {
    const anchorConfirmed = await confirmAnchor(proof.anchor)
    return { ok: anchorConfirmed, signatureValid, commitmentValid, inclusionValid, anchorConfirmed, fingerprint, root, ...(anchorConfirmed ? {} : { reason: 'anchored root not found on-chain' }) }
  }

  return { ok: true, signatureValid, commitmentValid, inclusionValid, fingerprint, root }
}

/** Does this exact file match the proof's fingerprint? (SHA-384, no keys.) */
export function fileMatchesProof(plaintext: Bytes, proof: PortableProof): boolean {
  return bytesEqual(sha384(plaintext), fromBase64Url(proof.signed.manifest.fingerprint))
}

/** Assemble a portable proof from a signed manifest + its Merkle inclusion. */
export function buildProof(signed: SignedManifest, merkleProof: MerkleProof, anchor: AnchorRef): PortableProof {
  return {
    v: PROOF_VERSION,
    signed,
    commitment: toBase64Url(commitmentFor(signed)),
    merkleProof,
    anchor
  }
}
