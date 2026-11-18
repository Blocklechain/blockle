import SwiftUI
import UIKit

struct CommitmentLockView: View {
    @StateObject private var model = CommitmentLockModel()
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if model.isActive { activeSection } else { setupSection }
                screenTimeGuide
                helpline
            }.padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Commitment Lock")
        .task { model.checkTamper() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in model.checkTamper() }
    }

    // MARK: setup

    @State private var days = 30
    @State private var openEnded = false
    @State private var partnerName = ""
    @State private var partnerContact = ""
    @State private var holder: KeyHolder = .partner
    @State private var generatedKey: String?

    private var setupSection: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("Make a commitment").font(.headline).foregroundStyle(Brand.ink)
                Text("Lock yourself into keeping the gambling block on. Blockle can't physically stop you from turning it off in Settings — no app can — but it makes doing so visible, slow, and accountable.")
                    .font(.subheadline).foregroundStyle(Brand.inkSoft)

                Toggle(isOn: $openEnded) { Text("Open-ended (until I formally ask to stop)").foregroundStyle(Brand.ink) }
                    .tint(Brand.red)
                if !openEnded {
                    Stepper("Commit for \(days) day\(days == 1 ? "" : "s")", value: $days, in: 1...365)
                        .foregroundStyle(Brand.ink)
                }

                Text("Accountability partner (optional)").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
                field("Name", text: $partnerName)
                field("Their email or phone", text: $partnerContact)

                Text("Who holds the early-exit key?").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
                Picker("", selection: $holder) {
                    Text("My partner").tag(KeyHolder.partner)
                    Text("Throw it away").tag(KeyHolder.discarded)
                    Text("Me").tag(KeyHolder.me)
                }.pickerStyle(.segmented)
                Text(holderExplanation).font(.footnote).foregroundStyle(Brand.muted)

                Button("Start my commitment") {
                    let end = openEnded ? nil : Calendar.current.date(byAdding: .day, value: days, to: Date())
                    generatedKey = model.start(endsAt: end,
                        partnerName: partnerName.isEmpty ? nil : partnerName,
                        partnerContact: partnerContact.isEmpty ? nil : partnerContact,
                        keyHolder: holder, cooldownHours: 24)
                    if generatedKey == nil { model.checkTamper() }
                }.buttonStyle(PrimaryButtonStyle())
            }
        }
        .alert("Share this key with \(partnerName.isEmpty ? "your partner" : partnerName)", isPresented: Binding(get: { generatedKey != nil && holder == .partner }, set: { if !$0 { generatedKey = nil } })) {
            Button("Copy") { UIPasteboard.general.string = generatedKey; generatedKey = nil }
            Button("Done", role: .cancel) { generatedKey = nil }
        } message: {
            Text("\(generatedKey ?? "")\n\nThis is the ONLY time it's shown. Blockle stored only a hash — we can't recover it. Without it (and a 24-hour wait) you can't end this commitment early.")
        }
    }

    private var holderExplanation: String {
        switch holder {
        case .partner: return "A one-time key is shown now to share with your partner. You'll need it (plus a 24-hour wait) to end early — so you can't relapse alone."
        case .discarded: return "No early-exit key exists. You can only stop when your commitment period ends. The strongest option."
        case .me: return "You hold the key. Weakest option — still adds a 24-hour cooldown, but you can end alone."
        }
    }

    // MARK: active

    @State private var enteredKey = ""
    @State private var unlockMsg: String?

    private var activeSection: some View {
        let c = model.commitment!
        return VStack(spacing: 14) {
            Card {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: model.filterEnabled ? "lock.shield.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(model.filterEnabled ? Brand.ok : Brand.red)
                        Text(model.filterEnabled ? "Commitment active" : "Block is OFF — you committed to keep it on")
                            .font(.headline).foregroundStyle(Brand.ink)
                    }
                    if let end = c.endsAt {
                        Text("Until \(end.formatted(date: .abbreviated, time: .omitted))").font(.subheadline).foregroundStyle(Brand.inkSoft)
                    } else {
                        Text("Open-ended commitment").font(.subheadline).foregroundStyle(Brand.inkSoft)
                    }
                    if let p = c.partnerName { Text("Accountability partner: \(p)").font(.footnote).foregroundStyle(Brand.muted) }
                    if c.tamperCount > 0 {
                        Text("⚠︎ Block turned off \(c.tamperCount) time\(c.tamperCount == 1 ? "" : "s")" + (c.lastTamperAt.map { ", last \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "") + (c.partnerContact.map { " — tell \(c.partnerName ?? "your partner") (\($0))" } ?? ""))
                            .font(.footnote).foregroundStyle(Brand.warn)
                    }
                    if !model.filterEnabled {
                        Button("Re-enable in Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                            .buttonStyle(.borderedProminent).tint(Brand.red)
                    }
                }
            }
            endCard(c)
        }
    }

    private func endCard(_ c: Commitment) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("End this commitment").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
                if model.hasExpired {
                    Button("End (commitment period reached)") { _ = model.attemptEnd(enteredKey: nil); unlockMsg = nil }
                        .buttonStyle(PrimaryButtonStyle())
                } else if c.keyHolder == .discarded {
                    Text("You chose to throw away the key. This commitment can only end when its period is up — by design, there's no early exit. Reach out for support instead.")
                        .font(.footnote).foregroundStyle(Brand.muted)
                } else {
                    if let eligible = model.unlockEligibleAt {
                        if Date() < eligible {
                            Text("Cooldown active. You can end early after \(eligible.formatted(date: .abbreviated, time: .shortened)).")
                                .font(.footnote).foregroundStyle(Brand.muted)
                        } else {
                            SecureField("Enter the early-exit key", text: $enteredKey)
                                .padding(10).background(Color.black.opacity(0.3))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Brand.line))
                            Button("Confirm end") { handleEnd(c) }.buttonStyle(PrimaryButtonStyle())
                        }
                    } else {
                        Text("Ending early requires a 24-hour cooldown. This is intentional — it gives the urge time to pass.")
                            .font(.footnote).foregroundStyle(Brand.muted)
                        Button("Request to end (starts 24h cooldown)") { model.requestEarlyUnlock() }
                            .buttonStyle(.bordered).tint(Brand.red)
                    }
                }
                if let m = unlockMsg { Text(m).font(.footnote).foregroundStyle(Brand.red) }
            }
        }
    }

    private func handleEnd(_ c: Commitment) {
        switch model.attemptEnd(enteredKey: enteredKey) {
        case .ended: unlockMsg = nil
        case .wrongKey: unlockMsg = "That key doesn't match. Ask your partner for the correct one."
        case .needKey: unlockMsg = "Enter the key your partner holds."
        case .cooldown(let d): unlockMsg = "Still in cooldown until \(d.formatted(date: .abbreviated, time: .shortened))."
        case .discardedNoEarlyExit: unlockMsg = "No early exit — the key was discarded."
        }
    }

    // MARK: guidance

    private var screenTimeGuide: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Image(systemName: "hourglass").foregroundStyle(Brand.red); Text("Make it truly un-removable").font(.headline).foregroundStyle(Brand.ink) }
                Text("For a lock you genuinely can't undo alone, use iOS Screen Time with a passcode someone you trust sets (and you don't know):")
                    .font(.subheadline).foregroundStyle(Brand.inkSoft)
                Text("Settings → Screen Time → turn on, set a passcode (have your partner enter it) → Content & Privacy Restrictions → Content Restrictions → Web Content → Limit Adult Websites, and add gambling sites under “Never Allow”.")
                    .font(.footnote).foregroundStyle(Brand.muted)
                Text("Because the Screen Time passcode is held by someone else, you can't turn it off in a weak moment.")
                    .font(.footnote).foregroundStyle(Brand.inkSoft)
            }
        }
    }

    private var helpline: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                HStack { Image(systemName: "heart.fill").foregroundStyle(Brand.red); Text("Need support now?").font(.headline).foregroundStyle(Brand.ink) }
                Text("US National Problem Gambling Helpline — call or text 1-800-522-4700, 24/7, free and confidential.")
                    .font(.subheadline).foregroundStyle(Brand.inkSoft)
                Link("Call 1-800-522-4700", destination: URL(string: "tel:18005224700")!).font(.subheadline.weight(.semibold)).tint(Brand.red)
                Link("More help — ncpgambling.org/help", destination: URL(string: "https://www.ncpgambling.org/help-treatment/")!).font(.footnote).tint(Brand.redSoft)
                Text("Outside the US, search for your national gambling helpline.").font(.footnote).foregroundStyle(Brand.muted)
            }
        }
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text).autocorrectionDisabled().textInputAutocapitalization(.never)
            .padding(10).background(Color.black.opacity(0.3))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Brand.line))
    }
}
