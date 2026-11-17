import Foundation

// Blockle Protect — envelope encryption + manifest + Merkle, a byte-exact port
// of packages/core/src/{envelope,manifest,merkle,proof}.ts. Produces the SAME
// signed manifest and commitment the web/backend produce, so a file protected
// on iOS verifies in the browser verifier and anchors through the same service.

let MANIFEST_VERSION = 1

enum ALGO {
    static let json: JSONValue = .object([
        ("kem", .string("ML-KEM-768")), ("sig", .string("ML-DSA-65")),
        ("cipher", .string("AES-256-GCM")), ("hash", .string("SHA-384")),
        ("kdf", .string("HKDF-SHA-384")),
    ])
}
enum CONTEXT {
    static let kek = Data("blockle-protect/v1/kek".utf8)
    static let contentAad = Data("blockle-protect/v1/content".utf8)
    static let wrapAad = Data("blockle-protect/v1/dek-wrap".utf8)
}

struct Recipient { let kemPublicKey: Data; let kind: String } // kind: device|recovery|share

struct WrapEntry {
    let recipient, kind, kemCipherText, wrapNonce, wrappedKey: String
    var json: JSONValue {
        .object([("recipient", .string(recipient)), ("kind", .string(kind)),
                 ("kemCipherText", .string(kemCipherText)), ("wrapNonce", .string(wrapNonce)),
                 ("wrappedKey", .string(wrappedKey))])
    }
}

struct Manifest {
    var v = MANIFEST_VERSION
    var fileId: String
    var fingerprint: String
    var size: Int
    var contentNonce: String
    var wraps: [WrapEntry]
    var signerPublicKey: String
    var createdAt: Int
    var label: String?

    var json: JSONValue {
        var fields: [(String, JSONValue)] = [
            ("v", .int(v)), ("algo", ALGO.json),
            ("fileId", .string(fileId)), ("fingerprint", .string(fingerprint)),
            ("size", .int(size)), ("contentNonce", .string(contentNonce)),
            ("wraps", .array(wraps.map { $0.json })),
            ("signerPublicKey", .string(signerPublicKey)), ("createdAt", .int(createdAt)),
        ]
        if let label { fields.append(("label", .string(label))) }
        return .object(fields)
    }
    /// The exact bytes an ML-DSA-65 signature covers (canonical JSON of the body).
    var signingBytes: Data { CanonicalJSON.bytes(json) }
}

struct SignedManifest {
    let manifest: Manifest
    let signature: String // base64url
    var json: JSONValue { .object([("manifest", manifest.json), ("signature", .string(signature))]) }
    /// SHA-384 over the canonical SIGNED record — the Merkle leaf / on-chain commitment.
    var commitment: Data { ProtectCrypto.sha384(CanonicalJSON.bytes(json)) }
}

/// Short stable recipient id = base64url(SHA-384(kemPublicKey))[:22].
func recipientIdFor(_ kemPublicKey: Data) -> String {
    String(ProtectCrypto.sha384(kemPublicKey).base64url.prefix(22))
}

// MARK: - Merkle (SHA-384, domain-separated: leaf 0x00, node 0x01)

enum Merkle {
    static func hashLeaf(_ data: Data) -> Data { ProtectCrypto.sha384(Data([0x00]) + data) }
    static func hashNode(_ l: Data, _ r: Data) -> Data { ProtectCrypto.sha384(Data([0x01]) + l + r) }

    struct ProofStep { let hash: String; let side: String } // side: "left" | "right"

    /// Returns (root, levels) — levels[0] are leaf hashes.
    static func levels(_ commitments: [Data]) -> (root: Data, levels: [[Data]]) {
        precondition(!commitments.isEmpty, "merkle: empty tree")
        var level = commitments.map(hashLeaf)
        var all = [level]
        while level.count > 1 {
            var next: [Data] = []
            var i = 0
            while i < level.count {
                let l = level[i]
                let r = i + 1 < level.count ? level[i + 1] : l // duplicate last if odd
                next.append(hashNode(l, r))
                i += 2
            }
            all.append(next); level = next
        }
        return (level[0], all)
    }

    static func root(_ commitments: [Data]) -> Data { levels(commitments).root }

    static func proof(_ commitments: [Data], index: Int) -> [ProofStep] {
        let lv = levels(commitments).levels
        var steps: [ProofStep] = []
        var idx = index
        for l in 0..<(lv.count - 1) {
            let nodes = lv[l]
            let isRight = idx % 2 == 1
            let sibIdx = isRight ? idx - 1 : idx + 1
            let sib = sibIdx < nodes.count ? nodes[sibIdx] : nodes[idx]
            steps.append(ProofStep(hash: sib.base64url, side: isRight ? "left" : "right"))
            idx /= 2
        }
        return steps
    }
}

// MARK: - protect() — iOS 26+ (needs ML-KEM / ML-DSA)

@available(iOS 26.0, macOS 26.0, *)
enum Protector {
    struct Result { let ciphertext: Data; let signed: SignedManifest }

    private static func contentAad(fileId: Data, fingerprint: Data, size: Int) -> Data {
        CONTEXT.contentAad + fileId + fingerprint + Data(String(size).utf8)
    }

    private static func wrapDekFor(dek: Data, fileId: Data, recipient: Recipient) throws -> WrapEntry {
        let enc = try ProtectCrypto.PQ.kemEncapsulate(publicKey: recipient.kemPublicKey)
        let kek = ProtectCrypto.hkdfSha384(ikm: enc.sharedSecret, salt: fileId, info: CONTEXT.kek, length: 32)
        let wrapNonce = ProtectCrypto.randomBytes(12)
        let wrappedKey = try ProtectCrypto.aesGcmEncrypt(key: kek, nonce: wrapNonce, plaintext: dek, aad: CONTEXT.wrapAad)
        return WrapEntry(recipient: recipientIdFor(recipient.kemPublicKey), kind: recipient.kind,
                         kemCipherText: enc.cipherText.base64url, wrapNonce: wrapNonce.base64url,
                         wrappedKey: wrappedKey.base64url)
    }

    /// Encrypt + wrap + sign, exactly like the TS core. Returns ciphertext + the
    /// signed manifest (whose `.commitment` is the Merkle leaf / anchor input).
    static func protect(plaintext: Data, recipients: [Recipient],
                        signerPublicKey: Data, signerPrivateKey: MLDSA65.PrivateKey,
                        label: String?, now: Int) throws -> Result {
        guard !recipients.isEmpty else { throw ProtectError.crypto("at least one recipient required") }
        let dek = ProtectCrypto.randomBytes(32)
        let fileId = ProtectCrypto.randomBytes(16)
        let fingerprint = ProtectCrypto.sha384(plaintext)
        let contentNonce = ProtectCrypto.randomBytes(12)
        let aad = contentAad(fileId: fileId, fingerprint: fingerprint, size: plaintext.count)
        let ciphertext = try ProtectCrypto.aesGcmEncrypt(key: dek, nonce: contentNonce, plaintext: plaintext, aad: aad)
        let wraps = try recipients.map { try wrapDekFor(dek: dek, fileId: fileId, recipient: $0) }

        var manifest = Manifest(
            fileId: fileId.base64url, fingerprint: fingerprint.base64url, size: plaintext.count,
            contentNonce: contentNonce.base64url, wraps: wraps,
            signerPublicKey: signerPublicKey.base64url, createdAt: now, label: label)
        manifest.v = MANIFEST_VERSION
        let signature = try ProtectCrypto.PQ.dsaSign(signerPrivateKey, manifest.signingBytes)
        return Result(ciphertext: ciphertext, signed: SignedManifest(manifest: manifest, signature: signature.base64url))
    }
}
