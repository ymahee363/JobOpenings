import { describe, expect, it } from 'vitest';
import {
  appliedCsv, buildRows, computeStats, DEFAULT_FILTERS, matchesFilters, rowsForTab, type BoardRow,
} from '../src/shared/board';
import type { Job, JobStatus } from '../src/shared/types';

const NOW = 1792500000000;
const DAY = 86_400_000;

function job(over: Partial<Job> & { jobId: string }): Job {
  return {
    title: 'Product Manager', company: 'Acme', location: 'Bengaluru', experience: '3-6 Yrs',
    expMin: 3, expMax: 6, salary: 'Not disclosed', salaryMinLpa: null, salaryMaxLpa: null, skills: ['SQL'],
    postedAt: NOW - DAY, postedLabel: '1 Day Ago', postedApprox: false, firstSeenAt: NOW - DAY, lastSeenAt: NOW,
    sourceFeeds: ['profile'], applyType: 'easy_apply', naukriUrl: 'https://www.naukri.com/job-listings-x-1',
    externalUrl: null, titleCompanyKey: 'product manager|acme', ...over,
  };
}

const row = (over: Partial<Job> & { jobId: string }): BoardRow => buildRows([job(over)], [], null, NOW)[0]!;

describe('buildRows', () => {
  it('flags new, maybe-closed and applied-before jobs', () => {
    const jobs = [
      job({ jobId: 'a', firstSeenAt: NOW - 1000 }),
      job({ jobId: 'b', lastSeenAt: NOW - 8 * DAY, titleCompanyKey: 'x|y' }),
      job({ jobId: 'c', firstSeenAt: NOW - 5 * DAY }),
    ];
    const statuses: JobStatus[] = [{ jobId: 'c', status: 'applied', statusAt: NOW }];
    const rows = buildRows(jobs, statuses, NOW - 60_000, NOW);
    expect(rows.map((r) => [r.jobId, r.isNew, r.maybeClosed, r.appliedBefore, r.status])).toEqual([
      ['a', true, false, true, 'new'],
      ['b', false, true, false, 'new'],
      ['c', false, false, false, 'applied'],
    ]);
  });
});

describe('rowsForTab', () => {
  const jobs = [
    job({ jobId: 'old', postedAt: NOW - 3 * DAY }),
    job({ jobId: 'new', postedAt: NOW - 1000 }),
    job({ jobId: 'tie-later', postedAt: NOW - DAY, firstSeenAt: NOW - 10 }),
    job({ jobId: 'tie-earlier', postedAt: NOW - DAY, firstSeenAt: NOW - 20 }),
    job({ jobId: 'site', applyType: 'company_site' }),
    job({ jobId: 'gone', postedAt: NOW }),
    job({ jobId: 'done', postedAt: NOW }),
  ];
  const statuses: JobStatus[] = [
    { jobId: 'gone', status: 'dismissed', statusAt: NOW },
    { jobId: 'done', status: 'applied', statusAt: NOW },
  ];
  const rows = buildRows(jobs, statuses, null, NOW);

  it('sorts newest first, ties by first seen, and hides dismissed and applied', () => {
    expect(rowsForTab(rows, 'easy_apply', DEFAULT_FILTERS, NOW).map((r) => r.jobId))
      .toEqual(['new', 'tie-later', 'tie-earlier', 'old']);
  });

  it('splits by apply type and has an applied tab', () => {
    expect(rowsForTab(rows, 'company_site', DEFAULT_FILTERS, NOW).map((r) => r.jobId)).toEqual(['site']);
    expect(rowsForTab(rows, 'applied', DEFAULT_FILTERS, NOW).map((r) => r.jobId)).toEqual(['done']);
  });
});

describe('matchesFilters', () => {
  const f = DEFAULT_FILTERS;
  it('applies posted-within (default 7 days)', () => {
    expect(matchesFilters(row({ jobId: '1', postedAt: NOW - 8 * DAY }), f, NOW)).toBe(false);
    expect(matchesFilters(row({ jobId: '1', postedAt: NOW - 8 * DAY }), { ...f, postedWithinDays: null }, NOW)).toBe(true);
  });
  it('applies experience, location and keywords', () => {
    const r = row({ jobId: '1' });
    expect(matchesFilters(r, { ...f, expYears: 2 }, NOW)).toBe(false);
    expect(matchesFilters(r, { ...f, expYears: 4 }, NOW)).toBe(true);
    expect(matchesFilters(r, { ...f, location: 'pune, bengaluru' }, NOW)).toBe(true);
    expect(matchesFilters(r, { ...f, location: 'pune' }, NOW)).toBe(false);
    expect(matchesFilters(r, { ...f, keywordsInclude: 'sql' }, NOW)).toBe(true);
    expect(matchesFilters(r, { ...f, keywordsInclude: 'java' }, NOW)).toBe(false);
    expect(matchesFilters(r, { ...f, keywordsExclude: 'manager' }, NOW)).toBe(false);
    expect(matchesFilters(r, { ...f, companyBlocklist: 'acme' }, NOW)).toBe(false);
  });
  it('applies the salary floor, with undisclosed salaries optional', () => {
    const undisclosed = row({ jobId: '1' });
    const paid = row({ jobId: '2', salaryMinLpa: 20, salaryMaxLpa: 30 });
    expect(matchesFilters(undisclosed, { ...f, salaryFloorLpa: 25 }, NOW)).toBe(true);
    expect(matchesFilters(undisclosed, { ...f, salaryFloorLpa: 25, includeUndisclosedSalary: false }, NOW)).toBe(false);
    expect(matchesFilters(paid, { ...f, salaryFloorLpa: 25 }, NOW)).toBe(true);
    expect(matchesFilters(paid, { ...f, salaryFloorLpa: 31 }, NOW)).toBe(false);
  });
});

describe('stats and CSV', () => {
  const jobs = [job({ jobId: 'a', postedAt: NOW - 10 * 3_600_000 }), job({ jobId: 'b', postedAt: NOW - 30 * 3_600_000 }),
    job({ jobId: 'c', title: '=HYPERLINK("x")', applyType: 'company_site', externalUrl: 'https://x.example/a' })];
  const statuses: JobStatus[] = [
    { jobId: 'a', status: 'applied', statusAt: NOW },
    { jobId: 'b', status: 'applied', statusAt: NOW },
    { jobId: 'c', status: 'applied', statusAt: NOW - 10 * DAY },
  ];
  const rows = buildRows(jobs, statuses, null, NOW);

  it('computes weekly count and median hours', () => {
    const s = computeStats(rows, NOW);
    expect(s.appliedLast7Days).toBe(2);
    expect(s.appliedTotal).toBe(3);
    // 10 h and 30 h; job c (applied before its posted date) is excluded.
    expect(s.medianHoursPostedToApplied).toBe(20);
    expect(s.byType).toEqual({ easy_apply: 2, company_site: 1, unknown: 0 });
    expect(s.byFeed).toEqual({ profile: 3 });
  });

  it('exports applied jobs and neutralises formula injection', () => {
    const csv = appliedCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('"Title","Company","Location","Apply type","Posted","Applied","Link"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"https://x.example/a"');
  });
});
