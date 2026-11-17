import Foundation
import CryptoKit
import LocalAuthentication
import UIKit

// Swift port of @blockle-protect/core `checkup` — identical finding model and
// scoring, so the app, web and backend agree. Honest scope: iOS sandboxing means
// this is a device/account HEALTH check, not a whole-device virus scanner.

enum Severity: String { case critical, high, medium, low, ok }

enum FixAction: Equatable {
    case openSettings(String)   // passcode | biometrics | softwareUpdate | advancedDataProtection
    case rotatePassword
    case reprotectFiles
    case updateApp
    case reviewDevice
    case none
}

struct Finding: Identifiable {
    let id: String
    let title: String
    let severity: Severity
    let detail: String
    let why: String
    let nextStep: String
    var fix: FixAction = .none
}

struct Checkup {
    let score: Int
    let grade: String
    let findings: [Finding]
    let summary: String
}

struct PostureSignals {
    var jailbroken: Bool?
    var appTampered: Bool?
    var passcodeSet: Bool?
    var biometricsEnrolled: Bool?
    var osVersion: String?
    var latestOsVersion: String?
    var advancedDataProtection: Bool?
    var protectedFilesFailing: Int?
    var pwnedPasswordHits: Int?
    var recoveryConfigured: Bool?
}

enum CheckupEngine {
    static let penalty: [Severity: Int] = [.critical: 45, .high: 22, .medium: 10, .low: 4, .ok: 0]
    static let rank: [Severity: Int]    = [.critical: 0, .high: 1, .medium: 2, .low: 3, .ok: 4]

    static func compareVersions(_ a: String, _ b: String) -> Int {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let d = (i < pa.count ? pa[i] : 0) - (i < pb.count ? pb[i] : 0)
            if d != 0 { return d < 0 ? -1 : 1 }
        }
        return 0
    }

    static func run(_ s: PostureSignals) -> Checkup {
        var f: [Finding] = []

        if s.jailbroken == true {
            f.append(Finding(id: "jailbreak", title: "Device appears jailbroken", severity: .critical,
                detail: "This device shows signs of a jailbreak or root.",
                why: "Jailbreaking removes the sandbox that keeps your encrypted files and keys isolated from other apps.",
                nextStep: "Back up and restore this device to stock iOS before storing sensitive files.", fix: .reviewDevice))
        }
        if s.appTampered == true {
            f.append(Finding(id: "tamper", title: "App integrity check failed", severity: .critical,
                detail: "Blockle Protect detected its binary may be modified or debugged.",
                why: "A tampered app could leak keys. Sensitive operations are halted when this is detected.",
                nextStep: "Delete and reinstall Blockle Protect from the App Store.", fix: .updateApp))
        }
        if s.passcodeSet == false {
            f.append(Finding(id: "passcode", title: "No device passcode", severity: .high,
                detail: "This device has no passcode set.",
                why: "Without a passcode the Secure Enclave can't protect your keys and anyone with the device can open it.",
                nextStep: "Set a passcode in Settings.", fix: .openSettings("passcode")))
        }
        if let hits = s.pwnedPasswordHits, hits > 0 {
            f.append(Finding(id: "pwned", title: "A password you use was found in data breaches", severity: .high,
                detail: "This password appears in \(hits.formatted()) known breaches.",
                why: "Breached passwords are the #1 way accounts are taken over by automated attacks.",
                nextStep: "Change it everywhere you use it, and never reuse passwords.", fix: .rotatePassword))
        }
        if let os = s.osVersion, let latest = s.latestOsVersion, compareVersions(os, latest) < 0 {
            f.append(Finding(id: "os", title: "Your operating system is out of date", severity: .high,
                detail: "You're on \(os); the latest is \(latest).",
                why: "Most device compromises exploit holes that a software update already fixes.",
                nextStep: "Install the latest update in Settings → General → Software Update.", fix: .openSettings("softwareUpdate")))
        }
        if let fail = s.protectedFilesFailing, fail > 0 {
            f.append(Finding(id: "integrity", title: "\(fail) protected file(s) failed verification", severity: .high,
                detail: "Some protected files no longer match their signed record.",
                why: "A file that changed unexpectedly could be corruption — or tampering.",
                nextStep: "Review the changes; restore the protected copy if the change wasn't yours.", fix: .reprotectFiles))
        }
        if s.biometricsEnrolled == false {
            f.append(Finding(id: "biometrics", title: "Face ID / Touch ID is not set up", severity: .medium,
                detail: "Biometric unlock isn't enrolled on this device.",
                why: "Biometrics let you lock your vault strongly without typing a passcode constantly.",
                nextStep: "Enroll Face ID or Touch ID in Settings.", fix: .openSettings("biometrics")))
        }
        if s.recoveryConfigured == false {
            f.append(Finding(id: "recovery", title: "No recovery method set up", severity: .medium,
                detail: "You haven't set up a recovery key or contact.",
                why: "If you lose this device with no recovery method your files can't be restored — by design, there's no backdoor.",
                nextStep: "Set up your recovery key and store it safely.", fix: .reviewDevice))
        }
        if s.advancedDataProtection == false {
            f.append(Finding(id: "adp", title: "Apple Advanced Data Protection is off", severity: .low,
                detail: "ADP end-to-end-encrypts more of your iCloud data.",
                why: "Your protected files are secure regardless, but ADP strengthens the rest of iCloud.",
                nextStep: "Consider enabling Advanced Data Protection in your Apple ID settings.", fix: .openSettings("advancedDataProtection")))
        }

        var score = 100
        for x in f { score -= (penalty[x.severity] ?? 0) }
        score = max(0, min(100, score))

        if f.isEmpty {
            f.append(Finding(id: "allclear", title: "No issues found", severity: .ok,
                detail: "Your device posture and protected files look healthy.",
                why: "Good security hygiene is the best defense against automated attacks.",
                nextStep: "Keep your OS and app up to date, and run a checkup regularly."))
        }
        f.sort { (rank[$0.severity] ?? 9) < (rank[$1.severity] ?? 9) }
        let grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F"
        let worst = f.first!.severity
        let summary: String
        switch worst {
        case .ok: summary = "All clear — your protection looks healthy."
        case .critical: summary = "Critical issues need your attention now."
        case .high: summary = "A few important things to fix."
        default: summary = "Looking good — minor improvements available."
        }
        return Checkup(score: score, grade: grade, findings: f, summary: summary)
    }
}

// MARK: - Device posture collection (real, Apple-permitted signals only)

enum DevicePosture {
    static func collect() -> PostureSignals {
        var s = PostureSignals()
        s.jailbroken = isJailbroken()
        s.appTampered = false // wired to a binary-integrity check in a later build
        let ctx = LAContext()
        var err: NSError?
        s.passcodeSet = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err)
        s.biometricsEnrolled = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        s.osVersion = UIDevice.current.systemVersion
        return s
    }

    /// Honest heuristic jailbreak detection (no single check is definitive).
    static func isJailbroken() -> Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        let suspicious = ["/Applications/Cydia.app", "/Library/MobileSubstrate/MobileSubstrate.dylib",
                          "/bin/bash", "/usr/sbin/sshd", "/etc/apt", "/private/var/lib/apt/"]
        for p in suspicious where FileManager.default.fileExists(atPath: p) { return true }
        // Can we write outside the sandbox?
        let probe = "/private/jailbreak-probe.txt"
        do {
            try "x".write(toFile: probe, atomically: true, encoding: .utf8)
            try? FileManager.default.removeItem(atPath: probe)
            return true
        } catch { /* expected on a healthy device */ }
        if let url = URL(string: "cydia://package/com.example"), UIApplication.shared.canOpenURL(url) { return true }
        return false
        #endif
    }
}

// MARK: - Privacy-preserving breach check (HaveIBeenPwned k-anonymity)

enum PwnedPasswords {
    /// Returns how many times `password` appears in known breaches. Only the
    /// first 5 hex chars of SHA-1(password) are sent; the password never leaves
    /// the device.
    static func count(_ password: String) async throws -> Int {
        let digest = Insecure.SHA1.hash(data: Data(password.utf8))
        let hex = digest.map { String(format: "%02X", $0) }.joined()
        let prefix = String(hex.prefix(5)), suffix = String(hex.dropFirst(5))
        var req = URLRequest(url: URL(string: "https://api.pwnedpasswords.com/range/\(prefix)")!)
        req.setValue("true", forHTTPHeaderField: "Add-Padding")
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let body = String(data: data, encoding: .utf8) else { return 0 }
        for line in body.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: ":")
            if parts.count == 2, parts[0] == suffix { return Int(parts[1]) ?? 0 }
        }
        return 0
    }
}
