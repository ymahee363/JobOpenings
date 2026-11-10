/**
 * QA helper server (http://127.0.0.1:8799, set QA_PORT to change).
 *
 *  GET  /            the built form engine (dist/form-engine.js) with CORS, to load into a live job page and drive
 *                    with the same messages the service worker sends (EXTRACT_FORM, FIND_APPLY, PAGE_SIGNALS…).
 *  POST /save        a page snapshot for offline checks on sites whose CSP blocks that fetch (Keka, Greenhouse,
 *                    Workday…): post a form with fields `name` and `html` (form posts are rarely blocked). Saved to
 *                    $QA_SNAPSHOTS (default: qa/snapshots/, git-ignored), then run `node scripts/qa-offline.mjs`.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.QA_PORT || 8799);
const file = path.join(__dirname, '..', 'dist', 'form-engine.js');
const snapDir = process.env.QA_SNAPSHOTS || path.join(__dirname, '..', 'qa', 'snapshots');

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method === 'POST' && req.url.startsWith('/save')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const name = (form.get('name') || 'page').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
      fs.mkdirSync(snapDir, { recursive: true });
      fs.writeFileSync(path.join(snapDir, `${name}.html`), form.get('html') || '');
      res.setHeader('Content-Type', 'text/plain');
      res.end(`saved ${name} (${(form.get('html') || '').length} chars)`);
    });
    return undefined;
  }
  // Your profile, resume and saved answers (seed/ai-seed.json) for a live in-page run: personal, so only at a one-time
  // secret path (QA_SEED_TOKEN, unset = never served) and only to the page origin in QA_SEED_ORIGIN.
  const seedToken = process.env.QA_SEED_TOKEN;
  if (seedToken && req.url === `/seed/${seedToken}.json`) {
    const allowed = process.env.QA_SEED_ORIGIN || 'https://www.naukri.com';
    if (req.headers.origin !== allowed) {
      res.statusCode = 403;
      res.end('origin not allowed');
      return undefined;
    }
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Content-Type', 'application/json');
    res.end(fs.readFileSync(path.join(__dirname, '..', 'seed', 'ai-seed.json')));
    return undefined;
  }
  // The AI apply flow for in-page runs (scripts/qa-harness.ts, built to qa/harness.js).
  if (req.url === '/harness.js') {
    try {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(__dirname, '..', 'qa', 'harness.js')));
    } catch {
      res.statusCode = 404;
      res.end('build it: npx esbuild scripts/qa-harness.ts --bundle --format=iife --outfile=qa/harness.js');
    }
    return undefined;
  }
  // An AI backend that is out of quota, as the real one answers when Gemini and Groq both are (502 + their 429 text).
  if (req.method === 'POST' && req.url === '/fake-limit/answer') {
    req.resume();
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ detail: 'All LLM providers failed -> Gemini: 429 RESOURCE_EXHAUSTED. Quota exceeded for metric: generate_content_free_tier_requests, limit: GenerateRequestsPerDayPerProjectPerModel | Groq: 429 Rate limit reached for model in organization on tokens per day (TPD). Please try again in 7m12.5s.' }));
    return undefined;
  }
  // A saved test form to try the engine on in a real browser: GET /fixture/input-types.html.
  // The address may carry options for the page's own script (?existing=1): only the path picks the file.
  const fixture = /^\/fixture\/([a-z0-9_-]+\.html)(?:\?.*)?$/i.exec(req.url || '');
  if (fixture) {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'forms', fixture[1])));
    } catch {
      res.statusCode = 404;
      res.end('no such fixture');
    }
    return undefined;
  }
  try {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(file));
  } catch {
    res.statusCode = 404;
    res.end('run npm run build first');
  }
  return undefined;
}).listen(port, '127.0.0.1', () => console.log(`QA server on http://127.0.0.1:${port}/`));
