/* Avrios Evidence Engine — Opportunity map: keyword clustering + packed-bubble chart
   THEME_RULES / classify() live in themes.js, shared with the ingest page. */

/* Source-density colors (distinct source types) — hardcoded hex from the design. */
const DENSITY = { 1: '#f5a623', 2: '#5eead4', 3: '#14b8a6', 4: '#0e9488' };
const CANVAS_W = 744;
const CANVAS_H = 640;

const state = { rows: [], themes: [], selected: null };

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const status = document.getElementById('mapStatus');
  try {
    state.rows = await loadCorpusRows();
  } catch (err) {
    status.className = 'status-msg error'; status.textContent = err.message; status.classList.remove('hidden'); return;
  }
  computeThemes();
  renderDensityScale();
  renderBubbles();
}

function computeThemes() {
  const map = new Map();
  for (const [name] of THEME_RULES) map.set(name, blank(name));
  map.set(OTHER, blank(OTHER));
  for (const row of state.rows) {
    const t = map.get(classify(row));
    t.cards.push(row);
    if (row.Source) t.sources.add(row.Source);
    const seg = (row.Segment || '').trim();
    if (seg && seg.toLowerCase() !== 'unknown') t.segments.add(seg);
  }
  state.themes = [...map.values()].filter(t => t.cards.length > 0);
}
function blank(name) { return { name, cards: [], sources: new Set(), segments: new Set() }; }

/* Circle-packing on an Archimedean spiral — ported verbatim from the design. */
function pack(rows) {
  const W = CANVAS_W, H = CANVAS_H, placed = [];
  const items = rows
    .map((r, i) => ({ name: r.name, count: r.count, keys: r.keys, src: r.src, i, r: 9 + Math.pow(r.count, 0.85) * 3.4 }))
    .sort((a, b) => b.r - a.r);
  for (const it of items) {
    let pos = null;
    for (let s = 0; s < 14000 && !pos; s++) {
      const t = s * 0.3, rad = 2.6 * Math.sqrt(s);
      const x = W / 2 + rad * Math.cos(t), y = H / 2 + rad * Math.sin(t) * 0.78;
      if (x - it.r < 0 || x + it.r > W || y - it.r < 0 || y + it.r > H) continue;
      if (placed.every(p => Math.hypot(p.x - x, p.y - y) >= p.r + it.r + 7)) pos = { x, y };
    }
    placed.push(Object.assign({}, it, pos || { x: W / 2, y: H / 2 }));
  }
  const minY = Math.min(...placed.map(p => p.y - p.r));
  const maxY = Math.max(...placed.map(p => p.y + p.r));
  const minX = Math.min(...placed.map(p => p.x - p.r));
  const maxX = Math.max(...placed.map(p => p.x + p.r));
  const pad = 10, dx = W / 2 - (minX + maxX) / 2;
  return {
    items: placed.map(p => Object.assign({}, p, { x: p.x + dx, y: p.y - minY + pad })),
    height: Math.round(maxY - minY + pad * 2),
  };
}

function themeRows() {
  return state.themes.map(t => ({
    name: t.name, count: t.cards.length, keys: [...t.sources], src: t.sources.size,
  })).filter(r => r.count > 0);
}

function renderDensityScale() {
  const el = document.getElementById('densityScale');
  el.innerHTML = [1, 2, 3, 4].map(n =>
    `<span class="item"><span class="sw" style="background:${DENSITY[n]}"></span>${n === 4 ? '4+ types' : n + (n === 1 ? ' type' : ' types')}</span>`
  ).join('');
}

function renderBubbles() {
  const field = document.getElementById('bubbleField');
  const layout = pack(themeRows());
  field.style.height = layout.height + 'px';
  field.style.maxWidth = CANVAS_W + 'px';
  field.style.margin = '0 auto';

  field.innerHTML = layout.items.map(p => {
    const selected = state.selected === p.name;
    const dimmed = state.selected && !selected;
    const color = DENSITY[Math.min(4, p.src)];
    const textColor = p.src >= 3 ? '#04211d' : '#1a1405';
    const label = p.r > 34 ? escapeHtml(p.name.replace(' & ', ' &\n')) : '';
    const count = p.r > 24 ? p.count : '';
    const labelSize = (p.r > 70 ? 17 : p.r > 55 ? 15 : p.r > 44 ? 13 : 12) + 'px';
    return `<button type="button" class="bubble" data-name="${escapeAttr(p.name)}"
      title="${escapeAttr(p.name + ' — ' + p.count + ' cards · ' + p.keys.join(', '))}"
      style="left:${p.x - p.r}px;top:${p.y - p.r}px;width:${p.r * 2}px;height:${p.r * 2}px;
        background:${color};color:${textColor};opacity:${dimmed ? 0.4 : 1};
        box-shadow:${selected ? '0 0 0 6px rgba(242,244,246,0.10)' : 'none'};
        outline:${selected ? '2px solid #f2f4f6' : 'none'};outline-offset:-2px;
        animation-delay:${Math.round(p.i * 45)}ms">
      <span class="b-label" style="font-size:${labelSize}">${label}</span>
      ${count !== '' ? `<span class="b-count">${count}</span>` : ''}
    </button>`;
  }).join('');

  field.querySelectorAll('.bubble').forEach(b => {
    b.onclick = () => {
      const name = b.dataset.name;
      state.selected = state.selected === name ? null : name;
      renderBubbles();
      if (state.selected) renderDrill(state.themes.find(t => t.name === state.selected));
      else clearDrill();
    };
  });
}

function renderDrill(theme) {
  const el = document.getElementById('drill');
  const color = DENSITY[Math.min(4, theme.sources.size)];
  const cards = [...theme.cards].sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
  const shown = cards.slice(0, 12);
  const more = cards.length - shown.length;
  el.innerHTML = `
    <section class="drill">
      <div class="drill-head">
        <span class="swatch" style="background:${color}"></span>
        <div class="titles">
          <h2>${escapeHtml(theme.name)}</h2>
          <span class="meta">${cards.length} insight card${cards.length !== 1 ? 's' : ''} · ${theme.sources.size} source ${theme.sources.size === 1 ? 'type' : 'types'} · ${[...theme.sources].map(escapeHtml).join(', ')}</span>
        </div>
        <button type="button" class="close" id="closeDrill">Close</button>
      </div>
      <div class="drill-cards">
        ${shown.map((c, i) => `
          <div class="drill-card" style="animation-delay:${60 + i * 60}ms">
            <div class="m">
              <span>${escapeHtml(c.Source || '—')}</span><span>${escapeHtml(c.Date || '—')}</span>
              <span>${escapeHtml(c.Segment || 'Unknown')}</span>
              ${c['Source link'] ? `<a href="${escapeAttr(c['Source link'])}" target="_blank" rel="noopener">source ↗</a>` : ''}
            </div>
            <div class="t">${escapeHtml(c.Insight || '(no insight text)')}</div>
          </div>`).join('')}
        ${more > 0 ? `<div class="ev-more">+ ${more} more card${more !== 1 ? 's' : ''} in this theme</div>` : ''}
      </div>
    </section>`;
  el.querySelector('#closeDrill').onclick = () => { state.selected = null; renderBubbles(); clearDrill(); };
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clearDrill() { const el = document.getElementById('drill'); if (el) el.innerHTML = ''; }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
