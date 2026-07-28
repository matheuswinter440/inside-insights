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

**Evaluate:** `system` = `system-prompt.txt` with the full corpus appended → one user message
(hypothesis text, plus an image block if a screenshot was attached) → Anthropic Messages API.
Model defaults to `claude-sonnet-5`; switch to `claude-opus-4-8` for higher quality. Errors are
handled: `401` re-prompts for the key, `429` shows a rate-limit message, network/CORS errors show raw.

> Verify current model strings against the docs before shipping:
> https://docs.claude.com/en/docs/about-claude/models

**Feedback:** 👍 / 👎 + an optional note under each result, logged to `localStorage`.
**Export feedback** downloads it as JSON. (Later: send to a store.)

**Opportunity map:** each card is assigned to a theme client-side using first-match-wins keyword
rules. Per theme we compute card count, distinct source types, and distinct non-"Unknown" segments,
then render a horizontal Chart.js bar chart. Filter by source type, toggle sort
(volume ↔ source-type breadth), click a bar to list that theme's cards.

### Caveats surfaced in the UI (kept on purpose)
- **Volume ≠ value** — the bar axis counts frequency, not worth.
- **Clustering is heuristic keyword matching**, not embeddings — should become embeddings later.
- **"Other"** is a catch-all for unmatched cards.
