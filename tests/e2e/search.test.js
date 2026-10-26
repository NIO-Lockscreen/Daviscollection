'use strict';
// Forgiving search as described in the README ("Søk som tåler skrivemåter").
const assert = require('node:assert/strict');
const { appTest, PHONE, search, cardTitles, resultText, showTab } = require('./helpers');

appTest('"daddys home" finds DADDY’S HOME (apostrophe ignored), exact title first', async ({ page }) => {
  await search(page, 'daddys home');
  const titles = await cardTitles(page);
  assert.equal(titles[0], 'DADDY’S HOME');
  assert.ok(titles.includes('DADDY’S HOME 1 & 2'), titles.join(' | '));
  // A straight apostrophe and different case find the same.
  await search(page, "Daddy's Home");
  assert.equal((await cardTitles(page))[0], 'DADDY’S HOME');
});

appTest('"spiderman" finds SPIDER-MAN titles, and the exact match comes first', async ({ page }) => {
  await search(page, 'spiderman');
  const titles = await cardTitles(page);
  // A–Z alone would put a "SPIDER-MAN ..." title first; the exact title wins.
  const az = await page.evaluate((list) => [...list].sort((a, b) => a.localeCompare(b)), titles);
  assert.notEqual(az[0], 'SPIDERMAN', 'precondition: plain A–Z order does not start with the exact match');
  assert.equal(titles[0], 'SPIDERMAN');
  for (const t of ['SPIDER-MAN HOMECOMING', 'SPIDER-MAN FAR FROM HOME', 'SPIDER-MAN INTO THE SPIDER-VERSE', 'SPIDERMAN NO WAY HOME']) {
    assert.ok(titles.includes(t), `${t} missing from: ${titles.join(' | ')}`);
  }
  // ...and the other way round: "spider-man" finds SPIDERMAN.
  await search(page, 'spider-man');
  assert.ok((await cardTitles(page)).includes('SPIDERMAN NO WAY HOME'));
});

appTest('"godfather 2" finds a PART II title; roman numerals and "part" are forgiven', async ({ page }) => {
  // The seed has no Godfather sequel, so add one through the Add form first.
  await showTab(page, 'add');
  await page.fill('#newTitle', 'The Godfather Part II');
  await page.click('#addMovieBtn');
  await page.waitForFunction(() => state.movies.some((m) => m.title === 'THE GODFATHER PART II'));
  await showTab(page, 'library');

  for (const q of ['godfather 2', 'godfather ii', 'godfather part 2', 'GODFATHER PART II']) {
    await search(page, q);
    const titles = await cardTitles(page);
    assert.deepEqual(titles, ['THE GODFATHER PART II'], `search "${q}"`);
  }
  // "2" is a whole number: it does not match the 2 inside other numbers.
  await search(page, 'jack reacher 2');
  assert.deepEqual(await cardTitles(page), ['JACK REACHER II']);
});

appTest('search also looks at the shelf name; no match shows an empty state with Clear filters', async ({ page }) => {
  await search(page, 'classic film');
  const shown = await page.$$eval('#movieGrid .card .meta .chip:first-child', (els) => els.map((e) => e.textContent));
  assert.ok(shown.length >= 6, `${shown.length} results`);
  assert.ok(shown.every((s) => s === 'CLASSIC FILM'), shown.join(' | '));

  await search(page, 'qqq no such movie zzz');
  assert.match(await resultText(page), /^Showing 0 of [\d,]+ titles$/);
  assert.match(await page.textContent('#movieGrid .empty'), /No movies match this filter/);
  await page.click('#movieGrid .empty [data-clear-filters]');
  assert.equal(await page.inputValue('#searchInput'), '');
  assert.match(await resultText(page), /^Showing ([\d,]+) of \1 titles$/);
});

appTest('phone: search works from the Collection tab', { device: PHONE }, async ({ page }) => {
  await showTab(page, 'library');
  await search(page, 'spiderman');
  assert.equal((await cardTitles(page))[0], 'SPIDERMAN');
  assert.match(await resultText(page), /^Showing 6 of [\d,]+ titles$/);
});
