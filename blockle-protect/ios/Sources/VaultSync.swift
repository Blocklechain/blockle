import Foundation

// iCloud backup/restore for the Vault. The vault only ever stores ENCRYPTED
// envelopes (ciphertext + signed manifests) — never plaintext or keys — so
// copying it to the user's private iCloud container is safe. Combined with the
// Recovery Key (same identity on a new device), this restores access anywhere.
//
// Explicit backup/restore (not transparent sync) keeps it simple and keeps the
// slow ubiquity-container resolution off the main thread. Requires the iCloud
// entitlement + container; when absent, `available` is false and the UI says so.
enum VaultSync {
    /// The app's iCloud container Documents dir, or nil if iCloud/entitlement
    /// isn't available. MUST be called off the main thread (can block).
    static func containerDocuments() -> URL? {
        guard let base = FileManager.default.url(forUbiquityContainerIdentifier: nil) else { return nil }
        let docs = base.appendingPathComponent("Documents/BlockleVault", isDirectory: true)
        try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        return docs
    }

    /// Why iCloud is or is not usable.
    ///
    /// THE DISTINCTION MATTERS: one of these is the user's to fix and the other
    /// is ours. The UI used to collapse both into "Sign in to iCloud", which
    /// sends someone who is already signed in to Settings to hunt for a switch
    /// that is on — while the real cause was the app's own container
    /// entitlement failing to resolve in a distribution build.
    enum Availability: Equatable {
        case ready
        case noAccount             // not signed in, or iCloud Drive is off
        case containerUnavailable  // signed in, but OUR container will not resolve
    }

    /// Cheap and main-thread safe: only inspects the account token.
    static var isSignedIn: Bool { FileManager.default.ubiquityIdentityToken != nil }

    /// MUST be called off the main thread — resolving the container can block.
    static func probe() -> Availability {
        guard isSignedIn else { return .noAccount }
        return containerDocuments() != nil ? .ready : .containerUnavailable
    }

    /// What to tell the user, honestly, for each case.
    static func explain(_ a: Availability) -> String {
        switch a {
        case .ready: return "Available"
        case .noAccount: return "Sign in to iCloud"
        case .containerUnavailable: return "Unavailable in this build"
        }
    }

    @available(*, deprecated, message: "Use probe() — isAvailable cannot tell a signed-out user from a broken container.")
    static var isAvailable: Bool { isSignedIn }

    private static func copyAll(from src: URL, to dst: URL) throws -> Int {
        let fm = FileManager.default
        try fm.createDirectory(at: dst, withIntermediateDirectories: true)
        var n = 0
        for name in (try? fm.contentsOfDirectory(atPath: src.path)) ?? [] {
            let s = src.appendingPathComponent(name), d = dst.appendingPathComponent(name)
            if fm.fileExists(atPath: d.path) { try? fm.removeItem(at: d) }
            try fm.copyItem(at: s, to: d)
            n += 1
        }
        return n
    }

    /// Copy the local vault INTO iCloud. Returns the number of files backed up.
    static func backup(localVault: URL) throws -> Int {
        guard let cloud = containerDocuments() else { throw ProtectError.crypto("iCloud is not available on this device/account") }
        return try copyAll(from: localVault, to: cloud)
    }

    /// Copy the iCloud vault back to the local vault. Returns files restored.
    static func restore(localVault: URL) throws -> Int {
        guard let cloud = containerDocuments() else { throw ProtectError.crypto("iCloud is not available on this device/account") }
        return try copyAll(from: cloud, to: localVault)
    }
}
