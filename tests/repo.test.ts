import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BoardDB } from '../src/db/db';
import {
  exportBackup, importBackup, purge, restoreStatus, setStatus, upsertJobs,
} from '../src/db/repo';
import type { ParsedJob } from '../src/shared/types';

const NOW = 1792500000000;
const DAY = 86_400_000;

function parsed(over: Partial<ParsedJob> & { jobId: string }): ParsedJob {
  return {
    title: 'PM', company: 'Acme', location: 'Pune', experience: '', expMin: null, expMax: null,
    salary: 'Not disclosed', salaryMinLpa: null, salaryMaxLpa: null, skills: [], postedAt: NOW - DAY,
    postedLabel: '1 Day Ago', postedApprox: false, sourceFeeds: ['profile'], applyType: 'easy_apply',
    naukriUrl: 'https://www.naukri.com/job-listings-pm-1', externalUrl: null, titleCompanyKey: 'pm|acme', ...over,
  };
}

let db: BoardDB;
let n = 0;
beforeEach(async () => {
  db = new BoardDB(`test-${n++}`);
  await db.open();
});

describe('upsertJobs', () => {
  it('adds new jobs with first/last seen and reports them', async () => {
    const r = await upsertJobs(db, [parsed({ jobId: '1' })], NOW);
    expect(r).toEqual({ added: ['1'], updated: 0 });
    expect(await db.jobs.get('1')).toMatchObject({ firstSeenAt: NOW, lastSeenAt: NOW });
  });

  it('merges feeds, keeps first seen and the earliest exact date', async () => {
    await upsertJobs(db, [parsed({ jobId: '1', postedAt: NOW - 2 * DAY })], NOW);
    const r = await upsertJobs(db, [parsed({ jobId: '1', postedAt: NOW - DAY, sourceFeeds: ['apply'], title: 'PM II' })], NOW + 1000);
    expect(r).toEqual({ added: [], updated: 1 });
    expect(await db.jobs.get('1')).toMatchObject({
      postedAt: NOW - 2 * DAY, sourceFeeds: ['profile', 'apply'], firstSeenAt: NOW, lastSeenAt: NOW + 1000, title: 'PM II',
    });
  });

  it('replaces an approximate date with an exact one', async () => {
    await upsertJobs(db, [parsed({ jobId: '1', postedAt: NOW - 30 * DAY, postedApprox: true })], NOW);
    await upsertJobs(db, [parsed({ jobId: '1', postedAt: NOW - 40 * DAY, postedApprox: false })], NOW);
    expect(await db.jobs.get('1')).toMatchObject({ postedAt: NOW - 40 * DAY, postedApprox: false });
  });

  it('never touches statuses', async () => {
    await upsertJobs(db, [parsed({ jobId: '1' })], NOW);
    await setStatus(db, '1', 'dismissed', NOW);
    await upsertJobs(db, [parsed({ jobId: '1' })], NOW + 1);
    expect((await db.statuses.get('1'))?.status).toBe('dismissed');
  });
});

describe('status and undo', () => {
  it('restores the previous status, or clears it', async () => {
    const first = await setStatus(db, '1', 'seen', NOW);
    expect(first).toBeNull();
    const prev = await setStatus(db, '1', 'applied', NOW + 1);
    await restoreStatus(db, '1', prev);
    expect((await db.statuses.get('1'))?.status).toBe('seen');
    await restoreStatus(db, '1', null);
    expect(await db.statuses.get('1')).toBeUndefined();
  });
});

describe('purge', () => {
  it('drops old unapplied jobs but keeps applied history', async () => {
    await upsertJobs(db, [
      parsed({ jobId: 'old', postedAt: NOW - 61 * DAY }),
      parsed({ jobId: 'old-applied', postedAt: NOW - 61 * DAY }),
      parsed({ jobId: 'recent', postedAt: NOW - DAY }),
    ], NOW);
    await setStatus(db, 'old-applied', 'applied', NOW);
    expect(await purge(db, NOW)).toBe(1);
    expect((await db.jobs.toArray()).map((j) => j.jobId).sort()).toEqual(['old-applied', 'recent']);
  });
});

describe('backup', () => {
  it('round-trips through export and import', async () => {
    await upsertJobs(db, [parsed({ jobId: '1' })], NOW);
    await setStatus(db, '1', 'applied', NOW);
    const text = await exportBackup(db, NOW);
    const other = new BoardDB(`test-${n++}`);
    expect(await importBackup(other, text)).toEqual({ jobs: 1, statuses: 1 });
    expect(await other.jobs.get('1')).toEqual(await db.jobs.get('1'));
  });

  it('rejects files that are not our backups or carry unsafe links', async () => {
    await expect(importBackup(db, '{"hello":1}')).rejects.toThrow();
    await upsertJobs(db, [parsed({ jobId: '1' })], NOW);
    const data = JSON.parse(await exportBackup(db, NOW));
    data.jobs[0].externalUrl = 'javascript:alert(1)';
    await expect(importBackup(db, JSON.stringify(data))).rejects.toThrow(/https/);
  });
});
