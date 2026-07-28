/* Avrios Evidence Engine — deterministic lexical retrieval
   ------------------------------------------------------------
   Same hypothesis → same candidate card set, every time. The model no longer
   decides which cards are relevant; it only judges the fixed set this returns.
   Matching = IDF-weighted term overlap with light stemming + a fleet-domain
   synonym map, so "fuel" also matches "consumption"/"diesel", "report" also
   matches "reporting"/"export"/"dashboard", etc. */

const STOPWORDS = new Set((
  'a an the of to for in on at by with and or but is are am be been being do does did ' +
  'can could would should will shall may might must have has had this that these those ' +
  'i we you they it he she them us our your their my me his her its ' +
  'want wants wanted need needs needed about more most less least very only just also ' +
  'than then when where how what which who whom whose why into from over under out up ' +
  'as if so no not yes get got make made use used using like such each any all some ' +
  'there here now new every'
).split(/\s+/));

/* Synonym groups — first token is the canonical form for the whole group. */
const SYNONYM_GROUPS = [
  ['fuel', 'consumption', 'diesel', 'petrol', 'gasoline', 'lng', 'cng', 'refuel', 'refuelling', 'tank', 'litre', 'liter', 'mpg'],
  ['report', 'reporting', 'dashboard', 'export', 'exports', 'analytics', 'overview', 'breakdown', 'summary'],
  ['cost', 'costs', 'spend', 'spending', 'expense', 'expenses', 'tco', 'budget'],
  ['anomaly', 'anomalies', 'anomalous', 'outlier', 'outliers'],
  ['compliance', 'licence', 'license', 'uvv', 'tuv', 'dlc', 'inspection', 'pickerl', 'halterhaftung', 'bkrfqg'],
  ['fine', 'fines', 'penalty', 'penalties', 'authority', 'authorities'],
  ['invoice', 'invoices', 'invoicing', 'billing', 'lease', 'leasing', 'installment', 'premium'],
  ['driver', 'drivers'],
  ['vehicle', 'vehicles', 'car', 'cars', 'van', 'vans', 'truck', 'trucks', 'fleet', 'fleets'],
  ['task', 'tasks', 'todo', 'workflow', 'workflows'],
  ['ai', 'automation', 'automations', 'automate', 'automated', 'automatic', 'automatically', 'llm', 'ocr'],
  ['document', 'documents', 'folder', 'folders', 'scan', 'scans', 'attachment', 'attachments', 'mailroom', 'poststelle'],
  ['handover', 'return', 'returns', 'pool', 'booking', 'bookings'],
  ['reminder', 'reminders', 'notification', 'notifications', 'alert', 'alerts'],
  ['permission', 'permissions', 'role', 'roles', 'access', 'rights'],
  ['odometer', 'mileage'],
  ['checklist', 'checklists', 'check', 'checks'],
  ['procurement', 'procure', 'replacement', 'order', 'orders', 'quote', 'quotes', 'purchase', 'decommission'],
];

const SYN_MAP = (() => {
  const m = new Map();
  for (const group of SYNONYM_GROUPS) for (const w of group) if (!m.has(w)) m.set(w, group[0]);
  return m;
})();

/* Crude stemmer — strips common English suffixes. */
function stem(w) {
  return w.replace(/(ings|ing|edly|ed|ly|ies|es|s)$/, '') || w;
}

/* token → canonical term (or null to drop). */
function canonical(raw) {
  const t = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!t || t.length < 3 || STOPWORDS.has(t)) return null;
  if (SYN_MAP.has(t)) return SYN_MAP.get(t);
  const s = stem(t);
  if (STOPWORDS.has(s)) return null;
  return SYN_MAP.get(s) || s;
}

function termsOf(text) {
  const out = new Set();
  for (const tok of String(text || '').split(/[^a-zA-Z]+/)) {
    const c = canonical(tok);
    if (c) out.add(c);
  }
  return out;
}

/* Per-corpus document frequencies, cached by the rows array identity. */
const _dfCache = new WeakMap();
function corpusStats(rows) {
  if (_dfCache.has(rows)) return _dfCache.get(rows);
  const df = new Map();
  const cardTerms = rows.map(r => {
    const terms = termsOf(`${r.Insight || ''} ${r.Description || ''}`);
    for (const t of terms) df.set(t, (df.get(t) || 0) + 1);
    return terms;
  });
  const stats = { df, cardTerms, N: rows.length };
  _dfCache.set(rows, stats);
  return stats;
}

/* Return every card that shares at least one meaningfully-rare term with the
   hypothesis, scored by summed IDF weight and sorted strongest-first.
   Ubiquitous terms (present in >35% of cards, e.g. "fleet"/"vehicle") carry no
   weight so they don't drag the whole corpus in. */
function retrieveCandidates(hypothesis, rows, { max = 40 } = {}) {
  const { df, cardTerms, N } = corpusStats(rows);
  const qterms = [...termsOf(hypothesis)];
  const weight = t => {
    const d = df.get(t) || 0;
    if (d === 0 || d / N > 0.35) return 0;          // unknown or ubiquitous → ignore
    return Math.log((N + 1) / (d + 1));
  };
  const qWeighted = qterms.filter(t => weight(t) > 0);

  const scored = [];
  for (let i = 0; i < rows.length; i++) {
    const terms = cardTerms[i];
    let score = 0;
    const matched = [];
    for (const t of qWeighted) {
      if (terms.has(t)) { score += weight(t); matched.push(t); }
    }
    if (matched.length) scored.push({ row: rows[i], score, matched });
  }
  scored.sort((a, b) => b.score - a.score || (b.row.Date || '').localeCompare(a.row.Date || ''));
  return { candidates: scored.slice(0, max), queryTerms: qWeighted, total: scored.length };
}
