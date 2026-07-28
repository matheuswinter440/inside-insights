/* Avrios Evidence Engine — shared: key mgmt, CSV loader, system-prompt loader, API client */

const KEY_STORAGE = 'aee_anthropic_key';
const FEEDBACK_STORAGE = 'aee_feedback';

/* ============================================================
   API key management (BYOK, localStorage only — never committed)
   ============================================================ */
const Keys = {
  get() { return localStorage.getItem(KEY_STORAGE) || ''; },
  set(k) { localStorage.setItem(KEY_STORAGE, k.trim()); },
  clear() { localStorage.removeItem(KEY_STORAGE); },
  has() { return !!this.get(); },
};

/* Key-entry modal. Returns a promise that resolves once a key is stored. */
function ensureKey({ force = false } = {}) {
  return new Promise((resolve) => {
    if (Keys.has() && !force) { resolve(Keys.get()); return; }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>Anthropic API key</h2>
        <p>This tool calls the Anthropic API directly from your browser. Paste your
           key to continue — it is stored only in this browser's <code>localStorage</code>
           and is never sent anywhere except Anthropic.</p>
        <div class="warn">Bring-your-own-key. The key is not committed to the repo and
           not shared with other users. Use a key you're comfortable using client-side.</div>
        <input type="password" id="keyInput" placeholder="sk-ant-..." autocomplete="off" />
        <div class="modal-actions">
          <button class="btn" id="keySave">Save key</button>
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

/* Key status indicator in the top bar (present on every page). */
function renderKeyStatus() {
  const el = document.getElementById('keyStatus');
  if (!el) return;
  if (Keys.has()) {
    const k = Keys.get();
    const masked = k.length > 12 ? k.slice(0, 7) + '…' + k.slice(-4) : '••••';
    el.innerHTML = `<span class="email">key <code>${masked}</code></span>
      <button class="btn-link" id="changeKey">change</button>
      <button class="btn-link" id="clearKey">clear</button>`;
    el.querySelector('#changeKey').onclick = () => ensureKey({ force: true });
    el.querySelector('#clearKey').onclick = () => {
      Keys.clear(); renderKeyStatus();
    };
  } else {
    el.innerHTML = `<button class="btn-link" id="addKey">add API key</button>`;
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
let _systemPromptCache = null;

async function loadCorpusRaw() {
  if (_corpusRawCache !== null) return _corpusRawCache;
  const res = await fetch('./data/corpus_all.csv');
  if (!res.ok) throw new Error(`Could not load corpus (${res.status}). If viewing locally, serve over http (see README).`);
  _corpusRawCache = await res.text();
  return _corpusRawCache;
}

async function loadCorpusRows() {
  if (_corpusRowsCache !== null) return _corpusRowsCache;
  _corpusRowsCache = parseCSV(await loadCorpusRaw());
  return _corpusRowsCache;
}

async function loadSystemPrompt() {
  if (_systemPromptCache !== null) return _systemPromptCache;
  const res = await fetch('./data/system-prompt.txt');
  if (!res.ok) throw new Error(`Could not load system prompt (${res.status}).`);
  _systemPromptCache = await res.text();
  return _systemPromptCache;
}

/* Build system = prompt with the full corpus appended after "=== CORPUS ===".
   The committed prompt contains a placeholder line; we replace it with the CSV
   text so the file stays verbatim/editable but the model gets real cards. */
async function buildSystemWithCorpus() {
  const [prompt, csv] = await Promise.all([loadSystemPrompt(), loadCorpusRaw()]);
  const placeholder = '{the app appends the full contents of corpus_all.csv here at runtime}';
  if (prompt.includes(placeholder)) return prompt.replace(placeholder, csv.trim());
  // Fallback: append if the marker/placeholder isn't present.
  if (prompt.includes('=== CORPUS ===')) return prompt.trimEnd() + '\n' + csv.trim() + '\n';
  return prompt.trimEnd() + '\n\n=== CORPUS ===\n' + csv.trim() + '\n';
}

/* ============================================================
   Anthropic API client (direct browser call — CORS header required)
   ============================================================ */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

async function callAnthropic({ model, system, userContent, maxTokens = 1500 }) {
  const key = Keys.get();
  if (!key) throw new Error('NO_KEY');

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (netErr) {
    throw new Error(`Network/CORS error: ${netErr.message}`);
  }

  if (res.status === 401) { const e = new Error('Invalid API key (401). Please re-enter your key.'); e.code = 401; throw e; }
  if (res.status === 429) { const e = new Error('Rate limited (429). Wait a moment and try again.'); e.code = 429; throw e; }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `API error (${res.status})`;
    const e = new Error(msg); e.code = res.status; throw e;
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { text, usage: data.usage };
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
