import Foundation

// Recovery Key — the user's SELF-HELD backup of their Blockle Protect identity.
//
// Honest-by-design (per the threat model): recovery is NOT a server-held
// backdoor. The recovery key simply encodes the 96-byte identity seed that
// lives in this device's Keychain. Whoever holds it can reconstruct the
// identity — and therefore open this user's protected files — on another
// device. We never see it; losing it with no copy means the files can't be
// recovered, by design.
//
// Encoding: Crockford Base32 (no ambiguous characters: no I/L/O/U), grouped in
// blocks of 5 for readability. 96 bytes → ~154 chars. Case-insensitive on input.
enum RecoveryKey {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    private static let decodeMap: [Character: UInt8] = {
        var m: [Character: UInt8] = [:]
        for (i, c) in alphabet.enumerated() { m[c] = UInt8(i) }
        // forgiving aliases for look-alikes (Crockford)
        m["I"] = 1; m["L"] = 1; m["O"] = 0
        return m
    }()

    @available(iOS 26.0, macOS 26.0, *)
    static func current() throws -> String { encode(try VaultIdentity.exportSeed()) }

    @available(iOS 26.0, macOS 26.0, *)
    static func restore(fromCode code: String) throws {
        guard let seed = decode(code) else { throw ProtectError.encoding("recovery key is not valid") }
        try VaultIdentity.restore(seed: seed)
    }

    /// base32-encode then group into blocks of 5 with spaces.
    static func encode(_ data: Data) -> String {
        var bits = 0, value = 0, out = ""
        for byte in data {
            value = (value << 8) | Int(byte); bits += 8
            while bits >= 5 { out.append(alphabet[(value >> (bits - 5)) & 31]); bits -= 5 }
        }
        if bits > 0 { out.append(alphabet[(value << (5 - bits)) & 31]) }
        // group in 5s
        var grouped = ""
        for (i, c) in out.enumerated() { if i > 0 && i % 5 == 0 { grouped.append(" ") }; grouped.append(c) }
        return grouped
    }

    static func decode(_ code: String) -> Data? {
        let clean = code.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        var bits = 0, value = 0
        var bytes = [UInt8]()
        for ch in clean {
            guard let v = decodeMap[ch] else { return nil }
            value = (value << 5) | Int(v); bits += 5
            if bits >= 8 { bytes.append(UInt8((value >> (bits - 8)) & 0xff)); bits -= 8 }
        }
        let d = Data(bytes)
        return d.count == 96 ? d : nil   // identity seed is exactly 96 bytes
    }
}
