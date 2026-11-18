import SwiftUI
import UIKit

struct IdentifiableURL: Identifiable { let id = UUID(); let url: URL }

/// Thin wrapper so SwiftUI can present the system share sheet for a file URL.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

// MARK: - Home

struct HomeView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Image(systemName: "checkmark.shield.fill").foregroundStyle(Brand.red)
                                Text("Protection").font(.headline).foregroundStyle(Brand.ink)
                                Spacer()
                                Text("Active").font(.caption.weight(.semibold))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(Brand.ok.opacity(0.15)).foregroundStyle(Brand.ok)
                                    .clipShape(Capsule())
                            }
                            HStack(spacing: 22) {
                                stat("\(ProtectState.protectedFileCount)", "Protected")
                                stat("\(max(0, ProtectState.integrityChecked - ProtectState.integrityFailing))", "Verified")
                                stat(ProtectState.recoveryConfigured ? "Key saved" : "Set up", "Recovery")
                            }
                        }
                    }
                    NavigationLink { ShieldDetail() } label: {
                        Card {
                            HStack {
                                Image(systemName: "shield.lefthalf.filled").font(.title2).foregroundStyle(Brand.red)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Run a Security Checkup").font(.headline).foregroundStyle(Brand.ink)
                                    Text("Scan this device and your account").font(.subheadline).foregroundStyle(Brand.muted)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(Brand.muted)
                            }
                        }
                    }.buttonStyle(.plain)
                    Card {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Protect your first file").font(.headline).foregroundStyle(Brand.ink)
                            Text("Pick a document or photo to encrypt, sign, and anchor. Your original stays in iCloud, untouched.")
                                .font(.subheadline).foregroundStyle(Brand.inkSoft)
                            Text("Coming in this beta: file & photo protection.").font(.footnote).foregroundStyle(Brand.muted)
                        }
                    }
                }.padding(16)
            }
            .background(Brand.bg.ignoresSafeArea())
            .navigationTitle("Blockle Protect")
        }
    }
    private func stat(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(v).font(.system(size: 24, weight: .bold)).foregroundStyle(Brand.ink)
            Text(l).font(.caption).foregroundStyle(Brand.muted)
        }
    }
}

// MARK: - Vault

struct VaultView: View {
    var body: some View {
        NavigationStack {
            Group {
                if #available(iOS 26.0, *) {
                    VaultContent()
                } else {
                    unsupported
                }
            }
            .background(Brand.bg.ignoresSafeArea())
            .navigationTitle("Vault")
        }
    }
    private var unsupported: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "lock.doc.fill").font(.system(size: 54)).foregroundStyle(Brand.red)
            Text("Your private vault").font(.title2.weight(.bold)).foregroundStyle(Brand.ink)
            Text("Post-quantum file protection uses the newest U.S. cryptography standards, which require iOS 26 or later on this device.")
                .font(.subheadline).foregroundStyle(Brand.inkSoft)
                .multilineTextAlignment(.center).padding(.horizontal, 32)
            Spacer()
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

@available(iOS 26.0, *)
struct VaultContent: View {
    @StateObject private var store = VaultStore()
    @State private var picking = false
    @State private var proofShare: IdentifiableURL?
    @State private var syncing = false
    @State private var syncMsg: String?
    @State private var showPaywall = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Protect a file").font(.headline).foregroundStyle(Brand.ink)
                        Text("Pick a document or photo. It's encrypted and signed on this device with post-quantum cryptography, and a tamper-evident fingerprint is anchored on the Blockle chain. Your original stays where it is, untouched.")
                            .font(.subheadline).foregroundStyle(Brand.inkSoft)
                        Button { picking = true } label: {
                            Label("Choose a file to protect", systemImage: "plus.circle.fill")
                        }.buttonStyle(PrimaryButtonStyle()).disabled(store.busy)
                        if store.busy { HStack(spacing: 8) { ProgressView().tint(Brand.red); Text("Protecting…").font(.footnote).foregroundStyle(Brand.muted) } }
                        if let err = store.lastError {
                            Text(err).font(.footnote).foregroundStyle(Brand.red)
                        }
                    }
                }
                iCloudCard
                if store.items.isEmpty {
                    Text("Protected files appear here.").font(.footnote).foregroundStyle(Brand.muted).padding(.top, 8)
                } else {
                    integrityCard
                    ForEach(store.items) { item in itemRow(item) }
                }
            }.padding(16)
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            Task { await importAndProtect(url) }
        }
        .sheet(item: $proofShare) { ShareSheet(url: $0.url) }
        .sheet(isPresented: $showPaywall) { PaywallView() }
    }

    private var iCloudCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Image(systemName: "icloud.fill").foregroundStyle(Brand.red); Text("iCloud Backup").font(.headline).foregroundStyle(Brand.ink) }
                Text("Back up your encrypted vault to your private iCloud, then restore it on another device with your Recovery Key. Only encrypted files are stored — never plaintext or keys.")
                    .font(.footnote).foregroundStyle(Brand.muted)
                HStack {
                    Button { Task { await doSync(backup: true) } } label: { Label("Back up", systemImage: "arrow.up.to.line") }
                        .buttonStyle(.bordered).tint(Brand.red).disabled(syncing)
                    Button { Task { await doSync(backup: false) } } label: { Label("Restore", systemImage: "arrow.down.to.line") }
                        .buttonStyle(.bordered).tint(Brand.red).disabled(syncing)
                }
                if syncing { HStack(spacing: 8) { ProgressView().tint(Brand.red); Text("Syncing…").font(.footnote).foregroundStyle(Brand.muted) } }
                if let m = syncMsg { Text(m).font(.footnote).foregroundStyle(Brand.inkSoft) }
            }
        }
    }

    private func doSync(backup: Bool) async {
        guard Entitlement.shared.unlocked else { showPaywall = true; return }
        syncing = true; defer { syncing = false }
        let local = store.dir
        do {
            let n = try await Task.detached {
                backup ? try VaultSync.backup(localVault: local) : try VaultSync.restore(localVault: local)
            }.value
            if !backup { store.reload() }
            syncMsg = backup ? "Backed up \(n) file(s) to iCloud." : "Restored \(n) file(s) from iCloud."
        } catch {
            syncMsg = (error as? LocalizedError)?.errorDescription ?? "iCloud isn't available on this device."
        }
    }

    private var integrityCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "checkmark.shield.fill").foregroundStyle(Brand.red)
                    Text("File Integrity Monitor").font(.headline).foregroundStyle(Brand.ink)
                    Spacer()
                    Button { Task { await store.verifyIntegrity() } } label: {
                        Text(store.verifying ? "Checking…" : "Verify now")
                    }.buttonStyle(.bordered).tint(Brand.red).disabled(store.verifying)
                }
                Text("Re-checks that every protected file still matches its signed record and on-chain anchor — so corruption or tampering is caught.")
                    .font(.footnote).foregroundStyle(Brand.muted)
                if let r = store.lastReport {
                    HStack(spacing: 6) {
                        Image(systemName: r.failing == 0 ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(r.failing == 0 ? Brand.ok : Brand.red)
                        Text(r.failing == 0 ? "All \(r.checked) file(s) verified intact" : "\(r.failing) of \(r.checked) file(s) failed verification")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
                    }
                    ForEach(r.results.filter { $0.state != .intact }) { res in
                        Text("• \(res.name): \(res.detail)").font(.footnote).foregroundStyle(Brand.red)
                    }
                }
            }
        }
    }

    private func itemRow(_ item: ProtectedItem) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: "lock.doc.fill").foregroundStyle(Brand.red)
                    Text(item.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.ink).lineLimit(1)
                    Spacer()
                    if item.anchored {
                        Label("Anchored", systemImage: "checkmark.seal.fill").font(.caption2).foregroundStyle(Brand.ok)
                    } else {
                        Label("Encrypted", systemImage: "lock.fill").font(.caption2).foregroundStyle(Brand.muted)
                    }
                }
                Text("\(byteString(item.size)) · SHA-384 \(String(item.fingerprintB64.prefix(12)))…")
                    .font(.caption).foregroundStyle(Brand.muted)
                if let tx = item.txid {
                    Text("anchor tx \(String(tx.prefix(12)))…").font(.caption2.monospaced()).foregroundStyle(Brand.redSoft)
                }
                Button { if let u = store.exportProof(item) { proofShare = IdentifiableURL(url: u) } } label: {
                    Label("Share verification proof", systemImage: "checkmark.seal")
                }.font(.footnote.weight(.medium)).buttonStyle(.bordered).tint(Brand.red)
                Text("Anyone can verify this file's authenticity at protect.blockle.org/verify — no account, no trust in us.")
                    .font(.caption2).foregroundStyle(Brand.muted)
            }
        }
    }

    private func importAndProtect(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { store.lastError = "Couldn't read that file."; return }
        await store.protectFile(name: url.lastPathComponent, plaintext: data, now: Int(Date().timeIntervalSince1970))
    }

    private func byteString(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
}

// MARK: - Shield

struct ShieldView: View {
    var body: some View { NavigationStack { ShieldDetail() } }
}

struct ShieldDetail: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                NavigationLink { SecurityCheckupView() } label: {
                    Card {
                        HStack {
                            Image(systemName: "shield.lefthalf.filled").font(.title2).foregroundStyle(Brand.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Security Checkup").font(.headline).foregroundStyle(Brand.ink)
                                Text("Device posture + account breach scan").font(.subheadline).foregroundStyle(Brand.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(Brand.muted)
                        }
                    }
                }.buttonStyle(.plain)
                NavigationLink { SafariShieldView() } label: {
                    Card {
                        HStack {
                            Image(systemName: "hand.raised.fill").font(.title2).foregroundStyle(Brand.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Family Protection").font(.headline).foregroundStyle(Brand.ink)
                                Text("Block 1.3M+ gambling, scam & adult sites in Safari").font(.subheadline).foregroundStyle(Brand.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(Brand.muted)
                        }
                    }
                }.buttonStyle(.plain)
                NavigationLink { SharingView() } label: {
                    Card {
                        HStack {
                            Image(systemName: "paperplane.fill").font(.title2).foregroundStyle(Brand.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Secure Sharing").font(.headline).foregroundStyle(Brand.ink)
                                Text("Send a file only one person can open (post-quantum)").font(.subheadline).foregroundStyle(Brand.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(Brand.muted)
                        }
                    }
                }.buttonStyle(.plain)
                NavigationLink { FamilyView() } label: {
                    Card {
                        HStack {
                            Image(systemName: "person.3.fill").font(.title2).foregroundStyle(Brand.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Family & Full Plan").font(.headline).foregroundStyle(Brand.ink)
                                Text("One $20 unlock, shared with family or your team").font(.subheadline).foregroundStyle(Brand.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(Brand.muted)
                        }
                    }
                }.buttonStyle(.plain)
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Image(systemName: "icloud.fill").foregroundStyle(Brand.red); Text("iCloud Shield").font(.headline).foregroundStyle(Brand.ink) }
                        Text("Protect selected iCloud files and photos, detect changes, and keep encrypted backups.")
                            .font(.subheadline).foregroundStyle(Brand.inkSoft)
                        Text("Coming in the next beta build.").font(.footnote).foregroundStyle(Brand.muted)
                    }
                }
            }.padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Shield")
    }
}

// MARK: - Activity

struct ActivityView: View {
    @State private var events: [ProtectState.Event] = []
    var body: some View {
        NavigationStack {
            Group {
                if events.isEmpty { empty } else { list }
            }
            .background(Brand.bg.ignoresSafeArea())
            .navigationTitle("Activity")
        }
        .onAppear { events = ProtectState.events }
    }
    private var empty: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "list.bullet.rectangle").font(.system(size: 46)).foregroundStyle(Brand.muted)
            Text("No activity yet").font(.title3.weight(.semibold)).foregroundStyle(Brand.ink)
            Text("Protecting a file, verifying integrity, sharing, and security events will appear here.")
                .font(.subheadline).foregroundStyle(Brand.muted).multilineTextAlignment(.center).padding(.horizontal, 36)
            Spacer()
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var list: some View {
        ScrollView {
            VStack(spacing: 10) {
                ForEach(events) { e in
                    Card {
                        HStack(spacing: 12) {
                            Image(systemName: e.icon).font(.title3)
                                .foregroundStyle(e.icon.contains("triangle") ? Brand.red : Brand.ok)
                                .frame(width: 26)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.ink)
                                Text(e.detail).font(.footnote).foregroundStyle(Brand.inkSoft)
                                Text(e.at.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(Brand.muted)
                            }
                            Spacer()
                        }
                    }
                }
            }.padding(16)
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { AccountView() } label: { label("person.crop.circle", "Account") }
                    NavigationLink { RecoveryKeyView() } label: { label("key.fill", "Recovery key") }
                    NavigationLink { SafariShieldView() } label: { label("lock.shield", "Security & Family Protection") }
                }
                Section {
                    NavigationLink { HowItWorksView() } label: { label("doc.text", "How it works") }
                    Link(destination: URL(string: "https://protect.blockle.org")!) {
                        label("globe", "protect.blockle.org")
                    }
                    HStack { label("info.circle", "Version"); Spacer(); Text("1.0.0 (beta)").foregroundStyle(Brand.muted) }
                }
                Section {
                    Text("Blockle Protect — by Alienbeing LLC. Powered by the Blockle blockchain.")
                        .font(.footnote).foregroundStyle(Brand.muted)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Brand.bg.ignoresSafeArea())
            .navigationTitle("Settings")
        }
    }
    private func row(_ icon: String, _ title: String) -> some View {
        NavigationLink { ComingSoon(title: title) } label: { label(icon, title) }
    }
    private func label(_ icon: String, _ title: String) -> some View {
        Label { Text(title).foregroundStyle(Brand.ink) } icon: { Image(systemName: icon).foregroundStyle(Brand.red) }
    }
}

struct ComingSoon: View {
    let title: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "hammer.fill").font(.system(size: 40)).foregroundStyle(Brand.muted)
            Text(title).font(.title3.weight(.semibold)).foregroundStyle(Brand.ink)
            Text("Available in an upcoming beta build.").foregroundStyle(Brand.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle(title)
    }
}

// MARK: - Onboarding

struct OnboardingView: View {
    var done: () -> Void
    @State private var page = 0
    private let pages: [(String, String, String)] = [
        ("lock.shield.fill", "Protected for the future", "Blockle Protect adds an independent, post-quantum security layer to the files you already keep in the cloud."),
        ("cpu.fill", "Post-quantum, in plain English", "Your files are encrypted and signed on your device with the newest U.S. standards — built to resist quantum computers. We never see them."),
        ("checkmark.seal.fill", "Verifiable by anyone", "A tamper-evident fingerprint of each file is anchored on the Blockle chain, so authenticity can be checked without trusting us.")
    ]
    var body: some View {
        VStack {
            TabView(selection: $page) {
                ForEach(0..<pages.count, id: \.self) { i in
                    VStack(spacing: 18) {
                        Spacer()
                        Image(systemName: pages[i].0).font(.system(size: 64)).foregroundStyle(Brand.red)
                        Text(pages[i].1).font(.title.weight(.bold)).foregroundStyle(Brand.ink)
                            .multilineTextAlignment(.center)
                        Text(pages[i].2).font(.body).foregroundStyle(Brand.inkSoft)
                            .multilineTextAlignment(.center).padding(.horizontal, 32)
                        Spacer()
                    }.tag(i)
                }
            }
            .tabViewStyle(.page)
            Button(page < pages.count - 1 ? "Continue" : "Get started") {
                if page < pages.count - 1 { withAnimation { page += 1 } } else { done() }
            }
            .buttonStyle(PrimaryButtonStyle()).padding(.horizontal, 24).padding(.bottom, 24)
        }
        .background(Brand.bg.ignoresSafeArea())
    }
}
