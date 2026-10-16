// Blockle Social client. The server serves this shell for every /social/* path; we route by
// location.pathname and render into #app. Plain anchors navigate (full reload, cached JS).
// All user content is escaped. Mutations carry the shared accounts CSRF token.
(() => {
  const BASE = document.body.dataset.base;
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null, CSRF = null;

  async function api(method, path, body) {
    const h = {}; if (body) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && CSRF) h['X-CSRF-Token'] = CSRF;
    const r = await fetch(BASE + path, { method, credentials: 'include', headers: h, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }
  const fmt = (n) => (Math.round(n * 10) / 10).toString();
  const tierTag = (t) => t && t !== 'new' ? `<span class="tier ${t}">${t}</span>` : '';
  const ago = (ms) => { const s = (Date.now() - ms) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };

  function header() {
    const w = $('#who');
    if (!me) { w.innerHTML = `<a class="btn ghost sm" href="/account/login">Sign in</a>`; return; }
    w.innerHTML = `<span class="pill gold">◆ ${me.blockUnits} BLOCK</span> <span class="pill">${esc(me.handle)} · ${fmt(me.karma)}</span>`;
  }

  // ---- post card ----
  function postCard(p, { full = false } = {}) {
    const el = document.createElement('div'); el.className = 'card';
    const bodyHtml = p.kind === 'link'
      ? `<a class="excerpt" href="${esc(p.body)}" rel="nofollow noopener" target="_blank">${esc(p.body)}</a>`
      : (full ? `<div class="excerpt">${esc(p.body)}</div>` : (p.body ? `<div class="excerpt">${esc(p.body.slice(0, 240))}${p.body.length > 240 ? '…' : ''}</div>` : ''));
    el.innerHTML = `
      <div class="vote" data-type="post" data-id="${p.id}">
        <button class="up" aria-label="upvote">▲</button>
        <span class="n">${fmt(p.score)}</span>
        <button class="down" aria-label="downvote">▼</button>
      </div>
      <div class="body">
        <div class="meta">${p.community ? `<a href="${BASE}/c/${esc(p.community.name)}">b/${esc(p.community.name)}</a> · ` : ''}<span class="t">${esc(p.author.handle)}</span> ${tierTag(p.author.tier)} · <span class="t">${ago(p.createdAt)}</span></div>
        <a href="${BASE}/post/${p.id}"><div class="title">${esc(p.title)}</div></a>
        ${bodyHtml}
        <div class="acts">
          <a href="${BASE}/post/${p.id}">💬 ${p.comments || 0}</a>
          <button class="tip" data-type="post" data-id="${p.id}">◆ Tip</button>
        </div>
      </div>`;
    wireVote(el); wireTip(el);
    return el;
  }

  function wireVote(el) {
    const v = $('.vote', el); if (!v) return;
    let cur = 0;
    const send = async (dir) => {
      if (!me) { location.href = '/account/login'; return; }
      const next = cur === dir ? 0 : dir;
      const r = await api('POST', '/api/vote', { targetType: v.dataset.type, targetId: v.dataset.id, dir: next });
      if (r.status === 200) { cur = next; $('.up', v).classList.toggle('on', next === 1); $('.down', v).classList.toggle('on', next === -1); }
      else toast(r.data.error || 'Could not vote.');
    };
    $('.up', v).addEventListener('click', () => send(1));
    $('.down', v).addEventListener('click', () => send(-1));
  }
  function wireTip(el) {
    const b = $('.tip', el); if (!b) return;
    b.addEventListener('click', async () => {
      if (!me) { location.href = '/account/login'; return; }
      const amt = parseInt(prompt('Tip how much BLOCK?', '5'), 10);
      if (!amt) return;
      const r = await api('POST', '/api/tip', { targetType: b.dataset.type, targetId: b.dataset.id, amount: amt });
      if (r.status === 200) { toast(`Tipped ${r.data.net} BLOCK ◆`, 'ok'); me.blockUnits -= amt; header(); }
      else toast(r.data.error || 'Tip failed.');
    });
  }
  function toast(t, kind = 'err') { let m = $('#msg'); if (!m) { m = document.createElement('div'); m.id = 'msg'; app.prepend(m); } m.className = 'msg ' + kind; m.textContent = t; setTimeout(() => { m.className = 'msg'; }, 4000); }

  // ---- views ----
  const views = {
    async home(sort = 'hot', c = null) {
      const r = await api('GET', `/api/feed?sort=${sort}${c ? '&c=' + encodeURIComponent(c) : ''}`);
      const tabs = ['hot', 'new', 'top'].map((s) => `<a href="${BASE}${c ? '/c/' + c : ''}?sort=${s}" class="${s === sort ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</a>`).join('');
      app.innerHTML = `${c ? `<h1>b/${esc(c)}</h1>` : '<h1>Home</h1>'}<div class="tabs">${tabs}</div><div id="feed"></div>`;
      const feed = $('#feed');
      if (!r.data.posts || !r.data.posts.length) { feed.innerHTML = '<p class="muted">Nothing here yet. Be the first to post.</p>'; return; }
      r.data.posts.forEach((p) => feed.appendChild(postCard(p)));
    },
    async post(id) {
      const r = await api('GET', '/api/post/' + encodeURIComponent(id));
      if (r.status !== 200) { app.innerHTML = '<p class="muted">Post not found.</p>'; return; }
      app.innerHTML = '<div id="pc"></div><div class="panel" style="margin-top:14px"><h1 style="font-size:16px">Comments</h1><div id="cform"></div><div id="cs"></div></div>';
      $('#pc').appendChild(postCard(r.data.post, { full: true }));
      $('#cform').innerHTML = me
        ? `<textarea id="cbody" placeholder="Add a comment…"></textarea><button class="btn sm" id="csend" style="margin-top:8px">Comment</button>`
        : `<p class="muted"><a href="/account/login">Sign in</a> to comment.</p>`;
      if (me) $('#csend').addEventListener('click', async () => {
        const body = $('#cbody').value.trim(); if (!body) return;
        const cr = await api('POST', '/api/comments', { pid: id, body });
        if (cr.status === 200) location.reload(); else toast(cr.data.error || 'Could not comment.');
      });
      const cs = $('#cs');
      (r.data.comments || []).forEach((c) => {
        const d = document.createElement('div'); d.className = 'cmt';
        d.innerHTML = `<div class="meta"><span class="t">${esc(c.author.handle)}</span> ${tierTag(c.author.tier)} · ${ago(c.createdAt)} · <span class="t">${fmt(c.score)} pts</span></div><div class="excerpt">${esc(c.body)}</div>
          <div class="acts"><div class="vote" data-type="comment" data-id="${c.id}"><button class="up">▲</button><span class="n">${fmt(c.score)}</span><button class="down">▼</button></div><button class="tip" data-type="comment" data-id="${c.id}">◆ Tip</button></div>`;
        wireVote(d); wireTip(d); cs.appendChild(d);
      });
    },
    async communities() {
      const r = await api('GET', '/api/communities');
      const list = (r.data.communities || []).map((c) => `<div class="card"><div class="body"><a href="${BASE}/c/${esc(c.name)}"><div class="title">b/${esc(c.name)} — ${esc(c.title)}</div></a><div class="excerpt">${esc(c.desc)}</div><div class="meta">${c.members} member(s)</div></div></div>`).join('') || '<p class="muted">No communities yet.</p>';
      const canCreate = me && ['member', 'trusted', 'curator', 'luminary'].includes(me.tier);
      app.innerHTML = `<h1>Communities</h1>${canCreate ? `<div class="panel" style="margin-bottom:14px"><label>New community</label><input id="cn" placeholder="name (a-z0-9_)"><label>Title</label><input id="ct"><label>Description</label><input id="cd"><button class="btn sm" id="cc" style="margin-top:10px">Create</button></div>` : (me ? '<p class="muted">Reach the Member tier (100 karma) to create a community.</p>' : '')}<div>${list}</div>`;
      if (canCreate) $('#cc').addEventListener('click', async () => {
        const r2 = await api('POST', '/api/communities', { name: $('#cn').value, title: $('#ct').value, desc: $('#cd').value });
        if (r2.status === 200) location.href = `${BASE}/c/${r2.data.community.name}`; else toast(r2.data.error || 'Could not create.');
      });
    },
    async submit() {
      if (!me) { location.href = '/account/login'; return; }
      const r = await api('GET', '/api/communities');
      const opts = (r.data.communities || []).map((c) => `<option value="${esc(c.name)}">b/${esc(c.name)}</option>`).join('');
      app.innerHTML = `<h1>New post</h1><div class="panel">
        <label>Community</label><select id="cid">${opts || '<option value="">(create one first)</option>'}</select>
        <label>Type</label><select id="kind"><option value="text">Text</option><option value="link">Link</option></select>
        <label>Title</label><input id="title" maxlength="200">
        <label id="blabel">Body</label><textarea id="body"></textarea>
        <button class="btn" id="go" style="margin-top:12px">Post</button></div>`;
      $('#kind').addEventListener('change', (e) => { $('#blabel').textContent = e.target.value === 'link' ? 'URL' : 'Body'; });
      $('#go').addEventListener('click', async () => {
        const r2 = await api('POST', '/api/posts', { cid: $('#cid').value, kind: $('#kind').value, title: $('#title').value, body: $('#body').value });
        if (r2.status === 200) location.href = `${BASE}/post/${r2.data.id}`; else toast(r2.data.error || 'Could not post.');
      });
    },
  };

  function route() {
    const p = location.pathname.replace(/\/+$/, '');
    const rest = p.slice(BASE.length);
    const sort = new URLSearchParams(location.search).get('sort') || 'hot';
    if (rest.startsWith('/post/')) return views.post(rest.slice(6));
    if (rest.startsWith('/c/')) return views.home(sort, rest.slice(3));
    if (rest === '/communities') return views.communities();
    if (rest === '/submit') return views.submit();
    return views.home(sort);
  }

  (async () => {
    const r = await api('GET', '/api/me');
    me = r.data.user; CSRF = r.data.csrf || null;
    header(); route();
  })();
})();
