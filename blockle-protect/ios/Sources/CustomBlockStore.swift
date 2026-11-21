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

    /// Is the "My List" Safari extension actually switched on in iOS Settings?
    /// nil until first checked. When this is false the user's list blocks
    /// NOTHING, however many sites they have added - and nothing else in the
    /// app would otherwise tell them, because reloadContentBlocker() succeeds
    /// silently on a disabled extension.
    @Published var extensionEnabled: Bool?

    /// Set when the rule list could not be handed to the extension at all
    /// (App Group container unavailable). Also silent before.
    @Published var writeFailed = false

    /// Error from the last reloadContentBlocker call, if Safari refused the list.
    @Published var reloadError: String?
    /// Size of the rule list handed over, so "0 bytes" is visible rather than implied.
    @Published var bytesWritten = 0
    /// What the extension said it served last time Safari ran it. nil = never run,
    /// or the extension cannot reach the App Group at all.
    @Published var lastServed: String?

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
        guard let dir = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else {
            // No App Group container: the extension can never see the list.
            // Previously this was `if let` with a `try?` write, so the whole
            // feature failed in total silence.
            // NOT "reinstall" — this is a signing/entitlement fault in the
            // build on the device, and reinstalling the same build cannot
            // change it. Sending a user round a loop that cannot work is
            // worse than telling them plainly that it is our problem.
            writeFailed = true
            message = "This build is missing its App Group entitlement, so the "
                + "blocker cannot see your list. This is a build fault, not "
                + "something you can fix on the phone."
            return
        }
        do {
            try data.write(to: dir.appendingPathComponent("custom-blockerList.json"),
                           options: .atomic)
            writeFailed = false
        } catch {
            writeFailed = true
            message = "Couldn't save your block list: \(error.localizedDescription)"
            return
        }
        bytesWritten = data.count
        // The reload error was previously thrown away with `{ _ in }`. It is the
        // ONE signal iOS gives about whether Safari actually accepted and
        // compiled the list — if the rules are malformed or oversized Safari
        // keeps the old ones and reports it here, and discarding it is why this
        // feature could fail with no indication anywhere.
        SFContentBlockerManager.reloadContentBlocker(withIdentifier: Self.blockerID) { [weak self] error in
            Task { @MainActor in
                self?.reloadError = error?.localizedDescription
                self?.readBreadcrumb()
            }
        }
        refreshExtensionState()
    }

    /// What the extension reported serving on its last run. Safari offers no way
    /// to read back compiled rules, so the extension leaves this behind.
    /// See CustomBlockerRequestHandler.
    func readBreadcrumb() {
        guard let dir = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup),
              let data = try? Data(contentsOf: dir.appendingPathComponent("custom-blocker-last-run.json")),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { lastServed = nil; return }
        let served = o["served"] as? String ?? "?"
        let bytes = o["bytes"] as? Int ?? 0
        let detail = o["detail"] as? String ?? ""
        lastServed = served == "shared"
            ? "your list (\(bytes) bytes)"
            : "the empty fallback\(detail.isEmpty ? "" : " — \(detail)")"
    }

    /// One-line summary of whether this feature is actually working, for the UI.
    /// Deliberately blunt: "nothing is being blocked" beats a green checkmark
    /// that means nothing.
    /// Is the shared container reachable AT ALL?
    ///
    /// Checked up front rather than discovered on the first add. When the App
    /// Group entitlement is missing from the signed build this is nil, and
    /// NOTHING about the feature can work — so the screen has to say so before
    /// the user types a site in and believes they are protected. A blocking
    /// app that silently fails open is worse than one that admits it is off.
    var containerReachable: Bool {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) != nil
    }

    /// Everything the screen can learn without the user doing anything.
    func preflight() {
        if !containerReachable {
            writeFailed = true
        }
        refreshExtensionState()
        readBreadcrumb()
    }

    var diagnosis: String {
        // THE BUILD ITSELF IS WRONG — said first, because it outranks
        // everything below it and because the advice is completely different.
        if !containerReachable {
            return "This build cannot reach its shared storage, so no site "
                + "you add here can be blocked. The App Group entitlement is "
                + "missing from the installed app — reinstalling will not fix "
                + "it and a new build is needed."
        }
        if all.isEmpty { return "No sites added yet." }
        if writeFailed { return "Your list could not be handed to the blocker." }
        if extensionEnabled == false {
            return "“My List” is OFF in Settings → Safari → Extensions, so none of your \(all.count) sites are blocked."
        }
        if let e = reloadError { return "Safari rejected the list: \(e)" }
        if let s = lastServed, s.hasPrefix("the empty fallback") {
            return "The blocker ran but served \(s) — your sites are NOT being blocked."
        }
        if lastServed == nil {
            return "Safari has not run the blocker yet. Visit a site in Safari, then reopen this screen."
        }
        return "Blocking \(all.count) site\(all.count == 1 ? "" : "s") — the blocker last served \(lastServed ?? "?")."
    }

    /// Ask iOS whether the My List extension is enabled. A disabled extension
    /// is the single most likely reason a user's own sites are not blocked.
    func refreshExtensionState() {
        SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: Self.blockerID) { [weak self] state, _ in
            let on = state?.isEnabled ?? false
            Task { @MainActor in self?.extensionEnabled = on }
        }
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
