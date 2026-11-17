import Foundation

// Blockle Intelligence — the in-app security advisor. It sends the device's
// posture signals + the user's question to the hardened, injection-proof
// assistant service (https://protect.blockle.org/api/assistant/ask), which runs
// the self-hosted Blockle LLM. The service is advisory only: every actionable
// suggestion is a gated FixAction looked up from the deterministic Checkup
// server-side, so a compromised model can never fabricate an action here.

struct AssistantSuggestion: Decodable, Identifiable {
    let findingId: String
    let title: String
    let fix: FixAction
    var id: String { findingId }

    private enum Keys: String, CodingKey { case findingId, title, fix }
    private enum FixKeys: String, CodingKey { case kind, target }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        findingId = try c.decode(String.self, forKey: .findingId)
        title = try c.decode(String.self, forKey: .title)
        let fc = try c.nestedContainer(keyedBy: FixKeys.self, forKey: .fix)
        switch try fc.decode(String.self, forKey: .kind) {
        case "openSettings": fix = .openSettings((try? fc.decode(String.self, forKey: .target)) ?? "")
        case "rotatePassword": fix = .rotatePassword
        case "reprotectFiles": fix = .reprotectFiles
        case "updateApp": fix = .updateApp
        case "reviewDevice": fix = .reviewDevice
        default: fix = FixAction.none
        }
    }
}

struct AssistantResponse: Decodable {
    let answer: String
    let suggestions: [AssistantSuggestion]
    let injectionSuspected: Bool
    let score: Int
    let grade: String
}

enum BlockleIntelligence {
    static let endpoint = URL(string: "https://protect.blockle.org/api/assistant/ask")!

    /// Ask the hardened assistant. `untrusted` carries attacker-influenceable
    /// strings (e.g. protected file names) so the model can reason about them
    /// without ever treating them as instructions.
    static func ask(question: String, signals: PostureSignals,
                    untrusted: [(label: String, text: String)] = []) async throws -> AssistantResponse {
        struct Untrusted: Encodable { let label: String; let text: String }
        struct Body: Encodable {
            let question: String
            let signals: PostureSignals
            let untrusted: [Untrusted]
        }
        let body = Body(question: question, signals: signals,
                        untrusted: untrusted.map { Untrusted(label: $0.label, text: $0.text) })
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        req.timeoutInterval = 60
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(AssistantResponse.self, from: data)
    }
}

@MainActor
final class AssistantModel: ObservableObject {
    @Published var question = ""
    @Published var answer: String?
    @Published var suggestions: [AssistantSuggestion] = []
    @Published var injectionSuspected = false
    @Published var asking = false
    @Published var errorText: String?

    func ask(signals: PostureSignals) async {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        asking = true; errorText = nil
        defer { asking = false }
        do {
            let r = try await BlockleIntelligence.ask(question: q, signals: signals)
            answer = r.answer
            suggestions = r.suggestions
            injectionSuspected = r.injectionSuspected
        } catch {
            errorText = "Couldn't reach Blockle Intelligence. Your scan results above are still accurate."
        }
    }
}
