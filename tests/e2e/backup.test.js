'use strict';
// Backup ▾: JSON export round-trip, import Merge / Replace all, Undo last import, CSV export, bad files.
const assert = require('node:assert/strict');
const {
  appTest, openApp, smallCollection, savedState, appState, nextDialog, toastText, download, resultText,
} = require('./helpers');

async function openBackupMenu(page) {
  if ((await page.getAttribute('#backupMenuBtn', 'aria-expanded')) !== 'true') await page.click('#backupMenuBtn');
  await page.waitForSelector('#backupMenu.open');
}
async function exportJson(page) {
  await openBackupMenu(page);
  const file = await download(page, () => page.click('#exportJsonBtn'));
  return { ...file, data: JSON.parse(file.text) };
}
/** Picks a backup file through the hidden file input, as "Import JSON backup" does. */
async function chooseBackup(page, data, name = 'backup.json') {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  await page.setInputFiles('#importFile', { name, mimeType: 'application/json', buffer: Buffer.from(text) });
}
async function undoLastImport(page) {
  await openBackupMenu(page);
  assert.ok(await page.locator('#undoImportBtn').isVisible(), '"Undo last import" is offered');
  const dialog = nextDialog(page, 'accept');
  await page.click('#undoImportBtn');
  assert.match(await dialog, /^Restore your collection to how it was before the last import\?/);
}
const movie = (id, title, section, updated, more = {}) => ({
  id, title, section, format: 'Blu-ray', barcode: '', poster: '', posterRemoved: false, notes: '', catalog: '',
  seen: true, added: '2026-01-01', updated, ...more,
});

appTest('JSON export round-trip: export on one device, Replace all on another gives the same collection', async ({ page }) => {
  const exported = await exportJson(page);
  assert.match(exported.name, /^movie-vault-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(exported.data.app, 'Movie Vault');
  assert.equal(exported.data.schemaVersion, 2);
  assert.ok(!Number.isNaN(Date.parse(exported.data.exportedAt)));
  const saved = await savedState(page);
  assert.deepEqual(exported.data.movies, saved.movies);
  assert.deepEqual(exported.data.sectionOrder, saved.sectionOrder);
  await openBackupMenu(page);
  assert.match(await page.textContent('#backupStatus'), /^Last backup: today/);

  // "Another device" with a different, small collection.
  const other = await openApp({ storage: smallCollection() });
  try {
    await openBackupMenu(other.page);
    const [chooser] = await Promise.all([other.page.waitForEvent('filechooser'), other.page.click('#importBtn')]);
    await chooser.setFiles({ name: exported.name, mimeType: 'application/json', buffer: Buffer.from(exported.text) });
    await other.page.waitForSelector('#importModal.active');
    assert.match(await other.page.textContent('#importSummary'), /^This file: 2329 movies, exported .+ · Your current collection: 6 movies$/);
    await other.page.click('#importReplaceBtn');
    assert.equal(await toastText(other.page, /^Replaced/), 'Replaced: 2329 movies');
    const imported = await savedState(other.page);
    assert.deepEqual(imported.movies, saved.movies);
    assert.deepEqual(imported.sectionOrder, saved.sectionOrder);
    assert.deepEqual(imported.toSortShelves, saved.toSortShelves);
    assert.deepEqual(other.errors, []);
  } finally {
    await other.context.close();
  }
});

appTest('import Merge adds new titles, keeps the newer copy of shared ones; Undo last import restores', { storage: smallCollection() }, async ({ page }) => {
  const before = await savedState(page);
  await chooseBackup(page, {
    schemaVersion: 2,
    exportedAt: '2026-03-01T10:00:00.000Z',
    movies: [
      movie('t-1', 'ALIEN (DIRECTOR’S CUT)', 'SCI-FI', '2026-03-01'),   // newer than ours -> updated
      movie('t-4', 'HEAT (OLD COPY)', 'CRIME', '2025-01-01'),          // older than ours -> ignored
      movie('x-1', 'PREDATOR', 'SCI-FI', '2026-02-01'),
      movie('x-2', 'RONIN', 'ACTION', '2026-02-01'),
    ],
    sectionOrder: ['SCI-FI', 'CRIME', 'ACTION'],
    toSortShelves: [],
  });
  await page.waitForSelector('#importModal.active');
  assert.equal(await page.textContent('#importSummary'), 'This file: 4 movies, exported 1 March 2026 · Your current collection: 6 movies');
  assert.match(await page.textContent('#importMergeInfo'), /\(2 to add, 1 to update\)/);
  await page.click('#importMergeBtn');
  assert.equal(await toastText(page, /^Merged/), 'Merged: 2 added, 1 updated');

  const merged = await savedState(page);
  assert.equal(merged.movies.length, 8);
  const title = (id) => merged.movies.find((m) => m.id === id).title;
  assert.equal(title('t-1'), 'ALIEN (DIRECTOR’S CUT)');
  assert.equal(title('t-4'), 'HEAT');
  assert.equal(title('x-2'), 'RONIN');
  assert.ok(merged.sectionOrder.includes('ACTION'));
  assert.equal(await resultText(page), 'Showing 8 of 8 titles');

  await undoLastImport(page);
  assert.equal(await toastText(page, /^Import undone/), 'Import undone: 6 movies restored');
  const restored = await savedState(page);
  assert.deepEqual(restored.movies, before.movies);
  assert.deepEqual(restored.sectionOrder, before.sectionOrder);
  await openBackupMenu(page);
  assert.equal(await page.locator('#undoImportBtn').isVisible(), false, 'nothing left to undo');
});

appTest('import Replace all swaps the whole collection; Undo last import brings the 2,329 titles back', async ({ page }) => {
  const before = await savedState(page);
  await chooseBackup(page, {
    schemaVersion: 2,
    movies: [movie('r-1', 'ONE', 'A', '2026-01-01'), movie('r-2', 'TWO', 'A', '2026-01-01'), movie('r-3', 'THREE', 'B', '2026-01-01')],
    sectionOrder: ['A', 'B'],
  });
  await page.waitForSelector('#importModal.active');
  assert.match(await page.textContent('#importSummary'), /^This file: 3 movies, export date unknown · Your current collection: 2329 movies$/);
  await page.click('#importReplaceBtn');
  assert.equal(await toastText(page, /^Replaced/), 'Replaced: 3 movies');
  assert.deepEqual((await savedState(page)).movies.map((m) => m.title), ['ONE', 'TWO', 'THREE']);
  assert.equal(await resultText(page), 'Showing 3 of 3 titles');

  await undoLastImport(page);
  await toastText(page, /^Import undone/);
  const restored = await savedState(page);
  assert.equal(restored.movies.length, 2329);
  assert.deepEqual(restored.movies, before.movies);
  assert.equal(await resultText(page), 'Showing 2,329 of 2,329 titles');
});

appTest('Cancel in the import dialog changes nothing; invalid files are refused', { storage: smallCollection() }, async ({ page }) => {
  const before = await savedState(page);
  await chooseBackup(page, { movies: [movie('z-1', 'ZODIAC', 'CRIME', '2026-01-01')] });
  await page.waitForSelector('#importModal.active');
  await page.click('#importCancelBtn');
  assert.equal(await toastText(page, /^Import cancelled/), 'Import cancelled. Nothing was changed.');
  assert.deepEqual(await savedState(page), before);

  await chooseBackup(page, '{not json', 'broken.json');
  assert.equal(await toastText(page, /not valid JSON/), 'That file is not valid JSON, so it cannot be imported.');
  await chooseBackup(page, { hello: 'world' }, 'other.json');
  assert.equal(await toastText(page, /not a Movie Vault backup/), 'That file is not a Movie Vault backup (no movie list found).');
  await chooseBackup(page, { movies: [] }, 'empty.json');
  assert.equal(await toastText(page, /no movies/), 'That backup has no movies in it.');
  assert.equal(await page.locator('#importModal.active').count(), 0);
  assert.deepEqual(await savedState(page), before);
});

// THE GODFATHER is lent out, so its row fills the two lending columns at the end.
const lentCollection = () => {
  const s = smallCollection();
  Object.assign(s.movies.find((m) => m.id === 't-5'), { lentTo: 'Ola N.', lentAt: '2026-03-04' });
  return s;
};

appTest('CSV export has a header row and one row per title', { storage: lentCollection() }, async ({ page }) => {
  await openBackupMenu(page);
  const csv = await download(page, () => page.click('#exportCsvBtn'));
  assert.match(csv.name, /^movie-vault-collection-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Title;Section;Format;Seen;Barcode;Catalog;Notes;Added;Updated;Poster URL;Lent to;Lent date');
  assert.equal(lines.length, 1 + (await appState(page)).movies.length);
  assert.ok(lines.includes('HEAT;CRIME;Blu-ray;no;;;;2026-01-01;2026-01-01;;;'), lines.join('\n'));
  assert.ok(lines.includes('THE GODFATHER;CRIME;Blu-ray;yes;;;;2026-01-01;2026-01-01;;Ola N.;2026-03-04'), lines.join('\n'));
});
