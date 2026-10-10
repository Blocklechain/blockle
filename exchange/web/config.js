/* config.js — frontend runtime config. Safe to serve as-is.
 *
 * By default the frontend talks to the relay on the SAME ORIGIN that serves
 * these pages (apiBase = ''), which is how exchange.blockle.org is deployed.
 * Point it elsewhere for local dev against a relay on another port.
 *
 * NO SECRETS HERE. Only public URLs. Keys live in the user's wallet.
 */
window.EXCHANGE_CONFIG = {
  // Relay HTTP base. '' = same origin. e.g. 'http://127.0.0.1:8900' in dev.
  apiBase: '',
  // WebSocket base. '' = derived from apiBase/origin (http->ws, https->wss).
  wsBase: ''

  // Bitcoin + Sui leg networks. TESTNET-FIRST: both default to testnet. Set to
  // 'mainnet' only once the relay/operator has flipped the mainnet flag and
  // completed legal/compliance review (see the footer note). Public config
  // only — no keys. These drive the BTC/Sui wallet connectors in connectors.js.
  // , btc: { network: 'testnet' }   // 'testnet' | 'signet' | 'mainnet'
  // , sui: { network: 'testnet' }   // 'testnet' | 'devnet' | 'mainnet'

  // MoonPay fiat on/off-ramp (optional; omit to use the built-in sandbox key).
  // PUBLISHABLE key only — never the secret. Signing, when enabled, happens on
  // the server-side endpoint below; the sandbox key needs no signing.
  // moonpay: {
  //   apiKey: 'pk_live_...',                         // default: pk_test_ sandbox key
  //   signingEndpoint: 'https://blockle.org/api/moonpay/sign', // '' = unsigned (sandbox)
  //   theme: 'dark',
  //   baseCurrencyCode: 'usd',
  //   currencyCodes: null                            // per-chain override map (see moonpay.js DEFAULT_MAP)
  // }
};
