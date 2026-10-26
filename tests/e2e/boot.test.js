'use strict';
// First start: no JS errors, the seed list loads on empty storage and is saved as schema v2; phone layout basics.
const assert = require('node:assert/strict');
const { appTest, PHONE, STORAGE_KEY, savedState, appState, showTab, openFilters, waitForApp } = require('./helpers');

appTest('boots on empty storage, loads the whole seed list and saves it as schema v2', async ({ page }) => {
  const seed = await page.evaluate(() => ({
    raw: SEED_DATA.movies.length,
    normalized: normalizeState(structuredClone(SEED_DATA)).movies.length,
  }));
  assert.equal(seed.raw, 2329, 'seed-data.js holds the 2,329 titles of the original list');
  assert.equal(seed.normalized, seed.raw, 'no seed title is dropped by the v1 -> v2 migration');

  const n = seed.raw.toLocaleString('en-US');
  assert.equal(await page.textContent('#resultText'), `Showing ${n} of ${n} titles`);
  assert.equal(await page.textContent('#totalCount'), n);
  assert.match(await page.textContent('#subtitle'), new RegExp(`${n} titles on \\d+ shelves`));

  // The first batch of cards is rendered, not all 2,329 (cards are added while scrolling).
  const cards = await page.locator('#movieGrid .card').count();
  assert.ok(cards >= 80 && cards < seed.raw, `first batch rendered (${cards} cards)`);

  const saved = await savedState(page);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.movies.length, seed.raw);
  assert.ok(saved.sectionOrder.includes('UNSORTED / NOT PLACED'));
  // The two "temporary" shelves of the original list count as waiting to be sorted.
  assert.deepEqual(saved.toSortShelves, ['NEW BLU-RAY – TEMPORARY LIST PLACEMENT', 'TV SECTION (NEED TO BE ARRANGED)']);
  assert.equal(await page.textContent('#fourKCount'), '163', 'To sort counter = titles on the to-sort shelves');
});

appTest('a reload keeps the saved collection instead of loading the seed again', async ({ page }) => {
  // Change something only the saved copy can know about, then reload.
  await page.evaluate((key) => {
    const s = JSON.parse(localStorage.getItem(key));
    s.movies = s.movies.slice(0, 10);
    localStorage.setItem(key, JSON.stringify(s));
  }, STORAGE_KEY);
  await page.reload();
  await waitForApp(page);
  assert.equal(await page.textContent('#resultText'), 'Showing 10 of 10 titles');
  assert.equal((await appState(page)).movies.length, 10);
});

appTest('scrolling the list adds more cards', async ({ page }) => {
  const before = await page.locator('#movieGrid .card').count();
  await page.locator('#gridSentinel').scrollIntoViewIfNeeded();
  await page.waitForFunction((n) => document.querySelectorAll('#movieGrid .card').length > n, before);
});

appTest('phone: boots without errors, filters sit behind the Filters button', { device: PHONE }, async ({ page }) => {
  await showTab(page, 'library');
  assert.ok(await page.locator('#movieGrid .card').first().isVisible(), 'cards are visible on the Collection tab');
  // The filter selects are hidden until "Filters" is tapped.
  assert.equal(await page.locator('#sectionFilter').isVisible(), false);
  await openFilters(page);
  assert.equal(await page.getAttribute('#filtersToggle', 'aria-expanded'), 'true');
  assert.ok(await page.locator('#sectionFilter').isVisible());
  // No horizontal scrolling on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page is ${overflow}px wider than the screen`);
});
