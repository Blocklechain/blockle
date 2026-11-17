import Foundation
import CryptoKit

// Blockle Protect — Swift cryptographic primitives. This is the ONLY file that
// talks to a crypto library, mirroring packages/core/src/primitives.ts so the
// whole audited surface is one file per platform. We invent nothing: SHA-384,
// HKDF-SHA-384 and AES-256-GCM come from CryptoKit; ML-KEM-768 (FIPS 203) and
// ML-DSA-65 (FIPS 204) come from CryptoKit's quantum-secure types (iOS 26+).
//
// Byte-compatibility with the TS core is proven by golden vectors
// (ios/Tests/golden-vectors.json) exercised in CryptoVectorsTests.

enum ProtectCrypto {
    // MARK: Hashing / KDF / AEAD (available on all supported OS versions)

    static func sha384(_ data: Data) -> Data {
        Data(SHA384.hash(data: data))
    }

    /// HKDF-SHA-384. Matches hkdfSha384(ikm, salt, info, length) in the TS core.
    static func hkdfSha384(ikm: Data, salt: Data, info: Data, length: Int = 32) -> Data {
        let key = HKDF<SHA384>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: salt, info: info, outputByteCount: length)
        return key.withUnsafeBytes { Data($0) }
    }

    /// AES-256-GCM. Returns ciphertext||tag (the TS layout). Nonce is 12 bytes.
    static func aesGcmEncrypt(key: Data, nonce: Data, plaintext: Data, aad: Data) throws -> Data {
        let sealed = try AES.GCM.seal(
            plaintext, using: SymmetricKey(data: key),
            nonce: try AES.GCM.Nonce(data: nonce), authenticating: aad)
        return sealed.ciphertext + sealed.tag
    }

    static func aesGcmDecrypt(key: Data, nonce: Data, ciphertextAndTag: Data, aad: Data) throws -> Data {
        guard ciphertextAndTag.count >= 16 else { throw ProtectError.crypto("ciphertext too short") }
        let ct = ciphertextAndTag.prefix(ciphertextAndTag.count - 16)
        let tag = ciphertextAndTag.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: nonce), ciphertext: ct, tag: tag)
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }

    static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }

    // MARK: Post-quantum (ML-KEM-768 / ML-DSA-65) — iOS 26+

    @available(iOS 26.0, macOS 26.0, *)
    enum PQ {
        // ---- ML-DSA-65 (signatures) ----
        static func dsaKeygenFromSeed(_ seed32: Data) throws -> (publicKey: Data, privateKey: MLDSA65.PrivateKey) {
            let sk = try MLDSA65.PrivateKey(seedRepresentation: seed32, publicKey: nil)
            return (sk.publicKey.rawRepresentation, sk)
        }
        static func dsaSign(_ privateKey: MLDSA65.PrivateKey, _ message: Data) throws -> Data {
            try privateKey.signature(for: message)
        }
        static func dsaVerify(publicKey: Data, message: Data, signature: Data) -> Bool {
            guard let pk = try? MLDSA65.PublicKey(rawRepresentation: publicKey) else { return false }
            return pk.isValidSignature(signature, for: message)
        }

        // ---- ML-KEM-768 (key establishment) ----
        static func kemKeygenFromSeed(_ seed64: Data) throws -> (publicKey: Data, privateKey: MLKEM768.PrivateKey) {
            let sk = try MLKEM768.PrivateKey(seedRepresentation: seed64, publicKey: nil)
            return (sk.publicKey.rawRepresentation, sk)
        }
        static func kemEncapsulate(publicKey: Data) throws -> (cipherText: Data, sharedSecret: Data) {
            let pk = try MLKEM768.PublicKey(rawRepresentation: publicKey)
            let r = try pk.encapsulate()
            let ss = r.sharedSecret.withUnsafeBytes { Data($0) }
            return (r.encapsulated, ss)
        }
        static func kemDecapsulate(cipherText: Data, privateKey: MLKEM768.PrivateKey) throws -> Data {
            let ss = try privateKey.decapsulate(cipherText)
            return ss.withUnsafeBytes { Data($0) }
        }
    }
}

enum ProtectError: Error, LocalizedError {
    case crypto(String)
    case unsupportedOS
    case encoding(String)
    var errorDescription: String? {
        switch self {
        case .crypto(let m): return "Crypto error: \(m)"
        case .unsupportedOS: return "Post-quantum protection requires iOS 26 or later."
        case .encoding(let m): return "Encoding error: \(m)"
        }
    }
}

// MARK: - Hex / base64url helpers (match the TS encoding.ts exactly)

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }

    init?(hex: String) {
        let s = hex.count % 2 == 0 ? hex : "0" + hex
        var d = Data(capacity: s.count / 2)
        var idx = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            guard let b = UInt8(s[idx..<next], radix: 16) else { return nil }
            d.append(b); idx = next
        }
        self = d
    }

    /// base64url without padding (matches toBase64Url).
    var base64url: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    init?(base64url s: String) {
        var b64 = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let pad = (4 - b64.count % 4) % 4
        b64 += String(repeating: "=", count: pad)
        guard let d = Data(base64Encoded: b64) else { return nil }
        self = d
    }
}
