import Foundation
import SafariServices

// "My List" — the user's own blocklist, on top of the built-in categories.
//
// Sites the user adds are packed into a Safari rule list and handed to the
// dynamic ShieldCustom content-blocker through the shared App Group container.
// When the device belongs to a household, the list is SHARED: anything a member
// (or the head) adds syncs to everyone in the family/team, so a parent can block
// a site once and it's blocked on every linked phone.
//
// Honest about scope: this blocks in Safari (and any app using Safari's content
// blockers), exactly like the category shields — it can't reach a site opened in
// a different third-party browser. The point is a single, shared, always-on list.
@MainActor
final class CustomBlockStore: ObservableObject {
    static let shared = CustomBlockStore()
    static let appGroup = "group.org.blockle.protect"
    static let blockerID = "org.blockle.protect.shieldCustom"
    private let key = "blockle.protect.customDomains"

    @Published var local: [String] = []   // this device's own additions
    @Published var family: [String] = []  // merged list pulled from the household
    @Published var message: String?
    @Published var syncing = false

    /// The full, de-duplicated set that is actually blocked.
    var all: [String] { Array(Set(local + family)).sorted() }

    private init() {
        local = (UserDefaults.standard.array(forKey: key) as? [String]) ?? []
        apply()
    }

    private func persist() { UserDefaults.standard.set(local, forKey: key) }

    /// Normalize user input to a bare registrable domain, or nil if invalid.
    static func normalize(_ raw: String) -> String? {
        var s = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
        if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
        if s.hasPrefix("www.") { s = String(s.dropFirst(4)) }
        let ok = s.range(of: "^[a-z0-9.-]+\\.[a-z]{2,}$", options: .regularExpression) != nil
        return (ok && s.count < 200) ? s : nil
    }

    func add(_ raw: String, household: Household?) async {
        guard let d = Self.normalize(raw) else { message = "Enter a valid site, like bet365.com"; return }
        if !local.contains(d) { local.append(d); local.sort(); persist() }
        if let h = household, let list = await HouseholdClient.custom(h, action: "add", domains: [d]) { family = list }
        apply()
        message = household == nil ? "Blocking \(d)." : "Blocking \(d) — synced to your family."
    }

    func remove(_ d: String, household: Household?) async {
        local.removeAll { $0 == d }; persist()
        // Only pull the site from the shared list if this device added it to the
        // family; otherwise members could silently unblock each other.
        if let h = household, let list = await HouseholdClient.custom(h, action: "remove", domains: [d]) { family = list }
        apply()
    }

    /// Pull the family's shared list (pushing up any local-only sites first) and
    /// re-apply. Call on foreground and when the My-List screen opens.
    func sync(household: Household?) async {
        guard let h = household else { family = []; apply(); return }
        syncing = true; defer { syncing = false }
        if !local.isEmpty { _ = await HouseholdClient.custom(h, action: "add", domains: local) }
        if let list = await HouseholdClient.custom(h, action: "get") { family = list }
        apply()
    }

    /// Pack the merged set into a Safari rule list, drop it in the App Group, and
    /// ask Safari to recompile the ShieldCustom extension.
    func apply() {
        let data = Self.packed(all)
        if let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) {
            try? data.write(to: dir.appendingPathComponent("custom-blockerList.json"), options: .atomic)
        }
        SFContentBlockerManager.reloadContentBlocker(withIdentifier: Self.blockerID) { _ in }
    }

    /// One `block` rule per chunk of ≤200 domains (via `if-domain`, which also
    /// matches subdomains). Empty → a valid no-op list so the reload succeeds.
    static func packed(_ domains: [String]) -> Data {
        if domains.isEmpty {
            return Data(#"[{"action":{"type":"ignore-previous-rules"},"trigger":{"url-filter":".*"}}]"#.utf8)
        }
        var rules: [[String: Any]] = []
        var i = 0
        while i < domains.count {
            let chunk = Array(domains[i..<min(i + 200, domains.count)])
            rules.append(["action": ["type": "block"],
                          "trigger": ["url-filter": ".*", "if-domain": chunk.map { "*" + $0 }]])
            i += 200
        }
        return (try? JSONSerialization.data(withJSONObject: rules)) ?? Data("[]".utf8)
    }
}
