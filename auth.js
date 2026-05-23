// Movie Vault — Authentication
// Password is SHA-256 hashed and stored in localStorage.
// Session flag lives in sessionStorage (cleared automatically when the tab closes).

const AUTH_KEY = 'movieVault.auth.v1';
const AUTH_SES = 'movieVault.session';

// ── Core helpers ──────────────────────────────────────────────────────────────

async function authHash(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function authIsUnlocked()   { return sessionStorage.getItem(AUTH_SES) === '1'; }
function authSetUnlocked()  { sessionStorage.setItem(AUTH_SES, '1'); }
function authClearSession() { sessionStorage.removeItem(AUTH_SES); }

function authStoredHash() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY))?.hash ?? null; }
  catch { return null; }
}

function authHasPassword() { return authStoredHash() !== null; }

async function authVerify(pw) {
  return (await authHash(pw)) === authStoredHash();
}

async function authSetPassword(pw) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({
    hash: await authHash(pw),
    updated: new Date().toISOString()
  }));
}

// ── Login gate ────────────────────────────────────────────────────────────────
// Returns a Promise that resolves once the user is authenticated.

function authGate() {
  if (authIsUnlocked()) return Promise.resolve();
  return new Promise(resolve => _showLoginOverlay(resolve));
}

function _showLoginOverlay(onSuccess) {
  const overlay   = document.getElementById('loginOverlay');
  const titleEl   = document.getElementById('loginTitle');
  const subEl     = document.getElementById('loginSubtitle');
  const passEl    = document.getElementById('loginPassword');
  const confField = document.getElementById('loginConfirmField');
  const confEl    = document.getElementById('loginConfirm');
  const btn       = document.getElementById('loginSubmitBtn');
  const errEl     = document.getElementById('loginError');

  const newUser = !authHasPassword();

  titleEl.textContent = newUser ? 'Create a password' : 'Welcome back';
  subEl.textContent   = newUser
    ? 'Set a password to protect your collection. It is stored locally and never sent anywhere.'
    : 'Enter your password to access your collection.';
  confField.style.display = newUser ? '' : 'none';
  btn.textContent = newUser ? 'Create password' : 'Unlock';

  overlay.style.display = 'flex';
  requestAnimationFrame(() => passEl.focus());

  async function attempt() {
    const pw = passEl.value;
    errEl.textContent = '';
    if (!pw) { errEl.textContent = 'Please enter a password.'; return; }

    if (newUser) {
      if (pw.length < 4)            { errEl.textContent = 'Password must be at least 4 characters.'; return; }
      if (pw !== confEl.value)       { errEl.textContent = 'Passwords do not match.'; return; }
      await authSetPassword(pw);
    } else {
      if (!await authVerify(pw)) {
        errEl.textContent = 'Wrong password.';
        passEl.value = '';
        passEl.focus();
        return;
      }
    }

    authSetUnlocked();
    overlay.style.display = 'none';
    onSuccess();
  }

  btn.onclick       = attempt;
  passEl.onkeydown  = e => { if (e.key === 'Enter') attempt(); };
  confEl.onkeydown  = e => { if (e.key === 'Enter') attempt(); };
}

// ── Change-password (called from settings modal) ──────────────────────────────

async function authChangePassword(oldPw, newPw, confirmPw) {
  if (!newPw)              return 'New password cannot be empty.';
  if (newPw.length < 4)   return 'Password must be at least 4 characters.';
  if (newPw !== confirmPw) return 'Passwords do not match.';

  if (authHasPassword()) {
    if (!oldPw)                        return 'Please enter your current password.';
    if (!await authVerify(oldPw))      return 'Current password is wrong.';
  }

  await authSetPassword(newPw);
  return null; // null = success
}
