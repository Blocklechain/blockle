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
// WHY THIS WRITES A BREADCRUMB
//
// If the shared file cannot be read, this falls back to a bundled no-op list so
// Safari always receives something compilable. That fallback is INVISIBLE: the
// app shows the user's sites, the extension reports as enabled, reload reports
// success, and nothing is blocked. Debugging it from the app side is impossible
// because there is no API to ask Safari what rules it compiled.
//
// So every run records what it actually served into the same App Group. The app
// reads that and shows it. The breadcrumb is diagnostic only — nothing depends
// on it — and its ABSENCE is itself the most useful signal: if the extension
// cannot reach the container it cannot write the breadcrumb either, which
// distinguishes "App Group is broken" from "list is empty" from "extension was
// never run by Safari".
private let appGroup = "group.org.blockle.protect"
private let listName = "custom-blockerList.json"
private let breadcrumbName = "custom-blocker-last-run.json"

final class CustomBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = NSExtensionItem()
        let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)

        var served = "empty"
        var bytes = 0
        var detail = ""

        if let container {
            let shared = container.appendingPathComponent(listName)
            if FileManager.default.fileExists(atPath: shared.path) {
                if let provider = NSItemProvider(contentsOf: shared) {
                    item.attachments = [provider]
                    served = "shared"
                    bytes = (try? Data(contentsOf: shared).count) ?? 0
                } else {
                    detail = "NSItemProvider refused the shared list"
                }
            } else {
                detail = "no \(listName) in the App Group yet"
            }
        } else {
            detail = "App Group \(appGroup) unavailable to the extension"
        }

        // Fall back to the bundled no-op so Safari always gets a valid list.
        if item.attachments?.isEmpty ?? true {
            if let url = Bundle.main.url(forResource: "empty", withExtension: "json"),
               let provider = NSItemProvider(contentsOf: url) {
                item.attachments = [provider]
            } else if detail.isEmpty {
                detail = "bundled empty.json is missing too"
            }
        }

        writeBreadcrumb(container: container, served: served, bytes: bytes, detail: detail)
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }

    private func writeBreadcrumb(container: URL?, served: String, bytes: Int, detail: String) {
        guard let container else { return }   // nothing we can do; absence is the signal
        let payload: [String: Any] = [
            "served": served,          // "shared" = the user's list, "empty" = the no-op
            "bytes": bytes,
            "detail": detail,
            "at": Date().timeIntervalSince1970,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: container.appendingPathComponent(breadcrumbName), options: .atomic)
    }
}
