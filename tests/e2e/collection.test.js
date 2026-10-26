'use strict';
// Everyday collection work: add, duplicate warning, edit, delete + Undo, seen toggle, select mode + move + Undo, Place on shelf.
const assert = require('node:assert/strict');
const {
  appTest, PHONE, UNSORTED, showTab, openFilters, search, cardTitles, appState, savedState, waitForApp,
  nextDialog, toastText, clickToastUndo, openCard,
} = require('./helpers');

const today = () => new Date().toISOString().slice(0, 10);   // the app stamps added/updated in UTC
const movieById = async (page, id) => (await savedState(page)).movies.find((m) => m.id === id);

appTest('add a movie: stored in UPPERCASE on UNSORTED / NOT PLACED and still there after a reload', async ({ page }) => {
  const before = (await appState(page)).movies.length;
  await showTab(page, 'add');
  await page.fill('#newTitle', 'My Test Movie');
  await page.selectOption('#newFormat', 'DVD');
  await page.fill('#newBarcode', '4006381333931');
  await page.fill('#newNotes', 'Bought at the flea market');
  await page.click('#addMovieBtn');
  assert.match(await toastText(page), /^Added MY TEST MOVIE$/);
  assert.equal(await page.inputValue('#newTitle'), '', 'the form is cleared');

  const saved = await savedState(page);
  assert.equal(saved.movies.length, before + 1);
  const m = saved.movies[0];   // new titles go to the top
  assert.equal(m.title, 'MY TEST MOVIE');
  assert.equal(m.section, UNSORTED);
  assert.equal(m.format, 'DVD');
  assert.equal(m.barcode, '4006381333931');
  assert.equal(m.notes, 'Bought at the flea market');
  assert.equal(m.seen, false);
  assert.equal(m.added, today());

  await page.reload();
  await waitForApp(page);
  assert.equal((await appState(page)).movies.length, before + 1);
  assert.equal(await page.inputValue('#newFormat'), 'DVD', 'the Add form remembers the last format');
  await showTab(page, 'library');
  assert.equal(await page.textContent('#fourKCount'), '164', 'To sort counter includes the new title');
  await search(page, '4006381333931');   // the barcode is searchable too
  assert.deepEqual(await cardTitles(page), ['MY TEST MOVIE']);
  const card = page.locator('#movieGrid .card').first();
  assert.equal(await card.locator('.meta .chip').first().textContent(), UNSORTED);
  assert.ok(await card.locator('.placeBtn').isVisible(), 'a to-sort title has "Place on shelf"');
});

appTest('empty title is refused', async ({ page }) => {
  const before = (await appState(page)).movies.length;
  await showTab(page, 'add');
  await page.click('#addMovieBtn');
  assert.equal(await toastText(page), 'Add a title first.');
  assert.equal((await appState(page)).movies.length, before);
});

appTest('typing a title you already own shows a duplicate warning; adding it counts as a duplicate', async ({ page }) => {
  const dupesBefore = Number(await page.textContent('#duplicateCount'));
  await showTab(page, 'add');
  await page.fill('#newTitle', 'the godfather');
  const note = page.locator('#titleDupeNote');
  await note.waitFor({ state: 'visible' });
  assert.match(await note.textContent(), /^You already have: THE GODFATHER \([^)]+\)/);

  // As forgiving as search: apostrophes, dashes and a leading "The" do not matter.
  for (const [typed, owned] of [['daddys home', 'DADDY’S HOME'], ['spiderman homecoming', 'SPIDER-MAN HOMECOMING'], ['godfather', 'THE GODFATHER']]) {
    await page.fill('#newTitle', typed);
    await note.waitFor({ state: 'visible' });
    assert.ok((await note.textContent()).includes(`${owned} (`), `${typed} -> ${await note.textContent()}`);
  }

  await page.fill('#newTitle', 'qqq not in the collection');
  await note.waitFor({ state: 'hidden' });

  await page.fill('#newTitle', 'The Godfather');
  await page.click('#addMovieBtn');
  await toastText(page);
  await showTab(page, 'library');
  assert.equal(Number(await page.textContent('#duplicateCount')), dupesBefore + 1);
  await search(page, 'the godfather');
  const first = page.locator('#movieGrid .card').first();
  assert.match(await first.textContent(), /2 editions/);
});

appTest('edit a movie and save', async ({ page }) => {
  await search(page, 'zoolander ii');
  const id = await page.getAttribute('#movieGrid .card', 'data-id');
  await openCard(page, 'ZOOLANDER II');
  assert.equal(await page.inputValue('#editMovieTitle'), 'ZOOLANDER II');

  await page.fill('#editMovieTitle', 'Zoolander 2 (Steelbook)');   // Edit keeps the letter case typed
  await page.selectOption('#editFormat', '4K Steelbook');
  await page.fill('#editCustomSection', 'comedy');                 // a new section is uppercased
  await page.fill('#editBarcode', '036000291452');
  await page.uncheck('#editSeen');
  await page.fill('#editNotes', 'Limited edition');
  await page.click('#saveEditBtn');
  assert.equal(await toastText(page), 'Saved changes.');
  await page.waitForSelector('#editModal', { state: 'hidden' });

  const m = await movieById(page, id);
  assert.deepEqual(
    { title: m.title, format: m.format, section: m.section, barcode: m.barcode, seen: m.seen, notes: m.notes, updated: m.updated },
    { title: 'Zoolander 2 (Steelbook)', format: '4K Steelbook', section: 'COMEDY', barcode: '036000291452', seen: false, notes: 'Limited edition', updated: today() },
  );
  assert.ok((await savedState(page)).sectionOrder.includes('COMEDY'));
  await search(page, 'zoolander 2');
  assert.deepEqual(await cardTitles(page), ['Zoolander 2 (Steelbook)']);
});

appTest('delete a movie, then Undo puts it back in the same place', async ({ page }) => {
  await search(page, 'zoolander ii');
  const id = await page.getAttribute('#movieGrid .card', 'data-id');
  const before = await savedState(page);
  const index = before.movies.findIndex((m) => m.id === id);

  // Cancelling the confirm keeps it.
  await openCard(page, 'ZOOLANDER II');
  let dialog = nextDialog(page, 'dismiss');
  await page.click('#deleteMovieBtn');
  assert.equal(await dialog, 'Delete “ZOOLANDER II”?');
  assert.ok(await movieById(page, id), 'still there after Cancel');

  dialog = nextDialog(page, 'accept');
  await page.click('#deleteMovieBtn');
  await dialog;
  assert.match(await toastText(page), /^Movie deleted\./);
  assert.equal(await movieById(page, id), undefined);
  assert.equal((await savedState(page)).movies.length, before.movies.length - 1);
  assert.deepEqual(await cardTitles(page), []);

  await clickToastUndo(page);
  await page.waitForFunction((mid) => state.movies.some((m) => m.id === mid), id);
  const after = await savedState(page);
  assert.equal(after.movies.length, before.movies.length);
  assert.equal(after.movies.findIndex((m) => m.id === id), index, 'restored at its old position');
  assert.deepEqual(after.movies[index], before.movies[index]);
  assert.deepEqual(await cardTitles(page), ['ZOOLANDER II']);
});

appTest('the Seen toggle on a card flips and saves seen / not seen', async ({ page }) => {
  await search(page, 'zoolander ii');
  const id = await page.getAttribute('#movieGrid .card', 'data-id');
  const toggle = page.locator('#movieGrid .card [data-toggle-seen]').first();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');

  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await toggle.textContent(), 'Not seen');
  assert.equal((await movieById(page, id)).seen, false);

  // The "Not seen yet" filter now finds it.
  await page.selectOption('#seenFilter', 'unseen');
  assert.deepEqual(await cardTitles(page), ['ZOOLANDER II']);
  await page.selectOption('#seenFilter', 'all');

  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await toggle.textContent(), 'Seen ✓');
  assert.equal((await movieById(page, id)).seen, true);
});

appTest('select mode: move several titles to a shelf, then Undo', async ({ page }) => {
  await search(page, 'spiderman');
  const before = await savedState(page);
  const ids = await page.$$eval('#movieGrid .card', (cards) => cards.slice(0, 3).map((c) => c.dataset.id));
  const sectionsBefore = ids.map((id) => before.movies.find((m) => m.id === id).section);

  await page.click('#selectToggle');
  await page.waitForSelector('#selectBar', { state: 'visible' });
  for (const id of ids) await page.click(`#movieGrid .card[data-id="${id}"] .title`);
  assert.equal(await page.textContent('#selectCount'), '3 selected');

  await page.click('#selectMoveBtn');
  await page.waitForSelector('#shelfModal.active');
  assert.equal(await page.textContent('#shelfTitle'), 'Move to shelf');
  await page.selectOption('#shelfSelect', 'WAR MOVIES');
  assert.equal(await page.textContent('#shelfOkBtn'), 'Move 3 titles');
  await page.click('#shelfOkBtn');
  assert.match(await toastText(page), /^Moved 3 titles to WAR MOVIES\./);

  let saved = await savedState(page);
  assert.deepEqual(ids.map((id) => saved.movies.find((m) => m.id === id).section), ['WAR MOVIES', 'WAR MOVIES', 'WAR MOVIES']);
  assert.equal(await page.textContent('#selectCount'), '0 selected', 'moved titles are unselected');

  await clickToastUndo(page);
  await page.waitForFunction((id) => state.movies.find((m) => m.id === id).section !== 'WAR MOVIES', ids[0]);
  saved = await savedState(page);
  assert.deepEqual(ids.map((id) => saved.movies.find((m) => m.id === id).section), sectionsBefore);
  assert.deepEqual(saved.movies, before.movies, 'Undo restores sections and updated dates exactly');
});

appTest('select mode: Select all + Mark unseen covers the whole filtered list', async ({ page }) => {
  await search(page, 'spiderman');
  await page.click('#selectToggle');
  await page.click('#selectAllBtn');
  assert.equal(await page.textContent('#selectCount'), '6 selected');
  await page.click('#selectUnseenBtn');
  assert.match(await toastText(page), /^Marked 6 titles as not seen\.$/);
  const unseen = (await savedState(page)).movies.filter((m) => m.seen === false).map((m) => m.title).sort();
  assert.equal(unseen.length, 6);
  assert.ok(unseen.every((t) => /SPIDER/.test(t)), unseen.join(' | '));
  await page.click('#selectCancelBtn');
  await page.waitForSelector('#selectBar', { state: 'hidden' });
});

appTest('Place on shelf moves a to-sort title onto a new shelf, Undo puts it back', async ({ page }) => {
  await page.click('#smartFilterStat');   // "To sort" counter -> only titles waiting to be sorted
  assert.equal(await page.inputValue('#sectionFilter'), '__tosort__');
  const card = page.locator('#movieGrid .card').first();
  const id = await card.getAttribute('data-id');
  const from = (await movieById(page, id)).section;
  await card.locator('.placeBtn').click();
  await page.waitForSelector('#shelfModal.active');
  assert.equal(await page.textContent('#shelfTitle'), 'Place on shelf');
  await page.selectOption('#shelfSelect', '__new__');
  await page.fill('#shelfNewInput', 'horror 4k');
  await page.click('#shelfOkBtn');
  assert.match(await toastText(page), /^Placed “.+” on HORROR 4K\./);
  assert.equal((await movieById(page, id)).section, 'HORROR 4K');
  assert.ok((await savedState(page)).sectionOrder.includes('HORROR 4K'));
  assert.equal(await page.locator(`#movieGrid .card[data-id="${id}"]`).count(), 0, 'it left the To sort list');

  await clickToastUndo(page);
  await page.waitForFunction((mid) => state.movies.find((m) => m.id === mid).section !== 'HORROR 4K', id);
  assert.equal((await movieById(page, id)).section, from);
  assert.ok(!(await savedState(page)).sectionOrder.includes('HORROR 4K'), 'the shelf the move created is gone again');
  assert.equal(await page.locator('#newSection option[value="HORROR 4K"]').count(), 0);
});

appTest('phone: add a movie, toggle seen and move it with taps', { device: PHONE }, async ({ page }) => {
  await showTab(page, 'add');
  await page.locator('#newTitle').tap();
  await page.fill('#newTitle', 'phone test movie');
  await page.locator('#addMovieBtn').tap();
  assert.equal(await toastText(page), 'Added PHONE TEST MOVIE');
  const id = (await savedState(page)).movies[0].id;

  await showTab(page, 'library');
  await search(page, 'phone test movie');
  await page.locator('#movieGrid .card [data-toggle-seen]').first().tap();
  assert.equal((await movieById(page, id)).seen, true);

  await openFilters(page);
  await page.locator('#selectToggle').tap();
  await page.locator('#movieGrid .card .title').first().tap();
  assert.equal(await page.textContent('#selectCount'), '1 selected');
  await page.locator('#selectMoveBtn').tap();
  await page.selectOption('#shelfSelect', 'KUNG FU');
  await page.locator('#shelfOkBtn').tap();
  assert.match(await toastText(page), /^Placed “PHONE TEST MOVIE” on KUNG FU\./);
  assert.equal((await movieById(page, id)).section, 'KUNG FU');
});

appTest('the Duplicates counter filters to titles owned more than once', async ({ page }) => {
  assert.ok(Number(await page.textContent('#duplicateCount')) > 0);
  await page.click('#duplicatesStat');
  assert.equal(await page.getAttribute('#duplicatesStat', 'aria-pressed'), 'true');
  const editions = await page.$$eval('#movieGrid .card', (cards) => cards.map((c) => /\d+ editions/.test(c.textContent)));
  assert.ok(editions.length > 0 && editions.every(Boolean), 'every shown card is a duplicate');
  await page.click('#clearFiltersBtn');
  assert.equal(await page.getAttribute('#duplicatesStat', 'aria-pressed'), 'false');
});

appTest('collection value: add an amount, then Rollback', async ({ page }) => {
  assert.equal(await page.textContent('#collectionValue'), '0 kr');
  await page.click('#collectionValueStat');
  await page.waitForSelector('#valueModal.active');
  await page.fill('#valueAmount', '499');
  await page.fill('#valueNote', 'New steelbook');
  await page.click('#applyValueBtn');
  assert.equal(await page.textContent('#collectionValue'), '499 kr');
  let saved = await savedState(page);
  assert.equal(saved.collectionValue, 499);
  assert.equal(saved.valueHistory[0].note, 'New steelbook');

  const dialog = nextDialog(page, 'accept');
  await page.click('#rollbackValueBtn');
  assert.match(await dialog, /^Rollback latest value change/);
  assert.equal(await page.textContent('#collectionValue'), '0 kr');
  saved = await savedState(page);
  assert.equal(saved.collectionValue, 0);
  assert.equal(saved.valueHistory[0].mode, 'rollback');
});
