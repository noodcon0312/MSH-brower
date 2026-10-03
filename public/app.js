(() => {
  const view = document.getElementById('view');
  const tabsEl = document.getElementById('tabs');
  const input = document.getElementById('q');
  let tabs = [];
  let active = 0;
  let seq = 0;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const cur = () => tabs.find(t => t.id === active);

  async function api(path, params) {
    const r = await fetch(path + '?' + new URLSearchParams(params));
    if (!r.ok) throw new Error('failed');
    return r.json();
  }

  function newTab() {
    const t = { id: ++seq, title: 'New tab', mode: 'home', q: '', url: '', items: [], page: null, error: false, loading: false };
    tabs.push(t);
    active = t.id;
    render();
    input.focus();
  }

  function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    tabs.splice(i, 1);
    if (!tabs.length) return newTab();
    if (active === id) active = tabs[Math.max(0, i - 1)].id;
    render();
  }

  async function search(t, q) {
    Object.assign(t, { mode: 'results', q, title: q, loading: true, error: false, items: [] });
    render();
    try { t.items = (await api('/api/search', { q })).items; } catch { t.error = true; }
    t.loading = false;
    render();
  }

  async function openPage(t, url) {
    Object.assign(t, { mode: 'page', url, loading: true, error: false, page: null });
    try { t.title = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    render();
    try {
      t.page = await api('/api/read', { url });
      t.title = t.page.title || t.page.host;
    } catch { t.error = true; }
    t.loading = false;
    render();
  }

  function go(t, text) {
    if (!text) return;
    if (/^https:\/\//i.test(text)) return openPage(t, text);
    if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return openPage(t, 'https://' + text);
    search(t, text);
  }

  function render() {
    const t = cur();
    document.body.dataset.mode = t.mode;
    document.body.classList.toggle('busy', t.loading);

    tabsEl.replaceChildren(...tabs.map(x => {
      const box = el('div', 'tab' + (x.id === active ? ' on' : ''));
      const label = el('button', 'tl', x.title);
      label.onclick = () => { active = x.id; render(); };
      const close = el('button', 'tx', 'x');
      close.setAttribute('aria-label', 'Close tab');
      close.onclick = () => closeTab(x.id);
      box.append(label, close);
      return box;
    }));

    input.value = t.mode === 'page' ? t.url : t.q;
    view.replaceChildren();
    if (t.mode === 'home' || t.loading && t.mode === 'results') return;

    if (t.mode === 'page') {
      const back = el('button', 'bk', 'Back');
      back.onclick = () => { t.mode = t.q ? 'results' : 'home'; render(); };
      view.append(back);
      if (t.error) return view.append(el('p', 'm', 'Unavailable'));
      if (t.page) {
        const art = el('article', 'art');
        const body = el('div');
        body.innerHTML = t.page.html;
        art.append(el('h1', null, t.page.title), el('div', 'h', t.page.host), body);
        view.append(art);
      }
      return;
    }

    if (t.error) return view.append(el('p', 'm', 'Unavailable'));
    if (!t.items.length) return view.append(el('p', 'm', 'No results'));
    for (const r of t.items) {
      const item = el('div', 'item');
      item.dataset.u = r.url;
      item.tabIndex = 0;
      item.setAttribute('role', 'link');
      const head = el('div', 'h', r.host);
      if (r.trusted) head.append(el('span', 'v', 'Verified'));
      item.append(head, el('div', 't', r.title));
      if (r.snippet) item.append(el('div', 's', r.snippet));
      view.append(item);
    }
  }

  view.addEventListener('click', e => {
    const a = e.target.closest('[data-u]');
    if (a) { e.preventDefault(); openPage(cur(), a.dataset.u); }
  });
  view.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.dataset.u) openPage(cur(), e.target.dataset.u);
  });
  document.getElementById('bar').addEventListener('submit', e => {
    e.preventDefault();
    go(cur(), input.value.trim());
  });
  document.getElementById('add').onclick = newTab;

  newTab();
})();
