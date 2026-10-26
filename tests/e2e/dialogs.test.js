'use strict';
// Dialogs: Escape closes only the topmost one, unsaved edits are asked about, Tab stays inside, focus returns to the opener,
// and the Back button closes the topmost dialog instead of leaving the app. Pick for me goes through the same dialog stack.
const assert = require('node:assert/strict');
const { appTest, PHONE, smallCollection, nextDialog, openCard, savedState } = require('./helpers');

const isOpen = (page, id) => page.evaluate((i) => document.getElementById(i).classList.contains('active'), id);
const focusedId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);
const waitClosed = (page, id) => page.waitForSelector(`#${id}:not(.active)`, { state: 'attached' });

appTest('Escape in the poster picker over Movie details closes only the picker and keeps the edit', { storage: smallCollection() }, async ({ page }) => {
  await openCard(page, 'ALIEN');
  await page.fill('#editMovieTitle', 'ALIEN (EDITED)');
  await page.click('#editPosterLookupBtn');
  await page.waitForSelector('#posterPickerModal.active');

  await page.keyboard.press('Escape');
  await waitClosed(page, 'posterPickerModal');
  assert.equal(await isOpen(page, 'editModal'), true, 'Movie details stays open');
  assert.equal(await page.inputValue('#editMovieTitle'), 'ALIEN (EDITED)');
  assert.equal(await focusedId(page), 'editPosterLookupBtn', 'focus is back on the button that opened the picker');

  // The next Escape asks about the unsaved title: Cancel keeps the dialog, OK discards without saving.
  let asked = nextDialog(page, 'dismiss');
  await page.keyboard.press('Escape');
  assert.match(await asked, /^Discard your unsaved changes/);
  assert.equal(await isOpen(page, 'editModal'), true);
  asked = nextDialog(page, 'accept');
  await page.keyboard.press('Escape');
  await asked;
  await waitClosed(page, 'editModal');
  assert.ok((await savedState(page)).movies.some((m) => m.title === 'ALIEN'), 'nothing was saved');
});

appTest('closing Movie details without changes does not ask; Save does not ask either', { storage: smallCollection() }, async ({ page }) => {
  let asked = false;
  page.on('dialog', (d) => { asked = true; d.dismiss(); });
  await openCard(page, 'HEAT');
  await page.click('#closeModalBtn');
  await waitClosed(page, 'editModal');
  await openCard(page, 'HEAT');
  await page.fill('#editNotes', 'Director’s cut');
  await page.click('#saveEditBtn');
  await waitClosed(page, 'editModal');
  assert.equal(asked, false);
  assert.equal((await savedState(page)).movies.find((m) => m.title === 'HEAT').notes, 'Director’s cut');
});

appTest('Tab stays inside a dialog and focus returns to the opener on close', { storage: smallCollection() }, async ({ page }) => {
  await page.click('#collectionValueStat');
  await page.waitForSelector('#valueModal.active');
  assert.equal(await focusedId(page), 'valueAmount');
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
    assert.ok(await page.evaluate(() => document.getElementById('valueModal').contains(document.activeElement)), `focus left the dialog after ${i + 1} presses`);
  }
  assert.equal(await page.evaluate(() => document.querySelector('.app').inert), true, 'the page behind is inert');
  await page.keyboard.press('Escape');
  await waitClosed(page, 'valueModal');
  assert.equal(await focusedId(page), 'collectionValueStat');
  assert.equal(await page.evaluate(() => document.querySelector('.app').inert), false);
});

appTest('Back closes the topmost dialog and never leaves the app', { storage: smallCollection() }, async ({ page }) => {
  const url = page.url();
  const historyBefore = await page.evaluate(() => history.length);
  await openCard(page, 'ALIENS');
  await page.click('#editPosterLookupBtn');
  await page.waitForSelector('#posterPickerModal.active');

  await page.goBack();
  await waitClosed(page, 'posterPickerModal');
  assert.equal(await isOpen(page, 'editModal'), true);
  await page.goBack();
  await waitClosed(page, 'editModal');
  assert.equal(page.url(), url);
  assert.ok(await page.locator('#movieGrid .card').count() > 0);

  // Dialogs closed on the page take their history entry with them.
  await openCard(page, 'ALIENS');
  await page.click('#closeModalBtn');
  await waitClosed(page, 'editModal');
  await page.waitForFunction((n) => history.length <= n + 2, historyBefore);
});

appTest('Back goes from Blueprint export to Add / scan to Collection', { storage: smallCollection() }, async ({ page }) => {
  await page.click('.tab[data-screen="add"]');
  await page.click('.tab[data-screen="export"]');
  await page.waitForSelector('#export.screen.active');
  await page.goBack();
  await page.waitForSelector('#add.screen.active');
  await page.goBack();
  await page.waitForSelector('#library.screen.active');
});

appTest('tabs are a tablist: arrow keys move between them', { storage: smallCollection() }, async ({ page }) => {
  const tab = page.locator('.tab[data-screen="library"]');
  assert.equal(await tab.getAttribute('role'), 'tab');
  assert.equal(await page.getAttribute('#library', 'role'), 'tabpanel');
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#add.screen.active');
  assert.equal(await page.getAttribute('.tab[data-screen="add"]', 'aria-selected'), 'true');
  await page.keyboard.press('End');
  await page.waitForSelector('#export.screen.active');
  await page.keyboard.press('ArrowRight');   // wraps around
  await page.waitForSelector('#library.screen.active');
});

appTest('Pick for me: Escape and Back close it, focus returns to the button, Details opens the picked title', { storage: smallCollection() }, async ({ page }) => {
  await page.click('#pickBtn');
  await page.waitForSelector('#pickModal.active');
  assert.match(await page.textContent('#pickBody'), /HEAT/, 'the only unseen title is picked');
  assert.ok(['pickAgainBtn', 'pickCloseBtn'].includes(await focusedId(page)));
  await page.keyboard.press('Escape');
  await waitClosed(page, 'pickModal');
  assert.equal(await focusedId(page), 'pickBtn');

  await page.click('#pickBtn');
  await page.waitForSelector('#pickModal.active');
  await page.goBack();
  await waitClosed(page, 'pickModal');

  await page.click('#pickBtn');
  await page.waitForSelector('#pickModal.active');
  await page.click('#pickDetailsBtn');
  await page.waitForSelector('#editModal.active');
  assert.equal(await isOpen(page, 'pickModal'), false);
  assert.equal(await page.inputValue('#editMovieTitle'), 'HEAT');
  await page.goBack();
  await waitClosed(page, 'editModal');
});

appTest('phone: a dialog opens with Close focused (no keyboard pop-up) and Back closes it', { device: PHONE, storage: smallCollection() }, async ({ page }) => {
  await page.click('.tab[data-screen="library"]');
  await page.locator('#movieGrid .card .title', { hasText: /^HEAT$/ }).tap();
  await page.waitForSelector('#editModal.active');
  assert.equal(await focusedId(page), 'closeModalBtn');
  await page.goBack();
  await waitClosed(page, 'editModal');
  assert.ok(await page.locator('#movieGrid .card').count() > 0);
});
