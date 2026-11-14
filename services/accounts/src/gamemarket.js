// Blocklings player marketplace — server-authoritative listings + settlement.
//
// RAILS (the settlement truth table):
//   GOLD listing  -> POST /buy: ONE store.txn moves gold buyer->seller, flips the listing to
//                    'sold', records the buyer. Atomic: all of it happens or none of it does.
//                    Goods delivery: the goods payload was escrowed INTO the listing at list
//                    time (the seller's client removed it from their save); the buy response
//                    hands the payload to the buyer's client, which adds it to their save.
//   CRYPTO listing -> the buyer pays the SELLER'S OWN ADDRESS wallet-side (client sendOn — the
//                    server never touches funds or keys), then POSTs the txid here:
//        chain 'blockle'          -> 'pending-verify' until the public explorer API shows a tx
//                                    paying >= price to the seller address, then 'sold' with
//                                    payment:'verified'. Unverifiable-yet stays pending (the
//                                    buyer's client retries the same POST — idempotent).
//        chain 'ethereum'/'solana'-> no verifier infra: 'sold' with payment:'attested' — an
//                                    HONEST "payment attested by buyer" status, never a fake
//                                    'verified'.
//   A given txid can settle AT MOST one listing, ever (gameMarketTxs claim) — one real payment
//   can't be replayed across listings.
//
// ECONOMY LAW: crypto-priced listings REQUIRE minted goods (uid + a MintRecord on the price
// chain); gold listings need no mint. GOLD itself never leaves the ledger (no cash-out here —
// this only moves it between accounts). NEVER fabricate txids/receipts: everything 'verified'
// was seen on-chain via the explorer; everything else says exactly what it is.
import { randomToken } from './crypto.js';

const CHAINS = ['blockle', 'ethereum', 'solana'];
const MAX_OPEN_PER_SELLER = 20;
const MAX_PAYLOAD_JSON = 4096;
const GOLD_MAX = 1_000_000_000;
const TX_RE = /^[A-Za-z0-9+/=:_-]{8,200}$/;
const ADDR_RE = {
  blockle: /^block1[a-z0-9]{20,110}$/,
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

const goldOf = (u) => (Number.isSafeInteger(u?.goldBalance) && u.goldBalance >= 0 ? u.goldBalance : 0);

/** Public view of a listing (what browse/mine return). The crypto price keeps the seller's
 *  receive address — the buyer needs it to pay, and a receive address is public by nature. */
function pub(l) {
  const v = {
    id: l.id, seller: l.sellerName, kind: l.kind, price: l.price,
    t: l.t, status: l.status, payment: l.payment || null,
  };
  if (l.kind === 'item') v.item = l.payload; else v.pet = l.payload;
  if (l.tx) v.tx = l.tx;
  return v;
}

function validPayload(kind, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Goods payload must be an object.';
  try { if (JSON.stringify(payload).length > MAX_PAYLOAD_JSON) return 'Goods payload too large.'; }
  catch { return 'Goods payload not serializable.'; }
  if (kind === 'item') {
    if (typeof payload.defId !== 'string' || !payload.defId) return 'Item listings need payload.defId.';
    const q = payload.qty ?? 1;
    if (!Number.isSafeInteger(q) || q < 1 || q > 999) return 'qty must be 1..999.';
  } else if (kind === 'pet') {
    if (typeof payload.petId !== 'string' || !payload.petId) return 'Pet listings need payload.petId.';
  } else return "kind must be 'item' or 'pet'.";
  if (payload.uid !== undefined && (typeof payload.uid !== 'string' || payload.uid.length > 64)) return 'Bad uid.';
  if (payload.mints !== undefined) {
    if (!Array.isArray(payload.mints) || payload.mints.length > 6) return 'Bad mints.';
    for (const m of payload.mints) {
      if (!m || typeof m !== 'object' || !CHAINS.includes(m.chain)
        || typeof m.token !== 'string' || !m.token
        || typeof m.tx !== 'string' || !m.tx) return 'Bad mint record.';
    }
  }
  return null;
}

function validPrice(price, payload) {
  if (!price || typeof price !== 'object') return 'A price is required.';
  if ('gold' in price) {
    if (!Number.isSafeInteger(price.gold) || price.gold < 1 || price.gold > GOLD_MAX) return 'GOLD price must be a positive integer.';
    return null;
  }
  if (!CHAINS.includes(price.chain)) return 'Unknown chain.';
  if (typeof price.amount !== 'number' || !Number.isFinite(price.amount) || price.amount <= 0 || price.amount > 1e9) return 'Bad crypto amount.';
  if (typeof price.address !== 'string' || !ADDR_RE[price.chain].test(price.address)) return 'Bad seller receive address for that chain.';
  // NFT LAW: crypto price => goods minted on that chain (uid + a MintRecord with a real tx).
  if (!payload.uid) return 'Crypto listings require minted goods (no uid).';
  const mints = Array.isArray(payload.mints) ? payload.mints : [];
  if (!mints.some((m) => m.chain === price.chain)) return `Crypto listings require the goods minted on ${price.chain}.`;
  return null;
}

export function makeGameMarket({ store, now, fetchFn, chainBase }) {
  const doFetch = fetchFn || globalThis.fetch;
  const base = chainBase || 'https://blockle.org';

  /** Look a BLOCK tx up on the public explorer. Returns the tx object or null (not found /
   *  explorer unreachable — the caller treats both as "not verifiable yet", never as paid). */
  async function blockleTx(txid) {
    try {
      const r = await doFetch(`${base}/api/explorer/tx/${encodeURIComponent(txid)}`);
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.tx && Array.isArray(j.tx.outputs) ? j.tx : null;
    } catch { return null; }
  }

  /** True when `tx` pays >= `amountBlock` to `address` (explorer amounts are 1e8 base units). */
  function paysEnough(tx, address, amountBlock) {
    const need = Math.round(amountBlock * 1e8);
    let got = 0;
    for (const o of tx.outputs) if (o && o.address === address && Number.isFinite(o.amount)) got += o.amount;
    return got >= need;
  }

  return {
    async create(u, body) {
      const kind = body.kind === 'pet' ? 'pet' : body.kind === 'item' ? 'item' : null;
      if (!kind) return { status: 400, data: { error: "kind must be 'item' or 'pet'." } };
      const payload = body.payload;
      const perr = validPayload(kind, payload);
      if (perr) return { status: 400, data: { error: perr } };
      const price = body.price;
      const prerr = validPrice(price, payload);
      if (prerr) return { status: 400, data: { error: prerr } };
      const open = store.all('gameListings').filter((l) => l.seller === u.id && (l.status === 'open' || l.status === 'pending-verify'));
      if (open.length >= MAX_OPEN_PER_SELLER) return { status: 400, data: { error: `Listing cap reached (${MAX_OPEN_PER_SELLER} open).` } };
      // One uid may be live in at most one listing (an instance is one thing).
      if (payload.uid && open.some((l) => l.payload && l.payload.uid === payload.uid))
        return { status: 409, data: { error: 'That item is already listed.' } };
      const cleanPrice = 'gold' in price
        ? { gold: price.gold }
        : { chain: price.chain, amount: price.amount, address: price.address };
      const l = {
        id: 'L' + randomToken(9), seller: u.id,
        sellerName: u.username || 'adventurer-' + String(u.id).slice(0, 4),
        kind, payload, price: cleanPrice, status: 'open', t: now(),
        buyer: null, soldAt: null, payment: null, tx: null, sellerAck: true,
      };
      await store.put('gameListings', l.id, l);
      return { status: 200, data: { ok: true, listingId: l.id, listing: pub(l) } };
    },

    browse(q) {
      let rows = store.all('gameListings').filter((l) => l.status === 'open');
      if (q.kind === 'item' || q.kind === 'pet') rows = rows.filter((l) => l.kind === q.kind);
      if (q.gold === '1' || q.gold === 'true') rows = rows.filter((l) => 'gold' in l.price);
      if (CHAINS.includes(q.chain)) rows = rows.filter((l) => l.price.chain === q.chain);
      if (q.id) rows = rows.filter((l) => (l.payload.defId || l.payload.petId) === q.id);
      if (q.text) {
        const t = String(q.text).toLowerCase();
        rows = rows.filter((l) => {
          const name = (l.payload.meta && typeof l.payload.meta.name === 'string') ? l.payload.meta.name : '';
          return name.toLowerCase().includes(t) || String(l.payload.defId || l.payload.petId).toLowerCase().includes(t);
        });
      }
      rows.sort((a, b) => b.t - a.t);
      return { status: 200, data: { listings: rows.slice(0, 200).map(pub) } };
    },

    mine(u) {
      const rows = store.all('gameListings')
        .filter((l) => l.seller === u.id || l.buyer === u.id)
        .sort((a, b) => b.t - a.t)
        .map((l) => ({ ...pub(l), mineAs: l.seller === u.id ? 'seller' : 'buyer', sellerAck: !!l.sellerAck }));
      return { status: 200, data: { listings: rows } };
    },

    async cancel(u, id) {
      const out = await store.txn((t) => {
        const l = t.get('gameListings', id);
        if (!l || l.seller !== u.id) return { status: 404, data: { error: 'No such listing.' } };
        if (l.status !== 'open') return { status: 409, data: { error: 'Only open listings can be cancelled.' } };
        l.status = 'cancelled';
        t.set('gameListings', id, l);
        // The goods go back to the seller's save client-side (the payload travels back).
        return { status: 200, data: { ok: true, listing: pub(l) } };
      });
      return out;
    },

    /** GOLD rail: the atomic settlement. Debit buyer + credit seller + flip the listing in ONE
     *  store transaction — a concurrent second buyer, an underfunded buyer, or a crash between
     *  steps can never produce gold created/destroyed or a double-sold listing. */
    async buyGold(u, id) {
      const out = await store.txn((t) => {
        const l = t.get('gameListings', id);
        if (!l) return { status: 404, data: { error: 'No such listing.' } };
        if (l.status !== 'open') return { status: 410, data: { error: 'Listing is no longer available.' } };
        if (!('gold' in l.price)) return { status: 400, data: { error: 'Not a GOLD listing — pay it from your wallet.' } };
        if (l.seller === u.id) return { status: 400, data: { error: "You can't buy your own listing." } };
        const buyer = t.get('users', u.id);
        if (!buyer) return { status: 401, data: { error: 'auth' } };
        const bal = goldOf(buyer);
        if (bal < l.price.gold) return { status: 400, data: { error: 'Insufficient GOLD.', balance: bal } };
        buyer.goldBalance = bal - l.price.gold;
        t.set('users', u.id, buyer);
        const seller = t.get('users', l.seller);
        if (seller) { // seller account deleted => the goods still deliver; the gold has no home and burns
          seller.goldBalance = goldOf(seller) + l.price.gold;
          t.set('users', l.seller, seller);
        }
        l.status = 'sold'; l.buyer = u.id; l.soldAt = now(); l.payment = 'gold'; l.sellerAck = false;
        t.set('gameListings', id, l);
        return { status: 200, data: { ok: true, balance: buyer.goldBalance, listing: pub(l) } };
      });
      return out;
    },

    /** CRYPTO rail: the buyer already paid the seller's address wallet-side; this records the
     *  txid and (blockle only) verifies it on-chain before completing. Idempotent per
     *  (listing, tx) so the buyer's client can retry while a tx confirms. */
    async paid(u, id, txid) {
      if (typeof txid !== 'string' || !TX_RE.test(txid)) return { status: 400, data: { error: 'Bad txid.' } };

      // Phase 1 (atomic): claim the txid + move the listing to pending-verify.
      const claim = await store.txn((t) => {
        const l = t.get('gameListings', id);
        if (!l) return { status: 404, data: { error: 'No such listing.' } };
        if (!l.price.chain) return { status: 400, data: { error: 'A GOLD listing — use buy.' } };
        if (l.seller === u.id) return { status: 400, data: { error: "You can't buy your own listing." } };
        if (l.status === 'sold') {
          if (l.buyer === u.id && l.tx === txid) return { status: 200, data: { ok: true, listing: pub(l) } }; // idempotent replay
          return { status: 410, data: { error: 'Listing already sold.' } };
        }
        // Open, the same buyer retrying their pending tx, or a STALE pending claim (>15 min
        // unverifiable — e.g. a bogus txid) which a new buyer may displace so the listing can't
        // be wedged forever by a junk attestation.
        const stale = l.status === 'pending-verify' && now() - (l.pendingAt || 0) > 15 * 60 * 1000;
        const retry = l.status === 'pending-verify' && l.buyer === u.id; // same buyer may re-POST / replace their tx
        if (l.status !== 'open' && !retry && !stale)
          return { status: 410, data: { error: 'Listing is no longer available.' } };
        if ((stale || retry) && l.tx && l.tx !== txid) t.del('gameMarketTxs', `${l.price.chain}:${l.tx}`);
        const txKey = `${l.price.chain}:${txid}`;
        const prev = t.get('gameMarketTxs', txKey);
        if (prev && prev.listing !== id) return { status: 409, data: { error: 'That transaction already settled another listing.' } };
        t.set('gameMarketTxs', txKey, { listing: id, uid: u.id, at: now() });
        l.status = 'pending-verify'; l.buyer = u.id; l.tx = txid; l.pendingAt = now();
        t.set('gameListings', id, l);
        return { listing: l };
      });
      if (claim.status) return claim; // terminal answer from phase 1
      const l = claim.listing;

      // Phase 2: chain-dependent completion.
      if (l.price.chain === 'blockle') {
        const tx = await blockleTx(txid); // network — outside any txn
        if (!tx) {
          return { status: 202, data: { ok: false, status: 'pending-verify', error: 'Transaction not visible on the explorer yet — retry shortly.', listing: pub(l) } };
        }
        if (!paysEnough(tx, l.price.address, l.price.amount)) {
          // Definitive mismatch: release the claim + reopen so the listing isn't wedged.
          const out = await store.txn((t) => {
            const cur = t.get('gameListings', id);
            if (cur && cur.status === 'pending-verify' && cur.tx === txid) {
              cur.status = 'open'; cur.buyer = null; cur.tx = null;
              t.set('gameListings', id, cur);
              t.del('gameMarketTxs', `${l.price.chain}:${txid}`);
            }
            return { status: 400, data: { error: `Transaction does not pay ${l.price.amount} BLOCK to the seller address.` } };
          });
          return out;
        }
        return store.txn((t) => {
          const cur = t.get('gameListings', id);
          if (!cur || cur.tx !== txid) return { status: 409, data: { error: 'Listing changed underneath — retry.' } };
          cur.status = 'sold'; cur.soldAt = now(); cur.payment = 'verified'; cur.sellerAck = false;
          t.set('gameListings', id, cur);
          return { status: 200, data: { ok: true, listing: pub(cur) } };
        });
      }

      // ethereum / solana: no verifier infra — HONEST attested status, never fake 'verified'.
      return store.txn((t) => {
        const cur = t.get('gameListings', id);
        if (!cur || cur.tx !== txid) return { status: 409, data: { error: 'Listing changed underneath — retry.' } };
        cur.status = 'sold'; cur.soldAt = now(); cur.payment = 'attested'; cur.sellerAck = false;
        t.set('gameListings', id, cur);
        return { status: 200, data: { ok: true, listing: pub(cur) } };
      });
    },

    /** Seller acknowledges a sale (their client emitted 'market:sold' + applied the save patch);
     *  stops the sale from being re-announced on every poll. */
    async ack(u, id) {
      const out = await store.txn((t) => {
        const l = t.get('gameListings', id);
        if (!l || l.seller !== u.id) return { status: 404, data: { error: 'No such listing.' } };
        l.sellerAck = true;
        t.set('gameListings', id, l);
        return { status: 200, data: { ok: true } };
      });
      return out;
    },
  };
}
