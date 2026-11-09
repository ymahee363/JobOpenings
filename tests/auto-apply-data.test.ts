import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { BoardDB } from '../src/db/db';
import {
  addAttempt, ATTEMPT_RETENTION_MS, exportBackup, finishAttempt, importBackup, listAttempts, purge, setStatus,
} from '../src/db/repo';
import { attemptsCsv } from '../src/shared/board';
import { DEFAULT_AGENT_CONFIG, normalizeAgentConfig, type Attempt } from '../src/shared/auto-apply/config';
import { staleAttempts } from '../src/shared/auto-apply/pacing';

const NOW = 1792500000000;

const base: Omit<Attempt, 'id'> = {
  jobId: 'iimjobs-1', title: 'Product Manager', company: 'Paytm', startedAt: NOW, finishedAt: null, mode: 'live',
  matched: ['title: product manager'], answers: [], questions: [], clicked: false, outcome: 'pending', reason: '',
};

let db: BoardDB;
let n = 0;
beforeEach(async () => {
  db = new BoardDB(`agent-test-${n++}`);
  await db.open();
});

describe('attempts', () => {
  it('round-trips and finishes an attempt', async () => {
    const id = await addAttempt(db, base);
    await finishAttempt(db, id, { finishedAt: NOW + 1_000, outcome: 'applied', clicked: true });
    const [a] = await listAttempts(db);
    expect(a).toMatchObject({ id, outcome: 'applied', clicked: true, finishedAt: NOW + 1_000 });
  });

  it('lists newest first, from a start time', async () => {
    await addAttempt(db, { ...base, jobId: 'a', startedAt: NOW - 10 });
    await addAttempt(db, { ...base, jobId: 'b', startedAt: NOW });
    expect((await listAttempts(db)).map((a) => a.jobId)).toEqual(['b', 'a']);
    expect((await listAttempts(db, NOW)).map((a) => a.jobId)).toEqual(['b']);
  });

  it('finds attempts cut off mid-run (crash recovery)', async () => {
    await addAttempt(db, { ...base, jobId: 'cut', startedAt: NOW - 10 * 60_000 });
    await addAttempt(db, { ...base, jobId: 'running', startedAt: NOW - 30_000 });
    await addAttempt(db, { ...base, jobId: 'done', startedAt: NOW - 10 * 60_000, outcome: 'applied' });
    expect(staleAttempts(await listAttempts(db), NOW).map((a) => a.jobId)).toEqual(['cut']);
  });

  it('keeps attempts for 180 days', async () => {
    await addAttempt(db, { ...base, jobId: 'old', startedAt: NOW - ATTEMPT_RETENTION_MS - 1 });
    await addAttempt(db, { ...base, jobId: 'kept', startedAt: NOW - ATTEMPT_RETENTION_MS + 60_000 });
    await purge(db, NOW);
    expect((await listAttempts(db)).map((a) => a.jobId)).toEqual(['kept']);
  });

  it('exports CSV safe for spreadsheets', () => {
    const csv = attemptsCsv([{ ...base, outcome: 'needs_me', questions: ['=Why us?'], reason: 'No stored answer' }]);
    const [header, row] = csv.split('\r\n');
    expect(header).toContain('"Outcome"');
    expect(row).toContain('"needs_me"');
    expect(row).toContain(`"'=Why us?"`);
  });
});

describe('appliedBy', () => {
  it('marks agent applies and keeps them in backups', async () => {
    await setStatus(db, 'iimjobs-1', 'applied', NOW, 'agent');
    await setStatus(db, 'iimjobs-2', 'dismissed', NOW, 'agent');
    expect(await db.statuses.get('iimjobs-1')).toEqual({ jobId: 'iimjobs-1', status: 'applied', statusAt: NOW, appliedBy: 'agent' });
    expect((await db.statuses.get('iimjobs-2'))?.appliedBy).toBeUndefined();
    const other = new BoardDB(`agent-restore-${n++}`);
    await importBackup(other, await exportBackup(db, NOW));
    expect((await other.statuses.get('iimjobs-1'))?.appliedBy).toBe('agent');
  });
});

describe('schema upgrade', () => {
  it('opens a v2 database and keeps its data', async () => {
    const name = `agent-upgrade-${n++}`;
    const v2 = new Dexie(name);
    v2.version(2).stores({ jobs: 'jobId, postedAt, lastSeenAt, applyType, titleCompanyKey', statuses: 'jobId, status, statusAt', log: '++id, ts' });
    await v2.open();
    await v2.table('statuses').put({ jobId: 'x', status: 'applied', statusAt: NOW });
    v2.close();
    const v3 = new BoardDB(name);
    await v3.open();
    expect(await v3.statuses.get('x')).toMatchObject({ status: 'applied' });
    expect(await v3.attempts.count()).toBe(0);
  });
});

describe('normalizeAgentConfig', () => {
  it('fills missing rules and clamps the cap', () => {
    const c = normalizeAgentConfig({ autoApply: true, dailyCap: 500, rules: { myYears: 8 } as never });
    expect(c.autoApply).toBe(true);
    expect(c.dryRun).toBe(true);
    expect(c.dailyCap).toBe(100);
    expect(c.rules.myYears).toBe(8);
    expect(c.rules.titleIncludes).toEqual(DEFAULT_AGENT_CONFIG.rules.titleIncludes);
  });
});
