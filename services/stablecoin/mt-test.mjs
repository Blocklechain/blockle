// Sandbox smoke test for the Modern Treasury rail: ping, create a counterparty
// with a test bank account, and issue a $1 ACH credit (payout) payment order.
import * as mt from './src/modern_treasury.js';

const [, , amountUsd = '1', email = 'Silentfriar@gmail.com'] = process.argv;
(async () => {
  console.log('configured:', mt.configured(), 'env:', mt.env());
  console.log('ping:', JSON.stringify(await mt.ping()));
  const cp = await mt.createCounterparty({
    name: 'USDB Test Redeemer',
    routingNumber: '021000021',
    accountNumber: '123456789',
    accountType: 'checking',
    email,
    idemKey: 'usdb-test-cp-' + Date.now(),
  });
  console.log('counterparty:', cp.counterpartyId, 'externalAccount:', cp.externalAccountId);
  const po = await mt.createPaymentOrder({
    amountCents: Math.round(Number(amountUsd) * 100),
    direction: 'credit',
    externalAccountId: cp.externalAccountId,
    description: 'USDB redeem test $' + amountUsd,
    idemKey: 'usdb-test-po-' + Date.now(),
  });
  console.log('payment_order:', po.id, '| status:', po.status, '| amount(cents):', po.amount, '| dir:', po.direction);
  console.log('\nMT RAIL OK — $' + amountUsd + ' ACH credit queued to the test bank.');
})().catch((e) => { console.error('MT TEST FAILED:', e.message); process.exit(1); });
