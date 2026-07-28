/* Avrios Evidence Engine — Evaluate page logic */

let attachedImage = null; // { dataUrl, mediaType, base64 }
let lastResult = null;    // { id, hypothesis, model, verdict, text }

const els = {};
document.addEventListener('DOMContentLoaded', () => {
  els.form = document.getElementById('evalForm');
  els.hypothesis = document.getElementById('hypothesis');
  els.model = document.getElementById('model');
  els.file = document.getElementById('imageInput');
  els.imgPreview = document.getElementById('imgPreview');
  els.submit = document.getElementById('submitBtn');
  els.result = document.getElementById('result');
  els.status = document.getElementById('status');

  els.file.addEventListener('change', onImageSelected);
  els.form.addEventListener('submit', onSubmit);

  // Prompt for a key up front if none stored (non-blocking).
  if (!Keys.has()) ensureKey();
});

/* ---- Image handling ---- */
function onImageSelected(e) {
  const file = e.target.files[0];
  if (!file) { clearImage(); return; }
  if (!file.type.startsWith('image/')) {
    showStatus('That file is not an image.', 'error');
    clearImage(); return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = dataUrl.split(',')[1];
    attachedImage = { dataUrl, mediaType: file.type, base64 };
    els.imgPreview.innerHTML = `<img src="${dataUrl}" alt="attached image preview" />
      <button type="button" class="btn secondary" id="removeImg">remove</button>`;
    els.imgPreview.querySelector('#removeImg').onclick = clearImage;
  };
  reader.readAsDataURL(file);
}
function clearImage() {
  attachedImage = null;
  els.file.value = '';
  els.imgPreview.innerHTML = '';
}

/* ---- Submit / evaluate ---- */
async function onSubmit(e) {
  e.preventDefault();
  const hypothesis = els.hypothesis.value.trim();
  if (!hypothesis) { els.hypothesis.focus(); return; }

  const key = await ensureKey();
  if (!key) { showStatus('An API key is required to evaluate.', 'error'); return; }

  setLoading(true);
  els.result.classList.add('hidden');
  showStatus('<span class="spinner"></span>Retrieving evidence from the corpus…');

  try {
    const system = await buildSystemWithCorpus();
    const model = els.model.value;

    const userContent = [];
    if (attachedImage) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: attachedImage.mediaType, data: attachedImage.base64 },
      });
    }
    userContent.push({ type: 'text', text: hypothesis });

    const { text } = await callAnthropic({ model, system, userContent });
    clearStatus();
    renderResult({ hypothesis, model, text });
  } catch (err) {
    if (err.code === 401) { showStatus(err.message, 'error'); ensureKey({ force: true }); }
    else showStatus(err.message || String(err), 'error');
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  els.submit.disabled = on;
  els.submit.textContent = on ? 'Evaluating…' : 'Evaluate';
}
function showStatus(html, cls = '') {
  els.status.className = 'status-msg' + (cls ? ' ' + cls : '');
  els.status.innerHTML = html;
  els.status.classList.remove('hidden');
}
function clearStatus() { els.status.classList.add('hidden'); els.status.innerHTML = ''; }

/* ---- Render structured result (verbatim body + parsed header for the badge) ---- */
function parseVerdict(text) {
  const m = text.match(/Verdict:\s*(SUPPORTED|CONTRADICTED|PARTIAL|GAP)/i);
  return m ? m[1].toUpperCase() : null;
}
function parseStrengthLine(text) {
  const m = text.match(/Strength:\s*(.+)/i);
  return m ? m[1].trim() : null;
}

function renderResult({ hypothesis, model, text }) {
  const verdict = parseVerdict(text);
  const strength = parseStrengthLine(text);
  const id = 'r_' + Date.now();
  lastResult = { id, hypothesis, model, verdict, text };

  const badgeClass = (verdict || 'gap').toLowerCase();
  const strengthPill = strength ? `<span class="strength-pill">${escapeHtml(strength)}</span>` : '';

  els.result.innerHTML = `
    <div class="panel">
      <div class="verdict-header">
        ${verdict ? `<span class="badge ${badgeClass}">${verdict}</span>` : ''}
        ${strengthPill}
      </div>
      <div class="result-body">${formatBody(text)}</div>
      <div class="feedback" id="feedback">
        <span style="font-size:13px;color:var(--text-dim)">Was this right?</span>
        <button class="fb-btn" data-v="up" title="helpful">👍</button>
        <button class="fb-btn" data-v="down" title="not helpful">👎</button>
        <input type="text" id="fbNote" placeholder="optional note…" />
        <span class="saved-note hidden" id="fbSaved">saved ✓</span>
      </div>
    </div>`;
  els.result.classList.remove('hidden');
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  wireFeedback();
}

/* Bold the leading labels; keep the rest verbatim. */
function formatBody(text) {
  const labels = ['Verdict', 'Strength', 'Evidence', 'Contradicts', 'Recommendation'];
  return escapeHtml(text)
    .split('\n')
    .map(line => {
      for (const lbl of labels) {
        const re = new RegExp('^(' + lbl + '):');
        if (re.test(line)) return line.replace(re, '<strong>$1:</strong>');
      }
      return line;
    })
    .join('\n');
}

function wireFeedback() {
  const fb = document.getElementById('feedback');
  const note = document.getElementById('fbNote');
  const saved = document.getElementById('fbSaved');
  let vote = null;

  fb.querySelectorAll('.fb-btn').forEach(btn => {
    btn.onclick = () => {
      vote = btn.dataset.v;
      fb.querySelectorAll('.fb-btn').forEach(b => b.classList.remove('active-up', 'active-down'));
      btn.classList.add(vote === 'up' ? 'active-up' : 'active-down');
      persist();
    };
  });
  note.addEventListener('input', () => { if (vote) persist(); });

  function persist() {
    Feedback.upsert({
      id: lastResult.id,
      timestamp: new Date().toISOString(),
      hypothesis: lastResult.hypothesis,
      model: lastResult.model,
      verdict: lastResult.verdict,
      vote,
      note: note.value.trim(),
      result: lastResult.text,
    });
    saved.classList.remove('hidden');
    updateExportCount();
    clearTimeout(persist._t);
    persist._t = setTimeout(() => saved.classList.add('hidden'), 1500);
  }
}

function updateExportCount() {
  const btn = document.getElementById('exportBtn');
  if (btn) btn.textContent = `Export feedback (${Feedback.count()})`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Export button wiring (in the toolbar). */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('exportBtn');
  if (btn) {
    updateExportCount();
    btn.onclick = () => {
      if (Feedback.count() === 0) { showStatus('No feedback logged yet.', ''); return; }
      Feedback.export();
    };
  }
});
