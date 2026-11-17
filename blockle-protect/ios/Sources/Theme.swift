import SwiftUI

/// Blockle Protect visual identity — deep charcoal, signal red, clean white.
enum Brand {
    static let red       = Color(hex: 0xFF3B4E)
    static let redDeep   = Color(hex: 0xE42A3B)
    static let redSoft   = Color(hex: 0xFF7E8B)
    static let bg        = Color(hex: 0x0A0A0E)
    static let bg2       = Color(hex: 0x120D12)
    static let panel     = Color(hex: 0x17121B)
    static let panel2    = Color(hex: 0x1F1722)
    static let line      = Color(hex: 0x352330)
    static let ink       = Color(hex: 0xFBEEF1)
    static let inkSoft   = Color(hex: 0xD8C7CF)
    static let muted     = Color(hex: 0xA5939E)
    static let ok        = Color(hex: 0x43D9A3)
    static let warn      = Color(hex: 0xFFC452)

    /// Severity → color for Security Checkup findings.
    static func severityColor(_ s: Severity) -> Color {
        switch s {
        case .critical, .high: return red
        case .medium:          return warn
        case .low:             return redSoft
        case .ok:              return ok
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue:  Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}

/// Reusable card container matching the web design.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(colors: [Brand.panel, Brand.bg2], startPoint: .top, endPoint: .bottom)
            )
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Brand.line, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

/// Primary red button style.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.vertical, 13).padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
            .background(LinearGradient(colors: [Brand.red, Brand.redDeep], startPoint: .top, endPoint: .bottom))
            .clipShape(RoundedRectangle(cornerRadius: 13))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}
