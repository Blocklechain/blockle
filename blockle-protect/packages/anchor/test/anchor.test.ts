/**
 * Anchoring-service conformance. Proves, with NO node and NO wallet:
 *   1. a batch's per-commitment inclusion proofs resolve to the batch root AND
 *      verify under the core's independent Merkle verifier;
 *   2. the full portable-proof path (sign → commit → batch → verifyProof) is
 *      green end-to-end;
 *   3. the on-chain key is the first 32 bytes of the SHA-384 root;
 *   4. with the chain NOT configured, submit returns anchored:false + an honest
 *      reason and a null txid — it never fabricates an anchor.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateIdentity, protect, signManifest, commitmentFor, buildProof, verifyProof,
  recipientFromIdentity, verifyMerkleProof, fromBase64Url, toBase64Url,
} from '../../core/src/index.js'
import { AnchorChain } from '../src/chain.js'
import { buildAndAnchorBatch } from '../src/batcher.js'

function unconfiguredChain(): AnchorChain {
  return new AnchorChain({ nodeUrl: 'http://127.0.0.1:1' }) // no contractId/wallet/wasm
}

test('batch inclusion proofs verify under the core Merkle verifier', async () => {
  const commitments = Array.from({ length: 5 }, (_, i) =>
    toBase64Url(new Uint8Array(48).fill(i + 1)))
  const { result } = await buildAndAnchorBatch(commitments, unconfiguredChain(), 1_700_000_000)
  const root = fromBase64Url(result.root)
  assert.equal(result.inclusions.length, 5)
  for (const { commitment, proof } of result.inclusions) {
    assert.ok(verifyMerkleProof(fromBase64Url(commitment), proof, root), `proof for ${commitment}`)
  }
})

test('on-chain key is the first 32 bytes of the SHA-384 root', async () => {
  const commitments = [toBase64Url(new Uint8Array(48).fill(7))]
  const { result } = await buildAndAnchorBatch(commitments, unconfiguredChain(), 1)
  const rootHex = Buffer.from(fromBase64Url(result.root)).toString('hex')
  assert.equal(result.onchainKey, rootHex.slice(0, 64))
  assert.equal(result.onchainKey.length, 64)
})

test('unconfigured chain → anchored:false, null txid, honest reason (no fake anchor)', async () => {
  const commitments = [toBase64Url(new Uint8Array(48).fill(9))]
  const { result, record } = await buildAndAnchorBatch(commitments, unconfiguredChain(), 42)
  assert.equal(result.anchored, false)
  assert.equal(result.txid, null)
  assert.equal(record.txid, null)
  assert.match(result.reason ?? '', /not submitted|not set|not configured/i)
})

test('full portable-proof path: sign → commit → batch → verifyProof is green', async () => {
  const alice = generateIdentity()
  const data = new TextEncoder().encode('quarterly-report.pdf contents')
  const { manifest } = protect(
    data,
    [recipientFromIdentity(alice.public, 'device')],
    fromBase64Url(alice.public.dsaPublicKey),
  )
  const signed = signManifest(manifest, alice.secret.dsaSecretKey)
  const commitment = commitmentFor(signed)

  // batch this commitment with a few siblings
  const siblings = Array.from({ length: 3 }, (_, i) => toBase64Url(new Uint8Array(48).fill(i + 100)))
  const all = [toBase64Url(commitment), ...siblings]
  const { result } = await buildAndAnchorBatch(all, unconfiguredChain(), 1_700_000_001)

  const inc = result.inclusions.find(x => x.commitment === toBase64Url(commitment))!
  const portable = buildProof(signed, inc.proof, {
    chain: 'blockle', txid: '0'.repeat(64), root: result.root,
  })
  const v = await verifyProof(portable) // offline: signature + commitment + inclusion
  assert.ok(v.signatureValid && v.commitmentValid && v.inclusionValid && v.ok, JSON.stringify(v))

  // sanity: tampering the signed manifest breaks the commitment check
  const tampered = structuredClone(portable)
  tampered.signed.manifest.fileId = 'file-2'
  const vt = await verifyProof(tampered)
  assert.equal(vt.ok, false)
})
