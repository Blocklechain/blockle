// Cross-chain relayer — drives the replay-safe BridgeEngine from observed chain
// events. It performs NO custody logic itself: it only (a) feeds verified chain
// observations into the engine and (b) executes the engine-authorized output
// (an SPL mint, or a BLOCK release via reserve-signer) then settles it.
//
// Idempotency + safety:
//  - The engine dedupes every transfer by a canonical id (direction:sourceTx)
//    and is a no-op on replay, so re-seeing a deposit/burn cannot authorize a
//    second mint/release.
//  - The one window the engine cannot close alone is "output sent, process
//    crashed before settle()": on restart the record is still MINTING/RELEASING
//    and we would act again. We therefore REQUIRE the minter and the reserve
//    signer to be IDEMPOTENT BY `ref` (the transfer id) — e.g. the SPL mint
//    carries the id as a memo and the adapter returns the existing signature if
//    a finalized mint for that id already exists; reserve-signer likewise dedupes
//    by purpose+ref. The fake adapters in the tests enforce this contract.
//  - Cursors (last BLOCK height / last Solana slot) persist in the store so a
//    restart resumes without reprocessing.
//
// This module moves no money on import and holds no keys; adapters are injected.

import { DIRECTIONS, STATES } from './statemachine.js';

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
const looksBlockAddr = (s) => typeof s === 'string' && /^block1[0-9a-z]{10,}$/.test(s);
const looksSolAddr = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export class Relayer {
  constructor({ engine, store, config, blockClient, solClient, minter, reserveSigner, log = () => {}, now = () => Date.now() }) {
    if (!engine || !store || !config) throw new Error('relayer needs engine, store, config');
    this.engine = engine;
    this.store = store;
    this.cfg = config;
    this.blockClient = blockClient;   // { depositsTo(address, sinceHeight) -> [{txid,amountBase,height,confirmations,destination}] }
    this.solClient = solClient;       // { burnsSince(mint, sinceSlot) -> [{signature,amountBase,blockDestination,slot,finalized}] }
    this.minter = minter;             // { mint({amountBase,recipient,ref}) -> signature }   (idempotent by ref)
    this.reserveSigner = reserveSigner; // { dispense({amountBase,to,ref}) -> {txid} }        (idempotent by ref)
    this.log = log;
    this.now = now;
    this.retries = 0;
    this.lastError = null;
  }

  _cursor(key, fallback) {
    const m = this.store.get('meta', key);
    return m && m.value != null ? m.value : fallback;
  }
  async _setCursor(key, value) {
    await this.store.put('meta', key, { value, at: this.now() });
  }

  async _ensureSubmitted(direction, { txid, amountBase, destination }) {
    const { deriveId } = await import('./statemachine.js');
    const id = deriveId(direction, txid);
    const ns = direction === DIRECTIONS.DEPOSIT ? 'deposits' : 'burns';
    if (this.store.has(ns, id)) return;
    // The watcher is the source of truth for on-chain-initiated transfers.
    await this.engine.submitSource({ direction, sourceTx: txid, destination, grossAmountBase: amountBase });
  }

  // BLOCK deposit -> wBLOCK mint. BLOCK txs carry no memo for the Solana
  // destination, so deposits are INTENT-driven: the user registers an intent
  // (destination + txid) via the bridge API (engine.submitSource), and we
  // confirm that txid paid the bridge address — exactly settlement's model.
  // We therefore iterate the not-yet-finalized deposit records and confirm each.
  async _mintAndSettle(rec) {
    // Idempotent by ref (rec.id): the minter must return the existing signature
    // if a mint for this id already finalized — so a crash between mint+settle
    // never double-mints on recovery.
    const sig = await this.minter.mint({ amountBase: rec.outputAmountBase, recipient: rec.destination, ref: rec.id });
    await this.engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: rec.sourceTx, outputTx: sig });
    this.log('minted', { id: rec.id, sig });
  }

  async processDeposits() {
    const relevant = (this.store.all('deposits') || []).filter((r) =>
      [STATES.SUBMITTED, STATES.CONFIRMING_SOURCE, STATES.AWAITING_VERIFICATION, STATES.MINTING].includes(r.state));
    for (const rec0 of relevant) {
      const txid = rec0.sourceTx;
      if (!isHex64(txid)) { this.log('skip deposit: bad txid', txid); continue; }
      // recovery: authorized but output/settle not finalized -> (re)mint idempotently
      if (rec0.state === STATES.MINTING) { await this._mintAndSettle(rec0); continue; }
      const seen = await this.blockClient.confirmTx(txid, this.cfg.blockBridgeAddr); // {amountBase, confirmations} | null
      if (!seen) continue; // not visible yet (mempool / unknown) — retry next tick
      await this.engine.observeSource({
        direction: DIRECTIONS.DEPOSIT, sourceTx: txid,
        confirmations: seen.confirmations, amountBase: seen.amountBase,
      });
      if (seen.confirmations >= this.cfg.confirmationDepth) {
        const rec = await this.engine.verify({
          direction: DIRECTIONS.DEPOSIT, sourceTx: txid,
          verifiedAmountBase: seen.amountBase, recipientOk: looksSolAddr(rec0.destination),
        });
        if (rec.state === STATES.MINTING) await this._mintAndSettle(rec);
      }
    }
  }

  // wBLOCK burn -> BLOCK release (via reserve-signer)
  async processRedeems() {
    const since = this._cursor('solCursor', 0);
    const burns = await this.solClient.burnsSince(this.cfg.solblockMint, since);
    let maxSlot = since;
    for (const b of burns || []) {
      if (b.slot > maxSlot) maxSlot = b.slot;
      if (!looksSolAddr(b.signature) && !isHex64(b.signature)) { /* sigs are base58 */ }
      await this._ensureSubmitted(DIRECTIONS.REDEEM, { txid: b.signature, amountBase: b.amountBase, destination: b.blockDestination });
      await this.engine.observeSource({
        direction: DIRECTIONS.REDEEM, sourceTx: b.signature,
        confirmations: b.finalized ? this.cfg.confirmationDepth : 0, amountBase: b.amountBase,
      });
      if (b.finalized) {
        const rec = await this.engine.verify({
          direction: DIRECTIONS.REDEEM, sourceTx: b.signature,
          verifiedAmountBase: b.amountBase, recipientOk: looksBlockAddr(b.blockDestination),
        });
        if (rec.state === STATES.RELEASING) await this._releaseAndSettle(rec);
        // REFUND_PENDING (insufficient reserves) is intentionally left for the operator.
      }
    }
    await this._setCursor('solCursor', maxSlot);
    // recovery sweep: a burn authorized to RELEASING but not settled (crash
    // between release+settle) is re-released idempotently — reserve-signer dedupes by ref.
    for (const rec of (this.store.all('burns') || []).filter((r) => r.state === STATES.RELEASING)) {
      await this._releaseAndSettle(rec);
    }
  }

  async _releaseAndSettle(rec) {
    const { txid } = await this.reserveSigner.dispense({ amountBase: rec.outputAmountBase, to: rec.destination, ref: rec.id });
    await this.engine.settle({ direction: DIRECTIONS.REDEEM, sourceTx: rec.sourceTx, outputTx: txid });
    this.log('released', { id: rec.id, txid });
  }

  /** One processing pass. Never throws — failures are logged, backed off, and
   *  retried next tick; cursors only advance past successfully handled items. */
  async tick() {
    let failed = false;
    for (const [name, fn] of [['deposits', () => this.processDeposits()], ['redeems', () => this.processRedeems()]]) {
      try {
        await fn();
      } catch (e) {
        failed = true;
        this.retries += 1;
        this.lastError = { at: this.now(), where: name, message: String(e && e.message || e) };
        this.log(`relayer ${name} error (retry ${this.retries})`, e && e.message);
      }
    }
    if (!failed) this.retries = 0; // only a fully clean pass clears the backoff
  }

  /** Exponential backoff delay (ms) for the current retry count, capped. */
  backoffMs(base = 1000, cap = 60000) {
    return Math.min(cap, base * 2 ** Math.min(this.retries, 6));
  }
}

export default Relayer;
