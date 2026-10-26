import { describe, expect, it } from 'vitest';
import {
  normalizeFilters, SITES, toggleSite, type Filters,
  appliedCsv, buildRows, cleanHideWord, computeStats, countHiddenByTitle, DEFAULT_FILTERS, DEFAULT_HIDDEN_TITLE_WORDS,
  matchesFilters, rowsForTab, titleHasHiddenWord, type BoardRow,
} from '../src/shared/board';
import type { Job, JobStatus, Site } from '../src/shared/types';

const NOW = 1792500000000;
const DAY = 86_400_000;

function job(over: Partial<Job> & { jobId: string }): Job {
  return {
    site: 'naukri', title: 'Product Manager', company: 'Acme', location: 'Bengaluru', experience: '3-6 Yrs',
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
  it('filters by one or several sites', () => {
    const indeed = row({ jobId: 'indeed-a10763a21af31e90', site: 'indeed' });
    const cutshort = row({ jobId: 'cutshort-6a5f1fdb022d82f19debe51b', site: 'cutshort' });
    expect(matchesFilters(indeed, f, NOW)).toBe(true);
    expect(matchesFilters(indeed, { ...f, sites: ['indeed'] }, NOW)).toBe(true);
    expect(matchesFilters(indeed, { ...f, sites: ['naukri'] }, NOW)).toBe(false);
    const both = { ...f, sites: ['indeed', 'cutshort'] as Site[] };
    expect([indeed, cutshort, row({ jobId: '1' })].map((r) => matchesFilters(r, both, NOW))).toEqual([true, true, false]);
  });

  it('ticks and unticks sites, treating every site as all', () => {
    expect(toggleSite([], 'linkedin', true)).toEqual(['linkedin']);
    expect(toggleSite(['linkedin'], 'naukri', true)).toEqual(['naukri', 'linkedin']);
    expect(toggleSite(['naukri', 'linkedin'], 'naukri', false)).toEqual(['linkedin']);
    expect(toggleSite(SITES.filter((s) => s !== 'iimjobs'), 'iimjobs', true)).toEqual([]);
  });

  it('turns an old single-site filter into a site list', () => {
    const { sites: _sites, ...old } = DEFAULT_FILTERS;
    expect(normalizeFilters({ ...old, site: 'indeed' } as unknown as Filters).sites).toEqual(['indeed']);
    expect(normalizeFilters({ ...old, site: 'all' } as unknown as Filters).sites).toEqual([]);
    expect(normalizeFilters({ ...DEFAULT_FILTERS, sites: ['monster', 'naukri'] as unknown as Site[] }).sites).toEqual(['naukri']);
    expect('site' in normalizeFilters({ ...old, site: 'indeed' } as unknown as Filters)).toBe(false);
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
    expect(s.bySite).toEqual({ naukri: 3, indeed: 0, instahyre: 0, wellfound: 0, linkedin: 0, cutshort: 0, foundit: 0, iimjobs: 0 });
    expect(s.byFeed).toEqual({ profile: 3 });
  });

  it('exports applied jobs and neutralises formula injection', () => {
    const csv = appliedCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('"Site","Title","Company","Location","Apply type","Posted","Applied","Link"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"https://x.example/a"');
  });
});

describe('hiding jobs by title words', () => {
  const words = DEFAULT_HIDDEN_TITLE_WORDS;

  it('starts with Designer and Engineer', () => {
    expect(words).toEqual(['Designer', 'Engineer']);
  });

  it.each([
    ['Senior Software Engineer', true],
    ['Product Designer', true],
    ['UX/UI designer - Fintech', true],
    ['Engineers (Backend)', true],
    ['Lead Engineer, Platform', true],
    ['DESIGNER', true],
    ['Senior Product Manager', false],
    ['Engineering Manager', false],
    ['Product Manager - Design Systems', false],
    ['Reengineering Lead', false],
  ])('"%s" hidden: %s', (title, hidden) => {
    expect(titleHasHiddenWord(title, words)).toBe(hidden);
  });

  it('handles multi-word phrases and characters that mean something in a pattern', () => {
    expect(titleHasHiddenWord('Customer Success Manager', ['customer success'])).toBe(true);
    expect(titleHasHiddenWord('C++ Developer', ['C++'])).toBe(true);
    expect(titleHasHiddenWord('Product Manager (AI)', ['(AI)'])).toBe(true);
    expect(titleHasHiddenWord('Product Manager', ['.*'])).toBe(false);
  });

  it('ignores blank words and an empty list', () => {
    expect(titleHasHiddenWord('Software Engineer', ['', '   '])).toBe(false);
    expect(titleHasHiddenWord('Software Engineer', [])).toBe(false);
  });

  it('cleans typed words', () => {
    expect(cleanHideWord('  Sales   Executive ')).toBe('Sales Executive');
    expect(cleanHideWord('x'.repeat(100))).toHaveLength(60);
  });

  it('leaves hidden jobs out of every tab except Applied, and counts them', () => {
    const rows = buildRows([
      job({ jobId: 'pm', title: 'Product Manager' }),
      job({ jobId: 'eng', title: 'Software Engineer' }),
      job({ jobId: 'des', title: 'Product Designer', applyType: 'company_site' }),
      job({ jobId: 'eng-applied', title: 'Platform Engineer' }),
      job({ jobId: 'des-dismissed', title: 'Visual Designer' }),
    ], [
      { jobId: 'eng-applied', status: 'applied', statusAt: NOW },
      { jobId: 'des-dismissed', status: 'dismissed', statusAt: NOW },
    ], null, NOW);
    expect(rowsForTab(rows, 'easy_apply', DEFAULT_FILTERS, NOW, words).map((r) => r.jobId)).toEqual(['pm']);
    expect(rowsForTab(rows, 'company_site', DEFAULT_FILTERS, NOW, words)).toEqual([]);
    expect(rowsForTab(rows, 'applied', DEFAULT_FILTERS, NOW, words).map((r) => r.jobId)).toEqual(['eng-applied']);
    // Removing the words brings them back.
    expect(rowsForTab(rows, 'easy_apply', DEFAULT_FILTERS, NOW, []).map((r) => r.jobId).sort()).toEqual(['eng', 'pm']);
    // Applied and dismissed jobs are not counted as hidden.
    expect(countHiddenByTitle(rows, words)).toBe(2);
  });
});
