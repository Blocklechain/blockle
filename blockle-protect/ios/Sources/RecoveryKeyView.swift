import SwiftUI
import UIKit

struct RecoveryKeyView: View {
    var body: some View {
        Group {
            if #available(iOS 26.0, *) { RecoveryKeyContent() }
            else { Text("Recovery keys require iOS 26.").font(.subheadline).foregroundStyle(Brand.muted).padding() }
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Recovery Key")
    }
}

@available(iOS 26.0, *)
struct RecoveryKeyContent: View {
    @State private var revealed = false
    @State private var code = ""
    @State private var restoreMode = false
    @State private var restoreInput = ""
    @State private var message: String?
    @State private var confirmRestore = false
    @State private var saved = ProtectState.recoveryConfigured

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Image(systemName: "key.horizontal.fill").foregroundStyle(Brand.red); Text("Your recovery key").font(.headline).foregroundStyle(Brand.ink) }
                        Text("This key is the ONLY way to restore your protected files if you lose this device. Save it somewhere safe — a password manager is ideal. Blockle never sees it and cannot recover it for you; that's what keeps it yours.")
                            .font(.subheadline).foregroundStyle(Brand.inkSoft)
                        if revealed {
                            Text(code).font(.system(.footnote, design: .monospaced)).foregroundStyle(Brand.ink)
                                .textSelection(.enabled)
                                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.black.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 10))
                            HStack {
                                Button { UIPasteboard.general.string = code } label: { Label("Copy", systemImage: "doc.on.doc") }
                                    .buttonStyle(.bordered).tint(Brand.red)
                                ShareLink(item: code) { Label("Save…", systemImage: "square.and.arrow.up") }.tint(Brand.red)
                            }
                            Button("I've saved it safely") { ProtectState.recoveryConfigured = true; saved = true }
                                .buttonStyle(PrimaryButtonStyle())
                        } else {
                            Button("Reveal my recovery key") { do { code = try RecoveryKey.current(); revealed = true } catch { message = "Couldn't read the key." } }
                                .buttonStyle(PrimaryButtonStyle())
                        }
                        if saved { Label("Recovery key saved", systemImage: "checkmark.seal.fill").font(.footnote).foregroundStyle(Brand.ok) }
                    }
                }

                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Restore from a recovery key").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
                        Text("On a new device, paste your recovery key to restore your identity and reopen your protected files.")
                            .font(.footnote).foregroundStyle(Brand.muted)
                        if restoreMode {
                            TextEditor(text: $restoreInput).frame(height: 90)
                                .font(.system(.footnote, design: .monospaced)).scrollContentBackground(.hidden)
                                .padding(8).background(Color.black.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Brand.line))
                            Button("Restore") { confirmRestore = true }.buttonStyle(.borderedProminent).tint(Brand.red)
                                .disabled(restoreInput.isEmpty)
                        } else {
                            Button("I have a recovery key to restore") { restoreMode = true }.buttonStyle(.bordered).tint(Brand.red)
                        }
                    }
                }
                if let m = message { Text(m).font(.footnote).foregroundStyle(message!.contains("restored") ? Brand.ok : Brand.red) }
            }.padding(16)
        }
        .alert("Replace this device's identity?", isPresented: $confirmRestore) {
            Button("Cancel", role: .cancel) {}
            Button("Restore", role: .destructive) {
                do { try RecoveryKey.restore(fromCode: restoreInput)
                    message = "Identity restored. Your protected and shared files will open again."
                    ProtectState.recoveryConfigured = true; saved = true; restoreMode = false
                } catch { message = (error as? LocalizedError)?.errorDescription ?? "That recovery key isn't valid." }
            }
        } message: {
            Text("This replaces the identity currently on this device. Files protected only to the current identity (and not to this recovery key) will no longer open. Continue only if this is your own recovery key.")
        }
    }
}
