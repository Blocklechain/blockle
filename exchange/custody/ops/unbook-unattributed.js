// Un-book the XRP activation reserve.
//
// BitGo funds a new XRP wallet with the protocol's base reserve to activate the
// account. The deposit watcher saw that incoming transfer, found no customer
// had been issued the address, and parked it in __unattributed__ — which is
// exactly right as a default, but the money is the VENUE'S OWN and is not a
// liability to anybody.
//
// It also did not reconcile: the watcher credited the transfer value
// (1,222,500 drops) while BitGo reports a confirmed balance of 1,200,000, so
// the books claimed 22,500 drops more than the custodian holds — a SHORTFALL,
// which halted XRP withdrawals. Reversing the credit takes the books to zero
// and leaves custody holding the reserve, which reconciles as a benign surplus:
// the venue holds coins it owes to nobody, which is the truth.
const Database = require('better-sqlite3');
const { Ledger } = require('/opt/blockle/exchange-custody/dist/src/ledger.js');

const APPLY = process.argv.includes('--apply');
const db = new Database('/var/lib/exchange-custody/ledger.db');
const l = new Ledger(db);

const ids = db.prepare(
  "SELECT DISTINCT t.id AS id FROM ledger_tx t" +
  " JOIN ledger_posting p ON p.tx_id = t.id" +
  " WHERE t.actor = 'deposit-watcher' AND p.owner = '__unattributed__'" +
  " AND NOT EXISTS (SELECT 1 FROM ledger_tx c WHERE c.corrects_tx_id = t.id)"
).all().map((r) => r.id);

const bal = (kind, owner, asset) => l.balance({ kind, owner, asset });
const show = (tag) => console.log(
  `  ${tag}: unattributed=${bal('user', '__unattributed__', 'XRP')} ` +
  `custody=${bal('custody', '', 'XRP')}`);

console.log(`uncorrected unattributed credits: ${ids.length}`);
show('before');
if (!APPLY) { console.log('  (dry run — pass --apply)'); process.exit(0); }

db.transaction(() => {
  for (const id of ids) {
    l.reverse(id, 'operator:security-audit-2026-11-25',
      'XRP activation reserve un-booked: BitGo funds a new XRP wallet with the ' +
      'base reserve to activate the account. That is the venue\'s own money, ' +
      'not a customer liability, and crediting it as one put the books 22,500 ' +
      'drops above what the custodian confirms — halting XRP withdrawals.');
  }
})();
show('after');
console.log(`  ledger verify: ${JSON.stringify(l.verify())}`);
