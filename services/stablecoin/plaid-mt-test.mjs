// End-to-end sandbox test: Plaid (connect+verify a bank) -> Modern Treasury
// (external account) -> an ACH credit payment order. Uses Plaid's sandbox
// public-token shortcut so no browser Link widget is needed.
import * as plaid from './src/plaid.js';
import * as mt from './src/modern_treasury.js';

(async () => {
  console.log('plaid configured:', plaid.configured(), 'env:', plaid.env());
  console.log('mt configured:', mt.configured(), 'env:', mt.env());

  const pub = await plaid.sandboxPublicToken();
  console.log('sandbox public_token:', pub.slice(0, 24) + '…');
  const { accessToken } = await plaid.exchange(pub);
  console.log('access_token:', accessToken.slice(0, 20) + '…');
  const accts = await plaid.accounts(accessToken);
  console.log('accounts:', accts.map((a) => a.name + ' ••' + a.mask + ' (' + a.subtype + ')').join(', '));
  const acct = accts.find((a) => a.subtype === 'checking') || accts[0];
  const proc = await plaid.mtProcessorToken(accessToken, acct.id);
  console.log('MT processor_token:', proc.slice(0, 24) + '…');

  const cp = await mt.createCounterpartyFromPlaid({ name: 'USDB Plaid Test', processorToken: proc, idemKey: 'plaid-cp-' + Date.now() });
  console.log('MT counterparty:', cp.counterpartyId, 'external:', cp.externalAccountId);
  const po = await mt.createPaymentOrder({ amountCents: 100, direction: 'credit', externalAccountId: cp.externalAccountId, description: 'USDB Plaid test $1', idemKey: 'plaid-po-' + Date.now() });
  console.log('payment_order:', po.id, '| status:', po.status, '| amount:', po.amount);
  console.log('\nPLAID -> MT CHAIN OK — bank connected via Plaid, $1 ACH credit queued via MT.');
})().catch((e) => { console.error('PLAID-MT TEST FAILED:', e.message); process.exit(1); });
