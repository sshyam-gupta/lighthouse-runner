#!/usr/bin/env node
/**
 * Lighthouse runner — audits every URL in a list on Google PageSpeed Insights
 * (same engine and servers as pagespeed.web.dev), mobile + desktop, 3 runs each,
 * and saves the full HTML report of the median run (by Performance score) into
 * reports/<timestamp>_<name>_psi/ with an index.html summary.
 *
 * Needs a PageSpeed Insights API key: PSI_API_KEY in .env (see .env.example).
 *
 * Usage (URL files live in urls/<name>.txt):
 *   npm run audit -- <name>            # audit urls/<name>.txt, e.g. npm run audit -- staging
 *   npm run audit -- https://a.com ... # ad-hoc URLs instead of a file
 *   npm run audit -- --mobile          # mobile only   (or --desktop)
 *   npm run audit -- --runs 1          # quick single run (default 3, median kept)
 *   npm run audit -- --label after-fix # appended to the report folder name
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
const args = process.argv.slice(2);
const URL_DIR = path.join(ROOT, 'urls');
let urlFile = '';
let listName = '';
const cliUrls = [];
let devices = ['mobile', 'desktop'];
let runs = 3;
let label = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--mobile') devices = ['mobile'];
  else if (a === '--desktop') devices = ['desktop'];
  else if (a === '--label') {
    label = (args[++i] ?? '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '');
    if (!label) { console.error('--label needs a name'); process.exit(1); }
  }
  else if (a === '--runs') {
    runs = parseInt(args[++i], 10);
    if (!(runs >= 1)) { console.error('--runs needs a number ≥ 1'); process.exit(1); }
  }
  else if (/^https?:\/\//i.test(a)) cliUrls.push(a);
  else if (!a.startsWith('-') && !listName) {
    // URL file: a name in urls/ (staging → urls/staging.txt) or a path to any .txt file
    urlFile = /[\\/]|\.txt$/i.test(a) ? path.resolve(a) : path.join(URL_DIR, `${a}.txt`);
    listName = path.basename(urlFile, '.txt');
  }
  else { console.error(`Unknown argument: ${a}`); process.exit(1); }
}

// ---------- helpers ----------
function parseUrlList(text) {
  return [...new Set(
    text.split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean)
      .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
  )];
}

function slugify(url) {
  const u = new URL(url);
  const p = (u.pathname + u.search).replace(/\/+$/, '');
  return (u.hostname.replace(/^www\./, '') + (p ? '_' + p : ''))
    .replace(/[^a-z0-9.]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (s) => (s == null ? '–' : Math.round(s * 100));
const CATS = ['performance', 'accessibility', 'best-practices', 'seo'];

// Unique query param per run: stops the CDN serving stale HTML and stops PSI reusing a cached result.
function withCacheBuster(url, token) {
  const u = new URL(url);
  u.searchParams.set('lh_nocache', token);
  return u.toString();
}

// Summarise CDN cache headers of the HTML response (CloudFront, Cloudflare, Fastly, Vercel, Netlify…).
function describeCache(h) {
  const status = h.get('x-cache') || h.get('cf-cache-status') || h.get('x-vercel-cache') || h.get('x-nf-cache-status')
    || h.get('x-cache-status') || h.get('x-proxy-cache') || '';
  const age = h.get('age');
  const short = /hit/i.test(status) ? 'HIT' : /miss|expired|bypass|dynamic|refresh/i.test(status) ? 'MISS' : status;
  if (!short && !age) return 'n/a';
  return [short || '?', age ? `age ${age}s` : ''].filter(Boolean).join(', ');
}

// Cached HTML older than an hour may be an old build (CDN not purged on deploy).
function isStale(cache) {
  const m = /age (\d+)s/.exec(cache || '');
  return !!m && +m[1] > 3600;
}

// Quick check before using PSI quota: skips 404/410, 5xx, DNS/connection failures, timeouts.
// Also records what the CDN is serving visitors for the plain URL.
async function checkUrl(url, timeoutMs = 20000) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' },
    });
    res.body?.cancel().catch(() => {});
    const skip = res.status === 404 || res.status === 410 || res.status >= 500;
    return { ok: !skip, reason: skip ? `HTTP ${res.status}` : '', cache: describeCache(res.headers) };
  } catch (err) {
    const code = err.cause?.code || err.name;
    return { ok: false, reason: code === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : `unreachable (${code || err.message})` };
  }
}

// ---------- PageSpeed Insights API ----------
// API key from env (PSI_API_KEY or LHCI_PSI_API_KEY) or the .env file next to this script.
async function loadPsiKey() {
  if (process.env.PSI_API_KEY) return process.env.PSI_API_KEY;
  if (process.env.LHCI_PSI_API_KEY) return process.env.LHCI_PSI_API_KEY;
  try {
    const env = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = /^\s*(PSI_API_KEY|LHCI_PSI_API_KEY)\s*=\s*["']?([^"'\s#]+)/.exec(line);
      if (m) return m[2];
    }
  } catch {}
  return '';
}

// Errors that won't change on retry (page 404s, DNS fails, bad key…).
const PSI_FATAL = /FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|DNS_FAILURE|NOT_HTML|INVALID_URL|API key not valid|API_KEY_INVALID|PERMISSION_DENIED|has not been used in project|is disabled/i;

// One PSI run → full Lighthouse result.
async function runPsi(target, device, key) {
  const qs = new URLSearchParams({ url: target, strategy: device, key });
  for (const c of ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']) qs.append('category', c);
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res, body;
    try {
      res = await fetch(endpoint, { signal: AbortSignal.timeout(180000) });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      if (attempt === 3) throw new Error(`PSI request failed: ${err.cause?.code || err.message}`);
      await sleep(5000 * attempt);
      continue;
    }
    if (res.ok && body.lighthouseResult) {
      const lhr = body.lighthouseResult;
      if (lhr.runtimeError) {
        const e = new Error(lhr.runtimeError.message);
        e.fatal = PSI_FATAL.test(lhr.runtimeError.code || '');
        throw e;
      }
      if (lhr.categories?.performance?.score == null) throw new Error('No performance score returned');
      return lhr;
    }
    const msg = (body.error?.message || `HTTP ${res.status}`).replace(/\s+/g, ' ').slice(0, 300);
    const fatal = PSI_FATAL.test(msg) || res.status === 400 || res.status === 403;
    if (fatal || attempt === 3) { const e = new Error(`PSI: ${msg}`); e.fatal = fatal; throw e; }
    await sleep(res.status === 429 ? 30000 * attempt : 5000 * attempt); // 429 = quota/rate limit
  }
}

// Median run by Performance score (lower-middle when the count is even).
function pickMedian(lhrs) {
  const sorted = [...lhrs].sort((a, b) => a.categories.performance.score - b.categories.performance.score);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// ---------- main ----------
async function main() {
  const available = async () => (await fs.readdir(URL_DIR).catch(() => []))
    .filter((f) => f.endsWith('.txt') && f !== 'example.txt').map((f) => f.replace(/\.txt$/, ''));
  if (!cliUrls.length && !urlFile) {
    const names = await available();
    console.log(`\nUsage: npm run audit -- <url file> [--mobile|--desktop] [--runs N] [--label name]`);
    console.log(`       npm run audit -- https://site.com/ ...`);
    console.log(`\nURL files in urls/: ${names.length ? names.join(', ') : '(none yet – copy urls/example.txt)'}\n`);
    process.exit(1);
  }
  if (!cliUrls.length && !(await exists(urlFile))) {
    console.error(`URL file not found: ${path.relative(ROOT, urlFile)}`);
    const names = await available();
    if (names.length) console.error(`Available: ${names.join(', ')}`);
    process.exit(1);
  }
  const urls = cliUrls.length ? cliUrls : parseUrlList(await fs.readFile(urlFile, 'utf8'));
  if (!urls.length) { console.error(`No URLs found in ${urlFile}`); process.exit(1); }

  const key = await loadPsiKey();
  if (!key) {
    console.error('\nNo PageSpeed Insights API key found.\nCopy .env.example to .env and set PSI_API_KEY=your-key (see README).\n');
    process.exit(1);
  }
  const { ReportGenerator } = await import('lighthouse/report/generator/report-generator.js');

  const runName = stamp() + (cliUrls.length ? '_adhoc' : `_${listName.replace(/[^a-z0-9-]+/gi, '-')}`) + '_psi' + (label ? `_${label}` : '');
  const outDir = path.join(ROOT, 'reports', runName);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`\nPageSpeed Insights: ${urls.length} URL(s) × ${devices.join(' + ')} × ${runs} run(s) → ${path.relative(ROOT, outDir)}\n`);

  const rows = [];
  let n = 0;
  const total = urls.length * devices.length;
  for (const url of urls) {
    const chk = await checkUrl(url);
    const cache = chk.cache || '–';
    if (!chk.ok) {
      for (const device of devices) { n++; rows.push({ url, device, skipped: true, error: `Skipped – ${chk.reason}` }); }
      console.log(`  ⏭️  [${n}/${total}] ${url}  →  skipped (${chk.reason})`);
      continue;
    }
    for (const device of devices) {
      n++;
      const tag = `[${n}/${total}] ${device.padEnd(7)} ${url}`;
      process.stdout.write(`\r  ⏳ ${tag}  (${runs} run(s))   `);
      // Runs happen on Google's servers, each with a unique URL, so run them in parallel.
      const settled = await Promise.allSettled(Array.from({ length: runs }, (_, k) =>
        runPsi(withCacheBuster(url, `${Date.now()}-${device}-${k + 1}`), device, key)));
      const runsDone = [], errors = [];
      for (const st of settled) st.status === 'fulfilled' ? runsDone.push(st.value) : errors.push(st.reason.message);

      if (!runsDone.length) {
        rows.push({ url, device, error: errors[0] || 'All runs failed' });
        process.stdout.write(`\r  ❌ ${tag}  →  ${errors[0]}\n`);
        continue;
      }
      const lhr = pickMedian(runsDone);
      const file = `${slugify(url)}__${device}.html`;
      await fs.writeFile(path.join(outDir, file), ReportGenerator.generateReport(lhr, 'html'));
      const scores = Object.fromEntries(CATS.map((c) => [c, lhr.categories[c]?.score]));
      const a = lhr.audits;
      const perfRuns = runsDone.map((x) => pct(x.categories.performance.score));
      rows.push({
        url, device, file, scores, perfRuns, cache, failedRuns: errors.length,
        lcp: a['largest-contentful-paint']?.displayValue ?? '–',
        cls: a['cumulative-layout-shift']?.displayValue ?? '–',
        tbt: a['total-blocking-time']?.displayValue ?? '–',
        fcp: a['first-contentful-paint']?.displayValue ?? '–',
      });
      const failNote = errors.length ? `  (${errors.length} run(s) failed: ${errors[0]})` : '';
      process.stdout.write(`\r  ✅ ${tag}  →  Perf ${pct(scores.performance)} median of [${perfRuns.join(', ')}]${failNote}\n`);
    }
  }

  console.log('');
  console.table(rows.map((r) => r.error
    ? { url: r.url, device: r.device, error: r.error }
    : { url: r.url, device: r.device, Perf: pct(r.scores.performance), 'Perf runs': r.perfRuns.join(' / '),
        A11y: pct(r.scores.accessibility), BP: pct(r.scores['best-practices']), SEO: pct(r.scores.seo),
        LCP: r.lcp, CLS: r.cls, TBT: r.tbt, Cache: r.cache }));

  const indexPath = path.join(outDir, 'index.html');
  await fs.writeFile(indexPath, indexHtml(rows, path.basename(outDir)));
  console.log(`\nReports: ${outDir}\nIndex:   ${indexPath}\n`);
  if (process.platform === 'darwin') exec(`open "${indexPath}"`);
  const skipped = rows.filter((r) => r.skipped).length;
  const failed = rows.filter((r) => r.error && !r.skipped).length;
  if (skipped || failed) console.log(`⚠️  ${skipped} skipped (unreachable/404), ${failed} failed – see table above.`);
  if (failed) process.exitCode = 1;
}

function indexHtml(rows, runName) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cell = (s) => {
    if (s == null) return '<td>–</td>';
    const v = Math.round(s * 100);
    return `<td class="${v >= 90 ? 'good' : v >= 50 ? 'ok' : 'bad'}">${v}</td>`;
  };
  const body = rows.map((r) => r.error
    ? `<tr><td>${esc(r.url)}</td><td>${r.device}</td><td colspan="10" class="${r.skipped ? 'muted' : 'bad'}">${esc(r.error)}</td></tr>`
    : `<tr><td><a href="${esc(r.file)}">${esc(r.url)}</a></td><td>${r.device}</td>${cell(r.scores.performance)}
       <td class="muted">${r.perfRuns.join(' / ')}${r.failedRuns ? ` <span class="bad">(${r.failedRuns} failed)</span>` : ''}</td>
       ${CATS.slice(1).map((c) => cell(r.scores[c])).join('')}
       <td>${esc(r.lcp)}</td><td>${esc(r.cls)}</td><td>${esc(r.tbt)}</td><td>${esc(r.fcp)}</td>
       <td class="${isStale(r.cache) ? 'bad' : 'muted'}">${esc(r.cache)}${isStale(r.cache) ? ' ⚠️ stale?' : ''}</td></tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lighthouse ${runName}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse}
th,td{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left}th{background:#f5f5f5}
.good{color:#0a7d36;font-weight:600}.ok{color:#b26b00;font-weight:600}.bad{color:#c62828;font-weight:600}.muted{color:#777}</style></head>
<body><h2>Lighthouse run ${runName}</h2>
<p class="muted">Run on Google PageSpeed Insights. Each row is the median run by Performance score; its full report is linked. LCP, CLS, TBT and FCP are from that same run.</p>
<table><tr><th>URL (click for full report)</th><th>Device</th><th>Perf (median)</th><th>Perf runs</th><th>A11y</th><th>Best Pr.</th><th>SEO</th><th>LCP</th><th>CLS</th><th>TBT</th><th>FCP</th><th>HTML cache*</th></tr>
${body}</table>
<p class="muted">* What the CDN serves visitors for the plain URL (HIT = from CDN cache, age = seconds since cached, n/a = no cache headers). Over 1 hour old is flagged: it may be an older build if the CDN isn't purged on deploy. The audits themselves always use a unique ?lh_nocache= param, so they measure the latest deploy.</p></body></html>`;
}

main().catch((e) => { console.error(e); process.exit(1); });
