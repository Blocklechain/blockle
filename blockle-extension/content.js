// content.js — runs in the isolated content-script world on every page.
// 1) injects inpage.js into the page's own JS context so `window.blockle` exists
// 2) relays provider requests page → background and responses back
// 3) relays background events (accountsChanged / connect / disconnect) → page
(function () {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inpage.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {}

  // page -> background
  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'blockle-inpage') return;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'rpc',
        method: d.method,
        params: d.params,
        origin: location.origin,
      });
      if (res && res.error) {
        window.postMessage({ source: 'blockle-content', id: d.id, error: res.error }, '*');
      } else {
        window.postMessage({ source: 'blockle-content', id: d.id, result: res ? res.result : null }, '*');
      }
    } catch (err) {
      window.postMessage(
        { source: 'blockle-content', id: d.id, error: { message: String((err && err.message) || err) } },
        '*'
      );
    }
  });

  // background -> page (events)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'event') {
      window.postMessage({ source: 'blockle-content', event: msg.event, data: msg.data }, '*');
    }
  });
})();
