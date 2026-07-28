/* Avrios Evidence Engine — Evaluate page logic
   Deterministic retrieval (retrieve.js) picks the candidate cards; the model
   only classifies that fixed set. Strength is computed in-app from the labels. */

const TODAY = '2026-07-28';
const RECENCY_CUTOFF = '2025-07-28'; // ~12 months before TODAY

/* Structured-output schema — forces a role for every candidate + a verdict. */
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['SUPPORTED', 'CONTRADICTED', 'PARTIAL', 'GAP'] },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          role: { type: 'string', enum: ['supporting', 'contradicting', 'irrelevant'] },
        },
        required: ['index', 'role'],
        additionalProperties: false,
      },
    },
    recommendation: { type: 'string' },
    validation_question: { type: 'string' },
  },
  required: ['verdict', 'cards', 'recommendation', 'validation_question'],
  additionalProperties: false,
};

let lastResult = null;
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

async function onSubmit(e) {
  e.preventDefault();
  const hypothesis = els.hypothesis.value.trim();
  if (!hypothesis) { els.hypothesis.focus(); return; }

  const key = await ensureKey();
  if (!key) { showStatus('An API key is required to evaluate.', 'error'); return; }

  setLoading(true);
  els.result.classList.add('hidden');

  try {
    const rows = await loadCorpusRows();
    const { candidates, total } = retrieveCandidates(hypothesis, rows);

    // Deterministic GAP: nothing in the corpus matches these terms.
    if (candidates.length === 0) {
      clearStatus();
      renderResult({
        hypothesis, model: els.model.value, verdict: 'GAP',
        supporting: [], contradicting: [], matched: 0, total: 0,
        recommendation: 'No cards in the corpus match these terms — this is a genuine gap. Validate with users before building.',
        validationQuestion: `Have users actually asked for "${hypothesis}"? Run a short validation session before committing roadmap.`,
      });
      return;
    }

    showStatus(`<span class="spinner"></span>Retrieved ${total} matching card${total !== 1 ? 's' : ''} deterministically — classifying evidence…`);

    const system = await buildSystemWithCandidates(candidates);
    const { text } = await callAnthropic({
      model: els.model.value,
      system,
      userContent: [{ type: 'text', text: hypothesis }],
      maxTokens: 4096,
      thinking: { type: 'disabled' }, // classification task; keeps the JSON budget intact + reduces variance
      outputConfig: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    });

    const parsed = safeParse(text);
    if (!parsed) {
      console.error('Unparseable model output:', text);
      throw new Error('The model returned an unparseable result. Try again — if it persists, switch model or reload.');
    }

    // Map each labelled index back to the real corpus card (never the model's text).
    const supporting = [], contradicting = [];
    for (const entry of parsed.cards || []) {
      const cand = candidates[(entry.index | 0) - 1];
      if (!cand) continue;
      if (entry.role === 'supporting') supporting.push(cand.row);
      else if (entry.role === 'contradicting') contradicting.push(cand.row);
    }

    clearStatus();
    renderResult({
      hypothesis, model: els.model.value,
      verdict: (parsed.verdict || 'GAP').toUpperCase(),
      supporting, contradicting, matched: candidates.length, total,
      recommendation: parsed.recommendation || '',
      validationQuestion: parsed.validation_question || '',
    });
  } catch (err) {
    if (err.code === 401) { showStatus(err.message, 'error'); ensureKey({ force: true }); }
    else showStatus(err.message || String(err), 'error');
  } finally {
    setLoading(false);
  }
}

function safeParse(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/* Mechanical strength score from the supporting cards + recency downgrade. */
function computeStrength(supporting) {
  const n = supporting.length;
  const sources = [...new Set(supporting.map(c => c.Source).filter(Boolean))];
  const ns = sources.length;
  if (n === 0) return { score: 0, label: 'No evidence', cards: 0, sources: 0, sourceList: [], note: '' };

  let score;
  if (n >= 3 && ns >= 2) score = 3;
  else if ((n >= 2 && ns === 1) || (ns >= 2 && n < 3)) score = 2;
  else score = 1;

  let note = '';
  const older = supporting.filter(c => (c.Date || '') && c.Date < RECENCY_CUTOFF).length;
  if (score > 1 && older > n / 2) { score -= 1; note = 'downgraded — most supporting cards are >12 months old'; }

  return { score, label: ['No evidence', 'Weak', 'Moderate', 'Strong'][score], cards: n, sources: ns, sourceList: sources, note };
}

function setLoading(on) { els.submit.disabled = on; els.submit.textContent = on ? 'Evaluating…' : 'Evaluate'; }
function showStatus(html, cls = '') { els.status.className = 'status-msg' + (cls ? ' ' + cls : ''); els.status.innerHTML = html; els.status.classList.remove('hidden'); }
function clearStatus() { els.status.classList.add('hidden'); els.status.innerHTML = ''; }

function renderResult({ hypothesis, model, verdict, supporting, contradicting, matched, total, recommendation, validationQuestion }) {
  const id = 'r_' + Date.now();
  lastResult = { id, hypothesis, model, verdict, supporting, contradicting, recommendation };

  const s = computeStrength(supporting);
  const vClass = verdict.toLowerCase();
  const vLabel = { SUPPORTED: 'Supported', CONTRADICTED: 'Contradicted', PARTIAL: 'Partially supported', GAP: 'Evidence gap' }[verdict] || verdict;
  const pct = Math.round((s.score / 3) * 100);

  const meta = [];
  if (s.cards) meta.push(`${s.cards} supporting card${s.cards !== 1 ? 's' : ''} · ${s.sources} source type${s.sources !== 1 ? 's' : ''} (${s.sourceList.map(escapeHtml).join(', ')})`);
  if (contradicting.length) meta.push(`${contradicting.length} contradiction${contradicting.length !== 1 ? 's' : ''}`);
  if (s.note) meta.push(escapeHtml(s.note));
  meta.push(total > matched ? `${matched} of ${total} matched cards classified` : `${matched} card${matched !== 1 ? 's' : ''} matched`);

  els.result.innerHTML = `
    <div class="verdict-block result-card">
      <div class="verdict-top">
        <span class="badge ${vClass}">${vLabel}</span>
        ${meta.length ? `<span class="verdict-meta">${meta.join(' · ')}</span>` : ''}
      </div>
      <div class="strength">
        <div class="row"><span>Strength score</span><span class="val">${s.score} / 3 · ${escapeHtml(s.label)}</span></div>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div>
      </div>
      ${recommendation ? `<p class="summary"><span class="lead">Recommendation.</span> ${escapeHtml(recommendation)}</p>` : ''}
      ${validationQuestion ? `<div class="validate"><b>Question to test →</b> ${escapeHtml(validationQuestion)}</div>` : ''}
    </div>

    <div class="evidence-grid result-card">
      <div class="ev-col support">
        <h3>Supporting evidence</h3>
        ${supporting.length ? cardsHtml(supporting) : '<p class="ev-empty">No candidate card supports this directly.</p>'}
      </div>
      ${contradicting.length ? `<div class="ev-col contra"><h3>Contradicting evidence</h3>${cardsHtml(contradicting)}</div>` : ''}
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
  return cards.map(c => `
    <div class="ev-item">
      <div class="m">${escapeHtml(c.Source || '—')} · ${escapeHtml(c.Date || '—')} · ${escapeHtml(c.Segment || 'Unknown')}${c['Source link'] ? ` · <a class="lnk" href="${escapeAttr(c['Source link'])}" target="_blank" rel="noopener">source ↗</a>` : ''}</div>
      <div class="t">${escapeHtml(c.Insight || '(no insight text)')}</div>
    </div>`).join('');
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
      hypothesis: lastResult.hypothesis, model: lastResult.model, verdict: lastResult.verdict,
      supporting: lastResult.supporting.map(c => c.Insight),
      contradicting: lastResult.contradicting.map(c => c.Insight),
      vote, note: note.value.trim(),
    });
    saved.classList.remove('hidden');
    clearTimeout(persist._t);
    persist._t = setTimeout(() => saved.classList.add('hidden'), 1500);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
