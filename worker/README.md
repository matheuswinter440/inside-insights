# Evidence Engine Worker

The backend for the static site in the parent directory. It exists to hold three
secrets the browser must never see, and to do the one thing a page served from
GitHub Pages cannot: write to the repo.

Before this Worker, the app was bring-your-own-key — every teammate pasted a
personal Anthropic key into `localStorage`. That is what this replaces.

## Endpoints

All `POST`, all requiring the `x-access-password` header.

| Endpoint | Body | Does |
|---|---|---|
| `/api/evaluate` | `{ hypothesis, candidates[], model? }` | Loads `system-prompt.txt`, appends the client's deterministically-retrieved candidates, returns the verdict JSON |
| `/api/extract` | `{ transcript, meta, model? }` | Loads `extraction-prompt.txt`, returns `{ cards[] }` |
| `/api/cards` | `{ cards[], meta }` | Validates, appends to `data/corpus_all.csv`, commits |

The prompts are fetched from the site rather than accepted from the caller. That
keeps `/data` as the single source of truth — edit a prompt file, commit, and
both routes pick it up — and keeps these endpoints purpose-specific instead of a
general "run any prompt on someone else's key" proxy. A leaked password buys the
ingest and evaluate flows, not arbitrary inference.

Model IDs are allowlisted (`claude-sonnet-5`, `claude-opus-5`, `claude-haiku-4-5`)
for the same reason.

## Setup

```bash
cd worker
npm install -g wrangler        # or: npx wrangler <cmd>
wrangler login
```

Set the three secrets. These are never written to `wrangler.toml`:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put ACCESS_PASSWORD
```

- **`ANTHROPIC_API_KEY`** — a standard `sk-ant-…` key. Usage now bills to this one
  key for the whole team rather than per person. That is the point, but it means a
  leaked access password is a leaked budget.
- **`GITHUB_TOKEN`** — a **fine-grained** PAT scoped to `inside-insights` only,
  with `Contents: Read and write` and nothing else. A classic `repo`-scoped token
  would grant this Worker write access to every repo you own.
- **`ACCESS_PASSWORD`** — the shared team password. Use a passphrase, not a word.

Non-secret config lives in `wrangler.toml`: `ALLOWED_ORIGINS`, `SITE_BASE_URL`,
`GITHUB_REPO`, `GITHUB_BRANCH`. If the Worker fails closed with a 401 for
everyone, the usual cause is `ACCESS_PASSWORD` never being set — auth fails
closed by design rather than falling open.

## Deploy

```bash
wrangler deploy
```

Note the deployed URL and put it in `assets/app.js` as `WORKER_URL`.

## Local development

```bash
cd worker && npx wrangler dev          # Worker on :8787
cd ..     && python3 -m http.server 8000
```

Point `WORKER_URL` in `assets/app.js` at `http://localhost:8787` while
developing. `wrangler dev` reads the deployed secrets when logged in; for a fully
offline run put them in `worker/.dev.vars` (gitignored).

**Test CORS against the real Pages origin before trusting a deploy.** A missing
preflight only fails cross-origin, so a localhost-only test will not catch it.

## Rotating a secret

```bash
wrangler secret put ACCESS_PASSWORD    # overwrite, then tell the team
```

Teammates will be re-prompted on their next request — the client clears a stored
password when the Worker returns 401.

## Operational notes

- **Free tier**: 100k requests/day, which this comfortably fits inside.
- **Prompt edits take up to a minute.** The prompts are cached per isolate for 60s and
  fetched with `cache: 'no-cache'` so the edge cache can't extend that. Editing
  `data/extraction-prompt.txt`, committing, and waiting for the Pages build is enough — no
  redeploy. If the site is unreachable or returns an error on refresh, the Worker keeps serving the
  last good copy rather than failing requests; only a cold isolate with an unreachable site 502s.
- **The corpus uses CRLF line endings.** The append path writes `\r\n` to match.
  Switching to `\n` would leave the file mixed-terminator and make every
  subsequent diff noisy. `tools/migrate-segments.py` sniffs and preserves it too.
- **Commits are optimistically locked** on the file SHA, with a bounded retry on
  conflict. Two people ingesting simultaneously would otherwise be a silent lost
  update. After `COMMIT_RETRIES` conflicts the Worker gives up and reports that
  nothing was written, rather than guessing.
- **Cards land live after the Pages rebuild**, roughly a minute after the commit —
  not instantly. The ingest page says so rather than implying otherwise.
