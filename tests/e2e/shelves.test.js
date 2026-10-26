'use strict';
// Shelves dialog: rename, merge (confirm), reorder, delete an empty shelf, and Undo.
const assert = require('node:assert/strict');
const { appTest, openFilters, savedState, nextDialog, toastText, clickToastUndo, smallCollection } = require('./helpers');

const counts = (s) => s.movies.reduce((c, m) => ({ ...c, [m.section]: (c[m.section] || 0) + 1 }), {});
const row = (page, shelf) => page.locator(`#shelvesList .shelfRow[data-s="${shelf}"]`);

async function openShelves(page) {
  await openFilters(page);
  await page.click('#shelvesBtn');
  await page.waitForSelector('#shelvesModal.active');
}
async function startRename(page, shelf, newName) {
  await row(page, shelf).locator('[data-sh="rename"]').click();
  await page.fill('#shelvesList .shelfRenameInput', newName);
}

appTest('rename a shelf, then Undo', async ({ page }) => {
  const before = await savedState(page);
  const index = before.sectionOrder.indexOf('CLASSIC FILM');
  await openShelves(page);
  assert.match(await row(page, 'CLASSIC FILM').textContent(), /6 titles/);

  await startRename(page, 'CLASSIC FILM', 'classic cinema');   // names are uppercased
  await row(page, 'CLASSIC FILM').locator('[data-sh="save"]').click();
  assert.match(await toastText(page), /^Renamed “CLASSIC FILM” to “CLASSIC CINEMA”\./);

  let saved = await savedState(page);
  assert.equal(saved.sectionOrder[index], 'CLASSIC CINEMA', 'keeps its place in the order');
  assert.ok(!saved.sectionOrder.includes('CLASSIC FILM'));
  assert.equal(counts(saved)['CLASSIC CINEMA'], 6);
  assert.equal(counts(saved)['CLASSIC FILM'], undefined);
  assert.match(await row(page, 'CLASSIC CINEMA').textContent(), /6 titles/);
  assert.ok(await page.locator('#sectionFilter option', { hasText: 'CLASSIC CINEMA (6)' }).count(), 'Section filter follows');

  await clickToastUndo(page);
  await page.waitForFunction(() => state.sectionOrder.includes('CLASSIC FILM'));
  saved = await savedState(page);
  assert.deepEqual(saved.sectionOrder, before.sectionOrder);
  assert.deepEqual(saved.movies, before.movies);
  assert.ok(await row(page, 'CLASSIC FILM').isVisible(), 'the open dialog shows the old name again');
});

appTest('renaming a shelf to an existing name merges them after a confirm, Undo splits them again', async ({ page }) => {
  const before = await savedState(page);
  assert.deepEqual([counts(before)['ARROW BLUERAY'], counts(before)['ARROW 4K']], [6, 19]);
  await openShelves(page);

  // Cancel the confirm: nothing changes.
  await startRename(page, 'ARROW BLUERAY', 'Arrow 4K');
  let dialog = nextDialog(page, 'dismiss');
  await row(page, 'ARROW BLUERAY').locator('[data-sh="save"]').click();
  assert.match(await dialog, /^Merge 6 titles into ARROW 4K\?/);
  assert.deepEqual(await savedState(page), before);

  // Confirm: merged.
  dialog = nextDialog(page, 'accept');
  await row(page, 'ARROW BLUERAY').locator('[data-sh="save"]').click();
  await dialog;
  assert.match(await toastText(page), /^Merged 6 titles into ARROW 4K\./);
  let saved = await savedState(page);
  assert.equal(counts(saved)['ARROW 4K'], 25);
  assert.ok(!saved.sectionOrder.includes('ARROW BLUERAY'));
  assert.equal(await row(page, 'ARROW BLUERAY').count(), 0);
  assert.match(await row(page, 'ARROW 4K').textContent(), /25 titles/);

  await clickToastUndo(page);
  await page.waitForFunction(() => state.sectionOrder.includes('ARROW BLUERAY'));
  saved = await savedState(page);
  assert.deepEqual(saved.sectionOrder, before.sectionOrder, 'the merged shelf is back in its old position');
  assert.deepEqual(saved.movies, before.movies, 'every title is back on its old shelf with its old date');
});

appTest('reorder with ▲▼, mark a shelf as waiting to be sorted, delete an empty shelf + Undo', { storage: smallCollection() }, async ({ page }) => {
  await openShelves(page);
  // ▼ on SCI-FI swaps it with CRIME.
  await row(page, 'SCI-FI').locator('[data-sh="down"]').click();
  assert.deepEqual((await savedState(page)).sectionOrder, ['UNSORTED / NOT PLACED', 'CRIME', 'SCI-FI', 'EMPTY SHELF']);

  // "Waiting to be sorted" adds the shelf's titles to the To sort counter.
  assert.equal(await page.textContent('#fourKCount'), '1');
  await row(page, 'CRIME').locator('[data-sh="sort"]').check();
  assert.deepEqual((await savedState(page)).toSortShelves, ['CRIME']);
  assert.equal(await page.textContent('#fourKCount'), '3');

  // Only empty shelves can be deleted.
  assert.ok(await row(page, 'CRIME').locator('[data-sh="del"]').isDisabled());
  const dialog = nextDialog(page, 'accept');
  await row(page, 'EMPTY SHELF').locator('[data-sh="del"]').click();
  assert.equal(await dialog, 'Delete the empty shelf “EMPTY SHELF”?');
  assert.match(await toastText(page), /^Deleted shelf “EMPTY SHELF”\./);
  assert.ok(!(await savedState(page)).sectionOrder.includes('EMPTY SHELF'));

  await clickToastUndo(page);
  await page.waitForFunction(() => state.sectionOrder.includes('EMPTY SHELF'));
  assert.deepEqual((await savedState(page)).sectionOrder, ['UNSORTED / NOT PLACED', 'CRIME', 'SCI-FI', 'EMPTY SHELF']);
});
