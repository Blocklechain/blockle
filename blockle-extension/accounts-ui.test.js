// accounts-ui.test.js — unit tests for the MoonPay SELL pre-fill helpers in the
// multi-chain accounts screen.
//
//   node accounts-ui.test.js
//
// Covers:
//   • sellAmountFrom: positive balances -> trimmed amount; zero/blank/junk -> null
//   • heldSellAmount: native row (row 0) + token row (by symbol) from holdings
//   • end-to-end: baseCurrencyAmount IS present in the sell URL when balance > 0
//     and is OMITTED when the balance is 0 (nothing to pre-fill)
//
// No DOM, no network: Wiring is injected as a global stub, fetch is unused.

const MP = require('./moonpay.js');
// accounts-ui.js touches the DOM only inside event handlers, not at load, so it
// requires cleanly in node; it exports its helpers on module.exports.
const AUI = require('./accounts-ui.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// ---- sellAmountFrom --------------------------------------------------------
{
  eq('whole balance', AUI.sellAmountFrom('5'), '5');
  eq('decimal balance', AUI.sellAmountFrom('1.5'), '1.5');
  eq('strips trailing zeros', AUI.sellAmountFrom('2.5000'), '2.5');
  eq('caps at 8 fractional digits', AUI.sellAmountFrom('1.123456789123'), '1.12345678');
  eq('strips thousands commas', AUI.sellAmountFrom('1,234.50'), '1234.5');
  eq('zero -> null', AUI.sellAmountFrom('0'), null);
  eq('zero decimal -> null', AUI.sellAmountFrom('0.00'), null);
  eq('blank -> null', AUI.sellAmountFrom(''), null);
  eq('dash -> null', AUI.sellAmountFrom('—'), null);
  eq('null -> null', AUI.sellAmountFrom(null), null);
  eq('junk -> null', AUI.sellAmountFrom('abc'), null);
}

// ---- heldSellAmount (injected Wiring stub) ---------------------------------
(async () => {
  const holdings = {
    ethereum: [
      { asset: { symbol: 'ETH' }, confirmed: '2500000000000000000', display: '2.5' },
      { asset: { symbol: 'USDC', address: '0xusdc' }, confirmed: '100000000', display: '100' },
      { asset: { symbol: 'DAI', address: '0xdai' }, confirmed: '0', display: '0' },
    ],
  };
  global.Wiring = { getHoldings: async (chain) => holdings[chain] || [] };

  eq('native held -> native row balance', await AUI.heldSellAmount('ethereum', { native: true }), '2.5');
  eq('token held by symbol', await AUI.heldSellAmount('ethereum', { symbol: 'USDC' }), '100');
  eq('token lowercase symbol matches', await AUI.heldSellAmount('ethereum', { symbol: 'usdc' }), '100');
  eq('zero-balance token -> null', await AUI.heldSellAmount('ethereum', { symbol: 'DAI' }), null);
  eq('unknown token -> null', await AUI.heldSellAmount('ethereum', { symbol: 'WETH' }), null);

  // ---- end-to-end: baseCurrencyAmount present when >0, omitted when 0 -------
  // Mirror doSell: amount from held balance -> MoonPay sell URL.
  const amtPos = await AUI.heldSellAmount('ethereum', { native: true });          // '2.5'
  const urlPos = MP.buildSellUrl({ apiKey: 'pk_test_x', baseCurrencyCode: 'eth',
    quoteCurrencyCode: 'usd', walletAddress: '0xABC',
    baseCurrencyAmount: amtPos || undefined });
  ok('balance>0 -> baseCurrencyAmount in sell URL', urlPos.indexOf('baseCurrencyAmount=2.5') >= 0);

  const amtZero = await AUI.heldSellAmount('ethereum', { symbol: 'DAI' });         // null
  const urlZero = MP.buildSellUrl({ apiKey: 'pk_test_x', baseCurrencyCode: 'dai',
    quoteCurrencyCode: 'usd', walletAddress: '0xABC',
    baseCurrencyAmount: amtZero || undefined });
  ok('balance==0 -> baseCurrencyAmount omitted from sell URL', urlZero.indexOf('baseCurrencyAmount=') < 0);

  console.log(`accounts-ui.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
