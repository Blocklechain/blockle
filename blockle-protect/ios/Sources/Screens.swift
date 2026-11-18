import SwiftUI

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
                                stat("0", "Protected")
                                stat("0", "Verified")
                                stat("—", "Last backup")
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
                if store.items.isEmpty {
                    Text("Protected files appear here.").font(.footnote).foregroundStyle(Brand.muted).padding(.top, 8)
                } else {
                    ForEach(store.items) { item in itemRow(item) }
                }
            }.padding(16)
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            Task { await importAndProtect(url) }
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
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "list.bullet.rectangle").font(.system(size: 46)).foregroundStyle(Brand.muted)
                Text("No activity yet").font(.title3.weight(.semibold)).foregroundStyle(Brand.ink)
                Text("Protection events, integrity checks and blockchain anchors will appear here.")
                    .font(.subheadline).foregroundStyle(Brand.muted)
                    .multilineTextAlignment(.center).padding(.horizontal, 36)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Brand.bg.ignoresSafeArea())
            .navigationTitle("Activity")
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    row("person.crop.circle", "Account")
                    row("key.fill", "Recovery key")
                    row("lock.shield", "Security")
                }
                Section {
                    row("doc.text", "How it works")
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
