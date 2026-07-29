# Avrios Evidence Engine

A static site that checks a product hypothesis against a corpus of de-identified
user-research insight cards, shows an aggregate **opportunity map** over the same corpus, and
grows that corpus from raw material. Served by GitHub Pages, with a small Cloudflare Worker
holding the credentials and doing the one thing a Pages site can't: write to the repo.

- **`index.html` (Evaluate):** enter a hypothesis (free text) → structured verdict
  (Supported / Contradicted / Partial / Gap) with an auditable strength score and cited cards.
- **`map.html` (Opportunity map):** the corpus clustered into themes, sized by demand volume,
  colored by evidence breadth (triangulated vs single-source).
- **`ingest.html` (Add insights):** paste an interview transcript or a set of insights → review the
  extracted cards → they're committed to `corpus_all.csv` and live after the next Pages build.

---

## Security

**No API key reaches the browser.** The Worker in `worker/` holds the Anthropic key, a GitHub token,
and a shared access password; the site sends only its own inputs. On first use you're prompted for
the **team access password**, stored in that browser's `localStorage`. There is a **clear** button in
the top bar.

This replaces the earlier bring-your-own-key setup, where every teammate pasted a personal Anthropic
key into their browser. That was acceptable for a trusted internal POC and is not a model for
anything wider — a browser-held key can be read by whoever uses that browser.

- **Never commit a key, token, or password.** Anything pushed here is public the moment it lands.
  Secrets live in `wrangler secret put` and nowhere else; there are none in this repository.
- **A leaked access password is a leaked budget.** Model usage bills to one team key now. Rotate by
  overwriting the secret — teammates are re-prompted on their next request.
- The Worker's endpoints are deliberately purpose-specific (fixed prompts loaded from `/data`,
  allowlisted model IDs), so the password buys the evaluate and ingest flows rather than arbitrary
  inference on the key.
- `/api/cards` re-validates everything the browser already checked. Client-side validation is UX;
  the Worker is the trust boundary.

---

## Running locally

The app `fetch()`es files from `/data`, so opening `index.html` via `file://` fails — browsers block
those fetches. Serve over HTTP, and run the Worker alongside it:

```bash
cd avrios-evidence-engine
python3 -m http.server 8000            # site  → http://localhost:8000

cd worker && npx wrangler dev          # Worker → http://localhost:8787
```

Point `WORKER_URL` at the top of `assets/app.js` to `http://localhost:8787` while developing, and
enter the access password when prompted. See [`worker/README.md`](worker/README.md) for secrets and
deployment.

---

## Deploying

Two targets: the site on GitHub Pages, the Worker via `wrangler`.

1. Push this repo to GitHub (`main` branch).
2. **Settings → Pages → Source = `main` / root**, save.
3. Deploy the Worker (`cd worker && wrangler deploy`), then set `WORKER_URL` in `assets/app.js` to
   the deployed URL and make sure the Pages origin is listed in `ALLOWED_ORIGINS` in
   `worker/wrangler.toml`.
4. Open the Pages URL and confirm `/data/corpus_all.csv` loads — the committed **`.nojekyll`** file
   is what guarantees Pages serves `/assets` and `/data` verbatim (no Jekyll processing).

**Test CORS from the real Pages origin.** A missing preflight only fails cross-origin, so a
localhost-only test won't catch it.

---

## Repo structure

```
/
  index.html            # Evaluate page
  map.html              # Opportunity map page
  ingest.html           # Add insights page
  /assets
    app.js              # shared: access password, CSV loader, Worker client, feedback store
    evaluate.js         # evaluate page logic
    map.js              # packed-bubble render + drill-down
    themes.js           # THEME_RULES + classify(), shared by map and ingest
    retrieve.js         # deterministic lexical retrieval (also powers ingest's similarity check)
    ingest.js           # extraction, similarity check, review gate, commit
    styles.css
  /data
    corpus_all.csv       # the insight-card corpus (committed, appended to by ingest)
    system-prompt.txt    # the evaluator prompt (committed, swappable)
    extraction-prompt.txt # the ingest prompt (committed, swappable)
  /worker
    src/index.js        # the three endpoints; see worker/README.md
    wrangler.toml
  /tools
    migrate-segments.py # one-shot Segment vocabulary migration (already applied)
  README.md
  .nojekyll             # serve /assets and /data as-is on GitHub Pages
```

---

## The "intelligence" lives in `/data`, not the code

The value of this tool is the **prompts + the cards**, not the JavaScript. All three are plain
editable files in `/data`, swappable without touching any code. The Worker fetches the prompts from
the deployed site, so editing one is a commit — not a redeploy.

### Updating the corpus
Normally you don't: **use the Add insights page**, which appends and commits for you. To bulk-replace
(a fresh Notion export, say), overwrite **`data/corpus_all.csv`**, commit, push.

Columns are fixed: `Insight, Date, Description, Segment, Source, Source link`. The parser handles
quoted fields with embedded commas and newlines. Two things to preserve:

- **CRLF line endings.** The file uses them; the Worker's append path and
  `tools/migrate-segments.py` both match. Rewriting it with LF works at runtime but makes every
  later diff show all 273 lines.
- **The controlled vocabularies.** `Source` ∈ `Planhat`, `Interviews`, `Usability test`, `Survey`,
  `Customer Success`. `Segment` ∈ `Enterprise`, `Multi-entity`, `Large fleet`, `Mid-market`,
  `Small fleet`, `Pool fleet`, `Specialised fleet`, `Prospect`, `Unknown`. Both are enforced by the
  Worker. `Source` is load-bearing: the strength score counts **distinct** Source values, so an
  invented per-interview Source would let one conversation look like several independent sources and
  score a false 3/3.

### Updating the prompts
Edit **`data/system-prompt.txt`** (Evaluate) or **`data/extraction-prompt.txt`** (Add insights).
Each must keep its marker line near the end, followed by a `{the app appends …}` placeholder:

| File | Marker | What gets substituted |
|---|---|---|
| `system-prompt.txt` | `=== CANDIDATE CARDS ===` | the retrieved candidate cards, numbered 1..N |
| `extraction-prompt.txt` | `=== RAW MATERIAL ===` | the run's metadata, then the pasted material |

If the placeholder is missing, the Worker appends after the marker; if the marker is missing too, it
appends both. Both prompts are free to change their wording, but the **JSON shape is enforced by a
schema in `worker/src/index.js`** — change the fields a prompt promises and you must change the
schema with it.

One thing a prompt cannot do: constrain string length. JSON Schema's `minLength`/`maxLength` aren't
supported by structured outputs, so the "one sentence, 40–140 characters" house style is stated in
`extraction-prompt.txt` with examples and re-checked in `ingest.js`, which flags violations at review
time rather than rejecting them.

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

The candidates and the prompt are assembled **on the Worker**, so the prompt and the JSON schema it
must satisfy live together and can't drift apart. Model defaults to `claude-sonnet-5`, with
`claude-opus-5` and `claude-haiku-4-5` also available (all three support structured outputs); the
Worker allowlists those three. Errors: `401` clears the stored password and re-prompts, `429` shows a
rate-limit message, unreachable-backend errors say to check the deploy and `ALLOWED_ORIGINS`.

> **Known limit / upgrade path:** lexical retrieval matches on words, so it can miss pure
> paraphrases with no shared vocabulary. The build-spec-anticipated upgrade is embedding-based
> retrieval (e.g. Voyage AI): precompute a card embedding once, embed the query at runtime, select
> by cosine similarity. Same deterministic contract, better semantic recall — at the cost of an
> embeddings key + a precompute step. This would improve ingest's similarity check too, which shares
> the same tokenizer and inherits the same blind spot.

> Verify current model strings against the docs before shipping:
> https://platform.claude.com/docs/en/about-claude/models

**Feedback:** 👍 / 👎 + an optional note under each result, logged to `localStorage`.
**Export feedback** downloads it as JSON. (Now that a Worker exists, this could post to it instead.)

**Opportunity map:** each card is assigned to a theme client-side using first-match-wins keyword
rules (`assets/themes.js`, shared with ingest). Per theme we compute card count, distinct source
types, and distinct non-"Unknown" segments, then render a **packed-bubble chart** (custom, no chart
library): bubble size = demand volume (card count), bubble color = source density (distinct source
types, 1 → 4+). Click a bubble to open that theme's insight cards. Bubbles are packed on an
Archimedean spiral entirely client-side.

**Add insights:** paste raw material, review, commit.

1. The Worker loads `extraction-prompt.txt` and returns `{ cards: [{ insight, description }] }` as
   structured JSON. Run metadata (Source, Segment, Date, link) comes from the form and is attached
   server-side, so the model can't drift it. The prompt keys its **voice** off the Source — the
   corpus has two, and mixing them reads wrong: `Planhat` / `Survey` / `Customer Success` cards are
   third person ("Fleet managers want…", 209 of the original 272 rows), `Interviews` /
   `Usability test` are first person ("I want…").
2. Material over ~80k characters is split on blank lines and extracted in several passes, because one
   response can't hold the cards for a long transcript. Cards repeated across passes are collapsed.
3. Each card is scored against the whole corpus using the **same** `termsOf`/IDF machinery as
   retrieval, and the review table shows its predicted theme, any similar existing card inline, and
   style or voice warnings. A card landing in `Other` is called out, since it would be invisible on
   the map.
4. You edit, uncheck, and press Add. The Worker re-validates, appends, and commits with the file SHA
   as an optimistic lock (bounded retry, so two simultaneous ingests can't silently lose one). Cards
   go live after the Pages rebuild, roughly a minute later.

> **The similarity check is one recall-oriented flag, not a duplicate detector.** Calibrated over all
> 36,856 pairs in the existing corpus, the ranking doesn't separate duplicates from non-duplicates:
> the top-scoring pair in the whole corpus (0.65) is two genuinely different insights sharing the
> phrase "bulk-update … via Excel import", while a real paraphrase pair scores 0.32. The corpus
> phrasing is formulaic enough that shared boilerplate dominates the IDF signal, so no threshold
> separates the classes. Flagged rows therefore stay **included** by default with the matching card
> shown — you adjudicate. Exact text matches are reliable and do default to excluded.

## Design system

The UI follows the "Evidence Engine" Claude Design project (Vimcar / Shiftmove dark theme):

- **Display face:** Pangea (licensed). The `.otf` files couldn't be committed here, so the stack
  falls back to **Hanken Grotesk** — the substitute named in the design system's own typography
  tokens — loaded from Google Fonts. To use the real Pangea, drop `Pangea-Regular.otf` /
  `Pangea-SemiBold.otf` into `assets/fonts/`, add a `@font-face` for each, and `Pangea` (already
  first in the `--font-display` stack in `styles.css`) will win automatically.
- **Body face:** Inter (Google Fonts).
- Dark-only theme, matching the design. Palette tokens live at the top of `assets/styles.css`.

> **Note vs. the design mockup:** the model dropdown labels were mapped to real, current model IDs
> (`claude-sonnet-5`, `claude-opus-5`, `claude-haiku-4-5`) — the mockup's "Opus 4.6" isn't a shipping
> model. The map's "volume ≠ value" and "heuristic clustering" caveats are kept visible (a build-spec
> non-negotiable) even though the mockup omitted them, and the Add insights page carries an equivalent
> caveat about its similarity check. The Add insights route has no mockup; it reuses the existing
> panel, badge, and card components rather than introducing new ones.

---

## Known rough edges

- **`TODAY` / `RECENCY_CUTOFF` in `assets/evaluate.js` are hardcoded** to `2026-07-28`. The strength
  score downgrades evidence older than the cutoff, so every card ingested from now on is compared
  against a frozen date and the downgrade drifts further the longer this stands. A one-line fix, but
  it changes existing verdicts, so it deserves a deliberate decision rather than a drive-by change.
- **The stemmer doesn't unify `digital` / `digitized`** (`assets/retrieve.js`), which is one reason a
  known paraphrase pair scores only 0.32. Fixing it would change which cards Evaluate retrieves, so
  it's a retrieval decision, not an ingest one.
- **Five rows lost real signal in the Segment migration** — `Plus` (a plan tier),
  `high-churn-risk account`, `high-document-volume`, `France`, `Ireland/insurance-driven`. None is a
  segment and none has a home in the current column set, so they became `Unknown`. Git history is the
  only record. Adding a column would fix it properly.

### Caveats surfaced in the UI (kept on purpose)
- **Volume ≠ value** — the bar axis counts frequency, not worth.
- **Clustering is heuristic keyword matching**, not embeddings — should become embeddings later.
- **"Other"** is a catch-all for unmatched cards.
