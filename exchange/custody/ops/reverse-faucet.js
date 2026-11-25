// Reverse the faucet-minted liabilities for one owner.
//
// Through Ledger.reverse() rather than SQL: it posts an equal-and-opposite
// CORRECTION that names the transaction it corrects, keeps the hash chain
// intact, leaves the original row untouched (the ledger is evidence, so its
// history is never edited), and is idempotent on `correction:<txId>` so a
// re-run cannot double-reverse.
//
// Why these liabilities have to go before mainnet: the faucet credits CUSTODY
// as well as the customer, so every one of them is a claim backed by coins no
// custodian holds. Flipping to mainnet with them on the books would mean the
// venue genuinely owes what it never received.
const Database = require('better-sqlite3');
const { Ledger } = require('/opt/blockle/exchange-custody/dist/src/ledger.js');

const OWNER = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!OWNER) {
  console.error('usage: node reverse-faucet.js <owner> [--apply]');
  process.exit(2);
}

const db = new Database('/var/lib/exchange-custody/ledger.db');
const l = new Ledger(db);

// Skip anything already corrected, so this is safe to run twice.
const ids = db.prepare(
  "SELECT DISTINCT t.id AS id FROM ledger_tx t" +
  " JOIN ledger_posting p ON p.tx_id = t.id" +
  " WHERE t.actor = 'testnet-faucet' AND p.kind = 'user' AND p.owner = ?" +
  " AND NOT EXISTS (SELECT 1 FROM ledger_tx c WHERE c.corrects_tx_id = t.id)" +
  " ORDER BY t.id"
).all(OWNER).map((r) => r.id);

// Every asset this owner holds, so the report is not USDT-shaped by accident.
const assets = db.prepare(
  "SELECT DISTINCT asset FROM ledger_posting WHERE kind = 'user' AND owner = ?"
).all(OWNER).map((r) => r.asset);

const snapshot = () => assets
  .map((a) => `${a}=${l.balance({ kind: 'user', owner: OWNER, asset: a })}`)
  .join(' ');

console.log(`owner ${OWNER}`);
console.log(`  uncorrected faucet txs : ${ids.length}`);
console.log(`  balances before        : ${snapshot()}`);

if (!APPLY) {
  console.log('  (dry run — pass --apply to post the corrections)');
  process.exit(0);
}

let done = 0;
// ONE TRANSACTION. A partial reversal would leave the books in a state nobody
// designed: some of the fake liability gone, some of it still owed.
db.transaction(() => {
  for (const id of ids) {
    l.reverse(
      id,
      'operator:security-audit-2026-11-25',
      'faucet-minted liability reversed before mainnet. These credits were ' +
      'created by the testnet faucet during an authenticated vulnerability ' +
      'scan (2026-11-23/25) and are backed by no custody. See the audit.',
    );
    done++;
  }
})();

console.log(`  corrections posted     : ${done}`);
console.log(`  balances after         : ${snapshot()}`);
console.log(`  ledger verify          : ${JSON.stringify(l.verify())}`);
