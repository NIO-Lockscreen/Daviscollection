// Barcode lookup for the app (Vercel serverless function: GET /api/barcode?upc=<8-14 digits>).
// Browsers cannot call upcitemdb directly: its CORS header only allows https://www.upcitemdb.com, so every lookup
// from the app failed as "could not reach the barcode service". This function asks upcitemdb server-side, falls back
// to Open Product Facts, and answers in upcitemdb's own shape ({code:'OK', items:[{title, brand, description, images}]}).
// Answers are cached at Vercel's edge (found: 30 days, not found: 1 day) so a barcode only spends the free daily
// upcitemdb quota once.
const UPCITEMDB = 'https://api.upcitemdb.com/prod/trial/lookup?upc=';
const OPEN_PRODUCT_FACTS = 'https://world.openproductsfacts.org/api/v2/product/';
const FOUND_CACHE = 'public, max-age=0, s-maxage=2592000, stale-while-revalidate=86400';
const NOT_FOUND_CACHE = 'public, max-age=0, s-maxage=86400';

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
}

async function getJson(url, ms) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MovieVault/1.0 (private collection app)' }, signal: AbortSignal.timeout(ms) });
  let data = null;
  try { data = await r.json(); } catch (_) { /* not JSON */ }
  return { status: r.status, ok: r.ok, data };
}

module.exports = async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const code = String(params.get('upc') || params.get('code') || '').replace(/[\s-]/g, '');
  if (!/^\d{8,14}$/.test(code)) return send(res, 400, { code: 'INVALID_UPC', message: 'A barcode is 8 to 14 digits.' }, 'no-store');

  let upstreamFailed = false;
  try {
    const r = await getJson(UPCITEMDB + code, 6000);
    if (r.status === 429) return send(res, 429, { code: 'EXCEED_LIMIT', message: 'Daily barcode lookup limit reached.' }, 'no-store');
    const items = r.ok && r.data && Array.isArray(r.data.items) ? r.data.items : null;
    if (items && items.length) {
      const slim = items.slice(0, 3).map(i => ({ title: i.title || '', brand: i.brand || '', description: String(i.description || '').slice(0, 400), images: (i.images || []).slice(0, 3) }));
      return send(res, 200, { code: 'OK', items: slim, source: 'upcitemdb' }, FOUND_CACHE);
    }
    if (!items) upstreamFailed = true;   // an error reply, not a clean "no such product"
  } catch (_) { upstreamFailed = true; }

  try {
    const r = await getJson(OPEN_PRODUCT_FACTS + code + '.json?fields=product_name,brands,image_url', 4000);
    const p = r.ok && r.data && r.data.status === 1 ? r.data.product : null;
    if (p && p.product_name) {
      return send(res, 200, { code: 'OK', items: [{ title: p.product_name, brand: p.brands || '', description: '', images: p.image_url ? [p.image_url] : [] }], source: 'openproductsfacts' }, FOUND_CACHE);
    }
  } catch (_) { /* fall through */ }

  if (upstreamFailed) return send(res, 502, { code: 'UPSTREAM', message: 'The barcode services did not answer.' }, 'no-store');
  return send(res, 200, { code: 'OK', items: [], source: 'none' }, NOT_FOUND_CACHE);
};
