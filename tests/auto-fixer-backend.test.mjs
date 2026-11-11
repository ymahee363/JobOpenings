// The auto fixer's data pipeline (backend review, 2026-11-11): LevelDB log reading, cause validation, metrics,
// regressions by build, the personal-data scan and the cycle lock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { crc32c, logEntries, maskCrc, readAttemptsWithStats } from '../scripts/auto-fixer/read-attempts.mjs';
import { metrics, readIsClean, triage, validateCauses, writeJsonAtomic } from '../scripts/auto-fixer/prep.mjs';
import { needlesFrom, scan } from '../scripts/auto-fixer/pii-scan.mjs';
import { acquire, release } from '../scripts/auto-fixer/lock.mjs';

const varint = (n) => { const b = []; while (n >= 0x80) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n); return Buffer.from(b); };
const value = (obj) => Buffer.concat([Buffer.from([0x00, 0xff, 0x0a]), v8.serialize(obj)]); // a Blink-like envelope
const batch = (seq, ops) => {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(seq), 0);
  head.writeUInt32LE(ops.length, 8);
  const parts = [head];
  for (const [kind, key, val] of ops) {
    parts.push(Buffer.from([kind === 'put' ? 1 : 0]), varint(key.length), Buffer.from(key));
    if (kind === 'put') parts.push(varint(val.length), val);
  }
  return Buffer.concat(parts);
};
const record = (payload, type = 1, corrupt = false) => {
  const h = Buffer.alloc(7);
  h.writeUInt32LE((maskCrc(crc32c(Buffer.concat([Buffer.from([type]), payload]))) ^ (corrupt ? 1 : 0)) >>> 0, 0);
  h.writeUInt16LE(payload.length, 4);
  h[6] = type;
  return Buffer.concat([h, payload]);
};
const attempt = (jobId, outcome, extra = {}) => ({ jobId, title: 'PM', company: 'Acme', startedAt: 1000, finishedAt: null, mode: 'live', outcome, reason: '', questions: [], clicked: false, ...extra });

describe('LevelDB log reading', () => {
  it('checks CRC32C against the standard test vector', () => {
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
  });

  it('keeps the newest version per key, applies deletes, skips corrupt and torn records', () => {
    const log = Buffer.concat([
      record(batch(1, [['put', 'k1', value(attempt('a', 'pending'))], ['put', 'k2', value(attempt('b', 'pending'))]])),
      record(batch(3, [['put', 'k1', value(attempt('a', 'applied'))], ['del', 'k2']])),
      record(batch(5, [['put', 'k3', value(attempt('c', 'failed'))]]), 1, true), // bad CRC
      record(batch(6, [['put', 'k4', value(attempt('d', 'applied'))]])).subarray(0, 20), // torn tail
    ]);
    const stats = {};
    expect([...logEntries(log, stats)]).toHaveLength(4);
    expect(stats).toMatchObject({ badCrc: 1, tornRecords: 1 });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-test-'));
    fs.writeFileSync(path.join(dir, '000001.log'), log);
    const { attempts, stats: s } = readAttemptsWithStats(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(attempts.map((a) => `${a.jobId}:${a.outcome}`)).toEqual(['a:applied']);
    expect(s.decodeFailures).toBe(0);
  });
});

describe('prep', () => {
  it('rejects a bad causes.json instead of crashing on it', () => {
    const errs = validateCauses([
      { id: 'C1', title: 't', signature: '(', status: 'watching' },
      { id: 'C1', title: 't', signature: 'x', status: 'fixed' },
      { id: 'C2', title: 't', signature: 'x', status: 'done' },
    ]);
    expect(errs.join('\n')).toMatch(/not a valid regex/);
    expect(errs.join('\n')).toMatch(/duplicate id/);
    expect(errs.join('\n')).toMatch(/status must be one of/);
    expect(validateCauses([{ id: 'C3', title: 't', signature: 'x', status: 'fixed', fixBuild: 5 }])).toEqual([]);
  });

  it('counts a stuck attempt as a failure in the success rate', () => {
    const m = metrics([attempt('linkedin-1', 'applied'), attempt('linkedin-2', 'pending')], 10 * 60 * 60_000);
    expect(m.linkedin).toMatchObject({ applied: 1, stuck: 1, success: 50 });
  });

  it('finds regressions by the build the fix shipped in, including that build itself', () => {
    const causes = [{ id: 'C1', title: 't', signature: 'boom', status: 'fixed', fixBuild: 100 }];
    const { known } = triage([
      attempt('a', 'failed', { reason: 'boom', build: 100 }),
      attempt('b', 'failed', { reason: 'boom', build: 99 }),
      attempt('c', 'failed', { reason: 'boom' }),
    ], causes);
    expect(known[0].regressions.map((x) => x.jobId)).toEqual(['a']);
  });

  it('will not act on a database that did not read cleanly', () => {
    expect(readIsClean({ attempts: 100, decodeFailures: 0, badFiles: 0, badBlocks: 0, badBatches: 0 })).toBe(true);
    expect(readIsClean({ attempts: 100, decodeFailures: 5, badFiles: 0, badBlocks: 0, badBatches: 0 })).toBe(false);
  });

  it('writes state atomically', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-state-')), 'state.json');
    writeJsonAtomic(f, { lastRunAt: 1 });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ lastRunAt: 1 });
    expect(fs.readdirSync(path.dirname(f))).toEqual(['state.json']);
  });
});

describe('personal-data scan', () => {
  const needles = needlesFrom({ email: 'someone@example.org', phone: '+91 98765 43210', current_ctc: 1234567, address: { line1: '12 Test Lane', postal_code: '560001' } });

  it('finds a phone written with spaces or dashes, in any commit of the range', () => {
    const patches = 'commit a\n+++ b/x.ts\n+const p = "98765-43210";\ncommit b\n+++ b/x.ts\n-const p = "98765-43210";\n';
    expect(scan(patches, needles).map((h) => h.kind)).toEqual(['phone']);
  });

  it('does not flag long unrelated numbers', () => {
    expect(scan('+++ b/x.ts\n+const ids = [4735114, 5034721, 101126006440];\n', needles)).toEqual([]);
  });

  it('reports added images and PDFs for a person to look at', () => {
    expect(scan('Binary files /dev/null and b/qa/reports/shot.png differ\n', needles)).toEqual([{ kind: 'binary file', file: 'qa/reports/shot.png' }]);
  });
});

describe('cycle lock', () => {
  it('lets one cycle in, refuses a second, and takes over a stale lock', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'af-lock-')), '.lock');
    expect(acquire(f, 1_000)).toBe(true);
    expect(acquire(f, 2_000)).toBe(false);
    expect(acquire(f, 1_000 + 3 * 60 * 60_000)).toBe(true);
    release(f);
    expect(fs.existsSync(f)).toBe(false);
  });
});
