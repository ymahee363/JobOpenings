import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { BoardDB } from '../src/db/db';
import {
  exportBackup, importBackup, markAppliedFromSite, purge, restoreStatus, setStatus, upsertJobs,
} from '../src/db/repo';
import type { ParsedJob } from '../src/shared/types';

const NOW = 1792500000000;
const DAY = 86_400_000;

function parsed(over: Partial<ParsedJob> & { jobId: string }): ParsedJob {
  return {
    site: 'naukri', title: 'PM', company: 'Acme', location: 'Pune', experience: '', expMin: null, expMax: null,
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

describe('markAppliedFromSite', () => {
  it('marks new and seen jobs applied, but never overrides a status you set', async () => {
    await setStatus(db, 'seen', 'seen', NOW - DAY);
    await setStatus(db, 'dismissed', 'dismissed', NOW - DAY);
    await setStatus(db, 'applied', 'applied', NOW - 2 * DAY);
    const n = await markAppliedFromSite(db, ['fresh', 'seen', 'dismissed', 'applied'], NOW);
    expect(n).toBe(2);
    expect(await db.statuses.get('fresh')).toEqual({ jobId: 'fresh', status: 'applied', statusAt: NOW });
    expect((await db.statuses.get('seen'))?.status).toBe('applied');
    expect((await db.statuses.get('dismissed'))?.status).toBe('dismissed');
    expect((await db.statuses.get('applied'))?.statusAt).toBe(NOW - 2 * DAY);
  });

  it('does nothing for an empty list', async () => {
    expect(await markAppliedFromSite(db, [], NOW)).toBe(0);
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

  it('round-trips Indeed jobs and treats old backups without a site as Naukri', async () => {
    await upsertJobs(db, [
      parsed({ jobId: 'indeed-a10763a21af31e90', site: 'indeed', naukriUrl: 'https://in.indeed.com/viewjob?jk=a10763a21af31e90' }),
      parsed({ jobId: '2' }),
    ], NOW);
    const data = JSON.parse(await exportBackup(db, NOW));
    delete data.jobs.find((j: { jobId: string }) => j.jobId === '2').site;
    const other = new BoardDB(`test-${n++}`);
    await importBackup(other, JSON.stringify(data));
    expect((await other.jobs.get('indeed-a10763a21af31e90'))?.site).toBe('indeed');
    expect((await other.jobs.get('2'))?.site).toBe('naukri');
  });

  it('round-trips Instahyre jobs', async () => {
    await upsertJobs(db, [
      parsed({ jobId: 'instahyre-443833', site: 'instahyre', naukriUrl: 'https://www.instahyre.com/job-443833-product-manager-at-sahi-bangalore/' }),
    ], NOW);
    const other = new BoardDB(`test-${n++}`);
    await importBackup(other, await exportBackup(db, NOW));
    expect((await other.jobs.get('instahyre-443833'))?.site).toBe('instahyre');
  });

  it('rejects files that are not our backups or carry unsafe links', async () => {
    await expect(importBackup(db, '{"hello":1}')).rejects.toThrow();
    await upsertJobs(db, [parsed({ jobId: '1' })], NOW);
    const data = JSON.parse(await exportBackup(db, NOW));
    data.jobs[0].externalUrl = 'javascript:alert(1)';
    await expect(importBackup(db, JSON.stringify(data))).rejects.toThrow(/https/);
    data.jobs[0].externalUrl = null;
    data.jobs[0].naukriUrl = 'https://indeed.com.evil.example/viewjob?jk=1';
    await expect(importBackup(db, JSON.stringify(data))).rejects.toThrow(/supported job site/);
  });
});

describe('schema upgrade', () => {
  it('marks jobs stored before Indeed support as Naukri jobs', async () => {
    const name = `test-${n++}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({ jobs: 'jobId, postedAt, lastSeenAt, applyType, titleCompanyKey', statuses: 'jobId, status, statusAt', log: '++id, ts' });
    const { site: _site, ...old } = parsed({ jobId: '1' });
    await v1.table('jobs').add({ ...old, firstSeenAt: NOW, lastSeenAt: NOW });
    v1.close();
    const upgraded = new BoardDB(name);
    expect((await upgraded.jobs.get('1'))?.site).toBe('naukri');
  });
});
