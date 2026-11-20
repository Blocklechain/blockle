import SwiftUI

// "My List" — add your own sites to block in Safari, on top of the built-in
// gambling / scam / adult categories. If you're in a household, the list is
// shared: anything you add is blocked on every family/team phone, and anything
// the head of household adds lands here automatically.
struct CustomBlockView: View {
    @StateObject private var store = CustomBlockStore.shared
    @StateObject private var hh = HouseholdModel()
    @State private var entry = ""
    @FocusState private var focused: Bool

    private var inFamily: Bool { hh.household != nil }

    /// Says plainly whether the list is actually in force. Without this the
    /// screen happily showed a list of sites that were not being blocked, with
    /// no way for anyone — user or developer — to tell the difference.
    private var statusCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                let broken = store.writeFailed
                    || store.extensionEnabled == false
                    || store.reloadError != nil
                    || (store.lastServed?.hasPrefix("the empty fallback") ?? false)
                HStack(spacing: 8) {
                    Image(systemName: broken ? "exclamationmark.triangle.fill" : "checkmark.shield.fill")
                        .foregroundStyle(broken ? Brand.red : Brand.redSoft)
                    Text(broken ? "Not blocking" : "Status").font(.headline).foregroundStyle(Brand.ink)
                }
                Text(store.diagnosis).font(.subheadline).foregroundStyle(Brand.inkSoft)

                if store.extensionEnabled == false {
                    Text("Open Settings → Safari → Extensions and switch on “Blockle Shield — My List”.")
                        .font(.footnote).foregroundStyle(Brand.muted)
                }
                // Enough detail to diagnose a report without a debug build.
                Text("extension: \(store.extensionEnabled.map { $0 ? "on" : "off" } ?? "unknown")  ·  rules: \(store.bytesWritten) bytes  ·  last run: \(store.lastServed ?? "never")")
                    .font(.caption2).foregroundStyle(Brand.muted)

                Button {
                    store.apply()
                    store.readBreadcrumb()
                } label: {
                    Label("Re-apply and re-check", systemImage: "arrow.clockwise")
                }.buttonStyle(.bordered).tint(Brand.red)
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Block a site").font(.headline).foregroundStyle(Brand.ink)
                        Text(inFamily
                             ? "Added sites are blocked in Safari on every phone in your family or team."
                             : "Added sites are blocked in Safari on this device. Join a family plan to share one list across phones.")
                            .font(.subheadline).foregroundStyle(Brand.muted)
                        HStack {
                            TextField("bet365.com", text: $entry)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .focused($focused)
                                .padding(10)
                                .background(Brand.bg2, in: RoundedRectangle(cornerRadius: 10))
                                .foregroundStyle(Brand.ink)
                            Button {
                                let raw = entry; entry = ""; focused = false
                                Task { await store.add(raw, household: hh.household) }
                            } label: {
                                Text("Block").fontWeight(.semibold).padding(.horizontal, 16).padding(.vertical, 10)
                                    .background(Brand.red, in: RoundedRectangle(cornerRadius: 10)).foregroundStyle(.white)
                            }.disabled(entry.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        if let m = store.message {
                            Text(m).font(.caption).foregroundStyle(Brand.redSoft)
                        }
                    }
                }

                statusCard

                if inFamily {
                    HStack(spacing: 8) {
                        Image(systemName: store.syncing ? "arrow.triangle.2.circlepath" : "person.3.fill")
                            .foregroundStyle(Brand.red)
                        Text(store.syncing ? "Syncing with your family…" : "Shared with your family / team")
                            .font(.caption).foregroundStyle(Brand.muted)
                        Spacer()
                    }
                }

                if store.all.isEmpty {
                    Card {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("No custom sites yet").font(.headline).foregroundStyle(Brand.ink)
                            Text("The built-in gambling, scam and adult shields are still active — this is for anything extra.")
                                .font(.subheadline).foregroundStyle(Brand.muted)
                        }
                    }
                } else {
                    Card {
                        VStack(spacing: 0) {
                            ForEach(store.all, id: \.self) { d in
                                HStack {
                                    Image(systemName: "nosign").foregroundStyle(Brand.red)
                                    Text(d).foregroundStyle(Brand.ink)
                                    if store.family.contains(d) && !store.local.contains(d) {
                                        Text("family").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                                            .background(Brand.bg2, in: Capsule()).foregroundStyle(Brand.muted)
                                    }
                                    Spacer()
                                    Button {
                                        Task { await store.remove(d, household: hh.household) }
                                    } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Brand.muted) }
                                        .buttonStyle(.plain)
                                }
                                .padding(.vertical, 10)
                                if d != store.all.last { Divider().overlay(Brand.bg2) }
                            }
                        }
                    }
                }

                Text("Blocking covers the site and its subdomains in Safari and apps that use Safari’s blocker. It can’t reach a site opened in a different third-party browser — the point is one shared, always-on list.")
                    .font(.caption).foregroundStyle(Brand.muted)
            }
            .padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("My List")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.sync(household: hh.household) }
    }
}
