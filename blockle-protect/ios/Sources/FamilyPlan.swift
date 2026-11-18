import Foundation
import StoreKit
import SafariServices

// Blockle Protect — ONE $20 one-time IAP unlocks everything (StoreKit
// non-consumable, mark the product "Family Sharable" in App Store Connect so it
// covers the whole Apple family). The buyer can also share it with family OR a
// team via an invite code/link: anyone who joins a household is unlocked too.
// The buyer becomes head of household and is emailed (via support@blockle.org)
// if any member turns a gambling/adult block off. Members JOIN for free.
//
// Central entitlement: unlocked == owns the product (incl. Family Sharing) OR
// is a member of a household. The free tier keeps the gambling/scam block, the
// Security Checkup, Commitment Lock and Recovery Key usable — protection is
// never paywalled; the unlock covers scale/convenience (full Vault, iCloud
// backup, Secure Sharing, Family, verification-proof export, adult filters).
@MainActor
final class Entitlement: ObservableObject {
    static let shared = Entitlement()
    @Published var unlocked = false

    func refresh() async {
        // StoreKit ownership (also true for Family-Shared purchases).
        var owned = false
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, t.productID == FamilyStore.productID, t.revocationDate == nil { owned = true; break }
        }
        // Household membership (invite-code share, incl. non-Apple-family / business).
        let inHousehold = UserDefaults.standard.data(forKey: "blockle.protect.household") != nil
        unlocked = owned || inHousehold
    }
}

@MainActor
final class FamilyStore: ObservableObject {
    static let productID = "org.blockle.protect.unlock"
    @Published var product: Product?
    @Published var owned = false
    @Published var busy = false
    @Published var message: String?

    func load() async {
        product = try? await Product.products(for: [Self.productID]).first
        await refreshOwned()
    }
    func refreshOwned() async {
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, t.productID == Self.productID, t.revocationDate == nil { owned = true; return }
        }
        owned = false
    }
    func buy() async {
        guard let product else { message = "The family plan isn’t set up yet — check back soon."; return }
        busy = true; defer { busy = false }
        do {
            switch try await product.purchase() {
            case .success(let v):
                if case .verified(let t) = v { await t.finish(); owned = true; await Entitlement.shared.refresh(); message = "Unlocked — thank you 💛 Share it with family or your team below." }
                else { message = "Couldn’t verify the purchase." }
            case .userCancelled: break
            case .pending: message = "Purchase pending approval."
            @unknown default: break
            }
        } catch { message = "The purchase didn’t go through." }
    }
    var priceText: String { product?.displayPrice ?? "$20" }
}

// MARK: - Household (persisted) + service client

struct Household: Codable {
    enum Role: String, Codable { case head, member }
    var role: Role
    var householdId: String
    var hoHAlias: String?
    var ownerToken: String?   // head only
    var code: String?         // head only (invite code)
    var joinUrl: String?      // head only
    var memberId: String?     // member only
    var memberToken: String?  // member only
    var lastAlertAt: Date?
}

enum HouseholdClient {
    static let base = "https://protect.blockle.org/api/accountability"

    private static func post(_ path: String, _ body: [String: Any]) async -> [String: Any]? {
        guard let url = URL(string: base + path) else { return nil }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (d, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    static func create(hoHEmail: String, hoHAlias: String) async -> Household? {
        guard let o = await post("/household/create", ["hoHEmail": hoHEmail, "hoHAlias": hoHAlias]),
              let id = o["householdId"] as? String else { return nil }
        return Household(role: .head, householdId: id, hoHAlias: hoHAlias,
                         ownerToken: o["ownerToken"] as? String, code: o["code"] as? String,
                         joinUrl: o["joinUrl"] as? String, memberId: nil, memberToken: nil)
    }
    static func join(code: String, memberAlias: String) async -> Household? {
        guard let o = await post("/household/join", ["code": code, "memberAlias": memberAlias]),
              let id = o["householdId"] as? String, let mid = o["memberId"] as? String,
              let mt = o["memberToken"] as? String else { return nil }
        return Household(role: .member, householdId: id, hoHAlias: o["hoHAlias"] as? String,
                         ownerToken: nil, code: nil, joinUrl: nil, memberId: mid, memberToken: mt)
    }
    static func alert(_ h: Household, event: String) async {
        guard h.role == .member, let mid = h.memberId, let mt = h.memberToken else { return }
        _ = await post("/household/alert", ["householdId": h.householdId, "memberId": mid, "memberToken": mt, "event": event])
    }

    /// Shared family blocklist. `action` is add / remove / set / get; every call
    /// returns the full merged domain list. Any member (or the head) may edit.
    static func custom(_ h: Household, action: String, domains: [String] = []) async -> [String]? {
        let token = h.ownerToken ?? h.memberToken
        guard let token else { return nil }
        guard let o = await post("/household/custom",
            ["householdId": h.householdId, "token": token, "action": action, "domains": domains]) else { return nil }
        return o["domains"] as? [String]
    }
}

@MainActor
final class HouseholdModel: ObservableObject {
    @Published var household: Household?
    private let key = "blockle.protect.household"

    init() {
        if let d = UserDefaults.standard.data(forKey: key), let h = try? JSONDecoder().decode(Household.self, from: d) { household = h }
    }
    private func save() {
        if let h = household, let d = try? JSONEncoder().encode(h) { UserDefaults.standard.set(d, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }

    func create(email: String, alias: String) async -> Bool {
        guard let h = await HouseholdClient.create(hoHEmail: email, hoHAlias: alias) else { return false }
        household = h; save(); await Entitlement.shared.refresh(); return true
    }
    func join(code: String, alias: String) async -> Bool {
        guard let h = await HouseholdClient.join(code: code, memberAlias: alias) else { return false }
        household = h; save(); await Entitlement.shared.refresh(); return true
    }
    func leave() { household = nil; save(); Task { await Entitlement.shared.refresh() } }

    /// If this is a MEMBER device and the gambling block is off, alert the head
    /// of household (locally rate-limited to once/hour). Call on foreground.
    func checkAndAlert() {
        guard var h = household, h.role == .member else { return }
        if let last = h.lastAlertAt, Date().timeIntervalSince(last) < 3600 { return }
        SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: "org.blockle.protect.shieldCore") { state, _ in
            guard state?.isEnabled == false else { return }
            Task { @MainActor in
                await HouseholdClient.alert(h, event: "relapse")
                h.lastAlertAt = Date(); self.household = h; self.save()
            }
        }
    }
}
