//! `blockle-game` — the Blockle Game Hub developer CLI.
//!
//!   blockle-game init           scaffold a blockle.toml
//!   blockle-game check <dir>    run the automated pre-review checks locally
//!   blockle-game submit <dir>   check, package, and submit to the hub
//!
//! The same checks run server-side before human review, so a clean `check` means
//! most of review is already done when you submit. Submitting is free; developers
//! keep 90% of every paid-game purchase. If you ask Blockle to host your build
//! (host = "blockle"), a one-time hosting fee + bandwidth tier applies.

mod bundle;
mod checks;
mod manifest;

use anyhow::{bail, Context, Result};
use checks::{Level, Report};
use clap::{Parser, Subcommand};
use manifest::Manifest;
use std::path::{Path, PathBuf};

const DEFAULT_ENDPOINT: &str = "https://blockle.org";

#[derive(Parser)]
#[command(
    name = "blockle-game",
    version,
    about = "Submit crypto games to the Blockle Game Hub (desktop & mobile)."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Scaffold a blockle.toml submission manifest.
    Init {
        /// Directory to write blockle.toml into (default: current dir).
        #[arg(default_value = ".")]
        dir: PathBuf,
    },
    /// Run the automated pre-review checks on a build directory.
    Check {
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// Treat warnings as failures (useful in CI).
        #[arg(long)]
        strict: bool,
    },
    /// Check, package, and submit a build directory to the Blockle Game Hub.
    Submit {
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// Build the bundle and run checks but do not upload.
        #[arg(long)]
        dry_run: bool,
        /// Override the hub API base (or set BLOCKLE_GAMES_API).
        #[arg(long)]
        endpoint: Option<String>,
    },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("\x1b[31merror:\x1b[0m {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Init { dir } => cmd_init(&dir),
        Cmd::Check { dir, strict } => cmd_check(&dir, strict).map(|_| ()),
        Cmd::Submit { dir, dry_run, endpoint } => cmd_submit(&dir, dry_run, endpoint),
    }
}

fn cmd_init(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).ok();
    let path = dir.join(manifest::MANIFEST_NAME);
    if path.exists() {
        bail!("{} already exists — not overwriting", path.display());
    }
    std::fs::write(&path, manifest::template())
        .with_context(|| format!("writing {}", path.display()))?;
    println!("Created {}", path.display());
    println!("Edit it, then run `blockle-game check {}`.", dir.display());
    Ok(())
}

/// Returns the report so `submit` can reuse it.
fn cmd_check(dir: &Path, strict: bool) -> Result<Report> {
    if !dir.is_dir() {
        bail!("{} is not a directory", dir.display());
    }
    let m = Manifest::load(dir)?;
    let report = checks::run(dir, &m);
    print_report(&m, &report);

    if report.fails() > 0 {
        bail!("{} check(s) failed — fix them before submitting", report.fails());
    }
    if strict && report.warns() > 0 {
        bail!("{} warning(s) with --strict", report.warns());
    }
    Ok(report)
}

fn cmd_submit(dir: &Path, dry_run: bool, endpoint: Option<String>) -> Result<()> {
    // 1. Gate on checks.
    let m = Manifest::load(dir)?;
    let report = cmd_check(dir, false)?;
    let _ = report; // already printed; fails already aborted

    // 2. Package (we always build the bundle; for dev-hosted it's a verifiable
    //    archive of what you submitted, for blockle-hosted it's what we serve).
    let out = dir.join(format!(
        "{}-{}.blocklegame.tar.gz",
        slug(&m.game.name),
        m.game.version
    ));
    let b = bundle::create(dir, &out)?;
    println!("\nPackaged {} ({}, sha256 {}…)", out.display(), human(b.bytes), &b.sha256[..16]);

    let base = endpoint
        .or_else(|| std::env::var("BLOCKLE_GAMES_API").ok())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());

    if dry_run {
        println!("\n--dry-run: not uploading. Bundle is ready at {}", out.display());
        return Ok(());
    }

    if m.host_is_blockle() {
        println!("\nHosting: Blockle (a one-time hosting fee + bandwidth tier applies; you'll be invoiced after review).");
    } else {
        println!("\nHosting: self-hosted at {} (free).", m.hosting.download_url);
    }

    upload(&base, &m, &b)
}

fn upload(base: &str, m: &Manifest, b: &bundle::Bundle) -> Result<()> {
    let url = format!("{}/account/api/games/submit", base.trim_end_matches('/'));
    let meta = serde_json::json!({
        "manifest": m,
        "sha256": b.sha256,
        "bytes": b.bytes,
        "hosted_by_blockle": m.host_is_blockle(),
    });

    // Dev-hosted: register the listing (JSON only). Blockle-hosted: send the
    // bundle bytes with the manifest in a header.
    let resp = if m.host_is_blockle() {
        let body = std::fs::read(&b.path)?;
        ureq::post(&url)
            .set("content-type", "application/gzip")
            .set("x-blockle-game", &serde_json::to_string(&meta)?)
            .send_bytes(&body)
    } else {
        ureq::post(&url)
            .set("content-type", "application/json")
            .send_string(&serde_json::to_string(&meta)?)
    };

    match resp {
        Ok(r) => {
            let txt = r.into_string().unwrap_or_default();
            println!("\n\x1b[32mSubmitted.\x1b[0m {txt}");
            println!("We'll review on top of the automated checks and follow up on Discord.");
            Ok(())
        }
        Err(ureq::Error::Status(code, r)) => {
            let txt = r.into_string().unwrap_or_default();
            if code == 404 {
                println!(
                    "\n\x1b[33mThe hub submission endpoint isn't open yet.\x1b[0m Your bundle is ready at:\n  {}\nApply on Discord (https://discord.gg/tx4MfyD9Vu) and attach it — the automated checks above have already passed.",
                    b.path.display()
                );
                Ok(())
            } else {
                bail!("submission rejected ({code}): {txt}")
            }
        }
        Err(e) => {
            println!(
                "\n\x1b[33mCouldn't reach the hub ({e}).\x1b[0m Your bundle is ready at:\n  {}\nApply on Discord (https://discord.gg/tx4MfyD9Vu) and attach it.",
                b.path.display()
            );
            Ok(())
        }
    }
}

fn print_report(m: &Manifest, r: &Report) {
    println!("\nBlockle Game Hub — pre-review checks");
    println!("  game:     {} v{}", m.game.name, m.game.version);
    println!("  chain:    {}", m.game.chain);
    println!("  platform: {}", m.game.platform.join(", "));
    println!(
        "  pricing:  {}",
        if m.pricing.paid { format!("{} BLOCK (you keep 90%)", m.pricing.price_block) } else { "free".into() }
    );
    println!("  scanned:  {} source files, {} total\n", r.files_scanned, human(r.total_bytes));

    if r.findings.is_empty() {
        println!("  {} no findings", tick(Level::Pass));
    }
    // Fails first, then warns, then passes.
    let mut findings = r.findings.clone();
    findings.sort_by(|a, b| b.level.cmp(&a.level));
    for f in &findings {
        let loc = f.location.as_deref().map(|l| format!(" ({l})")).unwrap_or_default();
        println!("  {} [{}] {}{}", tick(f.level), f.code, f.message, loc);
    }

    println!();
    if r.fails() > 0 {
        println!("  \x1b[31m{} fail\x1b[0m, {} warn", r.fails(), r.warns());
    } else if r.warns() > 0 {
        println!("  \x1b[33m0 fail, {} warn\x1b[0m — a human will confirm the warnings", r.warns());
    } else {
        println!("  \x1b[32mall checks passed\x1b[0m");
    }
}

fn tick(l: Level) -> &'static str {
    match l {
        Level::Pass => "\x1b[32m✓\x1b[0m",
        Level::Warn => "\x1b[33m!\x1b[0m",
        Level::Fail => "\x1b[31m✗\x1b[0m",
    }
}

fn slug(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let mut t = out.trim_matches('-').to_string();
    while t.contains("--") {
        t = t.replace("--", "-");
    }
    if t.is_empty() { "game".into() } else { t }
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
