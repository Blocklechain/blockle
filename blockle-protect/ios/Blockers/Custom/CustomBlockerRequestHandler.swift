import Foundation
import MobileCoreServices
import UniformTypeIdentifiers

// Dynamic content-blocker for the user's OWN blocklist ("My List").
//
// Unlike the static category blockers (which bundle a fixed blockerList.json),
// this one reads a packed Safari rule list the app writes into the shared App
// Group container — `custom-blockerList.json`. The app (or a family head)
// updates it whenever a site is added/removed and calls
// SFContentBlockerManager.reloadContentBlocker, so Safari re-compiles the list.
//
// If the shared file is missing or unreadable we fall back to a bundled no-op
// list (`empty.json`) so Safari always receives a valid, compilable rule set.
private let appGroup = "group.org.blockle.protect"

final class CustomBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = NSExtensionItem()
        if let shared = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("custom-blockerList.json"),
           FileManager.default.fileExists(atPath: shared.path),
           let provider = NSItemProvider(contentsOf: shared) {
            item.attachments = [provider]
        } else if let url = Bundle.main.url(forResource: "empty", withExtension: "json"),
                  let provider = NSItemProvider(contentsOf: url) {
            item.attachments = [provider]
        }
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }
}
