import Foundation

// Canonical JSON — byte-for-byte identical to packages/core/src/encoding.ts
// `canonicalJson`: object keys sorted lexicographically (by UTF-16 code unit,
// like JS), no insignificant whitespace, and string escaping identical to
// JavaScript's JSON.stringify (escape " \ and control chars; DO NOT escape "/"
// or non-ASCII). This is what makes an ML-DSA-65 manifest signature verify
// across iOS, the browser and the backend.

indirect enum JSONValue {
    case string(String)
    case int(Int)
    case bool(Bool)
    case object([(String, JSONValue)]) // insertion order irrelevant — we sort
    case array([JSONValue])
    case null
}

enum CanonicalJSON {
    static func string(_ v: JSONValue) -> String {
        switch v {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return String(i)
        case .string(let s): return encodeString(s)
        case .array(let a): return "[" + a.map(string).joined(separator: ",") + "]"
        case .object(let pairs):
            // sort by key using UTF-16 code-unit comparison to match JS String sort
            let sorted = pairs.sorted { lhsRhsLess($0.0, $1.0) }
            return "{" + sorted.map { encodeString($0.0) + ":" + string($0.1) }.joined(separator: ",") + "}"
        }
    }

    static func bytes(_ v: JSONValue) -> Data {
        Data(string(v).utf8)
    }

    /// JS String comparison is by UTF-16 code unit; Object.keys().sort() uses it.
    private static func lhsRhsLess(_ a: String, _ b: String) -> Bool {
        let ua = Array(a.utf16), ub = Array(b.utf16)
        var i = 0
        while i < ua.count && i < ub.count {
            if ua[i] != ub[i] { return ua[i] < ub[i] }
            i += 1
        }
        return ua.count < ub.count
    }

    /// Match JSON.stringify string escaping exactly.
    private static func encodeString(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar) // "/" and non-ASCII pass through literally
                }
            }
        }
        out += "\""
        return out
    }
}
