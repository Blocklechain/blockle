//! Automated pre-review checks.
//!
//! These run locally (`blockle-game check`) and again server-side on submission,
//! *before* a human looks at the game — so most of review is done by the time a
//! build reaches a person. Three passes: completeness, size/format, and a
//! heuristic malicious-code scan.
//!
//! The scan is a signal, not a verdict: a few unambiguous patterns hard-fail,
//! most are warnings a human reviewer confirms. It is deliberately conservative
//! — better a false warning than a silent miss.

use crate::manifest::Manifest;
use std::fmt;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Pass,
    Warn,
    Fail,
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Level::Pass => write!(f, "PASS"),
            Level::Warn => write!(f, "WARN"),
            Level::Fail => write!(f, "FAIL"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub level: Level,
    pub code: String,
    pub message: String,
    /// Optional file + line the finding points at.
    pub location: Option<String>,
}

impl Finding {
    fn new(level: Level, code: &str, message: impl Into<String>) -> Finding {
        Finding {
            level,
            code: code.into(),
            message: message.into(),
            location: None,
        }
    }
    fn at(mut self, loc: impl Into<String>) -> Finding {
        self.location = Some(loc.into());
        self
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub findings: Vec<Finding>,
    pub files_scanned: usize,
    pub total_bytes: u64,
}

impl Report {
    pub fn fails(&self) -> usize {
        self.findings.iter().filter(|f| f.level == Level::Fail).count()
    }
    pub fn warns(&self) -> usize {
        self.findings.iter().filter(|f| f.level == Level::Warn).count()
    }
    fn push(&mut self, f: Finding) {
        self.findings.push(f);
    }
}

// Size caps.
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB hard cap
const WARN_TOTAL_BYTES: u64 = 400 * 1024 * 1024; // 400 MiB -> suggest blockle hosting tier
const MAX_ICON_BYTES: u64 = 4 * 1024 * 1024;
const WARN_SINGLE_TEXT_SCAN_BYTES: u64 = 8 * 1024 * 1024; // skip scanning huge blobs line-by-line

/// Hard-fail patterns: unambiguous remote-code-exec / drainer shapes. Kept short
/// and specific on purpose; everything fuzzier is a warning below.
const HARD_PATTERNS: &[(&str, &str)] = &[
    // fetch/download a remote script and eval/exec it
    ("eval(atob(", "executes base64-decoded code at runtime (packed payload)"),
    ("Function(atob(", "builds a function from base64-decoded code (packed payload)"),
    ("eval(await fetch", "downloads and executes remote code at runtime"),
    ("curl", "shells out to curl — "), // refined below (only when combined w/ exec)
];

/// Warn patterns: legitimate in some games, dangerous in others — a human
/// confirms. (pattern, why)
const WARN_PATTERNS: &[(&str, &str)] = &[
    ("child_process", "spawns OS processes (Node child_process)"),
    ("Runtime.getRuntime().exec", "executes OS commands (Java)"),
    ("Process.Start", "starts an OS process (.NET)"),
    ("System.Diagnostics.Process", "process control (.NET)"),
    ("os.system(", "executes a shell command (Python)"),
    ("subprocess.", "spawns a subprocess (Python)"),
    ("WScript.Shell", "Windows shell scripting"),
    ("powershell", "invokes PowerShell"),
    ("reg add", "writes to the Windows registry"),
    ("eval(", "runtime code evaluation"),
    ("new Function(", "runtime code generation"),
    ("document.write(", "injects markup at runtime"),
    ("innerHTML", "sets raw HTML (XSS surface)"),
    ("XMLHttpRequest", "makes network requests"),
    ("navigator.clipboard.readText", "reads the user's clipboard"),
];

/// Wallet-exfiltration signal: reading secret material. Flagged WARN; becomes a
/// stronger signal when a file both reads secrets AND posts to the network.
const SECRET_TOKENS: &[&str] = &[
    "privateKey",
    "private_key",
    "mnemonic",
    "seedPhrase",
    "seed_phrase",
    "secretKey",
    "secret_key",
    "keystore",
];

const NETWORK_TOKENS: &[&str] = &["fetch(", "XMLHttpRequest", "http://", "https://", "WebSocket("];

fn is_probably_text(bytes: &[u8]) -> bool {
    // NUL byte => binary.
    !bytes.iter().take(8192).any(|&b| b == 0)
}

fn is_source_ext(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("js" | "mjs" | "cjs" | "ts" | "jsx" | "tsx" | "html" | "htm" | "cs" | "py"
            | "java" | "kt" | "lua" | "sh" | "bat" | "ps1" | "cmd" | "json" | "wat")
    )
}

/// Run every pass against a build directory.
pub fn run(dir: &Path, m: &Manifest) -> Report {
    let mut r = Report::default();
    completeness(dir, m, &mut r);
    size_and_scan(dir, &mut r);
    r
}

fn completeness(dir: &Path, m: &Manifest, r: &mut Report) {
    // Manifest basics.
    if m.game.name.trim().is_empty() {
        r.push(Finding::new(Level::Fail, "meta.name", "game.name is empty"));
    }
    if m.game.version.trim().is_empty() {
        r.push(Finding::new(Level::Fail, "meta.version", "game.version is empty"));
    }
    if m.game.description.trim().is_empty() {
        r.push(Finding::new(Level::Warn, "meta.description", "game.description is empty — players see this in the hub"));
    }
    if m.game.platform.is_empty() {
        r.push(Finding::new(Level::Fail, "meta.platform", "game.platform is empty — list desktop, mobile and/or web"));
    } else {
        for p in &m.game.platform {
            if !matches!(p.as_str(), "desktop" | "mobile" | "web") {
                r.push(Finding::new(Level::Fail, "meta.platform", format!("unknown platform \"{p}\" (use desktop, mobile, web)")));
            }
        }
    }

    // Entry point.
    if m.game.entry.trim().is_empty() {
        r.push(Finding::new(Level::Fail, "entry.missing", "game.entry is empty — name your entry file"));
    } else if !dir.join(&m.game.entry).exists() {
        r.push(Finding::new(Level::Fail, "entry.notfound", format!("entry \"{}\" not found in the build dir", m.game.entry)));
    }

    // Icon.
    if m.game.icon.trim().is_empty() {
        r.push(Finding::new(Level::Warn, "icon.missing", "no icon set — the hub will use a placeholder"));
    } else {
        let icon = dir.join(&m.game.icon);
        if !icon.exists() {
            r.push(Finding::new(Level::Fail, "icon.notfound", format!("icon \"{}\" not found", m.game.icon)));
        } else if let Ok(md) = std::fs::metadata(&icon) {
            if md.len() > MAX_ICON_BYTES {
                r.push(Finding::new(Level::Warn, "icon.large", "icon is over 4 MB — consider a smaller 512x512 image"));
            }
        }
    }

    // Hosting.
    if m.host_is_blockle() {
        r.push(Finding::new(Level::Pass, "hosting.blockle", "Blockle will host this build (one-time hosting fee + bandwidth tier applies)"));
    } else {
        let url = m.hosting.download_url.trim();
        if url.is_empty() {
            r.push(Finding::new(Level::Fail, "hosting.url", "host = \"dev\" but hosting.download_url is empty — provide the download/store link, or set host = \"blockle\""));
        } else if !url.starts_with("https://") {
            r.push(Finding::new(Level::Fail, "hosting.insecure", "hosting.download_url must be https"));
        }
    }

    // Pricing + payout.
    if m.pricing.paid {
        if m.pricing.price_block <= 0.0 {
            r.push(Finding::new(Level::Fail, "price.zero", "paid = true but price_block is 0 — set a BLOCK price"));
        }
    }
    let addr = m.developer.payout_address.trim();
    if addr.is_empty() || addr == "block1..." {
        let lvl = if m.pricing.paid { Level::Fail } else { Level::Warn };
        r.push(Finding::new(lvl, "payout.missing", "developer.payout_address is not set — your 90% share is paid here"));
    } else if !addr.starts_with("block1") {
        r.push(Finding::new(Level::Warn, "payout.format", "developer.payout_address does not look like a Blockle address (block1…)"));
    }
    if m.developer.name.trim().is_empty() {
        r.push(Finding::new(Level::Warn, "dev.name", "developer.name is empty"));
    }
}

fn size_and_scan(dir: &Path, r: &mut Report) {
    for entry in WalkDir::new(dir).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        r.total_bytes += md.len();

        if !is_source_ext(path) {
            continue;
        }
        if md.len() > WARN_SINGLE_TEXT_SCAN_BYTES {
            r.push(
                Finding::new(Level::Warn, "scan.huge", "source file over 8 MB — skipped line scan; may be minified/packed")
                    .at(rel(dir, path)),
            );
            continue;
        }
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if !is_probably_text(&bytes) {
            continue;
        }
        r.files_scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        scan_text(dir, path, &text, r);
    }

    if r.total_bytes > MAX_TOTAL_BYTES {
        r.push(Finding::new(Level::Fail, "size.hardcap", format!("build is {} — over the 2 GiB cap", human(r.total_bytes))));
    } else if r.total_bytes > WARN_TOTAL_BYTES {
        r.push(Finding::new(Level::Warn, "size.large", format!("build is {} — large; Blockle hosting uses a higher bandwidth tier", human(r.total_bytes))));
    }
}

fn scan_text(dir: &Path, path: &Path, text: &str, r: &mut Report) {
    let loc = rel(dir, path);
    let lower = text.to_lowercase();

    // Hard-fail shapes (exec-remote-code). "curl" only counts when paired w/ a
    // process-exec token in the same file (otherwise it's a false positive on docs).
    for (pat, why) in HARD_PATTERNS {
        if *pat == "curl" {
            if lower.contains("curl") && (lower.contains("| sh") || lower.contains("|sh") || lower.contains("| bash")) {
                r.push(Finding::new(Level::Fail, "exec.curlpipe", "downloads a script and pipes it to a shell").at(&loc));
            }
            continue;
        }
        if text.contains(pat) {
            r.push(Finding::new(Level::Fail, "exec.remote", format!("{why} (`{pat}`)")).at(line_of(text, pat, &loc)));
        }
    }

    // Warn shapes.
    for (pat, why) in WARN_PATTERNS {
        if text.contains(pat) {
            r.push(Finding::new(Level::Warn, "review", format!("{why} (`{pat}`)")).at(line_of(text, pat, &loc)));
        }
    }

    // Wallet-secret exfiltration: reading secrets, stronger if the same file
    // also makes network calls.
    let reads_secret = SECRET_TOKENS.iter().find(|t| text.contains(**t));
    if let Some(tok) = reads_secret {
        let networks = NETWORK_TOKENS.iter().any(|t| text.contains(t));
        if networks {
            r.push(
                Finding::new(Level::Fail, "exfil.secret", format!("references secret material (`{tok}`) AND makes network calls in the same file — possible key exfiltration"))
                    .at(&loc),
            );
        } else {
            r.push(
                Finding::new(Level::Warn, "secret.ref", format!("references secret material (`{tok}`) — Blockle games never need the player's keys; signing is done by the wallet"))
                    .at(&loc),
            );
        }
    }
}

fn rel(dir: &Path, path: &Path) -> String {
    path.strip_prefix(dir).unwrap_or(path).to_string_lossy().into_owned()
}

fn line_of(text: &str, pat: &str, loc: &str) -> String {
    for (i, line) in text.lines().enumerate() {
        if line.contains(pat) {
            return format!("{loc}:{}", i + 1);
        }
    }
    loc.to_string()
}

fn human(bytes: u64) -> String {
    const U: &[&str] = &["B", "KiB", "MiB", "GiB"];
    let mut b = bytes as f64;
    let mut i = 0;
    while b >= 1024.0 && i < U.len() - 1 {
        b /= 1024.0;
        i += 1;
    }
    format!("{b:.1} {}", U[i])
}
