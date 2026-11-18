import SwiftUI
import StoreKit

// $5 optional donation — a StoreKit 2 consumable. Works once a consumable IAP
// with product id `org.blockle.protect.donation5` (price ~$5) exists in App
// Store Connect and the Paid Apps agreement is active. Until then, the button
// honestly shows "unavailable" rather than faking a purchase.
@MainActor
final class DonationStore: ObservableObject {
    static let productID = "org.blockle.protect.donation5"
    @Published var product: Product?
    @Published var busy = false
    @Published var message: String?

    func load() async {
        product = try? await Product.products(for: [Self.productID]).first
    }

    func donate() async {
        guard let product else { message = "Donations aren’t set up yet — check back soon."; return }
        busy = true; defer { busy = false }
        do {
            switch try await product.purchase() {
            case .success(let verification):
                if case .verified(let txn) = verification {
                    await txn.finish()
                    message = "Thank you for supporting Blockle Protect 💛"
                } else {
                    message = "Couldn’t verify that purchase."
                }
            case .userCancelled:
                message = nil
            case .pending:
                message = "Your donation is pending approval."
            @unknown default:
                message = nil
            }
        } catch {
            message = "The purchase didn’t go through."
        }
    }
}

struct AccountView: View {
    @StateObject private var donation = DonationStore()

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                identityCard
                statusCard
                donationCard
                Card {
                    Text("Blockle Protect has no username or password and no server account — your identity is a set of keys held only on your device. “Account” here means that on-device identity.")
                        .font(.footnote).foregroundStyle(Brand.muted).frame(maxWidth: .infinity, alignment: .leading)
                }
            }.padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Account")
        .task { await donation.load() }
    }

    private var identityCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Image(systemName: "person.crop.circle.badge.checkmark").foregroundStyle(Brand.red); Text("Your identity").font(.headline).foregroundStyle(Brand.ink) }
                if #available(iOS 26.0, *), let id = try? VaultIdentity.loadOrCreate() {
                    Text("Protect ID").font(.caption).foregroundStyle(Brand.muted)
                    Text(id.recipientId).font(.system(.footnote, design: .monospaced)).foregroundStyle(Brand.ink).textSelection(.enabled)
                    NavigationLink { SharingView() } label: { Label("Share my Protect ID", systemImage: "square.and.arrow.up") }
                        .font(.subheadline.weight(.semibold)).tint(Brand.red)
                } else {
                    Text("Your post-quantum identity is created on first use and stored only in this device’s Keychain.")
                        .font(.subheadline).foregroundStyle(Brand.inkSoft)
                }
            }
        }
    }

    private var statusCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                statusRow("key.horizontal.fill", "Recovery key", ProtectState.recoveryConfigured ? "Saved" : "Not set up", ProtectState.recoveryConfigured)
                NavigationLink { RecoveryKeyView() } label: { Text(ProtectState.recoveryConfigured ? "Manage recovery key" : "Set up recovery key").font(.footnote.weight(.medium)) }.tint(Brand.red)
                Divider().overlay(Brand.line)
                statusRow("icloud.fill", "iCloud backup", VaultSync.isAvailable ? "Available" : "Sign in to iCloud", VaultSync.isAvailable)
            }
        }
    }

    private func statusRow(_ icon: String, _ title: String, _ value: String, _ ok: Bool) -> some View {
        HStack {
            Image(systemName: icon).foregroundStyle(Brand.red).frame(width: 24)
            Text(title).font(.subheadline).foregroundStyle(Brand.ink)
            Spacer()
            Text(value).font(.footnote.weight(.semibold)).foregroundStyle(ok ? Brand.ok : Brand.muted)
        }
    }

    private var donationCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Image(systemName: "heart.fill").foregroundStyle(Brand.red); Text("Support Blockle Protect").font(.headline).foregroundStyle(Brand.ink) }
                Text("Blockle Protect is independent and keeps your data on your device. If it’s useful to you, an optional one-time donation helps keep it going. Completely optional — every feature works without it.")
                    .font(.subheadline).foregroundStyle(Brand.inkSoft)
                Button {
                    Task { await donation.donate() }
                } label: {
                    Text(donation.busy ? "Processing…" : "Donate \(donation.product?.displayPrice ?? "$5")")
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(donation.busy)
                if let m = donation.message {
                    Text(m).font(.footnote).foregroundStyle(m.contains("Thank") ? Brand.ok : Brand.muted)
                }
            }
        }
    }
}
