// Clear every remaining seeded balance, before reconciliation is pointed at a
// real custodian.
//
// WHY IT HAS TO HAPPEN. These liabilities were created by the faucet and by
// test fixtures; no custodian holds anything behind them. Point RECONCILE_SOURCE
// at BitGo with them on the books and brand-new empty prod wallets, and every
// asset reports a shortfall and withdrawals halt across the board.
//
// TWO RULES THE ORDER DEPENDS ON:
//
//   1. THE PENDING WITHDRAWAL GOES THROUGH ITS STATE MACHINE, not the ledger.
//      reject() refunds the customer and releases INFLIGHT as one transaction
//      and leaves the withdrawal row terminal. Reversing the ledger posting
//      instead would balance the books while leaving a withdrawal row that
//      believes it is still owed — the books and the state machine disagreeing
//      is exactly the condition reconciliation cannot explain.
//
//   2. EVERYTHING ELSE UNWINDS NEWEST-FIRST. A trade spent coins a deposit
//      provided; reversing the deposit first would drive the account negative
//      and the ledger — correctly — refuses that. Undoing history backwards
//      means every account is solvent at every intermediate step.
const Database = require('better-sqlite3');
const { Ledger, AccountKind } = require('/opt/blockle/exchange-custody/dist/src/ledger.js');
const { Withdrawals } = require('/opt/blockle/exchange-custody/dist/src/withdrawals.js');

const APPLY = process.argv.includes('--apply');
const DB = '/var/lib/exchange-custody/ledger.db';
const db = new Database(DB);
const l = new Ledger(db);
const ACTOR = 'operator:security-audit-2026-11-25';
const NOTE =
  'seeded testnet liability cleared before mainnet: created by the faucet and ' +
  'by test fixtures, backed by no custody. See the 2026-11-25 audit.';

// --- what is outstanding -----------------------------------------------------

const balances = () => db.prepare(
  "SELECT kind, owner, asset, delta FROM ledger_posting"
).all().reduce((acc, r) => {
  const k = `${r.kind}|${r.owner}|${r.asset}`;
  acc[k] = (acc[k] ?? 0n) + BigInt(r.delta);   // TEXT -> BigInt, never a double
  return acc;
}, {});

const nonZero = () => Object.entries(balances())
  .filter(([, v]) => v !== 0n)
  .sort(([a], [b]) => a.localeCompare(b));

const show = (label) => {
  console.log(`\n${label}`);
  const rows = nonZero();
  if (rows.length === 0) { console.log('  (everything is zero)'); return; }
  for (const [k, v] of rows) {
    const [kind, owner, asset] = k.split('|');
    console.log(`  ${kind.padEnd(9)} ${(owner || '-').padEnd(22)} ${asset.padEnd(11)} ${v}`);
  }
};

const pending = db.prepare(
  "SELECT id FROM withdrawal WHERE state NOT IN ('confirmed','rejected','failed')"
).all().map((r) => r.id);

// Deposits and trades only. The withdrawal_request is settled by reject()
// below; reversing it as well would refund the customer twice.
const ids = db.prepare(
  "SELECT id FROM ledger_tx" +
  " WHERE reason IN ('deposit','trade')" +
  " AND id NOT IN (SELECT corrects_tx_id FROM ledger_tx WHERE corrects_tx_id IS NOT NULL)" +
  " ORDER BY id DESC"                      // newest first — see rule 2
).all().map((r) => r.id);

show('BEFORE');
console.log(`\npending withdrawals to reject : ${pending.length} ${JSON.stringify(pending)}`);
console.log(`deposit/trade txs to reverse  : ${ids.length}`);

if (!APPLY) {
  console.log('\n(dry run — pass --apply)');
  process.exit(0);
}

// --- do it -------------------------------------------------------------------

const w = new Withdrawals(db, l, {
  autoApprove: false,
  approvalThreshold: {},
  maxPerRequest: {},
  velocityCap24h: {},
  requireAllowlistedAddress: false,
});

for (const id of pending) {
  w.reject(id, ACTOR, NOTE);
  console.log(`  rejected withdrawal ${id} (customer refunded, INFLIGHT released)`);
}

let n = 0;
db.transaction(() => {
  for (const id of ids) { l.reverse(id, ACTOR, NOTE); n++; }
})();
console.log(`  reversed ${n} transactions`);

show('AFTER');
console.log(`\nledger verify : ${JSON.stringify(l.verify())}`);
