/**
 * SHA-384 Merkle tree for batching many file commitments into a single on-chain
 * anchor. Domain-separated leaf/node tags (0x00 / 0x01) prevent second-preimage
 * and leaf/node confusion. Odd levels duplicate the last node (Bitcoin-style).
 *
 * Batching is what makes anchoring cheap: thousands of users' file commitments
 * share ONE chain transaction (the root), yet each file keeps an independent
 * inclusion proof.
 */
import { sha384, type Bytes } from './primitives.js'
import { concatBytes, toBase64Url, fromBase64Url } from './encoding.js'

const LEAF_TAG = new Uint8Array([0x00])
const NODE_TAG = new Uint8Array([0x01])

/** Hash a leaf's data (the file commitment) into a Merkle leaf node. */
export function hashLeaf(data: Bytes): Bytes {
  return sha384(concatBytes(LEAF_TAG, data))
}
function hashNode(left: Bytes, right: Bytes): Bytes {
  return sha384(concatBytes(NODE_TAG, left, right))
}

export interface MerkleProof {
  leafIndex: number
  /** Sibling hashes from leaf→root, each tagged with which side it sits on. */
  siblings: { hash: string; side: 'left' | 'right' }[]
}

/** Compute the Merkle root over a list of commitments (leaf data). */
export function merkleRoot(commitments: Bytes[]): Bytes {
  return buildLevels(commitments).root
}

/** Build the full tree and return the root + a proof generator. */
export function merkleTree(commitments: Bytes[]): {
  root: Bytes
  proof: (leafIndex: number) => MerkleProof
} {
  const { root, levels } = buildLevels(commitments)
  return {
    root,
    proof(leafIndex: number): MerkleProof {
      if (leafIndex < 0 || leafIndex >= commitments.length) throw new Error('merkle proof: index out of range')
      const siblings: MerkleProof['siblings'] = []
      let idx = leafIndex
      for (let lvl = 0; lvl < levels.length - 1; lvl++) {
        const nodes = levels[lvl]!
        const isRight = idx % 2 === 1
        const sibIdx = isRight ? idx - 1 : idx + 1
        const sib = nodes[sibIdx] ?? nodes[idx]! // duplicated last node on odd level
        siblings.push({ hash: toBase64Url(sib), side: isRight ? 'left' : 'right' })
        idx = Math.floor(idx / 2)
      }
      return { leafIndex, siblings }
    }
  }
}

function buildLevels(commitments: Bytes[]): { root: Bytes; levels: Bytes[][] } {
  if (commitments.length === 0) throw new Error('merkle: cannot build an empty tree')
  let level = commitments.map(hashLeaf)
  const levels: Bytes[][] = [level]
  while (level.length > 1) {
    const next: Bytes[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!
      const right = level[i + 1] ?? left // duplicate last if odd
      next.push(hashNode(left, right))
    }
    levels.push(next)
    level = next
  }
  return { root: level[0]!, levels }
}

/** Independently verify an inclusion proof: does `commitment` sit under `root`? */
export function verifyMerkleProof(commitment: Bytes, proof: MerkleProof, root: Bytes): boolean {
  let node = hashLeaf(commitment)
  for (const sib of proof.siblings) {
    const sibHash = fromBase64Url(sib.hash)
    node = sib.side === 'left' ? hashNode(sibHash, node) : hashNode(node, sibHash)
  }
  if (node.length !== root.length) return false
  let diff = 0
  for (let i = 0; i < node.length; i++) diff |= node[i]! ^ root[i]!
  return diff === 0
}
