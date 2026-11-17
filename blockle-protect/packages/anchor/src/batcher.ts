/**
 * Anchor batcher — accumulates file/manifest commitments, builds one SHA-384
 * Merkle tree per batch, and anchors ONLY the root on-chain. Each commitment
 * gets a portable inclusion proof that resolves to the anchored root, so a
 * single on-chain write amortizes over the whole batch and every file remains
 * independently verifiable.
 */
import { merkleTree, fromBase64Url, toBase64Url, type MerkleProof } from '../../core/src/index.js'
import { AnchorChain, onchainRoot32, AnchorNotConfigured } from './chain.js'

export interface AnchorRecord {
  batchId: string
  /** base64url SHA-384 Merkle root. */
  root: string
  /** 32-byte on-chain anchor key (hex). */
  onchainKey: string
  txid: string | null
  height: number | null
  /** unix seconds the batch was submitted (server-stamped). */
  submittedAt: number
  /** commitment (base64url) -> inclusion proof. */
  proofs: Record<string, MerkleProof>
}

export interface BatchResult {
  root: string
  onchainKey: string
  txid: string | null
  /** per-commitment inclusion proofs, in submission order. */
  inclusions: { commitment: string; proof: MerkleProof }[]
  anchored: boolean
  reason?: string
}

/**
 * Build a Merkle batch from base64url commitments and (if the chain is
 * configured) anchor the root. Returns inclusion proofs regardless, so callers
 * can assemble portable proofs even before the anchor confirms.
 *
 * `now` is injected (no hidden clock) so this is deterministic and testable.
 */
export async function buildAndAnchorBatch(
  commitmentsB64: string[],
  chain: AnchorChain,
  now: number,
): Promise<{ result: BatchResult; record: AnchorRecord }> {
  if (commitmentsB64.length === 0) throw new Error('cannot anchor an empty batch')
  // de-dupe while preserving first-seen order
  const seen = new Set<string>()
  const commitments = commitmentsB64.filter(c => (seen.has(c) ? false : (seen.add(c), true)))

  const leaves = commitments.map(c => fromBase64Url(c))
  const { root, proof } = merkleTree(leaves)
  const rootB64 = toBase64Url(root)
  const rootHex = Buffer.from(root).toString('hex')
  const onchainKey = onchainRoot32(rootHex)

  const inclusions = commitments.map((commitment, i) => ({ commitment, proof: proof(i) }))
  const proofs: Record<string, MerkleProof> = {}
  for (const { commitment, proof } of inclusions) proofs[commitment] = proof

  let txid: string | null = null
  let anchored = false
  let reason: string | undefined
  try {
    const sub = await chain.anchor(onchainKey)
    txid = sub.txid
    anchored = true
  } catch (e) {
    if (e instanceof AnchorNotConfigured) {
      reason = `anchor not submitted — ${e.message}` // honest: no on-chain write happened
    } else {
      reason = `anchor submission failed — ${(e as Error).message}`
    }
  }

  const batchId = `${now.toString(36)}-${onchainKey.slice(0, 12)}`
  const record: AnchorRecord = {
    batchId, root: rootB64, onchainKey, txid,
    height: null, submittedAt: now, proofs,
  }
  const result: BatchResult = { root: rootB64, onchainKey, txid, inclusions, anchored, ...(reason ? { reason } : {}) }
  return { result, record }
}
