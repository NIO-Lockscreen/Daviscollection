'use strict';
// `node --check` on every .js file in the repo (app scripts, service worker, Vercel function, tests).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git', '.vercel']);

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && /\.(c|m)?js$/.test(entry.name) ? [full] : [];
  });
}

const files = jsFiles(ROOT);

test('finds the app scripts', () => {
  const rel = files.map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  for (const f of ['js/seed-data.js', 'js/storage.js', 'js/covers.js', 'js/scanner.js', 'js/remote-scan.js', 'js/app.js', 'js/pwa.js', 'sw.js', 'api/barcode.js']) {
    assert.ok(rel.includes(f), `${f} not found`);
  }
});

for (const file of files) {
  test(`node --check ${path.relative(ROOT, file).split(path.sep).join('/')}`, () => {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(String(err.stderr || err.message));
    }
  });
}
