/* Avrios Evidence Engine — Add insights
   ============================================================================
   Raw material -> extracted cards -> you review -> committed to corpus_all.csv.

   The extraction and the commit both happen on the Worker; this file owns the
   form, the similarity check, and the review gate. Nothing is committed until
   you press Add.
   ========================================================================== */

/* Similarity band, calibrated against all 36,856 pairs in the existing corpus.
   Deliberately ONE recall-oriented band rather than a confident
   duplicate/not-duplicate split: in the real corpus a genuine duplicate
   ("I want return and handover documents to be digital and automated" vs
   "Handover should be digitized and automated for me") scores 0.32, BELOW a
   non-duplicate pair that scores 0.65 ("bulk-update insurance contracts, e.g.
   via Excel import" vs "bulk-update annual vehicle-tax values, e.g. via Excel
   import"). The corpus phrasing is formulaic enough that shared boilerplate
   dominates the IDF signal, so no cut-point separates the two classes.

   Treat this as a prompt to look, not a verdict. Flagged rows stay INCLUDED by
   default — precision is poor at every threshold, so defaulting to excluded
   would silently drop good cards. Exact text matches are a different thing:
   those are reliable, and they default to excluded. */
const SIMILAR_THRESHOLD = 0.30;

/* Hard stops, not the house style. The 40-140 char one-sentence rule lives in
   data/extraction-prompt.txt, because JSON Schema cannot express string length
   and the model has to be told, not constrained. These re-check what came back. */
const STYLE_MAX = 160;
const STYLE_MIN = 25;

/* Above this, one response can't hold all the cards, so chunk by paragraph. The
   Worker's own ceiling is higher; this is about output, not input. */
const CHUNK_CHARS = 80_000;

/* Sources whose cards are written in first person — see extraction-prompt.txt. */
const FIRST_PERSON_SOURCES = ['Interviews', 'Usability test'];

const els = {};
let corpusRows = [];
let reviewCards = [];

document.addEventListener('DOMContentLoaded', async () => {
  els.form = document.getElementById('ingestForm');
  els.source = document.getElementById('source');
  els.segment = document.getElementById('segment');
  els.date = document.getElementById('date');
  els.link = document.getElementById('link');
  els.transcript = document.getElementById('transcript');
  els.model = document.getElementById('model');
  els.submit = document.getElementById('extractBtn');
  els.status = document.getElementById('status');
  els.review = document.getElementById('review');
  els.voiceHint = document.getElementById('voiceHint');
  els.sizeHint = document.getElementById('sizeHint');

  els.date.value = new Date().toISOString().slice(0, 10);
  els.form.addEventListener('submit', onExtract);
  els.source.addEventListener('change', renderVoiceHint);
  els.transcript.addEventListener('input', renderSizeHint);
  renderVoiceHint();
  renderSizeHint();

  if (!Keys.has()) ensureKey();

  // Loaded up front so the similarity check is instant at review time, and so a
  // broken corpus fetch surfaces before someone pastes a transcript.
  try {
    corpusRows = await loadCorpusRows();
  } catch (err) {
    showStatus(err.message, 'error');
  }
});

function renderVoiceHint() {
  const first = FIRST_PERSON_SOURCES.includes(els.source.value);
  els.voiceHint.textContent = first
    ? 'Cards will be written in first person ("I want…")'
    : 'Cards will be written in third person ("Fleet managers want…")';
}

function renderSizeHint() {
  const value = els.transcript.value;
  if (!value.length) { els.sizeHint.textContent = ''; return; }
  // Count the real split rather than dividing by the limit: chunkText breaks on
  // blank lines, so the arithmetic answer is often off by one.
  const passes = chunkText(value, CHUNK_CHARS).length;
  els.sizeHint.textContent = passes > 1
    ? `${value.length.toLocaleString()} characters — will be extracted in ${passes} passes`
    : `${value.length.toLocaleString()} characters`;
}

/* ============================================================
   Extraction
   ============================================================ */
async function onExtract(e) {
  e.preventDefault();

  const transcript = els.transcript.value.trim();
  if (!transcript) { els.transcript.focus(); return; }
  if (!els.date.value) { showStatus('Pick a date for this material.', 'error'); return; }

  const password = await ensureKey();
  if (!password) { showStatus('The access password is required.', 'error'); return; }

  setLoading(true);
  els.review.innerHTML = '';
  reviewCards = [];

  try {
    if (!corpusRows.length) corpusRows = await loadCorpusRows();

    const meta = currentMeta();
    const chunks = chunkText(transcript, CHUNK_CHARS);
    const extracted = [];
    let failure = null;
    let done = 0;

    for (let i = 0; i < chunks.length; i++) {
      showStatus(chunks.length > 1
        ? `<span class="spinner"></span>Extracting cards — pass ${i + 1} of ${chunks.length}…`
        : '<span class="spinner"></span>Extracting cards…');

      try {
        const res = await callWorker('/api/extract', {
          model: els.model.value,
          transcript: chunks[i],
          meta,
        });
        extracted.push(...(res.cards || []));
        done++;
      } catch (err) {
        // Don't throw away completed passes. A long transcript is minutes of
        // model time, and a transient 429 partway through shouldn't cost all of
        // it — surface what we have and say plainly what's missing.
        failure = err;
        break;
      }
    }

    if (failure && !extracted.length) throw failure;

    if (!extracted.length) {
      clearStatus();
      showStatus('No insights found in that material. If you expected some, check that it '
        + 'contains user statements rather than notes about the session.', 'error');
      return;
    }

    // Deduplicate within the run too — chunk boundaries and repetition in a
    // transcript both produce the same card twice.
    reviewCards = annotate(dedupeWithinRun(extracted), meta);
    clearStatus();
    renderReview(meta);

    if (failure) {
      showStatus(`Pass ${done + 1} of ${chunks.length} failed: `
        + `${escapeHtml(failure.message || String(failure))} — the cards below come from the `
        + `first ${done} pass${done !== 1 ? 'es' : ''} only. Add them, then re-run with the `
        + `remaining material.`, 'error');
      if (failure.code === 401) ensureKey({ force: true });
    }
  } catch (err) {
    if (err.code === 401) { showStatus(err.message, 'error'); ensureKey({ force: true }); }
    else showStatus(err.message || String(err), 'error');
  } finally {
    setLoading(false);
  }
}

function currentMeta() {
  return {
    source: els.source.value,
    segment: els.segment.value,
    date: els.date.value,
    link: els.link.value.trim(),
  };
}

/* Split on blank lines so a chunk boundary never lands mid-sentence. A single
   paragraph longer than the limit is passed through whole rather than cut. */
function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = '';
  for (const para of text.split(/\n\s*\n/)) {
    if (current && current.length + para.length + 2 > limit) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* ============================================================
   Similarity — reuses termsOf/IDF from retrieve.js rather than
   introducing a second tokenizer that could drift from retrieval
   ============================================================ */
function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function dedupeWithinRun(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    const key = normalizeText(c.insight);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/* Per-corpus IDF, same weighting as retrieveCandidates: terms present in more
   than 35% of cards carry no weight, so "fleet"/"vehicle" don't make everything
   look alike. */
function buildScorer(rows) {
  const { df, cardTerms, N } = corpusStats(rows);
  const weight = (t) => {
    const d = df.get(t) || 0;
    if (d === 0 || d / N > 0.35) return 0;
    return Math.log((N + 1) / (d + 1));
  };
  const norm = (terms) => Math.sqrt([...terms].reduce((s, t) => s + weight(t) ** 2, 0));
  const cardNorms = cardTerms.map(norm);

  return function nearest(text) {
    const terms = termsOf(text);
    const n = norm(terms);
    if (!n) return null;
    let best = null;
    for (let i = 0; i < rows.length; i++) {
      if (!cardNorms[i]) continue;
      let num = 0;
      for (const t of terms) if (cardTerms[i].has(t)) num += weight(t) ** 2;
      if (!num) continue;
      const score = num / (n * cardNorms[i]);
      if (!best || score > best.score) best = { score, row: rows[i] };
    }
    return best;
  };
}

/* Attach everything the review table needs: predicted theme, similarity, style
   warnings, and whether the row starts checked. */
function annotate(cards, meta) {
  const nearest = buildScorer(corpusRows);
  const exact = new Map(corpusRows.map(r => [normalizeText(r.Insight), r]));

  return cards.map((c, i) => {
    const insight = c.insight.trim();
    const description = (c.description || '').trim();
    const theme = classify({ Insight: insight, Description: description });

    const exactMatch = exact.get(normalizeText(insight)) || null;
    const near = exactMatch ? null : nearest(`${insight} ${description}`);
    const similar = (near && near.score >= SIMILAR_THRESHOLD) ? near : null;

    const warnings = [];
    if (insight.length > STYLE_MAX) warnings.push(`${insight.length} chars — long for one card`);
    if (insight.length < STYLE_MIN) warnings.push(`${insight.length} chars — probably too vague`);
    if (/[.!?]\s+\S/.test(insight)) warnings.push('reads as more than one sentence');
    if (FIRST_PERSON_SOURCES.includes(meta.source) && !/\b(I|my|me)\b/.test(insight)) {
      warnings.push('not first person, unlike other cards from this source');
    }
    if (theme === 'Other') warnings.push('no theme matched — invisible on the map');

    return {
      id: `c${i}`,
      insight,
      description,
      theme,
      exactMatch,
      similar,
      warnings,
      // Exact matches are a reliable signal, so they start excluded. Similarity
      // is not, so those start included and flagged.
      include: !exactMatch,
    };
  });
}

/* ============================================================
   Review table
   ============================================================ */
function renderReview(meta) {
  const flagged = reviewCards.filter(c => c.similar).length;
  const dupes = reviewCards.filter(c => c.exactMatch).length;

  const summary = [`${reviewCards.length} card${reviewCards.length !== 1 ? 's' : ''} extracted`];
  if (dupes) summary.push(`${dupes} already in the corpus (excluded)`);
  if (flagged) summary.push(`${flagged} similar to an existing card`);

  els.review.innerHTML = `
    <div class="verdict-block result-card">
      <div class="verdict-top">
        <span class="badge ${dupes ? 'partial' : 'supported'}">Review</span>
        <span class="verdict-meta">${summary.map(escapeHtml).join(' · ')}</span>
      </div>
      <p class="summary"><span class="lead">${escapeHtml(meta.source)} · ${escapeHtml(meta.segment)} · ${escapeHtml(meta.date)}.</span>
        Edit any wording below. Unchecked cards are not added.</p>
    </div>

    <div class="result-card">
      <div class="review-rows" id="reviewRows">
        ${reviewCards.map(renderRow).join('')}
      </div>
    </div>

    <div class="verdict-block result-card">
      <div class="controls-row">
        <button type="button" class="btn" id="commitBtn">Add to corpus</button>
        <button type="button" class="btn secondary" id="discardBtn">Discard</button>
        <span class="verdict-meta" id="commitCount"></span>
      </div>
      <div class="status-msg hidden" id="commitStatus"></div>
    </div>`;

  wireReview(meta);
  els.review.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRow(c) {
  const flags = [];
  if (c.exactMatch) {
    flags.push(`<span class="flag dupe">already in the corpus</span>`);
  } else if (c.similar) {
    flags.push(`<span class="flag warn">${(c.similar.score * 100).toFixed(0)}% similar to an existing card</span>`);
  }
  for (const w of c.warnings) flags.push(`<span class="flag note">${escapeHtml(w)}</span>`);

  const match = c.exactMatch || c.similar?.row;
  // Context starts hidden unless the model actually supplied some — roughly one
  // card in seven — so the common case is one clean field per card.
  const hasContext = !!c.description;

  return `
    <div class="review-card${c.include ? '' : ' excluded'}" data-id="${c.id}">
      <div class="review-card-head">
        <label class="review-check">
          <input type="checkbox" data-role="include" ${c.include ? 'checked' : ''} />
        </label>
        <span class="theme">${escapeHtml(c.theme)}</span>
        ${flags.join('')}
      </div>

      <textarea class="review-insight" data-role="insight" rows="2">${escapeHtml(c.insight)}</textarea>

      <div class="review-context${hasContext ? '' : ' hidden'}" data-part="context">
        <input type="text" class="review-desc" data-role="description"
               placeholder="Extra context — a qualifying detail, a specific list, the reason behind the need"
               value="${escapeAttr(c.description)}" />
      </div>
      <div class="review-card-foot">
        <button type="button" class="btn-link add-context${hasContext ? ' hidden' : ''}"
                data-role="add-context">+ Add context</button>
      </div>

      ${match ? `<div class="review-match">
        <span class="m">existing · ${escapeHtml(match.Source || '—')} · ${escapeHtml(match.Date || '—')}</span>
        <span class="t">${escapeHtml(match.Insight || '')}</span>
      </div>` : ''}
    </div>`;
}

function wireReview(meta) {
  const rows = els.review.querySelector('#reviewRows');
  const countEl = els.review.querySelector('#commitCount');

  const updateCount = () => {
    const n = reviewCards.filter(c => c.include).length;
    countEl.textContent = `${n} of ${reviewCards.length} selected`;
    els.review.querySelector('#commitBtn').disabled = n === 0;
  };

  // Reveal the context field on demand. Click, not input, so it's a separate
  // listener from the field edits below.
  rows.addEventListener('click', (ev) => {
    if (ev.target.dataset.role !== 'add-context') return;
    const cardEl = ev.target.closest('.review-card');
    if (!cardEl) return;
    cardEl.querySelector('[data-part="context"]').classList.remove('hidden');
    ev.target.classList.add('hidden');
    cardEl.querySelector('[data-role="description"]').focus();
  });

  rows.addEventListener('input', (ev) => {
    const rowEl = ev.target.closest('.review-card');
    if (!rowEl) return;
    const card = reviewCards.find(c => c.id === rowEl.dataset.id);
    if (!card) return;

    const role = ev.target.dataset.role;
    if (role === 'include') {
      card.include = ev.target.checked;
      rowEl.classList.toggle('excluded', !card.include);
      updateCount();
    } else if (role === 'insight') {
      card.insight = ev.target.value;
      // Theme follows the edited text — reword a card out of "Other" and the
      // label updates, so the fix is visible before committing.
      const theme = classify({ Insight: card.insight, Description: card.description });
      if (theme !== card.theme) {
        card.theme = theme;
        rowEl.querySelector('.theme').textContent = theme;
      }
    } else if (role === 'description') {
      card.description = ev.target.value;
    }
  });

  els.review.querySelector('#discardBtn').onclick = () => {
    reviewCards = [];
    els.review.innerHTML = '';
  };

  els.review.querySelector('#commitBtn').onclick = () => commit(meta);
  updateCount();
}

/* ============================================================
   Commit
   ============================================================ */
async function commit(meta) {
  const statusEl = els.review.querySelector('#commitStatus');
  const btn = els.review.querySelector('#commitBtn');
  const selected = reviewCards.filter(c => c.include && c.insight.trim());
  if (!selected.length) return;

  const show = (html, cls = '') => {
    statusEl.className = 'status-msg' + (cls ? ` ${cls}` : '');
    statusEl.innerHTML = html;
    statusEl.classList.remove('hidden');
  };

  btn.disabled = true;
  show('<span class="spinner"></span>Committing to the corpus…');

  try {
    const res = await callWorker('/api/cards', {
      meta,
      cards: selected.map(c => ({ insight: c.insight, description: c.description })),
    });

    const short = (res.commit || '').slice(0, 7);
    // Honest about the delay: Pages has to rebuild before anyone sees these.
    show(`Added ${res.added} card${res.added !== 1 ? 's' : ''}`
      + (short ? ` in commit <code>${escapeHtml(short)}</code>` : '')
      + `. GitHub Pages rebuilds in about a minute — reload then to see them in
         Evaluate and the map.`
      + (res.commit_url ? ` <a class="lnk" href="${escapeAttr(res.commit_url)}" target="_blank" rel="noopener">view commit ↗</a>` : ''));

    els.transcript.value = '';
    renderSizeHint();
    reviewCards = [];
    els.review.querySelector('#reviewRows').innerHTML =
      '<p class="ev-empty">Committed. Paste more material above to add another batch.</p>';
    els.review.querySelector('#discardBtn').textContent = 'Clear';
    // Clear the "N of M selected" label — it would otherwise still describe the
    // batch that just left.
    els.review.querySelector('#commitCount').textContent = '';
  } catch (err) {
    btn.disabled = false;
    if (err.code === 401) { show(err.message, 'error'); ensureKey({ force: true }); }
    else show(escapeHtml(err.message || String(err)), 'error');
  }
}

/* ============================================================
   Status + escaping
   ============================================================ */
function setLoading(on) {
  els.submit.disabled = on;
  els.submit.textContent = on ? 'Extracting…' : 'Extract cards';
}
function showStatus(html, cls = '') {
  els.status.className = 'status-msg' + (cls ? ` ${cls}` : '');
  els.status.innerHTML = html;
  els.status.classList.remove('hidden');
}
function clearStatus() { els.status.classList.add('hidden'); els.status.innerHTML = ''; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
