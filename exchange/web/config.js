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
};
