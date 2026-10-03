const express = require('express');
const dns = require('node:dns').promises;
const net = require('node:net');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const UA = 'Mozilla/5.0 (compatible; ClearReader/1.0)';
const TRUSTED = [
  'wikipedia.org', 'britannica.com', 'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk',
  'npr.org', 'theguardian.com', 'nytimes.com', 'washingtonpost.com', 'economist.com',
  'nature.com', 'science.org', 'who.int', 'un.org', 'arxiv.org', 'mozilla.org',
  'w3.org', 'ietf.org', 'python.org', 'nodejs.org', 'github.com', 'stackoverflow.com',
  'vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'vietnamnet.vn', 'dantri.com.vn'
];
const BLOCKED = [
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com',
  'facebook.net', 'adsrvr.org', 'taboola.com', 'outbrain.com', 'scorecardresearch.com',
  'hotjar.com', 'criteo.com', 'adnxs.com', 'amazon-adsystem.com'
];

const inList = (h, list) => list.some(d => h === d || h.endsWith('.' + d));
const blocked = h => inList(h, BLOCKED);
const trusted = h => inList(h, TRUSTED) || /\.(gov|edu|mil)(\.[a-z]{2})?$/.test(h);

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return s.includes('.') ? isPrivate(s.slice(7)) : true;
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}

async function safeFetch(raw, hops = 0) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) throw new Error('blocked');
  if (blocked(u.hostname)) throw new Error('blocked');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new Error('blocked');
  const res = await fetch(u, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en' }
  });
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) {
    if (hops >= 3) throw new Error('redirects');
    return safeFetch(new URL(loc, u).href, hops + 1);
  }
  return { res, url: u.href };
}

async function readText(res, max = 2e6) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { reader.cancel(); break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function clean(html, base) {
  const doc = new JSDOM('<body>' + html + '</body>').window.document;
  doc.querySelectorAll('script,style,iframe,img,picture,video,audio,source,svg,form,input,button,object,embed,link,meta,noscript').forEach(n => n.remove());
  doc.body.querySelectorAll('*').forEach(el => {
    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    for (const a of [...el.attributes]) el.removeAttribute(a.name);
    if (href) {
      try {
        const x = new URL(href, base);
        if (x.protocol === 'https:' && !blocked(x.hostname)) el.setAttribute('data-u', x.href);
      } catch {}
    }
  });
  return doc.body.innerHTML;
}

function extract(html, url) {
  const dom = new JSDOM(html, { url });
  const art = new Readability(dom.window.document).parse();
  if (!art || !art.content) throw new Error('empty');
  return {
    title: (art.title || '').slice(0, 300),
    host: new URL(url).hostname.replace(/^www\./, ''),
    html: clean(art.content, url)
  };
}

const tmp = new JSDOM('').window.document;
const plain = s => { const d = tmp.createElement('div'); d.innerHTML = String(s || ''); return d.textContent.trim(); };

async function searchWeb(q) {
  if (process.env.BRAVE_API_KEY) {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=20&q=' + encodeURIComponent(q), {
      headers: { 'x-subscription-token': process.env.BRAVE_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('search');
    const d = await r.json();
    return (d.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
  }
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error('search');
  const doc = new JSDOM(await r.text()).window.document;
  return [...doc.querySelectorAll('.result')].map(n => {
    const a = n.querySelector('a.result__a');
    if (!a) return null;
    let href = a.getAttribute('href') || '';
    try { const u = new URL(href, 'https://duckduckgo.com'); href = u.searchParams.get('uddg') || u.href; } catch {}
    return { title: a.textContent, url: href, snippet: n.querySelector('.result__snippet')?.textContent };
  }).filter(Boolean);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000'
  });
  next();
});

const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
app.use('/api', (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  res.set('Cache-Control', 'no-store');
  if (n > 60) return res.status(429).json({ error: 'rate' });
  next();
});

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'query' });
  try {
    const seen = new Set();
    const items = [];
    for (const r of await searchWeb(q)) {
      let u;
      try { u = new URL(r.url); } catch { continue; }
      if (u.protocol !== 'https:' || blocked(u.hostname) || seen.has(u.href)) continue;
      seen.add(u.href);
      const host = u.hostname.replace(/^www\./, '');
      items.push({ title: plain(r.title) || host, url: u.href, host, snippet: plain(r.snippet).slice(0, 220), trusted: trusted(host) });
    }
    items.sort((a, b) => b.trusted - a.trusted);
    res.json({ items: items.slice(0, 15) });
  } catch {
    res.status(502).json({ error: 'unavailable' });
  }
});

app.get('/api/read', async (req, res) => {
  try {
    const { res: r, url } = await safeFetch(String(req.query.url || ''));
    if (!r.ok || !(r.headers.get('content-type') || '').includes('text/html')) throw new Error('type');
    res.json(extract(await readText(r), url));
  } catch (e) {
    res.status(e.message === 'blocked' ? 400 : 502).json({ error: 'unavailable' });
  }
});

app.use(express.static('public', { maxAge: '1h' }));

if (require.main === module) {
  app.listen(process.env.PORT || 3000, '0.0.0.0');
}
module.exports = { isPrivate, clean, extract };
