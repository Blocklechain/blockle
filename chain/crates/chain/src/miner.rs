//! Block assembly and CPU mining.

use blockle_core::keys::Address;
use blockle_core::{Block, BlockHeader, Transaction, TxOutput};
use blockle_pow::difficulty::hash_meets_target;
use blockle_pow::equihash;

use crate::chain::{now_unix, Chain, ChainError};

/// Assemble and mine the next block. See [`mine_block_cancellable`]; this
/// variant never gives up.
pub fn mine_block(
    chain: &Chain,
    reward_to: Address,
    candidates: &[Transaction],
) -> Result<(Block, Vec<[u8; 32]>), ChainError> {
    Ok(mine_block_cancellable(chain, reward_to, candidates, || false)?
        .expect("uncancellable mining always returns a block"))
}

/// Assemble an unsolved block template on the current tip: select valid
/// transactions from `candidates` (skipping any that no longer apply), build
/// the coinbase, and fill in every header field except nonce/solution.
/// Returns the template plus the included txids. Used by the CPU miner and
/// the stratum server.
pub fn build_template(
    chain: &Chain,
    reward_to: Address,
    candidates: &[Transaction],
) -> Result<(Block, Vec<[u8; 32]>), ChainError> {
    let height = chain.blocks.len() as u64;
    let params = &chain.params;

    // Select transactions against scratch state views, applying the same
    // effects (including contract execution) that validation will.
    let mut view = chain.utxos.clone();
    let mut cview = chain.contracts.clone();
    let mut sview = chain.contract_storage.clone();
    let mut nview = chain.nullifiers.clone();
    let mut lview = chain.note_leaves.clone();
    let mut included = Vec::new();
    let mut included_ids = Vec::new();
    let mut fees: u64 = 0;
    let mut gas_total: u64 = 0;
    for tx in candidates {
        let gas = tx.contract.as_ref().map(|a| a.gas_limit()).unwrap_or(0);
        if gas_total + gas > chain.params.block_gas_limit {
            continue;
        }
        // Skip candidates whose nullifiers are already used in this template.
        if tx.nullifiers().iter().any(|n| nview.contains(n)) {
            continue;
        }
        let fee = match chain.check_transaction(tx, &view, height) {
            Ok(fee) => fee,
            Err(_) => continue, // stale or conflicting candidate — skip it
        };
        let txid = tx.txid();
        Chain::apply_tx_effects(
            tx, &txid, height, &mut view, &mut cview, &mut sview, &mut nview, &mut lview,
        );
        gas_total += gas;
        fees = fees.checked_add(fee).ok_or(ChainError::ValueOutOfRange)?;
        included.push(tx.clone());
        included_ids.push(txid);
    }

    let reward = params
        .block_subsidy(height)
        .checked_add(fees)
        .ok_or(ChainError::ValueOutOfRange)?;
    let coinbase = Transaction::coinbase(height, reward_to, reward, &params.coinbase_tag);

    let mut transactions = vec![coinbase];
    transactions.extend(included);

    // Stamp the timestamp first, then derive bits from it: the quiet-lane
    // decay keys off the block's own time, and the validator recomputes the
    // expected bits from that same timestamp.
    let time = now_unix().max(chain.median_time_past() + 1);
    let mut block = Block {
        aux_pow: None,
        header: BlockHeader {
            version: 1,
            prev_hash: chain.tip_hash(),
            merkle_root: [0u8; 32],
            state_root: [0u8; 32],
            time: time as u32,
            bits: chain.next_bits_for_at("native", time),
            nonce: [0u8; 32],
            solution: vec![],
        },
        transactions,
    };
    block.header.merkle_root = block.compute_merkle_root();
    Ok((block, included_ids))
}

/// Like [`build_template`], but splits the coinbase among `recipients` by
/// basis points (summing to 10_000); rounding dust goes to the last entry.
/// Zero-amount outputs are dropped.
pub fn build_template_split(
    chain: &Chain,
    recipients: &[(Address, u32)],
    candidates: &[Transaction],
) -> Result<(Block, Vec<[u8; 32]>), ChainError> {
    let (mut block, ids) = build_template(chain, recipients[0].0, candidates)?;
    let reward = block.transactions[0].outputs[0].amount;
    let mut outs = Vec::with_capacity(recipients.len());
    let mut assigned = 0u64;
    for (i, (addr, bp)) in recipients.iter().enumerate() {
        let amount = if i == recipients.len() - 1 {
            reward - assigned
        } else {
            (reward as u128 * *bp as u128 / 10_000) as u64
        };
        assigned += amount;
        if amount > 0 {
            outs.push(TxOutput { recipient: *addr, amount });
        }
    }
    block.transactions[0].outputs = outs;
    block.header.merkle_root = block.compute_merkle_root();
    Ok((block, ids))
}

/// Assemble the next block and grind nonces until an Equihash solution also
/// meets the difficulty target.
///
/// `cancel` is polled between nonce attempts; returning `true` aborts the
/// search (used by the P2P miner when a new tip arrives). On success returns
/// the mined block plus the txids that were included; on cancellation,
/// `Ok(None)`.
pub fn mine_block_cancellable<F: Fn() -> bool>(
    chain: &Chain,
    reward_to: Address,
    candidates: &[Transaction],
    cancel: F,
) -> Result<Option<(Block, Vec<[u8; 32]>)>, ChainError> {
    let params = &chain.params;
    let (mut block, included_ids) = build_template(chain, reward_to, candidates)?;

    let input = block.header.equihash_input();
    let mut nonce = [0u8; 32];
    loop {
        if cancel() {
            return Ok(None);
        }
        for solution in equihash::solve(&params.equihash, &input, &nonce) {
            block.header.nonce = nonce;
            block.header.solution = equihash::pack_solution(&params.equihash, &solution);
            if hash_meets_target(&block.header.hash(), block.header.bits, params.pow_limit) {
                return Ok(Some((block, included_ids)));
            }
        }
        increment(&mut nonce);
    }
}

fn increment(nonce: &mut [u8; 32]) {
    for byte in nonce.iter_mut() {
        let (v, overflow) = byte.overflowing_add(1);
        *byte = v;
        if !overflow {
            break;
        }
    }
}
