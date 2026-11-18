import Foundation

// Lightweight shared state + event log so the Activity screen and the Security
// Checkup reflect what's actually happened — protections, integrity checks,
// shares, tamper events. Plain UserDefaults; no entitlements, no server.
enum ProtectState {
    private static let d = UserDefaults.standard

    static var protectedFileCount: Int {
        get { d.integer(forKey: "protect.fileCount") }
        set { d.set(newValue, forKey: "protect.fileCount") }
    }
    static var integrityChecked: Int {
        get { d.integer(forKey: "protect.integrityChecked") }
        set { d.set(newValue, forKey: "protect.integrityChecked") }
    }
    static var integrityFailing: Int {
        get { d.integer(forKey: "protect.integrityFailing") }
        set { d.set(newValue, forKey: "protect.integrityFailing") }
    }
    static var lastIntegrityAt: Date? {
        get { d.object(forKey: "protect.integrityAt") as? Date }
        set { d.set(newValue, forKey: "protect.integrityAt") }
    }

    struct Event: Codable, Identifiable {
        var id = UUID()
        var at: Date
        var icon: String
        var title: String
        var detail: String
    }

    static func log(icon: String, title: String, detail: String) {
        var list = events
        list.insert(Event(at: Date(), icon: icon, title: title, detail: detail), at: 0)
        if list.count > 60 { list = Array(list.prefix(60)) }
        if let data = try? JSONEncoder().encode(list) { d.set(data, forKey: "protect.events") }
    }

    static var events: [Event] {
        guard let data = d.data(forKey: "protect.events"),
              let list = try? JSONDecoder().decode([Event].self, from: data) else { return [] }
        return list
    }
}
