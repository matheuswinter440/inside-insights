/* Avrios Evidence Engine — Evaluate page logic */

let lastResult = null;    // { id, hypothesis, model, verdict, text }

const els = {};
document.addEventListener('DOMContentLoaded', () => {
  els.form = document.getElementById('evalForm');
  els.hypothesis = document.getElementById('hypothesis');
  els.model = document.getElementById('model');
  els.submit = document.getElementById('submitBtn');
  els.result = document.getElementById('result');
  els.status = document.getElementById('status');

  els.form.addEventListener('submit', onSubmit);

  if (!Keys.has()) ensureKey();
});

/* ---- Submit ---- */
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
    const userContent = [{ type: 'text', text: hypothesis }];

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

function setLoading(on) { els.submit.disabled = on; els.submit.textContent = on ? 'Evaluating…' : 'Evaluate'; }
function showStatus(html, cls = '') { els.status.className = 'status-msg' + (cls ? ' ' + cls : ''); els.status.innerHTML = html; els.status.classList.remove('hidden'); }
function clearStatus() { els.status.classList.add('hidden'); els.status.innerHTML = ''; }

/* ============================================================
   Parse the fixed-format model output into structured fields.
   Format (from system-prompt.txt):
     Verdict / Strength / Evidence / Contradicts / Recommendation
   ============================================================ */
const LABELS = ['Verdict', 'Strength', 'Evidence', 'Contradicts', 'Recommendation'];

function parseResult(text) {
  const pos = {};
  LABELS.forEach(l => { const m = text.match(new RegExp('^[ \\t>*-]*' + l + '\\s*:', 'mi')); if (m) pos[l] = m.index; });

  function section(l) {
    if (pos[l] == null) return null;
    let body = text.slice(pos[l]).replace(new RegExp('^[ \\t>*-]*' + l + '\\s*:', 'i'), '');
    let cut = body.length;
    LABELS.forEach(o => {
      if (o === l) return;
      const m = body.match(new RegExp('\\n[ \\t>*-]*' + o + '\\s*:', 'i'));
      if (m && m.index < cut) cut = m.index;
    });
    return body.slice(0, cut).trim();
  }

  const verdictRaw = section('Verdict') || '';
  const vm = verdictRaw.match(/SUPPORTED|CONTRADICTED|PARTIAL|GAP/i);
  const verdict = vm ? vm[0].toUpperCase() : 'GAP';

  const strengthRaw = section('Strength') || '';
  const sm = strengthRaw.match(/(\d+)\s*\/\s*3/);
  const score = sm ? Math.max(0, Math.min(3, parseInt(sm[1], 10))) : (verdict === 'GAP' ? 0 : 1);
  // label word after the score, e.g. "2/3 Moderate — ..."
  const lw = strengthRaw.replace(/^\s*\d+\s*\/\s*3\s*/, '').match(/^([A-Za-z][A-Za-z ()]*?)(?=[—\-–;]|$)/);
  const scoreWord = lw ? lw[1].trim() : '';
  // detail = everything after the first dash separator
  const dashIdx = strengthRaw.search(/[—–]|\s-\s/);
  const strengthDetail = dashIdx >= 0 ? strengthRaw.slice(dashIdx).replace(/^[—–\- ]+/, '').trim() : strengthRaw.trim();

  const evidence = splitCards(section('Evidence'));
  const contradicts = splitCards(section('Contradicts'));
  const recommendation = section('Recommendation') || '';

  return { verdict, score, scoreWord, strengthDetail, evidence, contradicts, recommendation };
}

/* Split an Evidence/Contradicts block into card objects {text, meta, more}. */
function splitCards(block) {
  if (!block) return [];
  return block.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    line = line.replace(/^[•\-*–—\d.)\s]+/, '').trim();
    const more = /^\+\s*\d+\s+more/i.test(line);
    if (more) return { more: line };
    // Split "insight" — Source, Date  →  text + meta
    const m = line.match(/^(.*?)(?:\s+[—–]\s+|\s+-\s+)(.+)$/);
    if (m) return { text: stripQuotes(m[1]), meta: m[2].trim() };
    return { text: stripQuotes(line), meta: '' };
  });
}
function stripQuotes(s) { return s.replace(/^["“”']+|["“”']+$/g, '').trim(); }

/* ---- Render ---- */
function renderResult({ hypothesis, model, text }) {
  const p = parseResult(text);
  const id = 'r_' + Date.now();
  lastResult = { id, hypothesis, model, verdict: p.verdict, text };

  const vClass = p.verdict.toLowerCase();
  const vLabel = { SUPPORTED: 'Supported', CONTRADICTED: 'Contradicted', PARTIAL: 'Partially supported', GAP: 'Evidence gap' }[p.verdict];
  const pct = Math.round((p.score / 3) * 100);

  const metaBits = [];
  if (p.strengthDetail) metaBits.push(escapeHtml(p.strengthDetail));
  if (p.contradicts.filter(c => !c.more).length) metaBits.push(p.contradicts.filter(c => !c.more).length + ' contradiction' + (p.contradicts.filter(c => !c.more).length > 1 ? 's' : ''));
  const metaLine = metaBits.join(' · ');

  const contraHtml = p.contradicts.length ? `
    <div class="ev-col contra">
      <h3>Contradicting evidence</h3>
      ${cardsHtml(p.contradicts)}
    </div>` : '';

  const evidenceHtml = p.evidence.length ? `
    <div class="ev-col support">
      <h3>Supporting evidence</h3>
      ${cardsHtml(p.evidence)}
    </div>` : `
    <div class="ev-col support">
      <h3>Supporting evidence</h3>
      <p class="ev-empty">No cards in the corpus directly support this — see the recommendation.</p>
    </div>`;

  els.result.innerHTML = `
    <div class="verdict-block result-card">
      <div class="verdict-top">
        <span class="badge ${vClass}">${vLabel}</span>
        ${metaLine ? `<span class="verdict-meta">${metaLine}</span>` : ''}
      </div>
      <div class="strength">
        <div class="row"><span>Strength score</span><span class="val">${p.score} / 3${p.scoreWord ? ' · ' + escapeHtml(p.scoreWord) : ''}</span></div>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div>
      </div>
      ${p.recommendation ? `<p class="summary"><span class="lead">Recommendation.</span> ${escapeHtml(p.recommendation)}</p>` : ''}
    </div>

    <div class="evidence-grid result-card">
      ${evidenceHtml}
      ${contraHtml}
    </div>

    <div class="verdict-block result-card">
      <div class="feedback" id="feedback">
        <span>Was this verdict useful?</span>
        <button class="fb" data-v="up">Yes</button>
        <button class="fb" data-v="down">No</button>
        <input class="note" id="fbNote" type="text" placeholder="optional note — what did it miss?" />
        <span class="saved hidden" id="fbSaved">saved ✓</span>
      </div>
    </div>`;

  els.result.classList.remove('hidden');
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  wireFeedback();
}

function cardsHtml(cards) {
  return cards.map(c => {
    if (c.more) return `<div class="ev-more">${escapeHtml(c.more)}</div>`;
    return `<div class="ev-item">
      ${c.meta ? `<div class="m">${escapeHtml(c.meta)}</div>` : ''}
      <div class="t">${escapeHtml(c.text)}</div>
    </div>`;
  }).join('');
}

function wireFeedback() {
  const fb = document.getElementById('feedback');
  const note = document.getElementById('fbNote');
  const saved = document.getElementById('fbSaved');
  let vote = null;
  fb.querySelectorAll('.fb').forEach(btn => {
    btn.onclick = () => {
      vote = btn.dataset.v;
      fb.querySelectorAll('.fb').forEach(b => b.classList.remove('on-yes', 'on-no'));
      btn.classList.add(vote === 'up' ? 'on-yes' : 'on-no');
      persist();
    };
  });
  note.addEventListener('input', () => { if (vote) persist(); });
  function persist() {
    Feedback.upsert({
      id: lastResult.id, timestamp: new Date().toISOString(),
      hypothesis: lastResult.hypothesis, model: lastResult.model,
      verdict: lastResult.verdict, vote, note: note.value.trim(), result: lastResult.text,
    });
    saved.classList.remove('hidden');
    clearTimeout(persist._t);
    persist._t = setTimeout(() => saved.classList.add('hidden'), 1500);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
