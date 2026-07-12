# Radius PG — Build Contract Checker (hardened)

Upload a building contract, working drawings and site feasibility (PDFs). The tool produces a **cited, confidence-scored review** and surfaces only the items that need a human — an **exceptions list** — so a reviewer confirms a handful of flagged points instead of reading every page.

## How it works

1. **Contract — pass 1 (extract):** pulls parties, price, dates, insurances, retention, defects, stage claims, inclusions, exclusions and red flags — each with a **page/clause citation and confidence**.
2. **Contract — pass 2 (audit):** an independent skeptical re-read that hunts for the first pass's misses: blank mandatory fields, defects-period vs warranty-annexure conflicts, mis-referenced clauses, special-conditions precedence, retention/pay-before-keys, LD adequacy, commercial-vs-domestic, base-spec-vs-inclusions (e.g. glazing). Where the passes disagree, that becomes an exception.
3. **Drawings — index:** catalogues every sheet (~35-50 pp) and locates the window/door/finishes/electrical schedules by page.
4. **Drawings — cross-check:** verifies each contract inclusion against the specific sheets and cites them. Unsure -> "not found", low confidence (never a false "supported").
5. **Feasibility — cross-check:** for each excluded contract cost, decides whether the feasibility carries an allowance — flags gaps.

The results merge into one **checklist workspace**: an exceptions list up top (with citations, confidence, OK/Review/N-A + notes), a "couldn't verify" blind-spots list, and the auto-confirmed high-confidence detail collapsed below. Save the review to a file, reopen it later, or print to PDF.

## The trust model (read this)

This makes the reviewer's job minutes of cited spot-checks instead of hours of reading — it does **not** remove the reviewer. It can misread a figure or mislocate a drawing item, and it states things confidently. For anything going to an investor, confirm the flagged exceptions against the cited pages before relying on it. That's the deal that keeps it safe to put your name on.

## Deploy to Railway (via GitHub)

1. Push this folder to a new GitHub repo:
   ```
   git init && git add . && git commit -m "Contract checker (hardened)"
   git branch -M main
   git remote add origin https://github.com/<you>/contract-checker.git
   git push -u origin main
   ```
2. Railway -> **Deploy from GitHub repo** -> pick it (auto-detects Node, runs `npm start`).
3. Railway -> your service -> **Variables**:
   - `ANTHROPIC_API_KEY` = your key from console.anthropic.com
   - `ANTHROPIC_MODEL` = `claude-sonnet-5` (optional). For maximum contract-reading accuracy you can set an Opus-class model — higher cost per run.
4. Open the URL Railway gives you.

The key stays in Railway's environment; it is never sent to the browser. Documents are processed in memory per request and discarded.

## Run locally
```
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start   # http://localhost:3000
```

## Calibrate it to your contracts (do this after deploy)

The tool is tuned for GCC6 / SDA, but your real examples make it sharper:
1. Run it on 2-3 past contracts where you already know the correct findings.
2. Note anything it **missed**, got **wrong**, or **over-flagged**.
3. Adjust the prompt constants in `server.js` (`EXTRACT_SYSTEM`, `AUDIT_SYSTEM`, `DRAW_CHECK_SYSTEM`, `FEAS_SYSTEM`) — the "known issues" bullet lists are where you teach it your recurring points. Redeploy. Two or three rounds dials it in.

## Limits & cost

- **Files:** ~32 MB / ~100 pages per PDF. Split very large drawing sets.
- **Calls per run:** up to 5 (2 contract passes, 2 drawings, 1 feasibility). Document **prompt caching** is on, so the re-sent contract/drawings are cheap on the second pass.
- **Cost:** usually cents to a few dollars per run depending on page counts. Watch usage in the Anthropic console.
- **Time:** 1-3 minutes for a full run with drawings.

## Where to change things
- Model -> `ANTHROPIC_MODEL` or the default in `server.js`.
- Extraction / audit / cross-check behaviour -> the prompt constants at the top of `server.js`.
- What counts as an "exception" -> `mk()` and `buildReview()` in `server.js`.
- Workspace layout -> `public/app.js` (`renderWorkspace`, `cardHtml`) and `public/styles.css`.
