import Foundation
import CryptoKit

// Secure Sharing — protect a file TO another person using their published
// post-quantum (ML-KEM) public key, so only they can open it. Reuses the same
// envelope as the Vault: the data key is wrapped to each recipient's KEM key.
// A shared file travels as a self-contained .bprotect bundle (signed manifest +
// ciphertext); nothing secret is ever sent to a server.

struct ProtectContact: Codable, Identifiable {
    let id: String            // recipientId = base64url(SHA-384(kemPublicKey))[:22]
    var name: String
    let kemPublicKeyB64: String
    let dsaPublicKeyB64: String
}

/// The user's own public identity, as a compact shareable string others import.
struct PublicIDCard: Codable {
    var v = 1
    var n: String             // display name
    var kem: String           // base64url ML-KEM public key
    var dsa: String           // base64url ML-DSA public key
    var rid: String           // recipientId

    func encoded() -> String { (try? JSONEncoder().encode(self)).map { $0.base64url } ?? "" }
    static func decode(_ s: String) -> PublicIDCard? {
        guard let data = Data(base64url: s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return try? JSONDecoder().decode(PublicIDCard.self, from: data)
    }
}

/// On-the-wire bundle for a shared file.
struct ShareBundle: Codable {
    var v = 1
    var manifestJson: String  // canonical signed-manifest JSON
    var ct: String            // base64url ciphertext
}

@available(iOS 26.0, macOS 26.0, *)
@MainActor
final class SharingModel: ObservableObject {
    @Published var contacts: [ProtectContact] = []
    @Published var myCardString = ""
    @Published var error: String?

    private let key = "blockle.protect.contacts"
    private let nameKey = "blockle.protect.displayName"

    init() { load(); buildMyCard() }

    var displayName: String {
        get { UserDefaults.standard.string(forKey: nameKey) ?? "Me" }
        set { UserDefaults.standard.set(newValue, forKey: nameKey); buildMyCard() }
    }

    private func load() {
        if let d = UserDefaults.standard.data(forKey: key),
           let c = try? JSONDecoder().decode([ProtectContact].self, from: d) { contacts = c }
    }
    private func persist() {
        if let d = try? JSONEncoder().encode(contacts) { UserDefaults.standard.set(d, forKey: key) }
    }

    func buildMyCard() {
        do {
            let id = try VaultIdentity.loadOrCreate()
            myCardString = PublicIDCard(n: displayName, kem: id.kemPublicKey.base64url,
                                        dsa: id.dsaPublicKey.base64url, rid: id.recipientId).encoded()
        } catch { myCardString = "" }
    }

    func addContact(fromCard s: String) {
        guard let card = PublicIDCard.decode(s), Data(base64url: card.kem) != nil else {
            error = "That doesn't look like a valid Blockle Protect ID."; return
        }
        if let i = contacts.firstIndex(where: { $0.id == card.rid }) {
            contacts[i].name = card.n
        } else {
            contacts.append(ProtectContact(id: card.rid, name: card.n.isEmpty ? "Contact" : card.n,
                                            kemPublicKeyB64: card.kem, dsaPublicKeyB64: card.dsa))
        }
        persist(); error = nil
    }

    func removeContact(_ c: ProtectContact) { contacts.removeAll { $0.id == c.id }; persist() }

    /// Protect `plaintext` to `contact` (and to this device so the sender keeps
    /// access), returning a .bprotect bundle's bytes to hand to the share sheet.
    func makeBundle(name: String, plaintext: Data, to contact: ProtectContact, now: Int) throws -> Data {
        guard let kem = Data(base64url: contact.kemPublicKeyB64) else { throw ProtectError.encoding("contact key") }
        let me = try VaultIdentity.loadOrCreate()
        let recipients = [
            Recipient(kemPublicKey: me.kemPublicKey, kind: "device"),  // sender keeps access
            Recipient(kemPublicKey: kem, kind: "share"),               // the recipient
        ]
        let r = try Protector.protect(plaintext: plaintext, recipients: recipients,
            signerPublicKey: me.dsaPublicKey, signerPrivateKey: me.dsaPrivateKey, label: name, now: now)
        let bundle = ShareBundle(manifestJson: String(decoding: CanonicalJSON.bytes(r.signed.json), as: UTF8.self),
                                 ct: r.ciphertext.base64url)
        ProtectState.log(icon: "paperplane.fill", title: "Shared “\(name)”", detail: "Encrypted to \(contact.name) — only they can open it.")
        return try JSONEncoder().encode(bundle)
    }

    /// Open a received .bprotect bundle with this device's identity.
    func openBundle(_ data: Data) throws -> (name: String, plaintext: Data) {
        let bundle = try JSONDecoder().decode(ShareBundle.self, from: data)
        let signed = try JSONDecoder().decode(SignedManifest.self, from: Data(bundle.manifestJson.utf8))
        guard let ct = Data(base64url: bundle.ct) else { throw ProtectError.encoding("bundle ciphertext") }
        let me = try VaultIdentity.loadOrCreate()
        let holder = Protector.Holder(kemPrivateKey: me.kemPrivateKey, recipientId: me.recipientId)
        let pt = try Protector.unprotect(ciphertext: ct, manifest: signed.manifest, holder: holder)
        let name = signed.manifest.label ?? "shared-file"
        ProtectState.log(icon: "lock.open.fill", title: "Opened a shared file", detail: "Decrypted “\(name)” sent to you.")
        return (name, pt)
    }
}
