'use strict';
// Shared helpers for the browser tests: a tiny static server for the repo root, one Chromium per test file,
// and an `appTest()` wrapper that gives every test a fresh browser context (empty localStorage) which
// never leaves localhost and fails the test on any uncaught error in the page.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');            // the repo root, served as-is (no build step)
const STORAGE_KEY = 'movieVault.privateCollection.v1';
const UNSORTED = 'UNSORTED / NOT PLACED';

const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { ...devices['Pixel 7'] };                     // isMobile + hasTouch, 412 px wide

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------- Static file server (random free port on 127.0.0.1) ---------- */
function startServer(root = ROOT) {
  const server = http.createServer((req, res) => {
    let file;
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      file = path.join(root, path.normalize(pathname));
    } catch (_) {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (file !== root && !file.startsWith(root + path.sep)) {   // no escaping the repo root
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        file = path.join(file, 'index.html');
      }
      fs.readFile(file, (readErr, body) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

/* ---------- Browser ---------- */
// Uses whichever `playwright` module resolves (tests/node_modules when installed, else the global one).
// If that version's browser build is not installed, fall back to a pre-installed Chromium binary
// (MV_CHROMIUM, or /opt/pw-browsers/chromium as in the Claude Code sandbox).
async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (err) {
    const fallback = process.env.MV_CHROMIUM || '/opt/pw-browsers/chromium';
    if (/Executable doesn't exist/i.test(String(err && err.message)) && fs.existsSync(fallback)) {
      return chromium.launch({ executablePath: fallback });
    }
    throw err;
  }
}

function isLocalUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'data:' || protocol === 'blob:') return true;
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch (_) {
    return false;
  }
}

/* ---------- One server + one browser per test file ---------- */
const suite = { server: null, browser: null };
before(async () => {
  [suite.server, suite.browser] = await Promise.all([startServer(), launchBrowser()]);
});
after(async () => {
  await suite.browser?.close();
  await suite.server?.close();
});

/**
 * Opens the app in a fresh context.
 * opts.device   DESKTOP (default) or PHONE
 * opts.storage  a collection object written to localStorage before the first load (instead of the seed)
 * opts.path     URL path, default '/'
 */
async function openApp(opts = {}) {
  const context = await suite.browser.newContext({
    ...(opts.device || DESKTOP),
    locale: 'en-US',
    timezoneId: 'Europe/Oslo',
    serviceWorkers: 'block',   // keep the network deterministic: no service worker between the page and page.route
    acceptDownloads: true,
  });
  const blocked = [];
  // Only the local server is reachable: cover lookups, the barcode API, the QR library and the ntfy.sh relay all fail fast.
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocalUrl(url)) return route.continue();
    blocked.push(url);
    return route.abort('blockedbyclient');
  });
  if (opts.storage) {
    // Written once per tab (sessionStorage flag), so a reload sees what the app saved, not this again.
    await context.addInitScript(([key, value]) => {
      if (!sessionStorage.getItem('mvTestSeeded')) {
        localStorage.setItem(key, value);
        sessionStorage.setItem('mvTestSeeded', '1');
      }
    }, [STORAGE_KEY, typeof opts.storage === 'string' ? opts.storage : JSON.stringify(opts.storage)]);
  }
  const page = await context.newPage();
  const errors = [];
  let failOnError;
  // Rejects on the first uncaught page error; raced against the test body so the test fails at once with that error.
  const pageError = new Promise((_, reject) => { failOnError = reject; });
  pageError.catch(() => {});   // never left unhandled when nothing races it
  page.on('pageerror', (err) => {
    errors.push(err);
    failOnError(new Error(`Uncaught error in the page: ${err && err.stack || err}`));
  });
  try {
    await Promise.race([
      (async () => { await page.goto(suite.server.url + (opts.path || '/')); await waitForApp(page); })(),
      pageError,
    ]);
  } catch (err) {
    await context.close();
    throw err;
  }
  return { page, context, errors, blocked, pageError, baseUrl: suite.server.url };
}

/** Waits until the collection list has rendered ("Showing N of M titles"). */
async function waitForApp(page) {
  await page.waitForFunction(() => /^Showing [\d,]+ of [\d,]+ titles$/.test(document.getElementById('resultText')?.textContent || ''));
}

/**
 * test() with a fresh app: fn(app, t) gets {page, context, errors, blocked, baseUrl}.
 * Fails on any `pageerror`, and always closes the context.
 */
function appTest(name, opts, fn) {
  if (typeof opts === 'function') [fn, opts] = [opts, {}];
  const { todo, skip, timeout = 45000, ...appOpts } = opts;
  return test(name, { todo, skip, timeout }, async (t) => {
    const app = await openApp(appOpts);
    try {
      await Promise.race([fn(app, t), app.pageError]);
      if (app.errors.length) throw new Error(`Uncaught error in the page: ${app.errors[0].stack || app.errors[0]}`);
    } finally {
      await app.context.close();
    }
  });
}

/* ---------- Small UI helpers ---------- */
async function showTab(page, screen) {
  await page.click(`.tab[data-screen="${screen}"]`);
  await page.waitForSelector(`#${screen}.screen.active`);
}

/** On a phone the filters sit behind the "Filters" button. */
async function openFilters(page) {
  const toggle = page.locator('#filtersToggle');
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** Types a search and applies it at once (Enter skips the 150 ms debounce). */
async function search(page, text) {
  await page.fill('#searchInput', text);
  await page.press('#searchInput', 'Enter');
}

const cardTitles = (page) => page.$$eval('#movieGrid .card .title', (els) => els.map((e) => e.textContent));
const resultText = (page) => page.textContent('#resultText');

/** The collection as the app holds it in memory (`state` is a global of app.js). */
const appState = (page) => page.evaluate(() => state);
/** The collection as saved in localStorage. */
const savedState = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);

/** Resolves with the message of the next alert/confirm, after accepting (or dismissing) it. */
function nextDialog(page, action = 'accept') {
  return new Promise((resolve) => {
    page.once('dialog', async (dialog) => {
      const message = dialog.message();
      await (action === 'accept' ? dialog.accept() : dialog.dismiss());
      resolve(message);
    });
  });
}

/** Text of the visible toast; with `pattern`, waits for a toast matching it (for toasts shown after async work). */
async function toastText(page, pattern) {
  const toast = page.locator('#toast.show', pattern ? { hasText: pattern } : {});
  await toast.waitFor();
  return toast.textContent();
}
async function clickToastUndo(page) {
  await page.locator('#toast.show .toastBtn', { hasText: 'Undo' }).click();
}

/** Clicks something that downloads a file; resolves with {name, text}. */
async function download(page, click) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), text: fs.readFileSync(file, 'utf8') };
}

/** Opens the edit dialog of the first card whose title is exactly `title`. */
async function openCard(page, title) {
  await page.locator('#movieGrid .card .title', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }).first().click();
  await page.waitForSelector('#editModal.active');
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** A small, current-schema collection for tests that do not need the 2,300-title seed. */
function smallCollection(extra = {}) {
  const movie = (id, title, section, more = {}) => ({
    id, title, section, format: 'Blu-ray', barcode: '', poster: '', posterRemoved: false, notes: '', catalog: '',
    seen: true, added: '2026-01-01', updated: '2026-01-01', ...more,
  });
  return {
    schemaVersion: 2,
    movies: [
      movie('t-1', 'ALIEN', 'SCI-FI'),
      movie('t-2', 'ALIENS', 'SCI-FI'),
      movie('t-3', 'BLADE RUNNER', 'SCI-FI', { format: '4K UHD' }),
      movie('t-4', 'HEAT', 'CRIME', { seen: false }),
      movie('t-5', 'THE GODFATHER', 'CRIME'),
      movie('t-6', 'NEW ARRIVAL', UNSORTED),
    ],
    sectionOrder: [UNSORTED, 'SCI-FI', 'CRIME', 'EMPTY SHELF'],
    toSortShelves: [],
    importedFrom: 'test',
    importedCount: 6,
    collectionValue: 0,
    valueHistory: [],
    ...extra,
  };
}

module.exports = {
  ROOT, STORAGE_KEY, UNSORTED, DESKTOP, PHONE,
  startServer, launchBrowser, openApp, waitForApp, appTest, suite,
  showTab, openFilters, search, cardTitles, resultText, appState, savedState,
  nextDialog, toastText, clickToastUndo, download, openCard, smallCollection,
};
