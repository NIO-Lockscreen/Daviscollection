'use strict';
// api/barcode.js (the Vercel function) in plain Node, with a stubbed global fetch: no network, no browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const handler = require(path.join(__dirname, '..', '..', 'api', 'barcode.js'));

const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const isUpcItemDb = (url) => url.startsWith('https://api.upcitemdb.com/');
const isOpenProductFacts = (url) => url.startsWith('https://world.openproductsfacts.org/');

/** Calls the function like Vercel would; `upstream(url)` answers each fetch (return a reply or throw). */
async function call(url, upstream = () => { throw new Error('fetch should not be called'); }) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); return upstream(String(u)); };
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; },
  };
  try {
    await handler({ method: 'GET', url, headers: {} }, res);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body), calls };
}

test('invalid barcode -> 400 INVALID_UPC without asking upstream', async () => {
  for (const url of ['/api/barcode', '/api/barcode?upc=abc', '/api/barcode?upc=1234567', '/api/barcode?upc=123456789012345']) {
    const r = await call(url);
    assert.equal(r.status, 400, url);
    assert.equal(r.json.code, 'INVALID_UPC');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.calls.length, 0);
  }
});

test('upcitemdb 429 -> 429 EXCEED_LIMIT (not cached, no fallback lookup)', async () => {
  const r = await call('/api/barcode?upc=4006381333931', () => reply(429, { code: 'EXCEED_LIMIT' }));
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'EXCEED_LIMIT');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.calls.length, 1);
});

test('found on upcitemdb -> 200 with slimmed items, cached for 30 days', async () => {
  const item = (n) => ({ title: `HEAT ${n}`, brand: 'Fox', description: 'x'.repeat(1000), images: ['a', 'b', 'c', 'd'], ean: '4006381333931', offers: [{}] });
  // Spaces and dashes in the code are ignored; ?code= works as well as ?upc=.
  const r = await call('/api/barcode?code=4006-3813%2033931', () => reply(200, { code: 'OK', items: [item(1), item(2), item(3), item(4)] }));
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 'OK');
  assert.equal(r.json.source, 'upcitemdb');
  assert.equal(r.json.items.length, 3);
  assert.deepEqual(Object.keys(r.json.items[0]).sort(), ['brand', 'description', 'images', 'title']);
  assert.equal(r.json.items[0].title, 'HEAT 1');
  assert.equal(r.json.items[0].description.length, 400);
  assert.deepEqual(r.json.items[0].images, ['a', 'b', 'c']);
  assert.match(r.headers['cache-control'], /s-maxage=2592000/);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.deepEqual(r.calls, ['https://api.upcitemdb.com/prod/trial/lookup?upc=4006381333931']);
});

test('upcitemdb has nothing, Open Product Facts has it -> 200 from openproductsfacts', async () => {
  const r = await call('/api/barcode?upc=4006381333931', (url) => {
    if (isUpcItemDb(url)) return reply(200, { code: 'OK', total: 0, items: [] });
    if (isOpenProductFacts(url)) return reply(200, { status: 1, product: { product_name: 'Heat [Blu-ray]', brands: 'Fox', image_url: 'https://img.example/heat.jpg' } });
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'openproductsfacts');
  assert.deepEqual(r.json.items, [{ title: 'Heat [Blu-ray]', brand: 'Fox', description: '', images: ['https://img.example/heat.jpg'] }]);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls[1].startsWith('https://world.openproductsfacts.org/api/v2/product/4006381333931.json'), r.calls[1]);
  assert.match(r.headers['cache-control'], /s-maxage=2592000/);
});

test('both services failing -> 502 UPSTREAM (not cached)', async () => {
  // Network errors on both.
  let r = await call('/api/barcode?upc=4006381333931', () => { throw new TypeError('fetch failed'); });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'UPSTREAM');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.calls.length, 2);
  // upcitemdb answers with an error page, Open Product Facts does not know the code.
  r = await call('/api/barcode?upc=4006381333931', (url) => (isUpcItemDb(url) ? reply(500, null) : reply(404, { status: 0 })));
  assert.equal(r.status, 502);
});

test('a clean "not found" on both -> 200 with no items, cached for a day', async () => {
  const r = await call('/api/barcode?upc=4006381333931', (url) => (isUpcItemDb(url) ? reply(200, { code: 'OK', items: [] }) : reply(200, { status: 0 })));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { code: 'OK', items: [], source: 'none' });
  assert.match(r.headers['cache-control'], /s-maxage=86400/);
});
