/**
 * Blockle Protect core — known-answer, roundtrip, and tamper tests.
 *
 * Covers the MVP Definition-of-Done crypto items: encrypt locally, ML-DSA-65
 * sign, decrypt by an authorized recipient, a MODIFIED file FAILS verification,
 * an unmodified file PASSES, and a third party verifies the proof independently
 * — plus recovery (device migration) and sharing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SIZES, kem, dsa, sha384, hkdfSha384, aesGcmEncrypt, aesGcmDecrypt, randomBytes,
  generateIdentity, identityFromSeed, recipientIdFor,
  protect, unprotect, addRecipient, recoverDek, verifyFingerprint, recipientFromIdentity,
  signManifest, verifyManifest,
  merkleTree, merkleRoot, verifyMerkleProof, hashLeaf,
  buildProof, verifyProof, commitmentFor, fileMatchesProof,
  fromBase64Url, toBase64Url
} from '../src/index.js'

const te = new TextEncoder()

test('primitive sizes match FIPS parameter sets', () => {
  const k = kem.keygen()
  assert.equal(k.publicKey.length, SIZES.mlkem768.publicKey)   // 1184
  assert.equal(k.secretKey.length, SIZES.mlkem768.secretKey)   // 2400
  const e = kem.encapsulate(k.publicKey)
  assert.equal(e.cipherText.length, SIZES.mlkem768.cipherText) // 1088
  assert.equal(e.sharedSecret.length, SIZES.mlkem768.sharedSecret)
  const d = dsa.keygen()
  assert.equal(d.publicKey.length, SIZES.mldsa65.publicKey)    // 1952
  assert.equal(d.secretKey.length, SIZES.mldsa65.secretKey)    // 4032
  const sig = dsa.sign(d.secretKey, te.encode('x'))
  assert.equal(sig.length, SIZES.mldsa65.signature)            // 3309
  assert.equal(sha384(new Uint8Array([1])).length, SIZES.sha384) // 48
})

test('ML-KEM-768 encapsulate/decapsulate agree', () => {
  const k = kem.keygen()
  const e = kem.encapsulate(k.publicKey)
  const ss2 = kem.decapsulate(e.cipherText, k.secretKey)
  assert.deepEqual([...e.sharedSecret], [...ss2])
})

test('ML-DSA-65 sign/verify; tamper rejected', () => {
  const d = dsa.keygen()
  const msg = te.encode('blockle-protect')
  const sig = dsa.sign(d.secretKey, msg)
  assert.equal(dsa.verify(d.publicKey, msg, sig), true)
  assert.equal(dsa.verify(d.publicKey, te.encode('blockle-protecT'), sig), false)
  const badSig = Uint8Array.from(sig); badSig[0] = badSig[0]! ^ 1
  assert.equal(dsa.verify(d.publicKey, msg, badSig), false)
})

test('AES-256-GCM KAT: deterministic ct with fixed key/nonce; AAD tamper fails', () => {
  const key = new Uint8Array(32).fill(7)
  const nonce = new Uint8Array(12).fill(9)
  const pt = te.encode('top secret')
  const ct1 = aesGcmEncrypt(key, nonce, pt, te.encode('aad'))
  const ct2 = aesGcmEncrypt(key, nonce, pt, te.encode('aad'))
  assert.deepEqual([...ct1], [...ct2], 'deterministic under fixed key+nonce')
  assert.deepEqual([...aesGcmDecrypt(key, nonce, ct1, te.encode('aad'))], [...pt])
  assert.throws(() => aesGcmDecrypt(key, nonce, ct1, te.encode('AAD')), 'wrong AAD must fail')
  const flipped = Uint8Array.from(ct1); flipped[0] = flipped[0]! ^ 1
  assert.throws(() => aesGcmDecrypt(key, nonce, flipped, te.encode('aad')), 'ciphertext tamper must fail')
})

test('HKDF-SHA-384 is deterministic and salt-sensitive', () => {
  const ikm = new Uint8Array(32).fill(1)
  const a = hkdfSha384(ikm, new Uint8Array(16).fill(2), te.encode('info'), 32)
  const b = hkdfSha384(ikm, new Uint8Array(16).fill(2), te.encode('info'), 32)
  const c = hkdfSha384(ikm, new Uint8Array(16).fill(3), te.encode('info'), 32)
  assert.deepEqual([...a], [...b])
  assert.notDeepEqual([...a], [...c])
})

test('envelope: protect → sign → unprotect roundtrip (DoD 2,3,7,9)', () => {
  const owner = generateIdentity()
  const plaintext = randomBytes(5000)
  const { ciphertext, manifest } = protect(
    plaintext, [recipientFromIdentity(owner.public, 'device')], fromBase64Url(owner.public.dsaPublicKey)
  )
  const signed = signManifest(manifest, owner.secret.dsaSecretKey)
  assert.equal(verifyManifest(signed), true)              // DoD 3: valid ML-DSA-65 signature
  const holder = { kemSecretKey: owner.secret.kemSecretKey, recipientId: owner.public.recipientId }
  const out = unprotect(ciphertext, manifest, holder)     // DoD 7: authorized decrypt
  assert.deepEqual([...out], [...plaintext])
  assert.equal(verifyFingerprint(plaintext, manifest), true) // DoD 9: unmodified passes
})

test('envelope: a MODIFIED file fails integrity (DoD 8)', () => {
  const owner = generateIdentity()
  const plaintext = te.encode('the original contract text')
  const { ciphertext, manifest } = protect(
    plaintext, [recipientFromIdentity(owner.public, 'device')], fromBase64Url(owner.public.dsaPublicKey)
  )
  const holder = { kemSecretKey: owner.secret.kemSecretKey, recipientId: owner.public.recipientId }
  const tampered = Uint8Array.from(ciphertext); tampered[3] = tampered[3]! ^ 0x40
  assert.throws(() => unprotect(tampered, manifest, holder), /./) // GCM tag rejects it
  assert.equal(verifyFingerprint(te.encode('the ORIGINAL contract text'), manifest), false)
})

test('envelope: a non-recipient cannot recover the data key', () => {
  const owner = generateIdentity()
  const stranger = generateIdentity()
  const { manifest } = protect(
    te.encode('x'), [recipientFromIdentity(owner.public, 'device')], fromBase64Url(owner.public.dsaPublicKey)
  )
  assert.throws(() => recoverDek(manifest, { kemSecretKey: stranger.secret.kemSecretKey, recipientId: stranger.public.recipientId }), /not an authorized recipient/)
})

test('recovery: seed-derived identity is deterministic and can decrypt (DoD 11)', () => {
  const seed = randomBytes(96)
  const recovery1 = identityFromSeed(seed)
  const recovery2 = identityFromSeed(seed)
  assert.equal(recovery1.public.recipientId, recovery2.public.recipientId, 'deterministic from seed')
  const device = generateIdentity()
  // wrap to BOTH the device key and the recovery key (no server escrow)
  const plaintext = te.encode('identity documents')
  const { ciphertext, manifest } = protect(
    plaintext,
    [recipientFromIdentity(device.public, 'device'), recipientFromIdentity(recovery1.public, 'recovery')],
    fromBase64Url(device.public.dsaPublicKey)
  )
  // device lost; restore the recovery identity on a NEW device from the same seed
  const restored = identityFromSeed(seed)
  const out = unprotect(ciphertext, manifest, { kemSecretKey: restored.secret.kemSecretKey, recipientId: restored.public.recipientId })
  assert.deepEqual([...out], [...plaintext])
})

test('sharing: addRecipient lets a new identity decrypt without re-encrypting', () => {
  const owner = generateIdentity()
  const friend = generateIdentity()
  const plaintext = te.encode('shared document')
  const { ciphertext, manifest } = protect(
    plaintext, [recipientFromIdentity(owner.public, 'device')], fromBase64Url(owner.public.dsaPublicKey)
  )
  const entry = addRecipient(manifest, { kemSecretKey: owner.secret.kemSecretKey, recipientId: owner.public.recipientId }, recipientFromIdentity(friend.public, 'share'))
  manifest.wraps.push(entry)
  const out = unprotect(ciphertext, manifest, { kemSecretKey: friend.secret.kemSecretKey, recipientId: friend.public.recipientId })
  assert.deepEqual([...out], [...plaintext])
})

test('merkle: inclusion proofs verify for every leaf; wrong leaf fails', () => {
  for (const n of [1, 2, 3, 5, 8, 17]) {
    const commits = Array.from({ length: n }, (_, i) => sha384(te.encode('c' + i + '/' + n)))
    const tree = merkleTree(commits)
    assert.deepEqual([...tree.root], [...merkleRoot(commits)])
    for (let i = 0; i < n; i++) {
      assert.equal(verifyMerkleProof(commits[i]!, tree.proof(i), tree.root), true, `leaf ${i}/${n}`)
    }
    const wrong = sha384(te.encode('not-in-tree'))
    assert.equal(verifyMerkleProof(wrong, tree.proof(0), tree.root), false)
  }
})

test('portable proof: independent third-party verification (DoD 10) + modified file fails', async () => {
  // Build a batch of three protected files; anchor their Merkle root.
  const owner = generateIdentity()
  const files = [te.encode('file A'), te.encode('photo bytes B'), te.encode('contract C')]
  const signeds = files.map((f) => {
    const { manifest } = protect(f, [recipientFromIdentity(owner.public, 'device')], fromBase64Url(owner.public.dsaPublicKey))
    return signManifest(manifest, owner.secret.dsaSecretKey)
  })
  const commitments = signeds.map(commitmentFor)
  const tree = merkleTree(commitments)
  const anchor = { chain: 'blockle' as const, txid: 'deadbeef', root: toBase64Url(tree.root), height: 49_000, blockTime: 1_700_000_000 }
  const proofs = signeds.map((s, i) => buildProof(s, tree.proof(i), anchor))

  // A third party with NO account and NO backend access verifies every proof.
  for (const p of proofs) {
    const r = await verifyProof(p) // offline: signature + commitment + inclusion
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.signatureValid && r.commitmentValid && r.inclusionValid, true)
  }
  // The specific file matches its proof; a modified file does not.
  assert.equal(fileMatchesProof(files[1]!, proofs[1]!), true)
  assert.equal(fileMatchesProof(te.encode('photo bytes B!'), proofs[1]!), false)

  // Tampering with the anchored root breaks inclusion.
  const forged = { ...proofs[0]!, anchor: { ...anchor, root: toBase64Url(sha384(te.encode('forged root'))) } }
  const bad = await verifyProof(forged)
  assert.equal(bad.ok, false)

  // The optional on-chain confirm uses a PUBLIC chain read (mocked here).
  const confirmed = await verifyProof(proofs[0]!, async (a) => a.txid === 'deadbeef' && a.root === anchor.root)
  assert.equal(confirmed.anchorConfirmed, true)
  const unconfirmed = await verifyProof(proofs[0]!, async () => false)
  assert.equal(unconfirmed.ok, false)
})

test('recipientId is stable for a key and short', () => {
  const k = kem.keygen()
  assert.equal(recipientIdFor(k.publicKey), recipientIdFor(k.publicKey))
  assert.equal(recipientIdFor(k.publicKey).length, 22)
})
