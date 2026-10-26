'use strict';
// Start-up and saving: the seed list is only loaded when there is no usable save, background (cover) saves are written together,
// the format pickers come from one list, and the service worker starts the app offline.
const assert = require('node:assert/strict');
const { appTest, STORAGE_KEY, smallCollection, savedState, waitForApp } = require('./helpers');

const seedRequested = (page) => page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/js\/seed-data\.js$/.test(e.name)));

appTest('first run loads the seed list', async ({ page }) => {
  assert.equal(await seedRequested(page), true);
  assert.equal(await page.evaluate(() => typeof SEED_DATA), 'object');
});

appTest('a returning user does not download the seed list', { storage: smallCollection() }, async ({ page }) => {
  assert.equal(await seedRequested(page), false);
  assert.equal(await page.evaluate(() => typeof SEED_DATA), 'undefined');
  assert.equal(await page.evaluate(() => state.movies.length), smallCollection().movies.length);
});

appTest('an unreadable save falls back to the seed list and keeps the unreadable copy', { storage: '{"movies":' }, async ({ page }) => {
  assert.equal(await seedRequested(page), true);
  assert.equal(await page.evaluate(() => state.movies.length), await page.evaluate(() => SEED_DATA.movies.length));
  assert.equal(await page.evaluate(() => localStorage.getItem('movieVault.unreadableSave')), '{"movies":');
});

appTest('background cover saves are written together, and at once when the page is hidden', { storage: smallCollection() }, async ({ page }) => {
  // Count writes of the collection key.
  await page.evaluate((key) => {
    window.collectionWrites = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === key) window.collectionWrites++; return set.call(this, k, v); };
  }, STORAGE_KEY);
  await page.evaluate(() => state.movies.forEach((m, i) => { m.poster = `https://example.invalid/p${i}.jpg`; m.posterSource = 'auto'; saveSoon(); }));
  assert.equal(await page.evaluate(() => collectionWrites), 0, 'nothing is written straight away');
  await page.waitForFunction(() => collectionWrites === 1, null, { timeout: 4000 });
  assert.ok((await savedState(page)).movies.every((m) => m.poster), 'every cover is in the one write');

  await page.evaluate(() => { state.movies[0].poster = 'https://example.invalid/late.jpg'; saveSoon(); window.dispatchEvent(new Event('pagehide')); });
  assert.equal(await page.evaluate(() => collectionWrites), 2, 'pagehide writes the waiting change at once');
  assert.equal((await savedState(page)).movies[0].poster, 'https://example.invalid/late.jpg');
});

appTest('a user action saves at once and takes waiting background changes with it', { storage: smallCollection() }, async ({ page }) => {
  await page.evaluate(() => { state.movies[1].poster = 'https://example.invalid/bg.jpg'; saveSoon(); });
  await page.locator('#movieGrid .card[data-id="t-4"] [data-toggle-seen]').click();
  const saved = await savedState(page);
  assert.equal(saved.movies.find((m) => m.id === 't-4').seen, true);
  assert.equal(saved.movies[1].poster, 'https://example.invalid/bg.jpg');
});

appTest('the format pickers are built from KNOWN_FORMATS', { storage: smallCollection() }, async ({ page }) => {
  const known = await page.evaluate(() => KNOWN_FORMATS);
  const options = (sel) => page.$$eval(`${sel} option`, (os) => os.map((o) => o.value));
  assert.deepEqual(await options('#newFormat'), known);
  assert.deepEqual(await options('#editFormat'), known);
  assert.deepEqual(await options('#formatFilter'), ['All formats', ...known]);
});

appTest('the service worker starts the app offline', { storage: smallCollection(), serviceWorkers: 'allow' }, async ({ page, context }) => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();   // now under the worker's control, and every shell file has been cached
  await waitForApp(page);
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload();
  await waitForApp(page);
  assert.equal(await page.evaluate(() => state.movies.length), smallCollection().movies.length);
  await context.setOffline(false);
});
