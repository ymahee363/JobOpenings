/**
 * Personal-data scan (2026-11-11): the person's own values, read from seed/ai-seed.json (never printed), must not
 * appear in added lines. Exits 1 and names the kind and file of each hit, never the value.
 *
 *   node scripts/auto-fixer/pii-scan.mjs                     # staged changes
 *   node scripts/auto-fixer/pii-scan.mjs --range A..B        # every commit in A..B, each patch on its own
 *   node scripts/auto-fixer/pii-scan.mjs --unpushed <sha>    # every commit of <sha> not on any remote
 *
 * Commits are scanned one patch at a time, not as one net diff: a value added in one commit and removed in the next
 * still lands in history. Added images and PDFs (screenshots of filled forms) cannot be read here: they are reported
 * and block unless PII_ALLOW_BINARY=1 says a person looked at them.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINARY_RE = /\.(png|jpe?g|gif|webp|pdf|docx?|zip)$/i;

/** [kind, needle] pairs from the profile; numbers are matched by digits, ignoring spaces, dashes and dots. */
export function needlesFrom(profile) {
  const out = [];
  const add = (kind, v, min = 5) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (s.length >= min) out.push([kind, s]);
  };
  add('email', profile.email);
  const digits = String(profile.phone ?? '').replace(/\D/g, '');
  if (digits.length >= 10) out.push(['phone', `digits:${digits.slice(-10)}`]);
  add('date of birth', profile.date_of_birth, 6);
  for (const k of ['current_ctc', 'expected_ctc']) if (Number(profile[k]) >= 100000) out.push([k, `digits:${String(profile[k])}`]);
  const a = profile.address ?? {};
  // Line 1 and the postal code; line 2 is a locality name that also appears in public test text.
  for (const k of ['line1', 'street', 'address_line_1', 'postal_code', 'zip', 'pincode']) add(`address ${k}`, a[k], 6);
  return out;
}

/** Digit runs of a line, each with its separators (space, dash, dot, comma, parentheses) removed. */
function digitRuns(line) {
  return (line.match(/\+?\d[\d\s().,-]{4,}\d/g) ?? []).map((r) => r.replace(/\D/g, ''));
}

/** Hits in a unified diff (one or many patches): { kind, file }. Binary additions come back as kind 'binary file'. */
export function scan(diff, needles) {
  const hits = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    const bin = /^Binary files .* and (?:b\/)?(.+) differ$/.exec(line);
    if (bin && bin[1] !== '/dev/null' && BINARY_RE.test(bin[1])) { hits.push({ kind: 'binary file', file: bin[1] }); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const low = line.toLowerCase();
    const runs = digitRuns(line);
    for (const [kind, n] of needles) {
      const found = n.startsWith('digits:') ? runs.some((r) => r.includes(n.slice(7))) : low.includes(n);
      if (found) hits.push({ kind, file });
    }
  }
  return hits;
}

function gitText(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main() {
  const seedPath = path.join(ROOT, 'seed', 'ai-seed.json');
  if (!fs.existsSync(seedPath)) {
    console.log('pii-scan: no seed/ai-seed.json, nothing to compare against');
    return;
  }
  const needles = needlesFrom(JSON.parse(fs.readFileSync(seedPath, 'utf8')).profile ?? {});
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  let diff;
  if (arg('--range')) diff = gitText(['log', '-p', '--format=commit %H', arg('--range')]);
  else if (arg('--unpushed')) diff = gitText(['log', '-p', '--format=commit %H', arg('--unpushed'), '--not', '--remotes']);
  else diff = gitText(['diff', '--cached']);
  const hits = scan(diff, needles);
  const allowBinary = process.env.PII_ALLOW_BINARY === '1';
  const blocking = hits.filter((h) => h.kind !== 'binary file' || !allowBinary);
  for (const h of hits) {
    console.error(h.kind === 'binary file'
      ? `pii-scan: ${h.file} is an image/document; look at it for personal data${allowBinary ? ' (allowed by PII_ALLOW_BINARY=1)' : ', then rerun with PII_ALLOW_BINARY=1'}`
      : `pii-scan: your ${h.kind} appears in ${h.file}`);
  }
  if (blocking.length) process.exit(1);
  console.log(`pii-scan: clean (${needles.length} personal values checked)`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
