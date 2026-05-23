// Movie Vault — Vercel Blob sync
// Token and blob URL stored in localStorage.
// Pull on load (cloud-first), push on every save.

const SYNC_KEY  = 'movieVault.sync.v1';
const BLOB_PATH = 'movievault/collection.json';

// ── Config ────────────────────────────────────────────────────────────────────

function syncGetConfig() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; }
  catch { return {}; }
}

function syncSetConfig(patch) {
  localStorage.setItem(SYNC_KEY, JSON.stringify({ ...syncGetConfig(), ...patch }));
}

function syncHasToken() { return Boolean(syncGetConfig().token); }

// Derive the public blob base URL from the Vercel Blob token.
// Token format: vercel_blob_rw_{storeId}_{secret}
function syncBaseUrl(token) {
  const p = (token || '').split('_');
  if (p.length >= 5 && p[0] === 'vercel' && p[1] === 'blob') {
    return `https://${p[3]}.public.blob.vercel-storage.com`;
  }
  return null;
}

// ── Push ──────────────────────────────────────────────────────────────────────

async function syncPush(data) {
  const { token } = syncGetConfig();
  if (!token) return { ok: false, error: 'No token — open ⚙ Settings to configure.' };

  try {
    const res = await fetch(`https://blob.vercel-storage.com/${BLOB_PATH}`, {
      method: 'PUT',
      headers: {
        'Authorization':      `Bearer ${token}`,
        'Content-Type':       'application/json',
        'x-add-random-suffix': '0',
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => String(res.status));
      throw new Error(`${res.status}: ${msg}`);
    }

    const blob = await res.json();
    syncSetConfig({ blobUrl: blob.url, lastPush: Date.now() });
    return { ok: true, url: blob.url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Pull ──────────────────────────────────────────────────────────────────────

async function syncPull() {
  const cfg = syncGetConfig();
  if (!cfg.token) return { ok: false, skip: true };

  // Prefer the saved blob URL; fall back to derived URL on first pull
  const base   = syncBaseUrl(cfg.token);
  const blobUrl = cfg.blobUrl || (base ? `${base}/${BLOB_PATH}` : null);
  if (!blobUrl) return { ok: false, skip: true };

  try {
    const res = await fetch(`${blobUrl}?_cb=${Date.now()}`);
    if (res.status === 404) return { ok: true, notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    syncSetConfig({ lastPull: Date.now() });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── App-level helpers (call from app.js) ──────────────────────────────────────

// Called in init() after auth — loads from cloud and updates global state.
// 'state', 'normalizeState', and 'STORAGE_KEY' are globals defined in app.js.
async function syncOnLoad() {
  if (!syncHasToken()) { updateSyncBadge('idle'); return; }

  updateSyncBadge('syncing', 'Loading from cloud…');
  const r = await syncPull();

  if (r.ok && r.data) {
    try {
      // eslint-disable-next-line no-undef
      state = normalizeState(r.data);
      // eslint-disable-next-line no-undef
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      updateSyncBadge('ok', 'Loaded from cloud');
    } catch (e) {
      updateSyncBadge('error', 'Cloud data error: ' + e.message);
    }
  } else if (r.notFound) {
    updateSyncBadge('ok', 'Cloud is empty — will push on first save');
  } else if (r.skip) {
    updateSyncBadge('idle');
  } else {
    updateSyncBadge('error', r.error || 'Sync failed');
  }
}

// Called in save() — pushes silently in the background.
async function syncPushSilent() {
  if (!syncHasToken()) return;
  updateSyncBadge('syncing', 'Saving to cloud…');
  // eslint-disable-next-line no-undef
  const r = await syncPush(state);
  if (r.ok) {
    updateSyncBadge('ok', 'Saved to cloud');
    _refreshSyncSettingsUI();
  } else {
    updateSyncBadge('error', r.error);
    // eslint-disable-next-line no-undef
    if (typeof toast === 'function') toast('☁ Cloud sync failed: ' + r.error);
  }
}

// ── Status badge ──────────────────────────────────────────────────────────────

function updateSyncBadge(status, msg) {
  const labels = { idle: 'No cloud sync', syncing: 'Syncing…', ok: 'Synced ✓', error: 'Sync error' };
  const badge  = document.getElementById('syncBadge');
  const text   = document.getElementById('syncStatusText');
  const last   = document.getElementById('syncLastPush');

  if (badge) {
    badge.className = `syncBadge syncBadge--${status}`;
    badge.title     = msg || labels[status] || status;
    badge.setAttribute('aria-label', badge.title);
  }
  if (text) text.textContent = msg || labels[status] || status;
  _refreshSyncSettingsUI();
  if (last) {
    const t = syncGetConfig().lastPush;
    last.textContent = t ? 'Last push: ' + new Date(t).toLocaleString() : 'Never';
  }
}

// Refresh the token field + timestamp in the settings modal if it is open
function _refreshSyncSettingsUI() {
  const cfg  = syncGetConfig();
  const inp  = document.getElementById('syncTokenInput');
  const last = document.getElementById('syncLastPush');
  if (inp && !inp.dataset.dirty) inp.placeholder = cfg.token ? 'Token saved ✓ (paste to replace)' : 'vercel_blob_rw_…';
  if (last) {
    const t = cfg.lastPush;
    last.textContent = t ? 'Last push: ' + new Date(t).toLocaleString() : 'Never';
  }
}
