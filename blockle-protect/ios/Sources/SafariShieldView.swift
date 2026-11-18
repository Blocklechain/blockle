import SwiftUI
import SafariServices
import UIKit

// Family Protection — Blockle Protect's Safari content blockers. iOS blocks
// sites in Safari via content-blocker app extensions; the user turns them on in
// Settings. This screen shows each filter, how many sites it blocks, whether
// iOS currently has it enabled, and a one-tap jump to Settings. The blocking is
// system-wide in Safari, not just the in-app browser.

struct ShieldFilter: Identifiable {
    let id: String            // content-blocker bundle identifier
    let title: String
    let detail: String
    let count: String
}

@MainActor
final class SafariShieldModel: ObservableObject {
    // Keep in sync with project.yml extension bundle ids + blocklist counts.
    let filters: [ShieldFilter] = [
        ShieldFilter(id: "org.blockle.protect.shieldCore",
                     title: "Gambling & Scams",
                     detail: "Casinos, sportsbooks, betting, lotteries, poker + known scam and phishing sites.",
                     count: "350,000+ sites"),
        ShieldFilter(id: "org.blockle.protect.shieldAdultA",
                     title: "Adult Content (Part 1)",
                     detail: "Pornography and adult sites — first half of the list.",
                     count: "476,000+ sites"),
        ShieldFilter(id: "org.blockle.protect.shieldAdultB",
                     title: "Adult Content (Part 2)",
                     detail: "Pornography and adult sites — second half of the list.",
                     count: "476,000+ sites"),
    ]
    @Published var enabled: [String: Bool] = [:]
    @Published var refreshing = false

    func refresh() {
        refreshing = true
        let group = DispatchGroup()
        var result: [String: Bool] = [:]
        for f in filters {
            group.enter()
            SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: f.id) { state, _ in
                result[f.id] = state?.isEnabled ?? false
                group.leave()
            }
        }
        group.notify(queue: .main) {
            self.enabled = result
            self.refreshing = false
        }
    }
}

struct SafariShieldView: View {
    @StateObject private var model = SafariShieldModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Image(systemName: "hand.raised.fill").foregroundStyle(Brand.red)
                            Text("Block risky sites in Safari").font(.headline).foregroundStyle(Brand.ink)
                        }
                        Text("Blockle Protect can block over 1.3 million gambling, scam and adult sites system-wide in Safari — not just in this app. Turn the filters on in Settings; it works everywhere Safari does.")
                            .font(.subheadline).foregroundStyle(Brand.inkSoft)
                        Button { openSafariSettings() } label: {
                            Label("Open Safari extension settings", systemImage: "gearshape.fill")
                        }.buttonStyle(PrimaryButtonStyle())
                        Text("Settings → Apps → Safari → Extensions → turn on each “Blockle Shield”. (On some iOS versions: Settings → Safari → Extensions.)")
                            .font(.footnote).foregroundStyle(Brand.muted)
                    }
                }
                ForEach(model.filters) { f in filterRow(f) }
                Text("Lists are compiled from large, regularly-updated open blocklists. No site you visit is ever sent to us — the filtering happens entirely on your device.")
                    .font(.footnote).foregroundStyle(Brand.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Family Protection")
        .task { model.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            model.refresh()
        }
    }

    private func filterRow(_ f: ShieldFilter) -> some View {
        let on = model.enabled[f.id] ?? false
        return Card {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(f.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.ink)
                    Spacer()
                    if on {
                        Label("On", systemImage: "checkmark.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(Brand.ok)
                    } else {
                        Label("Off", systemImage: "circle").font(.caption.weight(.semibold)).foregroundStyle(Brand.muted)
                    }
                }
                Text(f.detail).font(.subheadline).foregroundStyle(Brand.inkSoft)
                Text(f.count + " blocked").font(.caption).foregroundStyle(Brand.redSoft)
            }
        }
    }

    private func openSafariSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
