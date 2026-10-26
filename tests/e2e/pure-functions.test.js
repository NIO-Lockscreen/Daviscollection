'use strict';
// Pure helpers of the app, evaluated inside the page (they are globals of the classic scripts).
const assert = require('node:assert/strict');
const { appTest, smallCollection, savedState, UNSORTED } = require('./helpers');

const small = { storage: smallCollection() };   // a 6-title collection loads faster than the seed

appTest('scanner.js: gtinCheckOk / isValidBarcode / normalizeBarcode', small, async ({ page }) => {
  const r = await page.evaluate(() => ({
    gtin: ['4006381333931', '036000291452', '73513537', '10012345678902', '4006381333932', '036000291453', '73513538']
      .map((c) => gtinCheckOk(c)),
    valid: [
      ['4006381333931'], ['  036000291452  '], ['73513537'], ['04252614'] /* UPC-E */, ['10012345678902'],
      ['4006381333932'], ['1234567'], ['123456789'], ['ABC-1234', 'code_128'], ['ABC-1234', 'code_39'],
      ['ABC12', 'code_128'], ['ABC-1234'], ['ABC-1234', 'ean_13'], [''], [null],
    ].map(([code, format]) => isValidBarcode(code, format)),
    norm: [' 4006 3813-33931 ', 'ABC 123', ' abc-1 ', '', null, undefined, 4006381333931].map((c) => normalizeBarcode(c)),
  }));
  assert.deepEqual(r.gtin, [true, true, true, true, false, false, false]);
  assert.deepEqual(r.valid, [true, true, true, true, true, false, false, false, true, true, false, false, false, false, false]);
  assert.deepEqual(r.norm, ['4006381333931', 'ABC 123', 'abc-1', '', '', '', '4006381333931']);
});

appTest('remote-scan.js: cleanRemoteCode only lets plausible barcodes through', small, async ({ page }) => {
  const inputs = ['4006381333931', ' 4006-3813 33931 ', '4006381333932', '04252614', '1234', '123456789012345',
    'ABC-12345', 'X1.2-3', 'AB12', '<b>hi</b>', 'ABC 12345', 'A'.repeat(32), 'A'.repeat(33), '9'.repeat(41), '', 12345678, null, {}];
  const out = await page.evaluate((list) => list.map((c) => cleanRemoteCode(c)), inputs);
  assert.deepEqual(out, ['4006381333931', '4006381333931', '', '04252614', '', '',
    'ABC-12345', 'X1.2-3', '', '', '', 'A'.repeat(32), '', '', '', '', '', '']);
});

const V1_SAVE = {   // a save from before schemaVersion existed
  movies: [
    { id: 'old-1', title: 'jaws   1234', section: ' horror ', format: 'weird', seen: false, added: '2024-01-01', updated: '2024-02-01' },
    { id: 'old-2', title: 'TEASER DRAMA', section: 'horror' },   // a junk line of the old import: dropped
    { title: 'Blade Runner', section: 'sci-fi 4k' },             // no id, format from the shelf name
    { id: 'old-4', title: 'Up', section: 'new arrivals - temporary', notes: '— Imported from blueprint' },
  ],
  sectionOrder: ['horror', 'new arrivals - temporary'],
  collectionValue: 1234,
};

appTest('storage.js: normalizeState migrates a v1 save (no schemaVersion) to schema v2', small, async ({ page }) => {
  const s = await page.evaluate((v1) => normalizeState(v1), V1_SAVE);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.movies.length, 3, 'TEASER DRAMA is dropped');
  const [jaws, blade, up] = s.movies;
  assert.deepEqual(
    { id: jaws.id, title: jaws.title, catalog: jaws.catalog, notes: jaws.notes, section: jaws.section, format: jaws.format, seen: jaws.seen, added: jaws.added, updated: jaws.updated },
    { id: 'old-1', title: 'jaws', catalog: '1234', notes: 'Catalog #1234', section: 'HORROR', format: 'Blu-ray', seen: false, added: '2024-01-01', updated: '2024-02-01' },
  );
  assert.match(blade.id, /^m-/, 'a missing id is generated');
  assert.equal(blade.section, 'SCI-FI 4K');
  assert.equal(blade.format, '4K UHD');
  assert.equal(blade.seen, true, 'seen defaults to true');
  assert.equal(up.notes, '', 'the old "Imported from blueprint" note is cleaned away');
  assert.deepEqual(s.sectionOrder, [UNSORTED, 'HORROR', 'NEW ARRIVALS - TEMPORARY', 'SCI-FI 4K']);
  assert.deepEqual(s.toSortShelves, ['NEW ARRIVALS - TEMPORARY'], 'shelves named TEMPORARY count as waiting to be sorted');
  assert.equal(s.collectionValue, 1234);

  // Current-schema data is kept exactly as stored (no uppercasing, no title cleanup).
  const cur = await page.evaluate(() => normalizeState({ schemaVersion: 2, movies: [{ id: 'a', title: 'jaws 1234', section: 'horror' }], toSortShelves: [] }));
  assert.deepEqual([cur.movies[0].title, cur.movies[0].section, cur.movies[0].catalog], ['jaws 1234', 'horror', '']);
});

appTest('a v1 save in localStorage is migrated on load, with a raw copy kept first', { storage: V1_SAVE }, async ({ page }) => {
  const saved = await savedState(page);
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.movies.map((m) => m.title), ['jaws', 'Blade Runner', 'Up']);
  const kept = await page.evaluate(() => localStorage.getItem('movieVault.preMigrationBackup'));
  assert.deepEqual(JSON.parse(kept), V1_SAVE);
  assert.equal(await page.textContent('#resultText'), 'Showing 3 of 3 titles');
  // Data that was never exported counts as not backed up: the reminder dot shows.
  assert.ok(await page.locator('#backupDot.show').count(), 'backup reminder dot');
});

appTest('storage.js: mergeStates counts added / updated and keeps the newer copy', small, async ({ page }) => {
  const r = await page.evaluate(() => {
    const m = (id, title, updated, section = 'SCI-FI') => ({ id, title, section, format: 'Blu-ray', seen: true, added: '2026-01-01', updated });
    const cur = normalizeState({ schemaVersion: 2, movies: [m('a', 'ALIEN', '2026-01-01'), m('b', 'BLADE RUNNER', '2026-01-05')], toSortShelves: [] });
    const inc = normalizeState({
      schemaVersion: 2,
      movies: [m('a', 'ALIEN (NEW)', '2026-02-01'), m('b', 'BLADE RUNNER (OLD)', '2026-01-01'), m('c', 'CONTACT', '2026-01-01', 'DRAMA'), m('d', 'DUNE', '2026-01-01')],
      toSortShelves: [], collectionValue: 500, valueHistory: [{ id: 'v', mode: 'set', amount: 500, before: 0, after: 500 }],
    });
    const same = mergeStates(cur, cur);
    const res = mergeStates(cur, inc);
    return { added: res.added, updated: res.updated, titles: res.state.movies.map((x) => x.title), order: res.state.sectionOrder,
      value: res.state.collectionValue, same: [same.added, same.updated, same.state.movies.length], curTitles: cur.movies.map((x) => x.title) };
  });
  assert.deepEqual([r.added, r.updated], [2, 1]);
  assert.deepEqual(r.titles, ['ALIEN (NEW)', 'BLADE RUNNER', 'CONTACT', 'DUNE']);
  assert.deepEqual(r.order, [UNSORTED, 'SCI-FI', 'DRAMA']);
  assert.equal(r.value, 500, 'a collection without a value takes the value from the file');
  assert.deepEqual(r.same, [0, 0, 2], 'merging a collection with itself changes nothing');
  assert.deepEqual(r.curTitles, ['ALIEN', 'BLADE RUNNER'], 'the current state object is not mutated');
});
