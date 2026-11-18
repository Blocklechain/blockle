import SwiftUI
import UIKit

struct SharingView: View {
    var body: some View {
        Group {
            if #available(iOS 26.0, *) { SharingContent() }
            else { Text("Secure sharing requires iOS 26.").font(.subheadline).foregroundStyle(Brand.muted).padding() }
        }
        .background(Brand.bg.ignoresSafeArea())
        .navigationTitle("Secure Sharing")
    }
}

@available(iOS 26.0, *)
struct SharingContent: View {
    @StateObject private var model = SharingModel()
    @State private var addingCard = ""
    @State private var selectedContact: ProtectContact?
    @State private var picking = false
    @State private var bundleURL: URL?
    @State private var openedName: String?
    @State private var openingBundle = false
    @State private var showPaywall = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                myIDCard
                contactsCard
                sendCard
                openCard
                Text("Files are encrypted on this device to the recipient's post-quantum key and travel as a self-contained .bprotect file. Nothing is uploaded to us.")
                    .font(.footnote).foregroundStyle(Brand.muted).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(16)
        }
        .sheet(isPresented: $showPaywall) { PaywallView() }
    }

    private var myIDCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Image(systemName: "person.crop.circle.badge.checkmark").foregroundStyle(Brand.red); Text("My Protect ID").font(.headline).foregroundStyle(Brand.ink) }
                Text("Share this with people who want to send you protected files. It contains only your public keys — never anything secret.")
                    .font(.footnote).foregroundStyle(Brand.muted)
                HStack {
                    TextField("Your name", text: Binding(get: { model.displayName }, set: { model.displayName = $0 }))
                        .padding(10).background(Color.black.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Brand.line))
                }
                if !model.myCardString.isEmpty {
                    ShareLink(item: model.myCardString) { Label("Share my Protect ID", systemImage: "square.and.arrow.up") }
                        .font(.subheadline.weight(.semibold)).tint(Brand.red)
                }
            }
        }
    }

    private var contactsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Contacts").font(.headline).foregroundStyle(Brand.ink)
                HStack {
                    TextField("Paste someone's Protect ID", text: $addingCard)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .padding(10).background(Color.black.opacity(0.3)).clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Brand.line))
                    Button("Add") { model.addContact(fromCard: addingCard); addingCard = "" }
                        .buttonStyle(.bordered).tint(Brand.red).disabled(addingCard.isEmpty)
                }
                if let e = model.error { Text(e).font(.footnote).foregroundStyle(Brand.red) }
                ForEach(model.contacts) { c in
                    HStack {
                        Image(systemName: "person.fill").foregroundStyle(Brand.redSoft)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(c.name).font(.subheadline).foregroundStyle(Brand.ink)
                            Text(c.id).font(.caption2.monospaced()).foregroundStyle(Brand.muted)
                        }
                        Spacer()
                        if selectedContact?.id == c.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(Brand.ok) }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { selectedContact = (selectedContact?.id == c.id) ? nil : c }
                }
                if model.contacts.isEmpty { Text("No contacts yet — add someone's Protect ID above.").font(.footnote).foregroundStyle(Brand.muted) }
            }
        }
    }

    private var sendCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Send a file securely").font(.headline).foregroundStyle(Brand.ink)
                Text(selectedContact.map { "To: \($0.name)" } ?? "Tap a contact above to choose a recipient.")
                    .font(.subheadline).foregroundStyle(selectedContact == nil ? Brand.muted : Brand.inkSoft)
                Button { if Entitlement.shared.unlocked { picking = true } else { showPaywall = true } } label: { Label("Choose a file to encrypt & send", systemImage: "lock.rectangle.stack.fill") }
                    .buttonStyle(PrimaryButtonStyle()).disabled(selectedContact == nil)
                if let url = bundleURL {
                    ShareLink(item: url) { Label("Share encrypted file", systemImage: "square.and.arrow.up") }
                        .font(.subheadline.weight(.semibold)).tint(Brand.red)
                }
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: false) { res in
            guard case let .success(urls) = res, let url = urls.first, let c = selectedContact else { return }
            Task { await encryptForSend(url, to: c) }
        }
    }

    private var openCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Open a file sent to me").font(.headline).foregroundStyle(Brand.ink)
                Button { openingBundle = true } label: { Label("Open a .bprotect file", systemImage: "lock.open.fill") }
                    .buttonStyle(.bordered).tint(Brand.red)
                if let n = openedName { Text("Decrypted “\(n)” — saved and ready to share.").font(.footnote).foregroundStyle(Brand.ok) }
            }
        }
        .fileImporter(isPresented: $openingBundle, allowedContentTypes: [.item, .json], allowsMultipleSelection: false) { res in
            guard case let .success(urls) = res, let url = urls.first else { return }
            Task { await openReceived(url) }
        }
    }

    private func encryptForSend(_ url: URL, to c: ProtectContact) async {
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { model.error = "Couldn't read that file."; return }
        do {
            let bundle = try model.makeBundle(name: url.lastPathComponent, plaintext: data, to: c, now: Int(Date().timeIntervalSince1970))
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("\(url.lastPathComponent).bprotect")
            try bundle.write(to: out, options: .atomic)
            bundleURL = out; model.error = nil
        } catch { model.error = (error as? LocalizedError)?.errorDescription ?? "Encryption failed." }
    }

    private func openReceived(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { model.error = "Couldn't read that file."; return }
        do {
            let (name, pt) = try model.openBundle(data)
            let out = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try pt.write(to: out, options: .atomic)
            openedName = name; model.error = nil
        } catch { model.error = (error as? LocalizedError)?.errorDescription ?? "Couldn't open — this file may not be shared with you." }
    }
}
