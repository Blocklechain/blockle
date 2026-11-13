//! Package a build directory into a reproducible `.tar.gz` for submission,
//! and compute its SHA-256 so both sides can verify the upload.

use anyhow::{Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct Bundle {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
}

pub fn create(dir: &Path, out: &Path) -> Result<Bundle> {
    let file = std::fs::File::create(out).with_context(|| format!("creating {}", out.display()))?;
    let enc = GzEncoder::new(file, Compression::default());
    let mut tar = tar::Builder::new(enc);
    tar.follow_symlinks(false);
    // Store everything under the game dir name for a clean extract.
    let base = dir.file_name().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("game"));
    tar.append_dir_all(&base, dir)
        .with_context(|| format!("archiving {}", dir.display()))?;
    tar.into_inner()?.finish()?;

    let bytes = std::fs::metadata(out)?.len();
    let sha256 = sha256_file(out)?;
    Ok(Bundle { path: out.to_path_buf(), sha256, bytes })
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let data = std::fs::read(path)?;
    let mut h = Sha256::new();
    h.update(&data);
    Ok(hex::encode(h.finalize()))
}
