import Foundation
import SafariServices
import BackgroundTasks

// Tells the people who agreed to hold someone accountable when protection gets
// switched off.
//
// WHY THIS EXISTS AS ITS OWN FILE: before this, two separate watchers each
// checked ONE blocker (`shieldCore`) and each only ran while its own screen was
// on screen — CommitmentLockView and FamilyView. So the most likely sequence in
// the real world (open Settings, turn a filter off, never open the Family tab
// again) produced no email at all, and the four adult filters and the custom
// "My List" were never watched by anything. This is the single watcher for every
// protected surface, driven from the app, not from a view.
//
// HONEST SCOPE — this is what the feature can and cannot do:
//   • iOS gives no callback when a content blocker is toggled, and no way to run
//     code at that moment. State can only be READ while this app is running.
//     So an alert is sent the next time the app runs, not the instant it happens.
//   • A BGAppRefreshTask (`refreshTaskID`) also runs this check, so a filter
//     switched off in Settings can be noticed without the app being opened.
//     But iOS decides if and when that task runs — it budgets background time
//     by how much the user actually uses the app, gives no guaranteed interval,
//     and never runs it at all while the device is in Low Power Mode or if the
//     user turns Background App Refresh off in Settings. It narrows the gap; it
//     does not close it. If someone disables protection and never opens the app
//     again, an email may never be sent.
//   • Therefore the UI must never promise real-time alerts.
//   • It cannot prevent anything. It makes removal visible, which is the claim
//     docs/THREAT-MODEL.md supports.
//
// A FALSE ALERT IS WORSE THAN A MISSED ONE. Telling someone their partner or
// child disabled a block when they did not is the kind of mistake that ends
// relationships, so two rules are absolute: a filter is only ever reported as
// turned off if this app has previously OBSERVED it on, and any read error is
// treated as unknown and reported as nothing.

struct WatchedFilter {
    let id: String
    /// How this reads in an email to a non-technical person.
    let label: String
}

@MainActor
final class DisableWatch: ObservableObject {
    static let shared = DisableWatch()

    /// Every protected surface. Keep in step with SafariShieldView's list —
    /// a filter missing here is a filter nobody is watching.
    static let filters: [WatchedFilter] = [
        WatchedFilter(id: "org.blockle.protect.shieldCore",   label: "Gambling, scam & phishing sites"),
        WatchedFilter(id: "org.blockle.protect.shieldAdult1", label: "Adult sites (list 1 of 4)"),
        WatchedFilter(id: "org.blockle.protect.shieldAdult2", label: "Adult sites (list 2 of 4)"),
        WatchedFilter(id: "org.blockle.protect.shieldAdult3", label: "Adult sites (list 3 of 4)"),
        WatchedFilter(id: "org.blockle.protect.shieldAdult4", label: "Adult sites (list 4 of 4)"),
        WatchedFilter(id: CustomBlockStore.blockerID,         label: "My List (custom blocked sites)"),
    ]

    /// Filters this app has seen switched on at least once. Without this, a user
    /// who never enabled the adult lists would be reported for "turning them
    /// off" on first launch.
    private let everOnKey = "blockle.protect.watch.everOn"
    /// Filters already reported as off, so one disable sends one email rather
    /// than one per app launch for as long as it stays off.
    private let reportedKey = "blockle.protect.watch.reportedOff"

    /// MUST match `BGTaskSchedulerPermittedIdentifiers` in project.yml. If the
    /// two ever drift, `submit` throws and background checking silently stops.
    /// `nonisolated` so the background handler and `scheduleRefresh()` can read
    /// it off the main actor — immutable and Sendable, so there is nothing to
    /// protect. (Without this it is a warning today and an error in Swift 6.)
    nonisolated static let refreshTaskID = "org.blockle.protect.refresh"

    /// How far out to ask for the next background run. iOS treats this as "not
    /// before", never "at" — the real interval is whatever the system's budget
    /// for this app allows, which may be much longer or never.
    nonisolated private static let refreshInterval: TimeInterval = 2 * 3600

    @Published private(set) var lastCheckedAt: Date?
    @Published private(set) var currentlyOff: [String] = []

    private var isChecking = false

    private var everOn: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: everOnKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: everOnKey) }
    }
    private var reportedOff: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: reportedKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: reportedKey) }
    }

    // MARK: - background scheduling

    /// Ask iOS for another background check. A submitted request is consumed
    /// when it runs, so this has to be called again from inside the background
    /// handler — otherwise the app gets exactly one background check, ever.
    ///
    /// `nonisolated` because BGTaskScheduler is thread-safe and this is called
    /// from the background-task handler, which is not on the main actor.
    nonisolated static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: refreshInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Expected and harmless in two cases: the simulator (which has no
            // scheduler) and a user who has turned Background App Refresh off.
            // Not surfaced to the user — foreground checks still work, and the
            // honest fix for the latter is in iOS Settings, not in this app.
            #if DEBUG
            print("[DisableWatch] background refresh not scheduled: \(error)")
            #endif
        }
    }

    // MARK: - reading state

    /// `nil` means the state could not be read — NOT that the filter is off.
    private static func isEnabled(_ id: String) async -> Bool? {
        await withCheckedContinuation { (k: CheckedContinuation<Bool?, Never>) in
            SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: id) { state, error in
                if error != nil { k.resume(returning: nil) }
                else { k.resume(returning: state?.isEnabled) }
            }
        }
    }

    // MARK: - the check

    /// Read every filter, work out what changed, and tell whoever is owed an
    /// email. Safe to call as often as you like — it only sends on a transition.
    func check() async {
        // Re-entrancy guard. Cold launch can call this twice — once from the
        // app's `.task`, once from the scenePhase change — and because this
        // method suspends on every blocker read, two overlapping runs could
        // both observe the same pre-state and both decide to send. The service
        // rate limit would mask it, but correctness should not depend on that.
        // Safe as a plain Bool: @MainActor serialises the read-modify-write.
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }

        var on: Set<String> = everOn
        var reported: Set<String> = reportedOff
        var newlyOff: [String] = []
        var backOn: [String] = []
        var offNow: [String] = []

        for f in Self.filters {
            guard let enabled = await Self.isEnabled(f.id) else { continue }  // unreadable: say nothing
            if enabled {
                on.insert(f.id)
                if reported.remove(f.id) != nil { backOn.append(f.label) }
            } else {
                offNow.append(f.id)
                // Only a filter we have actually seen working can be "turned off".
                guard on.contains(f.id), !reported.contains(f.id) else { continue }
                reported.insert(f.id)
                newlyOff.append(f.label)
            }
        }

        everOn = on
        reportedOff = reported
        currentlyOff = offNow
        lastCheckedAt = Date()

        if !newlyOff.isEmpty {
            ProtectState.log(icon: "exclamationmark.triangle.fill",
                             title: newlyOff.count == 1 ? "Protection turned off" : "\(newlyOff.count) protections turned off",
                             detail: newlyOff.joined(separator: ", "))
            await notify(event: "relapse", detail: Self.disableBody(newlyOff))
        }
        if !backOn.isEmpty {
            // Worth sending: a partner who got the "switched off" email is
            // otherwise left assuming it is still off.
            await notify(event: "restored", detail: Self.restoreBody(backOn))
        }
    }

    private static func disableBody(_ labels: [String]) -> String {
        let list = labels.map { "• \($0)" }.joined(separator: "\n")
        return labels.count == 1
            ? "This protection was switched off in iOS Settings:\n\(list)"
            : "These protections were switched off in iOS Settings:\n\(list)"
    }

    private static func restoreBody(_ labels: [String]) -> String {
        "Turned back on:\n" + labels.map { "• \($0)" }.joined(separator: "\n")
    }

    // MARK: - recipients

    /// Everyone who has agreed, by double opt-in, to hear about this: the
    /// accountability partner and/or the head of household. Both are optional
    /// and independent — a user may have one, both, or neither.
    private func notify(event: String, detail: String) async {
        if let link = PartnerStore.load() {
            await AccountabilityClient.notify(inviteId: link.inviteId,
                                              ownerToken: link.ownerToken,
                                              event: event, detail: detail)
        }
        let hh = HouseholdModel()
        if let h = hh.household, h.role == .member {
            await HouseholdClient.alert(h, event: event, detail: detail)
        }
    }

    /// True if anyone would actually be emailed. Used by the UI so it can say
    /// "nobody is being told" instead of implying someone is.
    static func hasRecipient(household: Household?) -> Bool {
        if PartnerStore.load() != nil { return true }
        if let h = household, h.role == .member { return true }
        return false
    }
}

// MARK: - partner linkage, persisted outside the commitment

/// The accountability partner's service linkage.
///
/// This used to live only inside `Commitment`, which meant ending a commitment
/// called `finish()`, set `commitment = nil`, and silently forgot the partner —
/// so disables after that went to nobody. Accountability is supposed to outlive
/// a single commitment, so it is stored separately and cleared only when the
/// user explicitly removes the partner.
struct PartnerLink: Codable {
    var inviteId: String
    var ownerToken: String
    var partnerName: String?
}

enum PartnerStore {
    private static let key = "blockle.protect.partnerLink"

    static func load() -> PartnerLink? {
        guard let d = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(PartnerLink.self, from: d)
    }
    static func save(_ l: PartnerLink) {
        if let d = try? JSONEncoder().encode(l) { UserDefaults.standard.set(d, forKey: key) }
    }
    static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}
