/* Avrios Evidence Engine — Cloudflare Worker
   ============================================================================
   Holds the three secrets the browser must never see:

     ANTHROPIC_API_KEY  the model key (previously pasted into each teammate's
                        browser under BYOK — that is what this replaces)
     GITHUB_TOKEN       fine-grained PAT, this repo only, contents:write
     ACCESS_PASSWORD    the shared team password gating every endpoint

   Three endpoints, all POST, all purpose-specific on purpose. The prompts are
   fetched from the site rather than accepted from the caller, so a leaked
   password buys the ingest and evaluate flows — not a general "run any prompt
   on someone else's key" proxy.

     /api/evaluate   { hypothesis, candidates[], model? }  -> verdict JSON
     /api/extract    { transcript, meta, model? }          -> { cards[] }
     /api/cards      { cards[], meta }                     -> commits the CSV
   ========================================================================== */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/* Allowlisted so the endpoint can't be steered into calling an arbitrary model. */
const MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'];
const DEFAULT_MODEL = 'claude-sonnet-5';

/* Load-bearing: computeStrength() in evaluate.js scores by DISTINCT Source
   values, so an open Source vocabulary would let one interview masquerade as
   several independent sources and score a false 3/3. */
const SOURCES = ['Planhat', 'Interviews', 'Usability test', 'Survey', 'Customer Success'];
const SEGMENTS = [
  'Enterprise', 'Multi-entity', 'Large fleet', 'Mid-market', 'Small fleet',
  'Pool fleet', 'Specialised fleet', 'Prospect', 'Unknown',
];

const CSV_PATH = 'data/corpus_all.csv';
const COLUMNS = ['Insight', 'Date', 'Description', 'Segment', 'Source', 'Source link'];

/* The committed corpus uses CRLF. Appending LF rows would work at runtime —
   parseCSV() normalizes — but would leave the file mixed-terminator and make
   every later diff noisy. */
const EOL = '\r\n';

const MAX_TRANSCRIPT = 400_000;   // chars; the client chunks well before this
const MAX_CARDS = 60;             // per commit
const MAX_INSIGHT = 400;          // generous vs the ~140 house style; a hard stop, not the style rule
const MAX_DESCRIPTION = 1000;
const COMMIT_RETRIES = 3;         // optimistic-lock retries on a 409/conflict

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          insight: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['insight', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

const EVALUATE_SCHEMA = {
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

/* ============================================================
   Router
   ============================================================ */
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

    if (!authorized(request, env)) {
      return json({ error: 'Wrong or missing access password.' }, 401, cors);
    }

    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Body must be JSON.' }, 400, cors);
      }

      switch (pathname) {
        case '/api/evaluate': return await handleEvaluate(body, env, cors);
        case '/api/extract':  return await handleExtract(body, env, cors);
        case '/api/cards':    return await handleCards(body, env, cors);
        default:              return json({ error: 'Not found' }, 404, cors);
      }
    } catch (err) {
      // Surface the message (these are our own throws, not raw upstream bodies)
      // and keep the status if one was attached.
      return json({ error: err.message || 'Unexpected error' }, err.status || 500, cors);
    }
  },
};

/* ============================================================
   Auth + CORS
   ============================================================ */

/* Timing-safe compare. Over HTTPS a timing attack on a shared password is
   impractical, but a plain === on a secret is a habit worth not forming. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  // Fold the length difference into the result instead of returning early.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(request, env) {
  if (!env.ACCESS_PASSWORD) return false;   // fail closed if the secret is unset
  return safeEqual(request.headers.get('x-access-password'), env.ACCESS_PASSWORD);
}

/* Reflect a single allowed origin rather than '*', so a stray page on another
   host can't drive the endpoints using a browser's stored password. */
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-access-password',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ============================================================
   Prompt loading — from the site, so /data stays the source of truth
   ============================================================ */
const promptCache = new Map();

async function loadPrompt(name, env) {
  if (promptCache.has(name)) return promptCache.get(name);
  const base = (env.SITE_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw fail('SITE_BASE_URL is not configured on the Worker.', 500);

  const res = await fetch(`${base}/data/${name}`);
  if (!res.ok) throw fail(`Could not load ${name} from the site (${res.status}).`, 502);
  const text = await res.text();
  promptCache.set(name, text);
  return text;
}

/* Mirrors buildSystemWithCandidates() in app.js: replace the placeholder line if
   present, else append after the marker, else append the marker and the block. */
function fillPrompt(prompt, marker, block) {
  const placeholder = /\{the app appends[^}]*\}/;
  if (placeholder.test(prompt)) return prompt.replace(placeholder, block);
  if (prompt.includes(marker)) return `${prompt.trimEnd()}\n${block}\n`;
  return `${prompt.trimEnd()}\n\n${marker}\n${block}\n`;
}

/* ============================================================
   Anthropic call
   ============================================================ */
async function callAnthropic(env, { model, system, userText, maxTokens, schema }) {
  if (!env.ANTHROPIC_API_KEY) throw fail('ANTHROPIC_API_KEY is not configured on the Worker.', 500);

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      // Classification and extraction both want a stable JSON envelope rather
      // than reasoning tokens competing for the max_tokens budget. See commit
      // 6b76484 — enabling thinking here is what produced unparseable results.
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema } },
    }),
  });

  const data = await res.json().catch(() => null);

  if (res.status === 401) throw fail('The Worker\'s Anthropic key was rejected (401).', 502);
  if (res.status === 429) throw fail('Rate limited by Anthropic (429). Wait a moment and try again.', 429);
  if (!res.ok) throw fail(data?.error?.message || `Anthropic error (${res.status})`, 502);

  const text = (data.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n');

  return { text, stopReason: data.stop_reason, usage: data.usage };
}

function pickModel(requested) {
  return MODELS.includes(requested) ? requested : DEFAULT_MODEL;
}

/* output_config guarantees valid JSON unless the response was cut short, so a
   parse failure here almost always means max_tokens. Kept tolerant anyway. */
function safeParse(text) {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

/* ============================================================
   /api/evaluate
   ============================================================ */
async function handleEvaluate(body, env, cors) {
  const hypothesis = String(body.hypothesis || '').trim();
  if (!hypothesis) throw fail('A hypothesis is required.', 400);

  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (!candidates.length) throw fail('No candidate cards were supplied.', 400);
  if (candidates.length > 200) throw fail('Too many candidate cards.', 400);

  // Numbered exactly as before, so the model's card indices still map back to
  // the client's candidate array by position.
  const block = candidates.map((c, i) => {
    const desc = String(c.description || '').trim();
    return `[${i + 1}] "${String(c.insight || '').trim()}" — Source: ${c.source || 'Unknown'}; `
      + `Date: ${c.date || 'Unknown'}; Segment: ${c.segment || 'Unknown'}`
      + (desc ? `\n     Context: ${desc}` : '');
  }).join('\n');

  const prompt = await loadPrompt('system-prompt.txt', env);
  const system = fillPrompt(prompt, '=== CANDIDATE CARDS ===', block);

  const { text, stopReason, usage } = await callAnthropic(env, {
    model: pickModel(body.model),
    system,
    userText: hypothesis,
    maxTokens: 4096,
    schema: EVALUATE_SCHEMA,
  });

  const parsed = safeParse(text);
  if (!parsed) {
    if (stopReason === 'max_tokens') {
      throw fail('The result was cut short before it could be parsed. Try a narrower hypothesis.', 502);
    }
    throw fail('The model returned an unparseable result. Try again, or switch model.', 502);
  }

  return json({ ...parsed, stop_reason: stopReason, usage }, 200, cors);
}

/* ============================================================
   /api/extract
   ============================================================ */
async function handleExtract(body, env, cors) {
  const transcript = String(body.transcript || '').trim();
  if (!transcript) throw fail('Paste some raw material first.', 400);
  if (transcript.length > MAX_TRANSCRIPT) {
    throw fail(`That material is ${transcript.length.toLocaleString()} characters, over the `
      + `${MAX_TRANSCRIPT.toLocaleString()} limit. Split it and ingest in sections.`, 413);
  }

  const meta = body.meta || {};
  const source = SOURCES.includes(meta.source) ? meta.source : null;
  if (!source) throw fail(`Source must be one of: ${SOURCES.join(', ')}.`, 400);
  const segment = SEGMENTS.includes(meta.segment) ? meta.segment : 'Unknown';

  // The prompt keys its voice off the Source — first person for Interviews and
  // Usability test, third person for the logged-request sources — so the run
  // metadata has to reach the model even though it never emits those fields.
  const block = `Source: ${source}\nSegment: ${segment}\nDate: ${meta.date || 'Unknown'}\n\n${transcript}`;

  const prompt = await loadPrompt('extraction-prompt.txt', env);
  const system = fillPrompt(prompt, '=== RAW MATERIAL ===', block);

  const { text, stopReason, usage } = await callAnthropic(env, {
    model: pickModel(body.model),
    system,
    userText: 'Extract the insight cards from the raw material.',
    maxTokens: 8192,
    schema: EXTRACT_SCHEMA,
  });

  const parsed = safeParse(text);
  if (!parsed) {
    // Extraction output scales with the input, unlike the fixed-size
    // classification envelope, so this is the failure that actually happens.
    if (stopReason === 'max_tokens') {
      throw fail('That material produced more cards than fit in one response. '
        + 'Ingest it in smaller sections.', 413);
    }
    throw fail('The model returned an unparseable result. Try again, or switch model.', 502);
  }

  const cards = (parsed.cards || [])
    .map(c => ({
      insight: String(c.insight || '').trim(),
      description: String(c.description || '').trim(),
    }))
    .filter(c => c.insight);

  return json({ cards, stop_reason: stopReason, usage }, 200, cors);
}

/* ============================================================
   /api/cards — the commit
   ============================================================ */
async function handleCards(body, env, cors) {
  if (!env.GITHUB_TOKEN) throw fail('GITHUB_TOKEN is not configured on the Worker.', 500);
  if (!env.GITHUB_REPO) throw fail('GITHUB_REPO is not configured on the Worker.', 500);

  // This is a trust boundary now, not a convenience layer: the client's checks
  // are UX, and everything that reaches the corpus is re-validated here.
  const meta = body.meta || {};
  if (!SOURCES.includes(meta.source)) {
    throw fail(`Source must be one of: ${SOURCES.join(', ')}.`, 400);
  }
  if (!SEGMENTS.includes(meta.segment)) {
    throw fail(`Segment must be one of: ${SEGMENTS.join(', ')}.`, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date || '')) {
    throw fail('Date must be ISO YYYY-MM-DD.', 400);
  }
  const link = String(meta.link || '').trim();
  if (link && !/^https?:\/\//i.test(link)) {
    throw fail('Source link must be an http(s) URL.', 400);
  }

  const incoming = Array.isArray(body.cards) ? body.cards : [];
  if (!incoming.length) throw fail('No cards to add.', 400);
  if (incoming.length > MAX_CARDS) {
    throw fail(`${incoming.length} cards in one commit is over the ${MAX_CARDS} limit.`, 413);
  }

  const rows = incoming.map((c, i) => {
    const insight = collapse(c.insight);
    const description = collapse(c.description);
    if (!insight) throw fail(`Card ${i + 1} has no insight text.`, 400);
    if (insight.length > MAX_INSIGHT) throw fail(`Card ${i + 1} exceeds ${MAX_INSIGHT} characters.`, 400);
    if (description.length > MAX_DESCRIPTION) {
      throw fail(`Card ${i + 1}'s description exceeds ${MAX_DESCRIPTION} characters.`, 400);
    }
    return {
      Insight: insight,
      Date: meta.date,
      Description: description,
      Segment: meta.segment,
      Source: meta.source,
      'Source link': link,
    };
  });

  const result = await commitRows(rows, meta, env);
  return json({ added: rows.length, ...result }, 200, cors);
}

/* Newlines inside a CSV field are legal and parseCSV() handles them, but an
   insight is one sentence — a stray newline means the model or an editor
   misbehaved, so flatten rather than persist it. */
function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(row) {
  return COLUMNS.map(c => csvField(row[c])).join(',');
}

/* ============================================================
   GitHub Contents API
   ============================================================ */
async function gh(path, env, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'avrios-evidence-engine-worker',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  return res;
}

/* base64 <-> UTF-8. atob/btoa are byte-oriented, so the corpus's non-ASCII
   content (TÜV, Contrôle, curly quotes) has to round-trip through TextEncoder
   rather than being passed through directly. */
function b64ToText(b64) {
  const clean = b64.replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function commitRows(rows, meta, env) {
  const branch = env.GITHUB_BRANCH || 'main';
  let lastConflict = null;

  // The file sha is an optimistic lock. Two people ingesting at once would
  // otherwise be a silent lost update, so re-read and retry on conflict.
  for (let attempt = 1; attempt <= COMMIT_RETRIES; attempt++) {
    const getRes = await gh(`contents/${CSV_PATH}?ref=${encodeURIComponent(branch)}`, env);
    if (!getRes.ok) {
      const detail = await getRes.text().catch(() => '');
      throw fail(`Could not read the corpus from GitHub (${getRes.status}). ${detail.slice(0, 200)}`, 502);
    }
    const file = await getRes.json();
    const current = b64ToText(file.content || '');

    // Append, keeping the file's own terminator and exactly one at the end.
    const trimmed = current.replace(/(\r?\n)+$/, '');
    const updated = `${trimmed}${EOL}${rows.map(csvRow).join(EOL)}${EOL}`;

    const putRes = await gh(`contents/${CSV_PATH}`, env, {
      method: 'PUT',
      body: JSON.stringify({
        message: commitMessage(rows.length, meta),
        content: textToB64(updated),
        sha: file.sha,
        branch,
      }),
    });

    if (putRes.ok) {
      const out = await putRes.json();
      return {
        commit: out.commit?.sha || null,
        commit_url: out.commit?.html_url || null,
        attempts: attempt,
      };
    }

    // 409 is the documented conflict; GitHub also returns 422 when the sha is
    // stale. Both mean "someone else committed first" — re-read and retry.
    if (putRes.status === 409 || putRes.status === 422) {
      lastConflict = putRes.status;
      continue;
    }

    const detail = await putRes.text().catch(() => '');
    throw fail(`GitHub rejected the commit (${putRes.status}). ${detail.slice(0, 200)}`, 502);
  }

  throw fail(`The corpus changed under us ${COMMIT_RETRIES} times in a row `
    + `(last status ${lastConflict}). Nothing was committed — try again.`, 409);
}

function commitMessage(count, meta) {
  const noun = count === 1 ? 'card' : 'cards';
  const subject = `Add ${count} ${noun} from ${meta.source} (${meta.date})`;
  const lines = [
    subject,
    '',
    `Segment: ${meta.segment}`,
    `Source: ${meta.source}`,
  ];
  if (meta.link) lines.push(`Source link: ${meta.link}`);
  lines.push('', 'Ingested via the Add insights page.');
  return lines.join('\n');
}
