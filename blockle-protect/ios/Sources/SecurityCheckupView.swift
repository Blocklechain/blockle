import SwiftUI
import UIKit

@MainActor
final class CheckupModel: ObservableObject {
    @Published var checkup: Checkup?
    @Published var running = false
    @Published var passwordToCheck = ""
    @Published var lastPwnedHits: Int?

    func run() async {
        running = true
        defer { running = false }
        var s = DevicePosture.collect()
        s.latestOsVersion = await Self.fetchLatestOS()
        s.pwnedPasswordHits = lastPwnedHits
        // Values the app will learn from its own state in later builds:
        s.recoveryConfigured = nil
        s.advancedDataProtection = nil
        s.protectedFilesFailing = 0
        checkup = CheckupEngine.run(s)
    }

    func checkPassword() async {
        let pw = passwordToCheck
        guard !pw.isEmpty else { return }
        lastPwnedHits = (try? await PwnedPasswords.count(pw)) ?? nil
        await run()
    }

    static func fetchLatestOS() async -> String? {
        guard let url = URL(string: "https://protect.blockle.org/latest-os.txt") else { return nil }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty else { return nil }
        return s
    }
}

struct SecurityCheckupView: View {
    @StateObject private var model = CheckupModel()
    @State private var showPwField = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let c = model.checkup {
                    scoreCard(c)
                    ForEach(c.findings) { findingRow($0) }
                } else {
                    introCard
                }
                breachCheckCard
                Text("Blockle Protect checks what iOS actually permits — device posture and account breaches. It is a security health check, not a whole-device virus scanner (no iOS app can scan other apps).")
                    .font(.footnote).foregroundStyle(Brand.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
            }
            .padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Security Checkup")
        .task { if model.checkup == nil { await model.run() } }
    }

    private var introCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Running checks…").font(.headline).foregroundStyle(Brand.ink)
                ProgressView().tint(Brand.red)
            }
        }
    }

    private func scoreCard(_ c: Checkup) -> some View {
        Card {
            HStack(spacing: 18) {
                ZStack {
                    Circle().stroke(Brand.line, lineWidth: 10).frame(width: 92, height: 92)
                    Circle().trim(from: 0, to: CGFloat(c.score) / 100)
                        .stroke(gradeColor(c.grade), style: StrokeStyle(lineWidth: 10, lineCap: .round))
                        .rotationEffect(.degrees(-90)).frame(width: 92, height: 92)
                    VStack(spacing: 0) {
                        Text(c.grade).font(.system(size: 30, weight: .bold)).foregroundStyle(Brand.ink)
                        Text("\(c.score)").font(.caption2).foregroundStyle(Brand.muted)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Security score").font(.subheadline).foregroundStyle(Brand.muted)
                    Text(c.summary).font(.headline).foregroundStyle(Brand.ink)
                    Button {
                        Task { await model.run() }
                    } label: { Text(model.running ? "Scanning…" : "Re-scan") }
                        .buttonStyle(.bordered).tint(Brand.red).disabled(model.running)
                }
                Spacer()
            }
        }
    }

    private func findingRow(_ f: Finding) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Image(systemName: icon(f.severity)).foregroundStyle(Brand.severityColor(f.severity))
                    Text(f.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.ink)
                    Spacer()
                }
                Text(f.detail).font(.subheadline).foregroundStyle(Brand.inkSoft)
                Text(f.why).font(.footnote).foregroundStyle(Brand.muted)
                HStack {
                    Text(f.nextStep).font(.footnote.weight(.medium)).foregroundStyle(Brand.redSoft)
                    Spacer()
                    if let label = fixLabel(f.fix) {
                        Button(label) { applyFix(f.fix) }
                            .font(.footnote.weight(.semibold)).buttonStyle(.borderedProminent).tint(Brand.red)
                    }
                }
            }
        }
    }

    private var breachCheckCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Check a password").font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.ink)
                Text("See if a password appears in known breaches. Your password never leaves this device — only a short hash prefix is sent.")
                    .font(.footnote).foregroundStyle(Brand.muted)
                SecureField("Password to check", text: $model.passwordToCheck)
                    .textContentType(.password).autocorrectionDisabled()
                    .padding(10).background(Color.black.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Brand.line))
                Button("Check for breaches") { Task { await model.checkPassword() } }
                    .buttonStyle(PrimaryButtonStyle()).disabled(model.passwordToCheck.isEmpty)
            }
        }
    }

    private func icon(_ s: Severity) -> String {
        switch s {
        case .critical: return "exclamationmark.octagon.fill"
        case .high: return "exclamationmark.triangle.fill"
        case .medium: return "exclamationmark.circle.fill"
        case .low: return "info.circle.fill"
        case .ok: return "checkmark.seal.fill"
        }
    }
    private func gradeColor(_ g: String) -> Color { g == "A" || g == "B" ? Brand.ok : (g == "C" ? Brand.warn : Brand.red) }
    private func fixLabel(_ f: FixAction) -> String? {
        switch f {
        case .openSettings: return "Open Settings"
        case .rotatePassword: return "How to fix"
        case .updateApp: return "Reinstall"
        case .reprotectFiles: return "Review"
        case .reviewDevice: return "Learn more"
        case .none: return nil
        }
    }
    private func applyFix(_ f: FixAction) {
        if case .openSettings = f, let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
