/**
 * The auto fixer's deterministic first step (2026-11-11): read the attempts (read-attempts.mjs), keep the newest
 * attempt per job, match every failure to a cause in qa/auto-fixer/causes.json, flag regressions (a failure of a
 * fixed cause from a build made after the fix shipped), group new failures by signature, compute per-site metrics the
 * same way every run, and print a short brief. The model reads the brief instead of raw log dumps.
 *
 *   node scripts/auto-fixer/prep.mjs [--since <ms>]       # the brief (read-only)
 *   node scripts/auto-fixer/prep.mjs --write              # also: metrics.md (once per run) + state.json lastRunAt
 *   node scripts/auto-fixer/prep.mjs --mark-fixed C3 [--verified]   # record the current dist build as C3's fix
 *
 * Exit codes: 0 ok; 1 no database / bad causes.json; 2 the database did not read cleanly (do not act on the brief).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDbDir, readAttemptsWithStats } from './read-attempts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'qa', 'auto-fixer');
const SITES = ['iimjobs', 'instahyre', 'wellfound', 'indeed', 'cutshort', 'foundit', 'linkedin'];
const STATUSES = ['fixed', 'fixed-unverified', 'watching', 'not-fixable'];
export const STUCK_MS = 30 * 60_000;

export function siteOf(jobId) {
  for (const s of SITES) if (jobId.startsWith(`${s}-`)) return s;
  return /^\d{6,}$/.test(jobId) ? 'naukri' : 'other';
}

/** A reason with the job's own words, quotes and numbers taken out, so the same failure on two jobs reads the same. */
export function signatureOf(a) {
  let r = String(a.reason || '(no reason)');
  for (const w of [a.title, a.company]) if (w && w.length > 2) r = r.split(w).join('…');
  return r.replace(/"[^"]{0,200}"/g, '"…"').replace(/\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 140);
}

export function newestPerJob(attempts) {
  const m = new Map();
  for (const a of attempts) if (a.mode !== 'dry_run' && (!m.has(a.jobId) || a.startedAt > m.get(a.jobId).startedAt)) m.set(a.jobId, a);
  return [...m.values()];
}

/**
 * applied / (applied + needs_me + failed + stuck): an attempt that never finished is a failure, not "pending"
 * (95 such were hidden on 2026-11-11). Skipped, already applied and in-progress are shown apart.
 */
export function metrics(latest, now) {
  const rows = {};
  for (const a of latest) {
    const s = siteOf(a.jobId);
    const r = (rows[s] ??= { applied: 0, needs_me: 0, failed: 0, stuck: 0, skipped: 0, already_applied: 0, pending: 0 });
    if (a.outcome === 'pending') r[now - a.startedAt > STUCK_MS ? 'stuck' : 'pending'] += 1;
    else if (a.outcome === 'halted') r.failed += 1;
    else if (a.outcome in r) r[a.outcome] += 1;
  }
  for (const r of Object.values(rows)) {
    const base = r.applied + r.needs_me + r.failed + r.stuck;
    r.success = base ? Math.round((100 * r.applied) / base) : null;
  }
  return rows;
}

/** Problems in causes.json, so one bad entry cannot crash or silently skew the brief. */
export function validateCauses(causes) {
  const errors = [];
  const ids = new Set();
  if (!Array.isArray(causes)) return ['"causes" must be an array'];
  for (const [i, c] of causes.entries()) {
    const at = `causes[${i}]${c?.id ? ` (${c.id})` : ''}`;
    if (!c?.id || typeof c.id !== 'string') errors.push(`${at}: id missing`);
    else if (ids.has(c.id)) errors.push(`${at}: duplicate id`);
    else ids.add(c.id);
    if (!c?.title) errors.push(`${at}: title missing`);
    if (!STATUSES.includes(c?.status)) errors.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    try {
      new RegExp(c?.signature, 'i');
      if (!c?.signature) errors.push(`${at}: signature missing`);
    } catch (e) {
      errors.push(`${at}: signature is not a valid regex (${e.message})`);
    }
    if ((c?.status === 'fixed' || c?.status === 'fixed-unverified') && !c.fixBuild && !c.fixedAt) errors.push(`${at}: a fixed cause needs fixBuild (prep.mjs --mark-fixed)`);
  }
  return errors;
}

/** The build a fix shipped in: `fixBuild` (a build stamp), or the older `fixedAt` (commit time). */
const shippedIn = (c) => c.fixBuild ?? c.fixedAt ?? 0;

export function triage(failures, causes) {
  const compiled = causes.map((c) => ({ ...c, re: new RegExp(c.signature, 'i') }));
  const byCause = new Map();
  const unknown = new Map();
  for (const a of failures) {
    const text = `${a.reason} ${(a.questions || []).join(' ')}`;
    const c = compiled.find((x) => x.re.test(text));
    if (c) {
      const e = byCause.get(c.id) ?? { cause: c, jobs: [], regressions: [] };
      e.jobs.push(a);
      if ((c.status === 'fixed' || c.status === 'fixed-unverified') && a.build && a.build >= shippedIn(c) && shippedIn(c) > 0) e.regressions.push(a);
      byCause.set(c.id, e);
    } else {
      const sig = signatureOf(a);
      const e = unknown.get(sig) ?? { sig, jobs: [] };
      e.jobs.push(a);
      unknown.set(sig, e);
    }
  }
  return { known: [...byCause.values()], unknown: [...unknown.values()].sort((x, y) => y.jobs.length - x.jobs.length) };
}

/** Write a JSON file atomically (temp file + rename), so a crash never leaves it half-written. */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The read is trustworthy enough to act on: few decode failures, no unreadable files. */
export function readIsClean(stats) {
  const bad = stats.decodeFailures + stats.badFiles + stats.badBlocks + stats.badBatches;
  return bad === 0 || bad / Math.max(1, stats.attempts) < 0.02;
}

const pct = (n) => (n === null ? '–' : `${n}%`);
const job = (a) => `${siteOf(a.jobId)} ${a.jobId} (${a.company || '?'})`;
const loadJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);

function markFixed(id, verified) {
  const file = path.join(DIR, 'causes.json');
  const doc = loadJson(file, { causes: [] });
  const c = doc.causes.find((x) => x.id === id);
  if (!c) {
    console.error(`No cause ${id} in causes.json`);
    process.exit(1);
  }
  const stampFile = path.join(ROOT, 'dist', 'build-stamp.json');
  if (!fs.existsSync(stampFile)) {
    console.error('dist/build-stamp.json missing: run npm run build first');
    process.exit(1);
  }
  c.fixBuild = JSON.parse(fs.readFileSync(stampFile, 'utf8')).builtAt;
  c.status = verified ? 'fixed' : 'fixed-unverified';
  writeJsonAtomic(file, doc);
  console.log(`${id}: ${c.status}, shipped in build ${c.fixBuild} (${new Date(c.fixBuild).toISOString()})`);
}

function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (arg('--mark-fixed')) return markFixed(arg('--mark-fixed'), process.argv.includes('--verified'));

  const stateFile = path.join(DIR, 'state.json');
  const state = loadJson(stateFile, {});
  const { causes } = loadJson(path.join(DIR, 'causes.json'), { causes: [] });
  const problems = validateCauses(causes);
  if (problems.length) {
    console.error(`causes.json has problems:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const since = Number(arg('--since') ?? state.lastRunAt ?? 0);
  const dir = findDbDir();
  if (!dir) {
    console.error('No extension database found in any Chrome profile: is the extension installed?');
    process.exit(1);
  }
  const now = Date.now();
  const { attempts, stats } = readAttemptsWithStats(dir);
  const latest = newestPerJob(attempts);
  const watching = new Set(causes.filter((c) => c.status === 'watching').map((c) => c.id));
  const failed = latest.filter((a) => a.outcome === 'needs_me' || a.outcome === 'failed' || (a.outcome === 'pending' && now - a.startedAt > STUCK_MS));
  const { known, unknown } = triage(failed, causes);
  const fresh = (a) => a.startedAt >= since;
  const m = metrics(latest, now);

  const out = [];
  out.push(`# Auto fixer brief ${new Date(now).toISOString().slice(0, 16)}Z (failures since ${since ? `${new Date(since).toISOString().slice(0, 16)}Z` : 'ever'})`);
  out.push(`Read: ${stats.attempts} attempts from ${stats.files} files; decode failures ${stats.decodeFailures}, bad files ${stats.badFiles}, bad blocks ${stats.badBlocks}, bad CRC ${stats.badCrc}, torn ${stats.tornRecords}.`);
  out.push('', '## Success per site (newest attempt per job; stuck counts as a failure)', '', '| Site | applied | needs me | failed | stuck | success | skipped | already | in progress |', '|---|---|---|---|---|---|---|---|---|');
  for (const [s, r] of Object.entries(m).sort((a, b) => (b[1].success ?? -1) - (a[1].success ?? -1))) {
    out.push(`| ${s} | ${r.applied} | ${r.needs_me} | ${r.failed} | ${r.stuck} | ${pct(r.success)} | ${r.skipped} | ${r.already_applied} | ${r.pending} |`);
  }
  const regressions = known.flatMap((k) => k.regressions.map((a) => [k.cause.id, a]));
  out.push('', `## Regressions (fixed cause failing on its fix build or later): ${regressions.length}`);
  for (const [id, a] of regressions.slice(0, 10)) out.push(`- ${id}: ${job(a)}: ${String(a.reason).slice(0, 120)}`);
  out.push('', '## Known causes (new since last run / all open)');
  for (const k of known.sort((x, y) => y.jobs.filter(fresh).length - x.jobs.filter(fresh).length)) {
    const n = k.jobs.filter(fresh).length;
    if (!n && !watching.has(k.cause.id)) continue;
    out.push(`- ${k.cause.id} [${k.cause.status}] ${k.cause.title}: ${n} new / ${k.jobs.length} open. e.g. ${job(k.jobs[0])}`);
  }
  const newSigs = unknown.map((u) => ({ ...u, fresh: u.jobs.filter(fresh) })).filter((u) => u.fresh.length);
  out.push('', `## New signatures (no cause yet): ${newSigs.length}`);
  for (const u of newSigs.slice(0, 15)) out.push(`- ${u.fresh.length}× ${u.sig}  — e.g. ${job(u.fresh[0])}`);
  const inProgress = latest.filter((a) => a.outcome === 'pending' && now - a.startedAt <= STUCK_MS).length;
  out.push('', `## In progress now: ${inProgress}${inProgress ? ' (do not rebuild until 0)' : ''}`);
  console.log(out.join('\n'));

  if (!readIsClean(stats)) {
    console.error('\nThe database did not read cleanly (see "Read:" above): do not act on this brief; report it.');
    process.exit(2);
  }
  if (process.argv.includes('--write')) {
    const runId = new Date(now).toISOString().slice(0, 16);
    const metricsFile = path.join(DIR, 'metrics.md');
    const existing = fs.existsSync(metricsFile) ? fs.readFileSync(metricsFile, 'utf8') : '# Auto fixer metrics\n';
    if (!existing.includes(`## ${runId}Z`)) {
      const lines = ['', `## ${runId}Z`, '', '| Site | applied | needs_me | failed | stuck | success |', '|---|---|---|---|---|---|'];
      for (const [s, r] of Object.entries(m)) lines.push(`| ${s} | ${r.applied} | ${r.needs_me} | ${r.failed} | ${r.stuck} | ${pct(r.success)} |`);
      fs.writeFileSync(`${metricsFile}.tmp`, `${existing.trimEnd()}\n${lines.join('\n')}\n`);
      fs.renameSync(`${metricsFile}.tmp`, metricsFile);
    }
    writeJsonAtomic(stateFile, { ...state, lastRunAt: now });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
