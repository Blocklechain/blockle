//! Generate the Alienbeing LLC clawback authority: a 2-of-2 ML-DSA-44 pair.
//!
//! Run ON the box, copy the two secrets OFF, then wipe. The secrets are written
//! to **tmpfs** (`/dev/shm` by default), so they never touch the SSD and there
//! are no wear-levelled remnants to worry about after removal.
//!
//! # Why 2-of-2 and not "2FA"
//!
//! A TOTP code cannot be checked by consensus: the nodes share no secret with
//! an authenticator app, the code is time-dependent (nodes validate historical
//! blocks years later), and it is replayable by anyone who sees it once. The
//! faithful translation of two-factor into something every node can verify is
//! **two independent signatures**, both required. Keep the two secrets in
//! different places and a single compromise authorises nothing.
//!
//! # What goes into consensus
//!
//! Only the two 32-byte ADDRESSES (the hash of each public key). A clawback
//! transaction carries the public keys and signatures; consensus recomputes
//! `pubkey_to_address(pk)` and compares. That is exactly how an ordinary input
//! is authorised on this chain, so the rule reuses machinery that is already
//! load-bearing rather than inventing a second scheme.
//!
//! An ML-DSA-44 public key is 1312 bytes; committing to the 32-byte address
//! instead keeps the hardcoded constants reviewable by a human.
//!
//! # This tool never prints a secret
//!
//! Secrets go to files, readable only by the owner. Only public material is
//! printed. That is deliberate: anything on stdout can end up in a terminal
//! scrollback, an SSH session log, or a support transcript.

// UNIX ONLY, AND IT REFUSES RATHER THAN DEGRADES.
//
// This tool's safety rests on two things the Unix filesystem gives it: a 0600
// secret file and a 0700 directory on tmpfs. Windows has neither API
// (`PermissionsExt` does not exist there), and the obvious fix — compile the
// permission calls away under `#[cfg(windows)]` — would produce a key generator
// that writes the clawback authority to a world-readable file while printing
// "[0600, NOT printed]". A tool that lies about how it protected a key is worse
// than one that will not run.
//
// So the real `main` is Unix-gated and every other platform gets a hard error.
// It still has to COMPILE everywhere, because CI builds the whole workspace on
// windows-latest and that job produces the Windows Qt wallet.
#[cfg(not(unix))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    Err("clawback-keygen requires Unix file permissions (0600 secret, 0700 directory \
         on tmpfs) to protect the generated authority keys, and this platform does not \
         provide them. Generate the authority on the Linux host instead."
        .into())
}

#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::PathBuf;

#[cfg(unix)]
use blockle_core::keys::{encode_address, pubkey_to_address, verify_signature, Keypair};

#[cfg(unix)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir: PathBuf = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/dev/shm/blockle-clawback".to_string())
        .into();
    // Optional second arg: generate ONE factor with that label ("a" or "b").
    // Needed because regenerating a lost factor must not churn the surviving
    // one -- a fresh factor A would invalidate an authority address already
    // committed to, or already signed with.
    let only: Option<String> = std::env::args().nth(2).map(|s| s.to_lowercase());
    if let Some(l) = &only {
        if l != "a" && l != "b" {
            return Err(format!("second argument must be 'a' or 'b', got {l:?}").into());
        }
    }

    // 0700 directory on tmpfs.
    fs::create_dir_all(&dir)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;

    println!("Blockle clawback authority — 2-of-2 ML-DSA-44 (post-quantum)");
    println!("Alienbeing LLC\n");
    println!("output directory: {}", dir.display());
    let on_tmpfs = dir.starts_with("/dev/shm") || dir.starts_with("/run");
    if on_tmpfs {
        println!("  (tmpfs — these bytes never reach the SSD)\n");
    } else {
        println!("  *** WARNING: NOT tmpfs. The secret will be written to persistent");
        println!("      storage, where a plain delete leaves recoverable remnants.");
        println!("      Re-run with /dev/shm/blockle-clawback instead.\n");
    }

    let mut lines = Vec::new();
    let labels: Vec<&str> = match only.as_deref() {
        Some("a") => vec!["a"],
        Some("b") => vec!["b"],
        _ => vec!["a", "b"],
    };
    for (i, label) in labels.iter().enumerate() {
        let kp = Keypair::generate();
        let pk = kp.public_bytes();
        let addr = kp.address();

        // PROVE THE KEY WORKS BEFORE IT IS RELIED ON. A key that cannot sign is
        // a clawback authority that cannot be exercised, and the only safe time
        // to discover that is now — not during an incident.
        let probe = b"blockle-clawback-authority-selftest";
        let sig = kp.sign(probe);
        verify_signature(&pk, probe, &sig).map_err(|e| format!("factor {label}: generated key failed its own verification: {e:?}"))?;
        if verify_signature(&pk, b"different message", &sig).is_ok() {
            return Err(format!("factor {label}: signature verified against the WRONG message").into());
        }
        assert_eq!(pubkey_to_address(&pk), addr, "address is not the hash of the public key");

        // Secret -> file, 0600, never stdout.
        let sk_path = dir.join(format!("clawback-factor-{label}.secret"));
        {
            let mut f = fs::File::create(&sk_path)?;
            fs::set_permissions(&sk_path, fs::Permissions::from_mode(0o600))?;
            f.write_all(hex::encode(kp.secret_bytes()).as_bytes())?;
            f.write_all(b"\n")?;
            f.sync_all()?;
        }
        // Public key -> file too, so a signing tool off-box has both halves.
        let pk_path = dir.join(format!("clawback-factor-{label}.public"));
        {
            let mut f = fs::File::create(&pk_path)?;
            fs::set_permissions(&pk_path, fs::Permissions::from_mode(0o644))?;
            f.write_all(hex::encode(&pk).as_bytes())?;
            f.write_all(b"\n")?;
            f.sync_all()?;
        }

        println!("FACTOR {} (of 2)", label.to_uppercase());
        println!("  address : {}", encode_address(&addr));
        println!("  pubkey  : {} bytes  (sha256 {})", pk.len(), short_hash(&pk));
        println!("  secret  : {}  [0600, NOT printed]", sk_path.display());
        println!("  public  : {}", pk_path.display());
        println!("  self-test: sign+verify OK, wrong-message rejected\n");
        lines.push((i, encode_address(&addr)));
    }

    println!("─────────────────────────────────────────────────────────────────");
    if only.is_some() {
        println!("SINGLE FACTOR regenerated. The authority is still 2-of-2; pair the");
        println!("address above with the OTHER factor's address when wiring consensus.\n");
    }
    println!("EMBED IN CONSENSUS (crates/chain/src/params.rs):\n");
    println!("    clawback_authority: [");
    for (_, a) in &lines {
        println!("        \"{a}\",");
    }
    println!("    ],\n");
    println!("Both signatures are required. Either alone authorises nothing.\n");

    println!("NEXT STEPS — do these in order, from YOUR machine:\n");
    println!("  1. Copy both secrets off the box:");
    println!("       scp blockle-box:{}/clawback-factor-*.secret .", dir.display());
    println!("       scp blockle-box:{}/clawback-factor-*.public .", dir.display());
    println!();
    println!("  2. VERIFY you can read them locally before wiping anything:");
    println!("       wc -c clawback-factor-a.secret clawback-factor-b.secret");
    println!("     Each secret file should be 5121 bytes (5120 hex chars + a newline);");
    println!("     an ML-DSA-44 private key is 2560 bytes.");
    println!();
    println!("  3. Store the two factors SEPARATELY. The entire value of 2-of-2 is");
    println!("     that one place being breached is not enough. Same laptop, same");
    println!("     password manager, or same backup is one place.");
    println!();
    println!("  4. Only then wipe the box copy:");
    println!("       ssh blockle-box 'shred -u {}/*.secret; rm -rf {}; ls {} 2>&1'",
             dir.display(), dir.display(), dir.display());
    println!();
    println!("  5. Confirm removal — that last `ls` must say No such file or directory.");
    println!();
    println!("  NOTE: on tmpfs a reboot also destroys these. If you do not complete");
    println!("  step 1 before the next restart, the keys are gone and you re-run this");
    println!("  tool — which is the safe failure, not a loss.");
    Ok(())
}

/// First 8 bytes of a SHA-256 over the key, as a fingerprint for comparing the
/// on-box copy against the one you took off without handling the full key.
#[cfg(unix)]
fn short_hash(b: &[u8]) -> String {
    let h = blockle_core::hash::sha256d(b);
    hex::encode(&h[..8])
}
