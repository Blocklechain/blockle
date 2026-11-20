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
    static let seedAccount = "blockle.protect.identity.seed"

    /// The raw 96-byte identity seed — the material behind the recovery key.
    static func exportSeed() throws -> Data { try Keychain.loadOrCreate(account: seedAccount, bytes: 96) }

    /// Restore an identity from a recovery key's 96-byte seed (replaces this
    /// device's identity). Caller must warn the user this changes which files
    /// they can open.
    static func restore(seed: Data) throws {
        guard seed.count == 96 else { throw ProtectError.crypto("recovery seed must be 96 bytes") }
        guard Keychain.write(account: seedAccount, data: seed) else { throw ProtectError.crypto("keychain write failed") }
    }

    static func loadOrCreate() throws -> VaultIdentity {
        let seed = try Keychain.loadOrCreate(account: seedAccount, bytes: 96)
        let kemSeed = Data(seed[0..<64])   // ML-KEM d||z
        let dsaSeed = Data(seed[64..<96])  // ML-DSA xi (32)
        let (kemPub, kemSk) = try ProtectCrypto.PQ.kemKeygenFromSeed(kemSeed)
        let (dsaPub, dsaSk) = try ProtectCrypto.PQ.dsaKeygenFromSeed(dsaSeed)
        return VaultIdentity(kemPublicKey: kemPub, kemPrivateKey: kemSk, dsaPublicKey: dsaPub, dsaPrivateKey: dsaSk)
    }
}

enum Keychain {
    static func read(account: String) -> Data? {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrAccount as String: account,
                                kSecReturnData as String: true]
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? (out as? Data) : nil
    }
    @discardableResult
    static func write(account: String, data: Data) -> Bool {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
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
    var commitmentB64: String // Merkle leaf / anchor input == SHA-384 of the signed manifest file
    var cipherSha384B64: String? // SHA-384 of the ciphertext file (integrity anchor)
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

    let dir: URL
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
    /// Re-read the index from disk (after an iCloud restore).
    func reload() { load(); ProtectState.protectedFileCount = items.count }
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
                cipherSha384B64: ProtectCrypto.sha384(result.ciphertext).base64url,
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
            ProtectState.protectedFileCount = items.count
            ProtectState.log(icon: "lock.doc.fill", title: "Protected “\(name)”",
                             detail: item.anchored ? "Encrypted, signed, and anchored on-chain." : "Encrypted and signed on this device.")
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - Portable verification proof

    /// Build the portable proof a third party verifies at protect.blockle.org/verify
    /// Decrypt a protected item to a temporary file so it can be viewed in the
    /// app, and return that file's URL.
    ///
    /// Protecting a file you can never open again is not protection, it is
    /// deletion with extra steps - the vault previously offered only "share
    /// verification proof", with no way back to the content.
    ///
    /// The plaintext is written to the system temporary directory, NOT into the
    /// vault and NOT anywhere iCloud syncs, and should be removed as soon as
    /// the viewer closes (see `discardRevealed`). It is deliberately the
    /// shortest-lived copy the app ever makes.
    /// The decrypted copy currently open in the previewer, if any. Owned by the
    /// store, not the view — see `discardRevealed()`.
    private(set) var revealedURL: URL?

    func reveal(_ item: ProtectedItem) -> URL? {
        do {
            let manURL = dir.appendingPathComponent(item.manifestPath)
            let cipherURL = dir.appendingPathComponent(item.cipherPath)
            // The on-disk manifest is the SIGNED wrapper; decode it and take
            // the inner manifest. `unprotect` re-verifies the GCM tag and the
            // SHA-384 fingerprint, so a tampered file throws rather than
            // silently opening as garbage.
            let signed = try JSONDecoder().decode(SignedManifest.self,
                                                  from: Data(contentsOf: manURL))
            let id = try VaultIdentity.loadOrCreate()
            let plain = try Protector.unprotect(
                ciphertext: Data(contentsOf: cipherURL),
                manifest: signed.manifest,
                holder: Protector.Holder(kemPrivateKey: id.kemPrivateKey,
                                         recipientId: id.recipientId))

            // Keep the original name so the previewer picks the right handler;
            // a unique directory avoids collisions between two files of the
            // same name and makes cleanup a single removeItem.
            let box = FileManager.default.temporaryDirectory
                .appendingPathComponent("reveal-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: box, withIntermediateDirectories: true)
            let out = box.appendingPathComponent(item.name)
            try plain.write(to: out, options: [.atomic, .completeFileProtection])
            // Any copy still open is replaced, so a second reveal cannot orphan
            // the first one's plaintext in the temp directory.
            discardRevealed()
            revealedURL = out
            return out
        } catch {
            lastError = "Couldn't open \(item.name): \(error.localizedDescription)"
            return nil
        }
    }

    /// Delete the revealed plaintext and its containing directory. Call as soon
    /// as the viewer is dismissed - a decrypted copy left in /tmp outlives the
    /// user's intent and is exactly what this app exists to prevent.
    ///
    /// Takes no argument ON PURPOSE. It used to take the URL from view state,
    /// which silently never deleted anything: SwiftUI's `.sheet(item:)` clears
    /// its binding as part of dismissal, so by the time `onDismiss` ran the
    /// URL it read was already nil. The store owns the path instead, so
    /// cleanup cannot depend on view-teardown ordering.
    func discardRevealed() {
        guard let url = revealedURL else { return }
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        revealedURL = nil
    }

    /// (or fully offline): the signed manifest + the single-leaf Merkle inclusion
    /// + the on-chain anchor reference. Writes a .json and returns its URL.
    /// Contains NO plaintext and NO keys — only the public, verifiable record.
    func exportProof(_ item: ProtectedItem) -> URL? {
        let manURL = dir.appendingPathComponent(item.manifestPath)
        guard let manData = try? Data(contentsOf: manURL),
              let signedObj = try? JSONSerialization.jsonObject(with: manData) else { return nil }
        var anchor: [String: Any] = ["chain": "blockle"]
        if let root = item.rootB64 { anchor["root"] = root }
        if let tx = item.txid { anchor["txid"] = tx }
        // single-file batch: the Merkle root is the (tagged) leaf hash, so the
        // inclusion proof has no siblings — matches merkleTree([commitment]).
        let proof: [String: Any] = [
            "v": 1,
            "signed": signedObj,
            "commitment": item.commitmentB64,
            "merkleProof": ["leafIndex": 0, "siblings": [Any]()],
            "anchor": anchor,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: proof, options: [.sortedKeys]) else { return nil }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("\(item.name).blockle-proof.json")
        do { try data.write(to: out, options: .atomic); return out } catch { return nil }
    }

    // MARK: - File Integrity Monitor

    enum IntegrityState: String { case intact, changed, missing }
    struct IntegrityResult: Identifiable {
        let id: String; let name: String; let state: IntegrityState
        let manifestOk: Bool; let cipherOk: Bool; let anchorConfirmed: Bool?
        let detail: String
    }
    struct IntegrityReport { var checked = 0; var failing = 0; var results: [IntegrityResult] = []; var ranAt = Date() }

    @Published var lastReport: IntegrityReport?
    @Published var verifying = false

    /// Re-verify every protected file still matches its signed record and (online)
    /// its on-chain anchor. Detects corruption or tampering without needing keys:
    /// the manifest file's SHA-384 IS the anchored commitment, and we stored the
    /// ciphertext's SHA-384 at protect time.
    func verifyIntegrity() async {
        verifying = true; defer { verifying = false }
        var report = IntegrityReport()
        for item in items {
            report.checked += 1
            let manURL = dir.appendingPathComponent(item.manifestPath)
            let cipURL = dir.appendingPathComponent(item.cipherPath)
            guard let man = try? Data(contentsOf: manURL), let cip = try? Data(contentsOf: cipURL) else {
                report.failing += 1
                report.results.append(IntegrityResult(id: item.id, name: item.name, state: .missing,
                    manifestOk: false, cipherOk: false, anchorConfirmed: nil,
                    detail: "Protected file is missing from the vault."))
                continue
            }
            let manifestOk = ProtectCrypto.sha384(man).base64url == item.commitmentB64
            let cipherOk = item.cipherSha384B64.map { ProtectCrypto.sha384(cip).base64url == $0 } ?? true
            var anchorConfirmed: Bool? = nil
            if let root = item.rootB64 { anchorConfirmed = try? await AnchorService.isAnchored(rootB64: root) }
            let intact = manifestOk && cipherOk
            if !intact { report.failing += 1 }
            let detail: String
            if !manifestOk { detail = "The signed record changed unexpectedly — possible tampering." }
            else if !cipherOk { detail = "The encrypted file changed since it was protected." }
            else { detail = anchorConfirmed == false ? "Intact; on-chain anchor not confirmed (pending or network)." : "Verified intact." }
            report.results.append(IntegrityResult(id: item.id, name: item.name,
                state: intact ? .intact : .changed, manifestOk: manifestOk, cipherOk: cipherOk,
                anchorConfirmed: anchorConfirmed, detail: detail))
        }
        lastReport = report
        ProtectState.integrityChecked = report.checked
        ProtectState.integrityFailing = report.failing
        ProtectState.lastIntegrityAt = report.ranAt
        ProtectState.log(icon: report.failing == 0 ? "checkmark.seal.fill" : "exclamationmark.triangle.fill",
                         title: "Integrity check",
                         detail: report.failing == 0 ? "All \(report.checked) file(s) verified intact." : "\(report.failing) of \(report.checked) file(s) failed verification.")
    }
}

// MARK: - Anchoring service client

struct AnchorResult { let root: String?; let txid: String?; let anchored: Bool }

enum AnchorService {
    static let submitURL = URL(string: "https://protect.blockle.org/api/anchor/submit")!

    /// Read-only: is this Merkle root anchored on-chain? (base64url SHA-384 root)
    static func isAnchored(rootB64: String) async throws -> Bool {
        guard let raw = Data(base64url: rootB64) else { return false }
        let hex = raw.hex
        guard let url = URL(string: "https://protect.blockle.org/api/anchor/root/\(hex)") else { return false }
        var req = URLRequest(url: url); req.timeoutInterval = 20
        let (data, _) = try await URLSession.shared.data(for: req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (obj?["anchored"] as? Bool) ?? false
    }

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
