import Foundation
import Security
import CryptoKit

// The Vault: protect a file end-to-end on-device — encrypt + sign with the
// post-quantum core, anchor its commitment on the Blockle chain, and keep a
// local record. The ORIGINAL is never modified: we read its bytes, write a new
// encrypted envelope into the app's container, and leave the source untouched.

// MARK: - Device identity (PQ key material; only a 96-byte seed is persisted)

@available(iOS 26.0, macOS 26.0, *)
struct VaultIdentity {
    let kemPublicKey: Data
    let kemPrivateKey: MLKEM768.PrivateKey
    let dsaPublicKey: Data
    let dsaPrivateKey: MLDSA65.PrivateKey
    var recipientId: String { recipientIdFor(kemPublicKey) }  // for addressing shares

    /// Load the device identity, generating + storing a fresh 96-byte seed the
    /// first time. The seed (not the expanded keys) lives in the Keychain,
    /// protected by the device passcode/biometrics (ThisDeviceOnly).
    static func loadOrCreate() throws -> VaultIdentity {
        let seed = try Keychain.loadOrCreate(account: "blockle.protect.identity.seed", bytes: 96)
        let kemSeed = Data(seed[0..<64])   // ML-KEM d||z
        let dsaSeed = Data(seed[64..<96])  // ML-DSA xi (32)
        let (kemPub, kemSk) = try ProtectCrypto.PQ.kemKeygenFromSeed(kemSeed)
        let (dsaPub, dsaSk) = try ProtectCrypto.PQ.dsaKeygenFromSeed(dsaSeed)
        return VaultIdentity(kemPublicKey: kemPub, kemPrivateKey: kemSk, dsaPublicKey: dsaPub, dsaPrivateKey: dsaSk)
    }
}

enum Keychain {
    static func loadOrCreate(account: String, bytes: Int) throws -> Data {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
        ]
        var query = base
        query[kSecReturnData as String] = true
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecSuccess, let d = out as? Data { return d }
        guard status == errSecItemNotFound else { throw ProtectError.crypto("keychain read \(status)") }
        let fresh = ProtectCrypto.randomBytes(bytes)
        var add = base
        add[kSecValueData as String] = fresh
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw ProtectError.crypto("keychain write \(addStatus)") }
        return fresh
    }
}

// MARK: - Protected-item record (what we persist)

struct ProtectedItem: Codable, Identifiable {
    let id: String            // fileId
    var name: String          // original file name (metadata only)
    var size: Int
    var createdAt: Int
    var fingerprintB64: String
    var commitmentB64: String // Merkle leaf / anchor input
    var rootB64: String?      // anchored Merkle root (from the service)
    var txid: String?         // anchor transaction (nil until anchored)
    var anchored: Bool
    var manifestPath: String  // relative path of the signed manifest JSON
    var cipherPath: String    // relative path of the ciphertext
}

// MARK: - Vault store + protect flow

@available(iOS 26.0, macOS 26.0, *)
@MainActor
final class VaultStore: ObservableObject {
    @Published private(set) var items: [ProtectedItem] = []
    @Published var busy = false
    @Published var lastError: String?

    private let dir: URL
    private let indexURL: URL

    init() {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        dir = base.appendingPathComponent("vault", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        indexURL = dir.appendingPathComponent("index.json")
        load()
    }

    private func load() {
        guard let data = try? Data(contentsOf: indexURL),
              let decoded = try? JSONDecoder().decode([ProtectedItem].self, from: data) else { return }
        items = decoded
    }
    private func persist() {
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: indexURL, options: .atomic) }
    }

    /// Protect a file: read its bytes (original untouched), encrypt+sign with the
    /// PQ core, write the envelope, then anchor the commitment. `now` injected.
    func protectFile(name: String, plaintext: Data, now: Int) async {
        busy = true; lastError = nil
        defer { busy = false }
        do {
            let id = try VaultIdentity.loadOrCreate()
            let result = try Protector.protect(
                plaintext: plaintext,
                recipients: [Recipient(kemPublicKey: id.kemPublicKey, kind: "device")],
                signerPublicKey: id.dsaPublicKey, signerPrivateKey: id.dsaPrivateKey,
                label: name, now: now)

            let fileId = result.signed.manifest.fileId
            let safe = fileId.replacingOccurrences(of: "/", with: "_")
            let manifestPath = "\(safe).manifest.json"
            let cipherPath = "\(safe).enc"
            try CanonicalJSON.bytes(result.signed.json).write(to: dir.appendingPathComponent(manifestPath), options: .atomic)
            try result.ciphertext.write(to: dir.appendingPathComponent(cipherPath), options: .atomic)

            var item = ProtectedItem(
                id: fileId, name: name, size: plaintext.count,
                createdAt: result.signed.manifest.createdAt,
                fingerprintB64: result.signed.manifest.fingerprint,
                commitmentB64: result.signed.commitment.base64url,
                rootB64: nil, txid: nil, anchored: false,
                manifestPath: manifestPath, cipherPath: cipherPath)

            // Anchor the commitment via the live service (best-effort; the file is
            // already protected + stored even if anchoring is deferred).
            if let anchor = try? await AnchorService.submit(commitmentB64: item.commitmentB64) {
                item.rootB64 = anchor.root
                item.txid = anchor.txid
                item.anchored = anchor.anchored
            }
            items.insert(item, at: 0)
            persist()
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Anchoring service client

struct AnchorResult { let root: String?; let txid: String?; let anchored: Bool }

enum AnchorService {
    static let submitURL = URL(string: "https://protect.blockle.org/api/anchor/submit")!

    static func submit(commitmentB64: String) async throws -> AnchorResult {
        struct Body: Encodable { let commitments: [String] }
        var req = URLRequest(url: submitURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(Body(commitments: [commitmentB64]))
        req.timeoutInterval = 30
        let (data, _) = try await URLSession.shared.data(for: req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let txidVal = (obj?["txid"] as? [String: Any])?["txid"] as? String ?? obj?["txid"] as? String
        return AnchorResult(root: obj?["root"] as? String, txid: txidVal, anchored: obj?["anchored"] as? Bool ?? false)
    }
}
