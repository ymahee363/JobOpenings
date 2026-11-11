import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script
import { metrics, newestPerJob, signatureOf, siteOf, triage } from '../scripts/auto-fixer/prep.mjs';
// @ts-expect-error plain .mjs script
import { snappyDecompress } from '../scripts/auto-fixer/read-attempts.mjs';

const at = (jobId: string, outcome: string, reason = '', extra: object = {}) =>
  ({ jobId, title: 'Product Manager', company: 'Acme', startedAt: 1000, finishedAt: 2000, mode: 'live', outcome, reason, questions: [], clicked: false, ...extra });

describe('auto fixer prep (2026-11-11)', () => {
  it('names the site of a job id', () => {
    expect(siteOf('wellfound-4735114')).toBe('wellfound');
    expect(siteOf('281026500745')).toBe('naukri');
    expect(siteOf('linkedin-1')).toBe('linkedin');
  });

  it('turns two jobs with the same failure into one signature', () => {
    const a = signatureOf(at('1', 'failed', 'Acme: pressing "Next" did not move on page 2'));
    const b = signatureOf({ ...at('2', 'failed', 'Globex: pressing "Continue" did not move on page 3'), company: 'Globex' });
    expect(a).toBe(b);
  });

  it('keeps the newest attempt per job and leaves dry runs out', () => {
    const latest = newestPerJob([at('j', 'failed'), { ...at('j', 'applied'), startedAt: 5000 }, { ...at('k', 'applied'), mode: 'dry_run' }]);
    expect(latest).toHaveLength(1);
    expect(latest[0].outcome).toBe('applied');
  });

  it('counts success as applied / (applied + needs me + failed + stuck)', () => {
    const m = metrics([at('linkedin-1', 'applied'), at('linkedin-2', 'needs_me'), at('linkedin-3', 'skipped'), at('linkedin-4', 'pending')], 10 * 60 * 60_000);
    expect(m.linkedin).toMatchObject({ applied: 1, needs_me: 1, skipped: 1, stuck: 1, success: 33 });
  });

  it('flags a fixed cause failing on a build made after the fix as a regression', () => {
    const causes = [{ id: 'C1', title: 't', signature: 'no application step', status: 'fixed', fixedAt: 100 }];
    const { known, unknown } = triage([
      at('a', 'failed', 'Indeed: no application step found', { build: 200 }),
      at('b', 'failed', 'Indeed: no application step found', { build: 50 }),
      at('c', 'failed', 'something new'),
    ], causes);
    expect(known[0].jobs).toHaveLength(2);
    expect(known[0].regressions.map((x: { jobId: string }) => x.jobId)).toEqual(['a']);
    expect(unknown).toHaveLength(1);
  });

  it('decompresses snappy literals and copies', () => {
    // "abcabcabc": length 9, literal "abc", copy of length 6 at offset 3 (1-byte offset form).
    const compressed = new Uint8Array([9, 0x08, 0x61, 0x62, 0x63, 0x09, 0x03]);
    expect(snappyDecompress(compressed).toString()).toBe('abcabcabc');
  });
});
