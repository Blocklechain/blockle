//! Cross-algorithm difficulty coupling activates by height. Below the
//! activation height every lane retargets independently; at and above it the
//! lanes are coupled by benchmark energy-per-hash and `connect_block` enforces
//! the coupled difficulty bits. Mirrors the intel_integration height-gate style.

use blockle_chain::{mine_block, Chain, ChainError, ChainParams};

fn regtest_activating_at(h: u64) -> ChainParams {
    let mut p = ChainParams::regtest();
    p.cross_algo_activation_height = h;
    p
}

/// Number of blocks in the chain (the height the NEXT block will occupy, which
/// is what `connect_block`/`next_bits_for_at` gate on).
fn blocks_len(chain: &Chain) -> u64 {
    chain.height().map(|h| h + 1).unwrap_or(0)
}

/// Mine native blocks (regtest Equihash 48,5 is cheap) until the chain holds
/// `target_len` blocks. Each block's bits come from the miner's build_template
/// -> next_bits_for_at, so a clean run already proves miner and validator agree
/// across the activation boundary.
fn grow_to_len(chain: &mut Chain, target_len: u64) -> i64 {
    let addr = [9u8; 32];
    let mut last = 0i64;
    while blocks_len(chain) < target_len {
        let (b, _) = mine_block(chain, addr, &[]).expect("mine native");
        last = b.header.time as i64;
        chain.connect_block(b).expect("block connects across the activation gate");
    }
    last
}

#[test]
fn coupling_gate_switches_the_retarget_rule() {
    let activation = 24u64;
    let mut chain = Chain::new(regtest_activating_at(activation));

    // The next block will occupy height activation-1 — still below the gate, so
    // next_bits_for_at must use the INDEPENDENT per-lane rule.
    let last = grow_to_len(&mut chain, activation - 1);
    let within = last + 1; // inside the decay grace window (no decay applied)
    let independent = chain.next_bits_for("native");
    let coupled = chain.next_bits_coupled("native");
    assert_ne!(
        independent, coupled,
        "the two retarget rules must genuinely differ here for the test to mean anything"
    );
    assert_eq!(
        chain.next_bits_for_at("native", within),
        independent,
        "below activation the chain must use the independent per-lane LWMA"
    );

    // Mine one more block (height activation-1, independent). Now the next block
    // occupies height activation — AT the gate -> coupled rule.
    let last = grow_to_len(&mut chain, activation);
    let within = last + 1;
    let coupled_now = chain.next_bits_coupled("native");
    assert_eq!(
        chain.next_bits_for_at("native", within),
        coupled_now,
        "at/above activation the chain must use the energy-coupled rule"
    );
}

#[test]
fn coupled_bits_are_enforced_and_chain_keeps_extending() {
    let activation = 22u64;
    let mut chain = Chain::new(regtest_activating_at(activation));

    // Grow well past activation; connect_block succeeding here proves the miner's
    // coupled bits validate.
    grow_to_len(&mut chain, activation + 7);
    assert!(blocks_len(&chain) >= activation + 7);

    // A block whose difficulty bits don't match the coupled expectation is
    // rejected before PoW is even checked.
    let addr = [3u8; 32];
    let (good, _) = mine_block(&chain, addr, &[]).expect("mine a valid coupled block");
    let expected = good.header.bits;
    let mut tampered = good.clone();
    tampered.header.bits = expected.wrapping_add(1); // definitely not the coupled target
    match chain.connect_block(tampered) {
        Err(ChainError::BadBits { expected: e, .. }) => {
            assert_eq!(e, expected, "validator must demand the coupled bits");
        }
        other => panic!("expected BadBits for wrong coupled difficulty, got {other:?}"),
    }

    // The correctly-built block still connects.
    chain.connect_block(good).expect("the valid coupled block connects");
}
