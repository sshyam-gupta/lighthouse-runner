# Lighthouse Runner

Runs **Google PageSpeed Insights** (the same engine and servers as pagespeed.web.dev) on lists of live URLs – mobile and desktop, 3 runs each – and saves the full Lighthouse HTML report of the median run, plus a summary page.

## Setup (once)
```bash
cd ~/Documents/projects/lighthouse-runner
npm install
cp .env.example .env      # then set PSI_API_KEY=your-key
```
Get a free key in Google Cloud Console: enable **PageSpeed Insights API** → Credentials → Create API key (restrict it to that API). Free quota is ~25,000 requests/day; each URL uses 6 requests (2 devices × 3 runs).

## URL files
One file per environment (or any group of pages) in `urls/` – one URL per line, `#` for comments. Copy `urls/example.txt` to start a new one, e.g. `urls/staging.txt`.

## Run
```bash
npm run audit -- <url file>            # e.g. npm run audit -- staging  → urls/staging.txt
npm run audit -- https://site.com/ https://site.com/about   # specific URLs
npm run audit                          # shows usage + available URL files
```

Options (add after the file name, they combine):
- `--mobile` / `--desktop` – one device only
- `--runs 1` – quick single run (default 3, median kept)
- `--label after-fix` – added to the report folder name, handy for before/after

Example: `npm run audit -- staging --mobile --label after-fix`

Several files can run in parallel in separate terminals.

## Output
`reports/<YYYY-MM-DD_HHMM>_<url file>_psi[_label]/`
- `<site>__mobile.html`, `<site>__desktop.html` – full Lighthouse report of the median run
- `index.html` – summary: median Perf + each run's Perf, A11y, Best Practices, SEO, LCP, CLS, TBT, FCP, and the CDN cache status. Opens when the run finishes.

## Notes
- Every run adds a unique `?lh_nocache=…` so the CDN can't serve stale HTML and PSI can't reuse an earlier result – you always measure the latest deploy.
- The **HTML cache** column shows what the CDN serves real visitors; cached HTML over 1 hour old is flagged ⚠️ (possibly an old build if the CDN isn't purged on deploy).
- URLs returning 404/410/5xx or not resolving are skipped before using quota.
- Scores still vary run to run (that's why the median of 3). Compare runs with each other, not single runs.

## Sharing / git
`urls/*.txt`, `.env`, `reports/` and `node_modules/` are git-ignored. `urls/example.txt` and `.env.example` are the templates teammates copy.
