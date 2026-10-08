// background.js — the wallet engine (MV3 service worker).
//
// Handles provider RPC from content scripts, enforces per-origin connection
// permissions, opens approval windows for connect/sign, and broadcasts events
// (accountsChanged / connect / disconnect) to a site's tabs. Signing itself
// happens in the approval window (which can unlock the vault); this worker never
// holds private keys.
importScripts('storage.js', 'chain.js');

const pending = new Map(); // requestId -> { resolve, windowId }
let reqSeq = 0;

const err = (code, message) => ({ error: { code, message } });

async function walletAddress() {
  const list = (await Store.get('wallets')).wallets || [];
  const sel = (await Store.get('selectedId')).selectedId;
  const rec = list.find((w) => w.id === sel) || list[0];
  return rec ? rec.address : null;
}
async function getSites() {
  return (await Store.get('sites')).sites || {};
}
async function setSites(s) {
  await Store.set({ sites: s });
}
async function isConnected(origin) {
  return !!(await getSites())[origin];
}

async function openApproval(type, origin, detail) {
  const id = 'req_' + ++reqSeq + '_' + Date.now();
  await Store.set({ ['pending:' + id]: { type, origin, ...(detail || {}) } });
  const qs = new URLSearchParams({ view: 'approve', req: id });
  const url = chrome.runtime.getURL('popup.html') + '?' + qs.toString();
  return new Promise((resolve) => {
    chrome.windows.create(
      { url, type: 'popup', width: 390, height: 650, focused: true },
      (win) => pending.set(id, { resolve, windowId: win && win.id })
    );
  });
}

async function finishApproval(id, result) {
  await Store.remove('pending:' + id);
  const p = pending.get(id);
  if (p) {
    pending.delete(id);
    p.resolve(result);
  }
}

// If the user closes an approval window without deciding, treat as rejection.
chrome.windows.onRemoved.addListener((winId) => {
  for (const [id, p] of pending) {
    if (p.windowId === winId) {
      pending.delete(id);
      Store.remove('pending:' + id);
      p.resolve({ approved: false, closed: true });
    }
  }
});

async function broadcast(origin, event, data) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || !t.url) continue;
      let o;
      try {
        o = new URL(t.url).origin;
      } catch {
        continue;
      }
      if (o === origin) chrome.tabs.sendMessage(t.id, { type: 'event', event, data }).catch(() => {});
    }
  } catch (_) {}
}

async function handle(method, params, origin) {
  const address = await walletAddress();
  switch (method) {
    case 'blockle_chainInfo':
      return { result: { chainId: 'blockle-main', ticker: 'BLOCK', name: 'Blockle' } };

    case 'blockle_getHeight': {
      const s = await Chain.stats();
      return { result: s ? s.height : null };
    }

    case 'blockle_accounts':
      return { result: (await isConnected(origin)) && address ? [address] : [] };

    case 'blockle_connect': {
      if (!address) return err(4100, 'No wallet is set up in Blockle Wallet');
      if (await isConnected(origin)) return { result: [address] };
      const dec = await openApproval('connect', origin, {});
      if (!dec.approved) return err(4001, 'User rejected the connection request');
      const sites = await getSites();
      sites[origin] = { connectedAt: Date.now(), address };
      await setSites(sites);
      broadcast(origin, 'connect', { address });
      broadcast(origin, 'accountsChanged', [address]);
      return { result: [address] };
    }

    case 'blockle_disconnect': {
      const sites = await getSites();
      delete sites[origin];
      await setSites(sites);
      broadcast(origin, 'disconnect', {});
      broadcast(origin, 'accountsChanged', []);
      return { result: true };
    }

    case 'blockle_getBalance': {
      if (!(await isConnected(origin))) return err(4100, 'Not connected — call connect() first');
      const a = await Chain.account(address);
      return { result: a ? { address, balance: a.balance, balanceFmt: a.balanceFmt, ticker: 'BLOCK' } : { address, balance: null } };
    }

    case 'blockle_signMessage': {
      if (!(await isConnected(origin))) return err(4100, 'Not connected — call connect() first');
      const message = params && params[0] != null ? String(params[0]) : '';
      const dec = await openApproval('sign', origin, { message });
      if (!dec.approved) return err(4001, 'User rejected the signature request');
      return { result: dec.payload };
    }

    case 'blockle_deployContract': {
      if (!(await isConnected(origin))) return err(4100, 'Not connected — call connect() first');
      const code = params && params[0] != null ? String(params[0]) : '';
      const gas = String((params && params[1]) || 200000);
      if (!/^[0-9a-fA-F]+$/.test(code) || code.length === 0) return err(4200, 'invalid contract bytecode');
      const dec = await openApproval('deploy', origin, { code, gas });
      if (!dec.approved) return err(4001, 'User rejected the deployment');
      return { result: dec.payload };
    }

    case 'blockle_tokenInit': {
      if (!(await isConnected(origin))) return err(4100, 'Not connected — call connect() first');
      const contractId = params && params[0] != null ? String(params[0]) : '';
      const gas = String((params && params[1]) || 100000);
      if (!/^[0-9a-fA-F]{64}$/.test(contractId)) return err(4200, 'invalid contract id');
      const dec = await openApproval('action', origin, { kind: 'init', contractId, gas });
      if (!dec.approved) return err(4001, 'User rejected the token init');
      return { result: dec.payload };
    }

    case 'blockle_createPool': {
      if (!(await isConnected(origin))) return err(4100, 'Not connected — call connect() first');
      const token = params && params[0] != null ? String(params[0]) : '';
      const blockAmt = String((params && params[1]) || 0);
      const tokenAmt = String((params && params[2]) || 0);
      const gas = String((params && params[3]) || 200000);
      if (!/^[0-9a-fA-F]{64}$/.test(token)) return err(4200, 'invalid token id');
      const dec = await openApproval('action', origin, { kind: 'pool', token, blockAmt, tokenAmt, gas });
      if (!dec.approved) return err(4001, 'User rejected the pool creation');
      return { result: dec.payload };
    }

    default:
      return err(4200, 'Unsupported method: ' + method);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'approve-response') {
        await finishApproval(msg.req, { approved: !!msg.approved, payload: msg.payload });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'wallet-state-changed') {
        // The popup tells us accounts changed or the wallet locked.
        const sites = await getSites();
        const accounts = msg.accounts || [];
        for (const origin of Object.keys(sites)) broadcast(origin, 'accountsChanged', accounts);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'revoke-site') {
        const sites = await getSites();
        delete sites[msg.origin];
        await setSites(sites);
        broadcast(msg.origin, 'disconnect', {});
        broadcast(msg.origin, 'accountsChanged', []);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'rpc') {
        const origin = msg.origin || (sender && sender.origin) || '';
        sendResponse(await handle(msg.method, msg.params || [], origin));
        return;
      }
      sendResponse(err(-1, 'unknown message'));
    } catch (e) {
      sendResponse(err(-1, String((e && e.message) || e)));
    }
  })();
  return true; // keep the message channel open for the async response
});
