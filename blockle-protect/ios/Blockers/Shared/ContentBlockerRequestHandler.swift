import Foundation
import MobileCoreServices
import UniformTypeIdentifiers

// Shared request handler for all Blockle Protect Safari content-blocker
// extensions. Each extension bundles its own `blockerList.json` (a packed
// Safari rule list — many domains per rule via `if-domain`, so we stay well
// under the per-extension rule cap). The handler just hands that list to Safari.
//
// The lists are produced from large open blocklists (gambling / scam / adult)
// and fetched into each extension at build time; see the CI "Fetch blocklists"
// step. Static by design: no App Group, no shared state — simplest + most
// robust signing, and each extension compiles independently so one oversized
// category can never break the others.
final class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = NSExtensionItem()
        if let url = Bundle.main.url(forResource: "blockerList", withExtension: "json"),
           let provider = NSItemProvider(contentsOf: url) {
            item.attachments = [provider]
        }
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }
}
