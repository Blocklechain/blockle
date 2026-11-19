import Foundation
import SafariServices
import UserNotifications
import CryptoKit

// Commitment Lock — a self-restraint tool for people blocking gambling sites.
//
// HONEST SCOPE: iOS does not let a third-party app forcibly keep a Safari
// content blocker enabled — the user can always toggle it in Settings. So this
// does NOT claim to make blocking impossible to remove. Instead it makes
// removal visible, effortful and accountable, which is what actually helps:
//   • Detection — checks the gambling filter's state and records if it's turned
//     off during a commitment.
//   • Accountability — an optional trusted partner; the early-unlock key can be
//     held by that partner or discarded entirely ("throw away the key").
//   • Friction — ending a commitment early requires a long, non-skippable
//     cooldown and explicit confirmation.
// For a lock the user genuinely cannot remove alone, the app guides them to
// iOS Screen Time with a partner-held passcode (see CommitmentLockView).

enum KeyHolder: String, Codable { case me, partner, discarded }

struct Commitment: Codable {
    var startedAt: Date
    /// nil = open-ended ("until I ask to stop"); otherwise a fixed end date.
    var endsAt: Date?
    var partnerName: String?
    var partnerContact: String?   // email/phone the user will report to
    var keyHolder: KeyHolder
    /// SHA-256 of the random unlock key (we never store the key itself).
    var keyHash: String?
    /// Set when the user asks to end early; unlock allowed only after cooldown.
    var unlockRequestedAt: Date?
    var cooldownHours: Int
    /// Times a protected filter was found disabled during this commitment.
    var tamperCount: Int = 0
    var lastTamperAt: Date?
    /// Accountability email service linkage (set once the buddy invite is sent).
    var inviteId: String?
    var ownerToken: String?
    var lastProgressAt: Date?
}

/// Talks to the accountability-buddy email service (support@blockle.org sends
/// the actual emails after the buddy double-opt-in confirms).
enum AccountabilityClient {
    static let base = "https://protect.blockle.org/api/accountability"
    static func invite(buddyEmail: String, buddyName: String?, alias: String) async -> (inviteId: String, ownerToken: String)? {
        guard let url = URL(string: base + "/invite") else { return nil }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["buddyEmail": buddyEmail, "buddyName": buddyName ?? "", "userAlias": alias])
        guard let (d, _) = try? await URLSession.shared.data(for: req),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let id = o["inviteId"] as? String, let t = o["ownerToken"] as? String else { return nil }
        return (id, t)
    }
    static func notify(inviteId: String, ownerToken: String, event: String, detail: String? = nil) async {
        guard let url = URL(string: base + "/notify") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["inviteId": inviteId, "ownerToken": ownerToken, "event": event, "detail": detail ?? ""])
        _ = try? await URLSession.shared.data(for: req)
    }
}

@MainActor
final class CommitmentLockModel: ObservableObject {
    static let gamblingFilterID = "org.blockle.protect.shieldCore"
    private let key = "blockle.protect.commitment"

    @Published var commitment: Commitment?
    @Published var filterEnabled = true   // last observed state of the gambling filter

    init() { load() }

    var isActive: Bool { commitment != nil }

    // MARK: lifecycle

    func load() {
        if let data = UserDefaults.standard.data(forKey: key),
           let c = try? JSONDecoder().decode(Commitment.self, from: data) {
            commitment = c
        }
    }
    private func save() {
        if let c = commitment, let data = try? JSONEncoder().encode(c) {
            UserDefaults.standard.set(data, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    /// Start a commitment. Returns the one-time unlock key IFF the holder is the
    /// partner (to be shared with them) — never persisted in the clear. For
    /// `.discarded` there is no early-unlock key at all.
    func start(endsAt: Date?, partnerName: String?, partnerContact: String?,
               keyHolder: KeyHolder, cooldownHours: Int) -> String? {
        var key: String?
        var hash: String?
        if keyHolder == .partner || keyHolder == .me {
            let k = Self.randomKey()
            key = k
            hash = Data(SHA256.hash(data: Data(k.utf8))).map { String(format: "%02x", $0) }.joined()
        }
        commitment = Commitment(startedAt: Date(), endsAt: endsAt,
                                partnerName: partnerName, partnerContact: partnerContact,
                                keyHolder: keyHolder, keyHash: hash,
                                unlockRequestedAt: nil, cooldownHours: cooldownHours)
        save()
        requestNotificationAuth()
        // If the partner gave an email, send the double-opt-in invite (they must
        // confirm before any update email is sent).
        if let contact = partnerContact, contact.contains("@") {
            let saved = UserDefaults.standard.string(forKey: "blockle.protect.displayName")
            let alias = (saved?.isEmpty == false ? saved : nil) ?? "Your friend"
            Task {
                guard let r = await AccountabilityClient.invite(buddyEmail: contact, buddyName: partnerName, alias: alias),
                      var c = self.commitment else { return }
                c.inviteId = r.inviteId; c.ownerToken = r.ownerToken
                self.commitment = c; self.save()
                // Also store it outside the commitment. `finish()` nils the
                // commitment out, which used to forget the partner along with
                // it — so disabling a filter after a commitment ended emailed
                // nobody. Accountability outlives one commitment; this is
                // cleared only when the user removes the partner.
                PartnerStore.save(PartnerLink(inviteId: r.inviteId, ownerToken: r.ownerToken,
                                              partnerName: partnerName))
            }
        }
        return key
    }

    /// Weekly "still going strong" update to the buddy. Call on foreground.
    func sendProgressIfDue() {
        guard var c = commitment, let id = c.inviteId, let t = c.ownerToken else { return }
        let last = c.lastProgressAt ?? c.startedAt
        guard Date().timeIntervalSince(last) >= 7 * 24 * 3600 else { return }
        let days = Int(Date().timeIntervalSince(c.startedAt) / 86400)
        c.lastProgressAt = Date(); commitment = c; save()
        Task { await AccountabilityClient.notify(inviteId: id, ownerToken: t, event: "progress", detail: "Day \(days) and going strong.") }
    }

    /// Natural expiry (endsAt reached) — always allowed, no friction.
    var hasExpired: Bool {
        guard let c = commitment, let end = c.endsAt else { return false }
        return Date() >= end
    }

    func requestEarlyUnlock() {
        guard var c = commitment, c.unlockRequestedAt == nil else { return }
        c.unlockRequestedAt = Date()
        commitment = c; save()
    }

    var unlockEligibleAt: Date? {
        guard let c = commitment, let req = c.unlockRequestedAt else { return nil }
        return req.addingTimeInterval(TimeInterval(c.cooldownHours) * 3600)
    }

    enum UnlockResult { case ended, cooldown(Date), needKey, wrongKey, discardedNoEarlyExit }

    /// Attempt to end the commitment. Natural expiry bypasses all checks.
    func attemptEnd(enteredKey: String?) -> UnlockResult {
        guard let c = commitment else { return .ended }
        if hasExpired {
            if let id = c.inviteId, let t = c.ownerToken {
                Task { await AccountabilityClient.notify(inviteId: id, ownerToken: t, event: "completed") }
            }
            finish(); return .ended
        }
        if c.keyHolder == .discarded { return .discardedNoEarlyExit }
        guard let eligible = unlockEligibleAt else { return .cooldown(Date()) } // not yet requested
        if Date() < eligible { return .cooldown(eligible) }
        guard let entered = enteredKey, !entered.isEmpty else { return .needKey }
        let h = Data(SHA256.hash(data: Data(entered.utf8))).map { String(format: "%02x", $0) }.joined()
        guard h == c.keyHash else { return .wrongKey }
        finish(); return .ended
    }

    private func finish() { commitment = nil; save() }

    // MARK: tamper detection

    /// Check the gambling filter's live state; if it's off during a commitment,
    /// record it and nag. Call on launch, foreground, and from background refresh.
    func checkTamper() {
        SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: Self.gamblingFilterID) { [weak self] state, _ in
            Task { @MainActor in
                guard let self else { return }
                let on = state?.isEnabled ?? false
                self.filterEnabled = on
                guard var c = self.commitment, !on else { return }
                c.tamperCount += 1
                c.lastTamperAt = Date()
                self.commitment = c; self.save()
                self.notifyTamper(c)
                ProtectState.log(icon: "exclamationmark.triangle.fill", title: "Gambling block turned off",
                                 detail: c.partnerName.map { "During your commitment — consider telling \($0)." } ?? "During your active commitment.")
                // The partner email is NOT sent from here. DisableWatch watches
                // every filter app-wide and names which one changed; sending
                // from both paths would race for the service's rate limit and
                // the vaguer message could win. This path keeps the commitment
                // bookkeeping (tamperCount) and the local nag only.
            }
        }
    }

    private func notifyTamper(_ c: Commitment) {
        let content = UNMutableNotificationContent()
        content.title = "Your gambling block is OFF"
        content.body = c.partnerName.map { "You committed to keep this on. Re-enable it, or let \($0) know." }
            ?? "You committed to keep this on. Re-enable it in Settings → Safari → Extensions."
        content.sound = .default
        let req = UNNotificationRequest(identifier: "tamper-\(Int(Date().timeIntervalSince1970))",
                                        content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    private func requestNotificationAuth() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func randomKey() -> String {
        // 4 words-ish: a readable but hard-to-guess key for a partner to hold.
        let bytes = (0..<10).map { _ in UInt8.random(in: 0...255) }
        return Data(bytes).map { String(format: "%02x", $0) }.joined()
    }
}
