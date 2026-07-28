/* Avrios Evidence Engine — Opportunity map: keyword clustering + Chart.js */

/* Keyword theme rules, first match wins — ported verbatim from the build spec.
   Order matters; the first regex that matches an insight's text wins. */
const THEME_RULES = [
  ['Compliance & licence checks', /DLC|licen|UVV|Halterhaftung|TÜV|compliance|BKrFQG|Pickerl|inspection|Contrôle/i],
  ['Fines management',            /fine|penalt|authorit|bounce/i],
  ['Procurement & lifecycle',     /procure|replacement|Not Ordered|quote|offer amount|purchase agreement|order status|decommission|financing|depreciation/i],
  ['Reporting & analytics',       /report|dashboard|consumption|TCO|benchmark|export|utilization|anomal|analy/i],
  ['Automation & AI trust',       /\bAI\b|automat|auto-|revert|approv|trust|escalat|LLM|OCR|readout/i],
  ['Documents & mailroom',        /post office|mailroom|Poststelle|document|folder|smime|scan|attachment/i],
  ['Vehicle checks & checklists', /checklist|vehicle check|check item/i],
  ['Handover & pool vehicles',    /handover|return|pool|booking/i],
  ['Invoices & finance',          /invoice|leasing|lease|fringe benefit|tax|cost cent|budget|insurance|installment|premium/i],
  ['User rights & permissions',   /user right|permission|role|access|sub-org/i],
  ['Driver app & comms',          /driver app|WhatsApp|notification|reminder|email address|PIN-user|username|SMS|messag/i],
  ['Tasks & workflow',            /task|template|workshop|scheduled date|recurring/i],
  ['Data & master data',          /master data|odometer|mileage|custom field|column|filter|registration paper/i],
];
const OTHER = 'Other';

/* Chart colors must be hardcoded hex — canvas can't read CSS vars. */
const COLOR_TRIANGULATED = '#12b5a6'; // teal: >=2 source types
const COLOR_SINGLE = '#f5a524';       // amber: single source type
const COLOR_GRID = 'rgba(128,135,150,0.15)';
const COLOR_TICK = '#9aa3b2';

function classify(row) {
  const hay = `${row.Insight || ''} ${row.Description || ''}`;
  for (const [name, re] of THEME_RULES) {
    if (re.test(hay)) return name;
  }
  return OTHER;
}

let state = {
  rows: [],
  themes: [],       // [{ name, cards:[], sources:Set, segments:Set }]
  sourceFilter: 'all',
  sort: 'volume',   // 'volume' | 'breadth'
  chart: null,
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const status = document.getElementById('mapStatus');
  try {
    state.rows = await loadCorpusRows();
  } catch (err) {
    status.className = 'status-msg error';
    status.textContent = err.message;
    return;
  }
  status.classList.add('hidden');

  populateSourceFilter();
  computeThemes();
  renderStats();
  document.getElementById('sourceFilter').addEventListener('change', (e) => {
    state.sourceFilter = e.target.value;
    computeThemes();
    renderChart();
    clearDrill();
  });
  document.getElementById('sortToggle').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderChart();
  });
  renderChart();
}

function allSourceTypes() {
  return [...new Set(state.rows.map(r => r.Source).filter(Boolean))].sort();
}

function populateSourceFilter() {
  const sel = document.getElementById('sourceFilter');
  const opts = ['<option value="all">All source types</option>']
    .concat(allSourceTypes().map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`));
  sel.innerHTML = opts.join('');
}

function filteredRows() {
  if (state.sourceFilter === 'all') return state.rows;
  return state.rows.filter(r => r.Source === state.sourceFilter);
}

function computeThemes() {
  const map = new Map();
  for (const [name] of THEME_RULES) map.set(name, blankTheme(name));
  map.set(OTHER, blankTheme(OTHER));

  for (const row of filteredRows()) {
    const t = map.get(classify(row));
    t.cards.push(row);
    if (row.Source) t.sources.add(row.Source);
    const seg = (row.Segment || '').trim();
    if (seg && seg.toLowerCase() !== 'unknown') t.segments.add(seg);
  }
  state.themes = [...map.values()].filter(t => t.cards.length > 0);
}
function blankTheme(name) { return { name, cards: [], sources: new Set(), segments: new Set() }; }

function sortedThemes() {
  const t = [...state.themes];
  if (state.sort === 'breadth') {
    t.sort((a, b) => (b.sources.size - a.sources.size) || (b.cards.length - a.cards.length));
  } else {
    t.sort((a, b) => (b.cards.length - a.cards.length) || (b.sources.size - a.sources.size));
  }
  return t;
}

function renderStats() {
  const el = document.getElementById('stats');
  const totalCards = state.rows.length;
  const themeCount = state.themes.length;
  const triangulated = state.themes.filter(t => t.sources.size >= 2).length;
  el.innerHTML = `
    <div class="stat"><div class="num">${totalCards}</div><div class="lbl">insight cards</div></div>
    <div class="stat"><div class="num">${themeCount}</div><div class="lbl">themes (heuristic)</div></div>
    <div class="stat"><div class="num">${triangulated}</div><div class="lbl">triangulated (≥2 sources)</div></div>`;
}

function renderChart() {
  const themes = sortedThemes();
  const labels = themes.map(t => `${t.name}  (${t.sources.size} src)`);
  const data = themes.map(t => t.cards.length);
  const colors = themes.map(t => t.sources.size >= 2 ? COLOR_TRIANGULATED : COLOR_SINGLE);

  const ctx = document.getElementById('themeChart').getContext('2d');
  if (state.chart) state.chart.destroy();

  state.chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'cards',
        data,
        backgroundColor: colors,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const t = themes[items[0].dataIndex];
              const srcs = [...t.sources].join(', ') || '—';
              const segs = t.segments.size;
              return [`sources: ${srcs}`, `distinct segments: ${segs}`, 'click bar → list cards'];
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { precision: 0, color: COLOR_TICK },
          grid: { color: COLOR_GRID },
          title: { display: true, text: 'demand volume (card count)', color: COLOR_TICK },
        },
        y: { ticks: { color: COLOR_TICK, autoSkip: false, font: { size: 11 } }, grid: { display: false } },
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        renderDrill(themes[elements[0].index]);
      },
    },
  });

  // Size the canvas container to the number of bars so labels don't cram.
  const box = document.getElementById('chartBox');
  box.style.height = Math.max(320, themes.length * 42 + 60) + 'px';
}

function renderDrill(theme) {
  const el = document.getElementById('drill');
  const cards = [...theme.cards].sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
  const triFlag = theme.sources.size >= 2
    ? '<span style="color:var(--teal)">triangulated</span>'
    : '<span style="color:var(--amber)">single-source</span>';
  el.innerHTML = `
    <div class="drill">
      <h3>${escapeHtml(theme.name)}</h3>
      <p class="drill-meta">${cards.length} cards · ${theme.sources.size} source type(s) (${[...theme.sources].map(escapeHtml).join(', ')}) · ${triFlag}</p>
      <div class="card-list">
        ${cards.map(c => `
          <div class="insight-card">
            <p class="ins">${escapeHtml(c.Insight || '(no insight text)')}</p>
            <div class="meta">
              <span class="src-tag">${escapeHtml(c.Source || '—')}</span>
              <span>${escapeHtml(c.Date || '—')}</span>
              <span>${escapeHtml(c.Segment || 'Unknown')}</span>
              ${c['Source link'] ? `<a href="${escapeAttr(c['Source link'])}" target="_blank" rel="noopener">source ↗</a>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clearDrill() { const el = document.getElementById('drill'); if (el) el.innerHTML = ''; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
