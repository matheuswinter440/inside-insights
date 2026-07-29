/* Avrios Evidence Engine — shared: access password, CSV loader, Worker client */

/* Deployed Worker. It holds the Anthropic key, the GitHub token and the access
   password; none of those ever reach the browser. Point this at
   http://localhost:8787 while running `wrangler dev`. */
const WORKER_URL = 'https://avrios-evidence-engine.winterdyck-matheus.workers.dev';

const KEY_STORAGE = 'aee_access_password';
const FEEDBACK_STORAGE = 'aee_feedback';

/* ============================================================
   Access password (shared team secret, this browser only)
   ------------------------------------------------------------
   This replaces bring-your-own-key. Previously each teammate pasted a personal
   Anthropic key here; now one Worker holds one key and this password is what
   gets you through to it.
   ============================================================ */
const Keys = {
  get() { return localStorage.getItem(KEY_STORAGE) || ''; },
  set(k) { localStorage.setItem(KEY_STORAGE, k.trim()); },
  clear() { localStorage.removeItem(KEY_STORAGE); },
  has() { return !!this.get(); },
};

/* Password modal. Resolves once a password is stored, or null if cancelled. */
function ensureKey({ force = false } = {}) {
  return new Promise((resolve) => {
    if (Keys.has() && !force) { resolve(Keys.get()); return; }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>Access password</h2>
        <p>This tool talks to Anthropic through our own backend, so you don't need
           an Anthropic key. Enter the team access password — it is stored only in
           this browser's <code>localStorage</code>.</p>
        <div class="warn">One shared password for the team. Model usage bills to the
           team key, so don't pass it outside the team.</div>
        <input type="password" id="keyInput" placeholder="access password" autocomplete="current-password" />
        <div class="modal-actions">
          <button class="btn" id="keySave">Save</button>
          <button class="btn secondary" id="keyCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#keyInput');
    input.value = Keys.get();
    input.focus();

    const close = () => overlay.remove();
    overlay.querySelector('#keySave').onclick = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      Keys.set(v);
      close();
      renderKeyStatus();
      resolve(v);
    };
    overlay.querySelector('#keyCancel').onclick = () => { close(); resolve(null); };
    input.onkeydown = (e) => { if (e.key === 'Enter') overlay.querySelector('#keySave').click(); };
  });
}

/* Status indicator in the top bar (present on every page). Never renders the
   password itself — unlike an API key prefix, there is no non-secret part. */
function renderKeyStatus() {
  const el = document.getElementById('keyStatus');
  if (!el) return;
  if (Keys.has()) {
    el.innerHTML = `<span class="email">signed in</span>
      <button class="btn-link" id="changeKey">change</button>
      <button class="btn-link" id="clearKey">clear</button>`;
    el.querySelector('#changeKey').onclick = () => ensureKey({ force: true });
    el.querySelector('#clearKey').onclick = () => {
      Keys.clear(); renderKeyStatus();
    };
  } else {
    el.innerHTML = `<button class="btn-link" id="addKey">enter password</button>`;
    el.querySelector('#addKey').onclick = () => ensureKey({ force: true });
  }
}

/* ============================================================
   CSV parser — handles quoted fields with embedded newlines & commas
   ============================================================ */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  // Normalize line endings.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // Flush last field/row if any content remains.
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.length && r.some(v => v.trim() !== ''))
    .map(r => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
      return obj;
    });
}

/* Cache so both pages / repeat calls don't re-fetch. */
let _corpusRawCache = null;   // raw CSV text
let _corpusRowsCache = null;  // parsed rows

async function loadCorpusRaw() {
  if (_corpusRawCache !== null) return _corpusRawCache;
  // Revalidate rather than cache-bust with a hardcoded token: the corpus now
  // changes on every ingest, with no deploy to bump a version against. The
  // browser sends If-None-Match and gets a cheap 304 when nothing changed —
  // and the new cards when something did. A stale corpus is indistinguishable
  // from "my cards didn't show up".
  const res = await fetch('./data/corpus_all.csv', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load corpus (${res.status}). If viewing locally, serve over http (see README).`);
  _corpusRawCache = await res.text();
  return _corpusRawCache;
}

async function loadCorpusRows() {
  if (_corpusRowsCache !== null) return _corpusRowsCache;
  _corpusRowsCache = parseCSV(await loadCorpusRaw());
  return _corpusRowsCache;
}

/* ============================================================
   Worker client
   ------------------------------------------------------------
   The prompts and the Anthropic key live on the Worker, so the browser sends
   only its own inputs. Prompt assembly that used to happen here
   (buildSystemWithCandidates) moved server-side.
   ============================================================ */
async function callWorker(path, payload) {
  const password = Keys.get();
  if (!password) throw new Error('NO_KEY');

  let res;
  try {
    res = await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-access-password': password,
      },
      body: JSON.stringify(payload),
    });
  } catch (netErr) {
    throw new Error(`Could not reach the backend: ${netErr.message}. `
      + 'Check that the Worker is deployed and that this origin is in ALLOWED_ORIGINS.');
  }

  const data = await res.json().catch(() => null);

  if (res.status === 401) {
    // The stored password is wrong, so drop it rather than letting every later
    // request fail against a value the user can't see.
    Keys.clear();
    renderKeyStatus();
    const e = new Error('Wrong access password. Please enter it again.');
    e.code = 401;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(data?.error || `Backend error (${res.status})`);
    e.code = res.status;
    throw e;
  }
  return data;
}

/* ============================================================
   Feedback store (localStorage) + export
   ============================================================ */
const Feedback = {
  all() {
    try { return JSON.parse(localStorage.getItem(FEEDBACK_STORAGE) || '[]'); }
    catch { return []; }
  },
  add(entry) {
    const list = this.all();
    list.push(entry);
    localStorage.setItem(FEEDBACK_STORAGE, JSON.stringify(list));
  },
  /* Replace the most recent entry that shares this id (one feedback per result). */
  upsert(entry) {
    const list = this.all();
    const idx = list.findIndex(e => e.id === entry.id);
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    localStorage.setItem(FEEDBACK_STORAGE, JSON.stringify(list));
  },
  count() { return this.all().length; },
  export() {
    const blob = new Blob([JSON.stringify(this.all(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `evidence-engine-feedback-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/* Init the top-bar key status on every page. */
document.addEventListener('DOMContentLoaded', renderKeyStatus);
