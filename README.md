# Avrios Evidence Engine

A standalone static site that checks a product hypothesis against a corpus of de-identified
user-research insight cards, and shows an aggregate **opportunity map** over the same corpus.
No backend. Built to be served by GitHub Pages.

- **`index.html` (Evaluate):** enter a hypothesis (free text) + optional screenshot → structured
  verdict (Supported / Contradicted / Partial / Gap) with an auditable strength score and cited cards.
- **`map.html` (Opportunity map):** the corpus clustered into themes, sized by demand volume,
  colored by evidence breadth (triangulated vs single-source).

---

## ⚠️ Security: Bring-Your-Own-Key (read this)

This app calls the Anthropic API **directly from the browser**. On first use it prompts each user
for their own Anthropic API key, which is stored **only in that browser's `localStorage`** and sent
only to Anthropic. There is a **clear key** button in the top bar.

- **Never commit or hardcode an API key.** Anything pushed to the repo is public the moment it lands.
  There is no key in this repository, and none should ever be added.
- BYOK is acceptable for a **trusted internal POC** with a handful of users. It is *not* a model for
  a public app — a browser-held key can be read by whoever uses that browser.
- **Hardening path (out of scope for the POC):** put a serverless proxy (Cloudflare Worker / Vercel
  function) in front that holds one key server-side, and have this static site call the proxy instead
  of Anthropic directly. Then no key ever reaches the browser.

---

## Running locally

Because the app `fetch()`es files from `/data`, opening `index.html` via `file://` will fail
(browsers block those fetches). Serve it over HTTP:

```bash
cd avrios-evidence-engine
python3 -m http.server 8000
# open http://localhost:8000
```

Then paste your Anthropic API key when prompted.

---

## Deploying to GitHub Pages

1. Push this repo to GitHub (`main` branch).
2. **Settings → Pages → Source = `main` / root**, save.
3. Wait for the deploy, then open the Pages URL.
4. Confirm `/data/corpus_all.csv` and `/data/system-prompt.txt` load — the committed **`.nojekyll`**
   file is what guarantees GitHub Pages serves `/assets` and `/data` verbatim (no Jekyll processing).

---

## Repo structure

```
/
  index.html            # Evaluate page
  map.html              # Opportunity map page
  /assets
    app.js              # shared: key mgmt, CSV loader, system-prompt loader, API client, feedback store
    evaluate.js         # evaluate page logic
    map.js              # keyword clustering + Chart.js render
    styles.css
  /data
    corpus_all.csv      # the insight-card corpus (committed, swappable)
    system-prompt.txt   # the evaluator system prompt (committed, swappable)
  README.md
  .nojekyll             # serve /assets and /data as-is on GitHub Pages
```

---

## The "intelligence" lives in `/data`, not the code

The value of this tool is the **system prompt + the cards**, not the JavaScript. Both are plain
editable files in `/data`, swappable without touching any code.

### Updating the corpus
Re-export from Notion, replace **`data/corpus_all.csv`**, commit, push. No app change needed.
Columns: `Insight, Date, Description, Segment, Source, Source link`. The CSV parser handles
quoted fields with embedded commas/newlines.

### Updating the system prompt
Edit **`data/system-prompt.txt`**. It must keep the line `=== CORPUS ===` near the end followed by
the placeholder `{the app appends the full contents of corpus_all.csv here at runtime}` — at runtime
the app replaces that placeholder with the full CSV so the model can retrieve against real cards.
(If the placeholder is absent, the app appends the corpus after `=== CORPUS ===` as a fallback.)

The system prompt defines the output format verbatim (Verdict / Strength / Evidence / Contradicts /
Recommendation); the Evaluate page renders that output and only parses the verdict + strength line to
color the badge.

---

## How it works

**Evaluate:** retrieval is **deterministic and done in the app**, not by the model — so the same
hypothesis references the same cards every time (fixing the earlier behavior where the model, asked
to retrieve in-context over ~270 cards, would sometimes return a different subset or even GAP on a
supported query).

1. `assets/retrieve.js` scores every corpus card against the hypothesis using IDF-weighted term
   overlap with light stemming + a fleet-domain synonym map (so "fuel" also matches
   "consumption"/"diesel", "report" also matches "reporting"/"export"/"dashboard"). Same query →
   same candidate set, ranked strongest-first. Ubiquitous terms ("fleet", "vehicle") carry no
   weight so they don't drag the whole corpus in. Top 40 are sent to the model (surfaced in the UI
   when the match count exceeds that).
2. `system` = `system-prompt.txt` with **only those candidates** appended (numbered). The model's
   job shrinks to classifying each candidate as supporting / contradicting / irrelevant and picking
   a verdict — it returns **structured JSON** (`output_config.format`), so there's no fragile text
   parsing. Card text/source/date shown always come from the corpus (by index), never the model.
3. The **strength score is computed in the app** from the supporting labels (distinct cards ×
   distinct source types, with a recency downgrade), so it's auditable and stable.

Model defaults to `claude-sonnet-5`; `claude-opus-4-8` and `claude-haiku-4-5` are also available
(all three support structured outputs). Errors are handled: `401` re-prompts for the key, `429`
shows a rate-limit message, network/CORS errors show raw.

> **Known limit / upgrade path:** lexical retrieval matches on words, so it can miss pure
> paraphrases with no shared vocabulary. The build-spec-anticipated upgrade is embedding-based
> retrieval (e.g. Voyage AI): precompute a card embedding once, embed the query at runtime, select
> by cosine similarity. Same deterministic contract, better semantic recall — at the cost of an
> embeddings key + a precompute step.

> Verify current model strings against the docs before shipping:
> https://docs.claude.com/en/docs/about-claude/models

**Feedback:** 👍 / 👎 + an optional note under each result, logged to `localStorage`.
**Export feedback** downloads it as JSON. (Later: send to a store.)

**Opportunity map:** each card is assigned to a theme client-side using first-match-wins keyword
rules. Per theme we compute card count, distinct source types, and distinct non-"Unknown" segments,
then render a **packed-bubble chart** (custom, no chart library): bubble size = demand volume (card
count), bubble color = source density (distinct source types, 1 → 4+). Click a bubble to open that
theme's insight cards. Bubbles are packed on an Archimedean spiral entirely client-side.

## Design system

The UI follows the "Evidence Engine" Claude Design project (Vimcar / Shiftmove dark theme):

- **Display face:** Pangea (licensed). The `.otf` files couldn't be committed here, so the stack
  falls back to **Hanken Grotesk** — the substitute named in the design system's own typography
  tokens — loaded from Google Fonts. To use the real Pangea, drop `Pangea-Regular.otf` /
  `Pangea-SemiBold.otf` into `assets/fonts/`, add a `@font-face` for each, and `Pangea` (already
  first in the `--font-display` stack in `styles.css`) will win automatically.
- **Body face:** Inter (Google Fonts).
- Dark-only theme, matching the design. Palette tokens live at the top of `assets/styles.css`.

> **Note vs. the design mockup:** the model dropdown labels were mapped to real, current model
> IDs (`claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`) — the mockup's
> "Opus 4.6" isn't a shipping model. The map's "volume ≠ value" and "heuristic clustering"
> caveats are kept visible (a build-spec non-negotiable) even though the mockup omitted them.
> The evaluate result parses the system prompt's fixed output format (Verdict / Strength /
> Evidence / Contradicts / Recommendation) into the two-column layout; the system prompt itself
> is unchanged.

### Caveats surfaced in the UI (kept on purpose)
- **Volume ≠ value** — the bar axis counts frequency, not worth.
- **Clustering is heuristic keyword matching**, not embeddings — should become embeddings later.
- **"Other"** is a catch-all for unmatched cards.
