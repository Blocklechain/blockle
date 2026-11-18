import SwiftUI
import StoreKit
import UIKit

/// Reusable upsell shown when a locked feature is tapped without the unlock.
struct PaywallView: View {
    @StateObject private var store = FamilyStore()
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Image(systemName: "checkmark.seal.fill").font(.system(size: 54)).foregroundStyle(Brand.red)
                Text("Unlock Blockle Protect").font(.title2.weight(.bold)).foregroundStyle(Brand.ink)
                Text("One payment of \(store.priceText), once — no subscription. Unlocks everything, and you can share it with your whole family (Apple Family Sharing) or your team (invite code).")
                    .font(.subheadline).foregroundStyle(Brand.inkSoft).multilineTextAlignment(.center).padding(.horizontal, 20)
                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        perk("Unlimited Vault + iCloud backup")
                        perk("Secure Sharing (send files only one person can open)")
                        perk("Family / team plan with head-of-household alerts")
                        perk("Portable verification proofs + full adult filters")
                        perk("Unlimited Blockle Intelligence")
                        Text("Always free: the gambling & scam blocker, Security Checkup, Commitment Lock and Recovery Key — protection is never paywalled.")
                            .font(.footnote).foregroundStyle(Brand.muted).padding(.top, 4)
                    }
                }
                Button { Task { await store.buy(); if store.owned { dismiss() } } } label: {
                    Text(store.busy ? "Processing…" : "Unlock everything — \(store.priceText)")
                }.buttonStyle(PrimaryButtonStyle()).disabled(store.busy)
                Button("Restore purchase") { Task { try? await AppStore.sync(); await Entitlement.shared.refresh(); if Entitlement.shared.unlocked { dismiss() } } }
                    .font(.footnote).tint(Brand.redSoft)
                if let m = store.message { Text(m).font(.footnote).foregroundStyle(Brand.muted) }
            }.padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .task { await store.load() }
    }
    private func perk(_ t: String) -> some View {
        HStack(spacing: 8) { Image(systemName: "checkmark.circle.fill").foregroundStyle(Brand.ok); Text(t).font(.subheadline).foregroundStyle(Brand.inkSoft); Spacer() }
    }
}

struct FamilyView: View {
    @StateObject private var store = FamilyStore()
    @StateObject private var hh = HouseholdModel()
    @ObservedObject private var ent = Entitlement.shared

    @State private var hoHEmail = ""
    @State private var hoHAlias = ""
    @State private var joinCode = ""
    @State private var memberAlias = ""
    @State private var msg: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                unlockCard
                if ent.unlocked { headCard }
                joinCard
                if let m = msg { Text(m).font(.footnote).foregroundStyle(Brand.muted) }
            }.padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Family & Full Plan")
        .task { await store.load(); await ent.refresh() }
    }

    private var unlockCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Image(systemName: ent.unlocked ? "checkmark.seal.fill" : "lock.fill").foregroundStyle(ent.unlocked ? Brand.ok : Brand.red)
                    Text(ent.unlocked ? "Full version unlocked" : "Unlock everything").font(.headline).foregroundStyle(Brand.ink) }
                if ent.unlocked {
                    Text("Thanks for supporting Blockle Protect. Every feature is unlocked. Share it with family or your team below — no extra cost.")
                        .font(.subheadline).foregroundStyle(Brand.inkSoft)
                } else {
                    Text("One \(store.priceText) payment unlocks the full app forever — shareable with your family and your team. No subscription.")
                        .font(.subheadline).foregroundStyle(Brand.inkSoft)
                    Button { Task { await store.buy(); await ent.refresh() } } label: {
                        Text(store.busy ? "Processing…" : "Unlock everything — \(store.priceText)")
                    }.buttonStyle(PrimaryButtonStyle()).disabled(store.busy)
                    Button("Restore purchase") { Task { try? await AppStore.sync(); await ent.refresh() } }.font(.footnote).tint(Brand.redSoft)
                    if let m = store.message { Text(m).font(.footnote).foregroundStyle(Brand.muted) }
                }
            }
        }
    }

    // Head-of-household: create a family/team and share the invite code/link.
    private var headCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your family / team").font(.headline).foregroundStyle(Brand.ink)
                if let h = hh.household, h.role == .head, let code = h.code {
                    Text("Invite code").font(.caption).foregroundStyle(Brand.muted)
                    Text(code).font(.system(size: 26, weight: .bold, design: .monospaced)).foregroundStyle(Brand.red).textSelection(.enabled)
                    if let link = h.joinUrl {
                        ShareLink(item: URL(string: link)!) { Label("Share invite link", systemImage: "square.and.arrow.up") }.font(.subheadline.weight(.semibold)).tint(Brand.red)
                    }
                    Text("Family or teammates install Blockle Protect and enter this code under “Join a household”. You’ll be emailed if any of them turns a gambling or adult block off — once you confirm the email we sent you.")
                        .font(.footnote).foregroundStyle(Brand.muted)
                } else if hh.household?.role == .member {
                    Text("You’re part of \(hh.household?.hoHAlias ?? "a") plan. The head of household is alerted if you turn a block off.")
                        .font(.subheadline).foregroundStyle(Brand.inkSoft)
                    Button("Leave this household") { hh.leave() }.font(.footnote).tint(Brand.redSoft)
                } else {
                    Text("Create a family/team: you’ll get an invite code to share, and an email alert if anyone turns their block off.")
                        .font(.footnote).foregroundStyle(Brand.muted)
                    field("Your email (head of household)", text: $hoHEmail)
                    field("Family or team name", text: $hoHAlias)
                    Button("Create & get invite code") {
                        Task { msg = await hh.create(email: hoHEmail, alias: hoHAlias.isEmpty ? "our household" : hoHAlias) ? nil : "Couldn’t create — check the email and try again." }
                    }.buttonStyle(.borderedProminent).tint(Brand.red).disabled(!hoHEmail.contains("@"))
                }
            }
        }
    }

    private var joinCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Join a household").font(.headline).foregroundStyle(Brand.ink)
                Text("Have an invite code from a family member or your organization? Joining unlocks the full app for you too — free.")
                    .font(.footnote).foregroundStyle(Brand.muted)
                if hh.household?.role == .member {
                    Label("Joined \(hh.household?.hoHAlias ?? "a household")", systemImage: "checkmark.circle.fill").font(.subheadline).foregroundStyle(Brand.ok)
                } else {
                    field("Invite code", text: $joinCode)
                    field("Your name", text: $memberAlias)
                    Button("Join") {
                        Task { msg = await hh.join(code: joinCode, alias: memberAlias.isEmpty ? "A family member" : memberAlias) ? nil : "That code isn’t valid." }
                    }.buttonStyle(.bordered).tint(Brand.red).disabled(joinCode.count < 4)
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in hh.checkAndAlert() }
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text).autocorrectionDisabled().textInputAutocapitalization(.never)
            .padding(10).background(Color.black.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Brand.line))
    }
}
