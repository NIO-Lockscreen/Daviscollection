'use strict';
// Blueprint export: the whole list, or one shelf only.
const assert = require('node:assert/strict');
const { appTest, showTab, savedState, download, smallCollection } = require('./helpers');

/** Shelf headings of a blueprint text: lines "SHELF:<tab><tab>* TITLE". */
const headings = (text) => [...text.matchAll(/^([^\t\n*][^\t\n]*):\t\t\* /gm)].map((m) => m[1]);
const bullets = (text) => text.split('\n').filter((l) => /^(\S.*:\t\t|\t\t\t)\* /.test(l));

appTest('blueprint for one shelf contains only that shelf (preview and TXT download)', async ({ page }) => {
  await showTab(page, 'export');
  await page.selectOption('#blueprintShelf', 'CLASSIC FILM');
  const preview = await page.textContent('#blueprintPreview');
  assert.match(preview, /^THE DIGITAL VIDEO DISC COLLECTION\n/);
  assert.deepEqual(headings(preview), ['CLASSIC FILM']);
  const saved = await savedState(page);
  const onShelf = saved.movies.filter((m) => m.section === 'CLASSIC FILM').map((m) => m.title).sort((a, b) => a.localeCompare(b));
  assert.equal(onShelf.length, 6);
  assert.deepEqual(bullets(preview).map((l) => l.replace(/^.*?\* /, '')), onShelf, 'every title of the shelf, A–Z, nothing else');

  const txt = await download(page, () => page.click('#downloadBlueprintTextBtn'));
  assert.equal(txt.name, 'digital-video-disc-collection-blueprint-classic-film.txt');
  assert.equal(txt.text, preview);

  const html = await download(page, () => page.click('#downloadBlueprintBtn'));
  assert.equal(html.name, 'digital-video-disc-collection-blueprint-classic-film.html');
  assert.match(html.text, /^<!doctype html>/);
  assert.ok(html.text.includes('CLASSIC FILM:'));
  assert.ok(!html.text.includes('TV ROOM:'));
});

appTest('blueprint for all shelves lists every shelf that holds titles, in shelf order', async ({ page }) => {
  await showTab(page, 'export');
  assert.equal(await page.inputValue('#blueprintShelf'), '', 'All shelves is the default');
  const saved = await savedState(page);
  const used = new Set(saved.movies.map((m) => m.section));
  const expected = saved.sectionOrder.filter((s) => used.has(s));
  // The preview is cut at 12,000 characters, so check the full text of the TXT download.
  const txt = await download(page, () => page.click('#downloadBlueprintTextBtn'));
  assert.equal(txt.name, 'digital-video-disc-collection-blueprint.txt');
  assert.deepEqual(headings(txt.text), expected);
  assert.equal(bullets(txt.text).length, saved.movies.length);
  assert.match(await page.textContent('#blueprintPreview'), /Preview truncated, export contains the full list\.$/);
});

appTest('blueprint lines carry "not seen" and barcode notes', { storage: smallCollection() }, async ({ page }) => {
  await page.evaluate(() => { state.movies.find((m) => m.title === 'THE GODFATHER').barcode = '036000291452'; save(); });
  await showTab(page, 'export');
  await page.selectOption('#blueprintShelf', 'CRIME');
  const preview = await page.textContent('#blueprintPreview');
  assert.deepEqual(headings(preview), ['CRIME']);
  assert.deepEqual(bullets(preview), ['CRIME:\t\t* HEAT \tnot seen', '\t\t\t* THE GODFATHER \tbarcode 036000291452']);
});
