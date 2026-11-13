//! `blockle.toml` — the game submission manifest.
//!
//! Lives at the root of a game's build/source directory and describes the game,
//! how it's hosted, how it's priced, and where the developer's 90% is paid.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MANIFEST_NAME: &str = "blockle.toml";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub game: Game,
    #[serde(default)]
    pub hosting: Hosting,
    #[serde(default)]
    pub pricing: Pricing,
    pub developer: Developer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Game {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// Chain the game integrates with (blockle, ethereum, solana, bnb, …).
    #[serde(default = "default_chain")]
    pub chain: String,
    /// One or more of: desktop, mobile, web.
    #[serde(default)]
    pub platform: Vec<String>,
    /// Entry point relative to the build dir — index.html (web), or the
    /// executable / app package for desktop/mobile.
    #[serde(default)]
    pub entry: String,
    /// Store icon relative to the build dir (png/jpg/webp).
    #[serde(default)]
    pub icon: String,
}

fn default_chain() -> String {
    "blockle".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hosting {
    /// "dev" (you provide a download URL — free) or "blockle" (we host your
    /// build for a one-time hosting fee + bandwidth tier).
    #[serde(default = "default_host")]
    pub host: String,
    /// Required when host = "dev": https URL to the downloadable build / store
    /// listing. Ignored when host = "blockle".
    #[serde(default)]
    pub download_url: String,
}

fn default_host() -> String {
    "dev".into()
}

impl Default for Hosting {
    fn default() -> Self {
        Hosting {
            host: default_host(),
            download_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Pricing {
    /// Free game (just opens) vs. paid (bought with crypto, you keep 90%).
    #[serde(default)]
    pub paid: bool,
    /// Price in whole BLOCK when paid. Priced in BLOCK only.
    #[serde(default)]
    pub price_block: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Developer {
    pub name: String,
    /// Where your 90% share is paid — a Blockle address (block1…).
    pub payout_address: String,
    #[serde(default)]
    pub contact: String,
}

impl Manifest {
    pub fn load(dir: &Path) -> Result<Manifest> {
        let path = dir.join(MANIFEST_NAME);
        if !path.exists() {
            bail!(
                "no {} found in {} — run `blockle-game init` first",
                MANIFEST_NAME,
                dir.display()
            );
        }
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let m: Manifest = toml::from_str(&text)
            .with_context(|| format!("parsing {} (check the TOML syntax)", path.display()))?;
        Ok(m)
    }

    pub fn host_is_blockle(&self) -> bool {
        self.hosting.host.eq_ignore_ascii_case("blockle")
    }
}

/// Starter manifest written by `blockle-game init`.
pub fn template() -> String {
    r#"# Blockle Game Hub submission manifest.
# Docs: https://blockle.org/games/submit

[game]
name = "My Blockle Game"
version = "0.1.0"
description = "A short one-line description players will see in the hub."
# Chain your game integrates with: blockle, ethereum, solana, bnb, polygon, tron, ton, bitcoin, …
chain = "blockle"
# Desktop PC store — ship native builds for Windows / macOS / Linux
platform = ["desktop"]
# Entry executable relative to this build dir (the .exe / .app / .x86_64 that launches the game)
entry = "MyGame.exe"
# Store icon relative to this build dir (png/jpg/webp, ideally 512x512)
icon = "icon.png"

[hosting]
# "dev"     -> you host the download; submission stays free
# "blockle" -> we host your build (one-time hosting fee + bandwidth tier)
host = "dev"
# Required when host = "dev": https link to the downloadable build or store listing
download_url = ""

[pricing]
# false = free game; true = bought with crypto (you keep 90% of every purchase)
paid = false
# Price in BLOCK when paid (BLOCK only)
price_block = 0

[developer]
name = "Your name or studio"
# Your 90% revenue share is paid to this Blockle address
payout_address = "block1..."
contact = "you@example.com or Discord handle"
"#
    .into()
}
