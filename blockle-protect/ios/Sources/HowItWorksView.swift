import SwiftUI

struct HowItWorksView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                section("lock.shield.fill", "Protection you can verify",
                        "Blockle Protect adds an independent, post-quantum security layer over the files and accounts you already have. Everything that matters happens on your device — we’re not a place your data passes through.")
                section("cpu.fill", "Post-quantum, in plain terms",
                        "Files are encrypted and signed on your device with the newest U.S. standards — ML-KEM-768 (FIPS 203) and ML-DSA-65 (FIPS 204), with AES-256-GCM and SHA-384. These are built to resist both today’s computers and future quantum ones. We use only audited, standard algorithms — never home-grown crypto.")
                section("link", "Anchored on the Blockle chain",
                        "A tamper-evident fingerprint (a Merkle root) of each protected file is recorded on the Blockle blockchain — never the file, never a key. Anyone can later confirm a file’s authenticity at protect.blockle.org/verify without an account and without trusting us.")
                section("eye.slash.fill", "What we never see",
                        "Your file contents, your data-encryption keys, your signing keys, and your recovery key never leave your device in a form we can read. Secure Sharing encrypts to the recipient’s public key; the Safari filters run entirely on-device — no browsing history is sent anywhere.")
                section("key.horizontal.fill", "Recovery is yours alone",
                        "Your recovery key is held only by you. It’s not escrowed on our servers — there is no backdoor. That means if you lose it with no backup, your files can’t be recovered, by design. Save it somewhere safe.")
                section("checkmark.seal.fill", "Honest about limits",
                        "A timestamp proves when a record was made, not who authored the underlying content. A signature proves control of a key, not a real-world identity. An iOS app can’t scan other apps for viruses, so the Security Checkup checks what iOS actually permits — device posture and account breaches.")
                Text("Blockle Protect — by Alienbeing LLC. Powered by the Blockle blockchain.")
                    .font(.footnote).foregroundStyle(Brand.muted).padding(.top, 4)
            }.padding(16)
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("How it works")
    }

    private func section(_ icon: String, _ title: String, _ body: String) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) { Image(systemName: icon).foregroundStyle(Brand.red); Text(title).font(.headline).foregroundStyle(Brand.ink) }
                Text(body).font(.subheadline).foregroundStyle(Brand.inkSoft)
            }
        }
    }
}
