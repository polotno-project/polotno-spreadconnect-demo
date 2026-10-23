// Backend for the Polotno + Spreadconnect demo.
//
// The editor runs in the browser, so it cannot hold the Spreadconnect credentials.
// This server holds them and exposes:
//
//   GET /health
//   GET /spreadconnect/print-area
//   POST /spreadconnect/mockups
//
// Env:
//   SPREADCONNECT_LIVE_API_KEY
//   ALLOWED_ORIGINS comma-separated, defaults to localhost:5173

import http from 'node:http';

const env = process.env;
const PORT = Number(env.PORT || 8787);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGINS = (
  env.ALLOWED_ORIGINS ||
  'http://localhost:5173'
).split(',');

const SIDES = ['front', 'back'];

const MAX_BODY = 25 * 1024 * 1024;

// --- helpers ------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cached(fn, ttlMs = 60 * 60 * 1000) {
  const cache = new Map();
  return async (key) => {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await fn(key);
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  };
}

async function api(base, token, path, { method = 'GET', body, headers = {} } = {}) {
  // A provider with its own auth header passes Authorization: undefined.
  const allHeaders = Object.fromEntries(
    Object.entries({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }).filter(
      ([, v]) => v !== undefined
    )
  );
  const res = await fetch(base + path, {
    method,
    headers: allHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.message || json?.result || text;
    throw new HttpError(502, `${method} ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

// The demo posts base64 PNGs per side. Keep only real, non-empty PNG data.
function readSides(body) {
  const sides = {};
  for (const side of SIDES) {
    const value = body?.files?.[side];
    if (!value) continue;
    const base64 = String(value).replace(/^data:image\/png;base64,/, '');
    if (!base64.startsWith('iVBOR')) throw new HttpError(400, `${side} is not a PNG`);
    sides[side] = base64;
  }
  if (!Object.keys(sides).length) throw new HttpError(400, 'No design to send');
  return sides;
}

// --- Spreadconnect ----------------------------------------------------------------

const SC_API = 'https://api.spreadconnect.app';
// Men's Premium T-Shirt. Spreadconnect previews only work on its hotspots.
const SC_PRODUCT = Number(env.SPREADCONNECT_PRODUCT_TYPE || 812);
const SC_COLORS = { black: '2', blue: '317', red: '366' };
const SC_HOTSPOTS = { front: 'FULL_FRONT', back: 'FULL_BACK' };
// Exported at 150 DPI; Spreadconnect takes PNG under 10 MB.
const SC_DPI = 150;

function scKey() {
  if (!env.SPREADCONNECT_LIVE_API_KEY) throw new HttpError(503, 'SPREADCONNECT_LIVE_API_KEY is not set');
  return env.SPREADCONNECT_LIVE_API_KEY;
}
const spreadconnect = (path, opts = {}) =>
  api(SC_API, '', path, { ...opts, headers: { Authorization: undefined, 'X-SPOD-ACCESS-TOKEN': scKey(), ...opts.headers } });

const scProduct = cached(() => spreadconnect(`/productTypes/${SC_PRODUCT}`));

async function spreadconnectPrintArea() {
  const product = await scProduct('product');
  const areas = {};
  for (const [side, view] of [['front', 'FRONT'], ['back', 'BACK']]) {
    const a = product.printAreas.find((p) => p.view === view);
    if (a) areas[side] = { width: Math.round(a.widthInch * SC_DPI), height: Math.round(a.heightInch * SC_DPI), dpi: SC_DPI };
  }
  return { product: product.customerName?.trim(), areas, request: `GET ${SC_API}/productTypes/${SC_PRODUCT}` };
}

async function spreadconnectMockups(body) {
  const sides = readSides(body);
  const appearanceId = SC_COLORS[body.color] || '2';
  const configurations = [];
  for (const [side, base64] of Object.entries(sides)) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }), `polotno-demo-${side}.png`);
    const res = await fetch(`${SC_API}/designs/upload`, { method: 'POST', headers: { 'X-SPOD-ACCESS-TOKEN': scKey() }, body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.designId) throw new HttpError(502, `Spreadconnect upload failed (${res.status})`);
    configurations.push({ designId: json.designId, hotspot: SC_HOTSPOTS[side] });
  }
  const previewBody = { appearanceId, width: 600, height: 600, configurations };
  const preview = await spreadconnect(`/productTypes/${SC_PRODUCT}/previews`, { method: 'POST', body: previewBody });
  const wanted = configurations.map((c) => (c.hotspot === 'FULL_BACK' ? 'BACK' : 'FRONT'));
  const mockups = (preview.images || [])
    .filter((img) => wanted.includes(img.viewName))
    .map((img) => ({ side: img.viewName.toLowerCase(), url: img.url }));
  return {
    mockups,
    requests: [
      { title: 'Upload each side', endpoint: `POST ${SC_API}/designs/upload`, body: { file: '<PNG, under 10 MB>' } },
      { title: 'Get product previews', endpoint: `POST ${SC_API}/productTypes/${SC_PRODUCT}/previews`, body: previewBody },
    ],
  };
}

// --- rate limit -----------------------------------------------------------------

const hits = new Map();
function rateLimit(ip, limit = 12, windowMs = 60 * 1000) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) throw new HttpError(429, 'Too many requests, try again in a minute');
  recent.push(now);
  hits.set(ip, recent);
}

// --- server ---------------------------------------------------------------------

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /spreadconnect/print-area': () => spreadconnectPrintArea(),
  'POST /spreadconnect/mockups': (body) => spreadconnectMockups(body),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Design too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new HttpError(400, 'Body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (!route) throw new HttpError(404, 'Not found');
    if (req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0]
        .trim();
      rateLimit(ip);
    }
    const body = req.method === 'POST' ? await readBody(req) : null;
    const result = await route(body, url.searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(req.method, url.pathname, e.message);
    res
      .writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`pod-proxy listening on ${PORT}`));
