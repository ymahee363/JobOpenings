import { describe, expect, it } from 'vitest';
import search from './fixtures/instahyre-search.json';
import { parseInstahyreCapture } from '../src/shared/parse-instahyre';

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

describe('parseInstahyreCapture', () => {
  it('reads the jobs in a job-search response', () => {
    const { jobs, rejected, firstError } = parseInstahyreCapture(search, 'instahyre-search', NOW);
    expect(rejected).toBe(0);
    expect(firstError).toBeNull();
    expect(jobs.map((j) => j.jobId)).toEqual(['instahyre-443833', 'instahyre-440884', 'instahyre-439962']);
    expect(jobs[0]).toEqual({
      jobId: 'instahyre-443833',
      site: 'instahyre',
      title: 'Product Manager',
      company: 'Sahi',
      location: 'Bangalore',
      experience: '',
      expMin: null,
      expMax: null,
      salary: 'Not disclosed',
      salaryMinLpa: null,
      salaryMaxLpa: null,
      skills: ['fintech', 'product', 'sql', 'wealthtech'],
      // No posted date in the response: dated by when it was first seen.
      postedAt: NOW,
      postedLabel: '',
      postedApprox: true,
      sourceFeeds: ['instahyre-search'],
      applyType: 'easy_apply',
      naukriUrl: 'https://www.instahyre.com/job-443833-product-manager-at-sahi-bangalore/',
      externalUrl: null,
      titleCompanyKey: 'product manager|sahi',
    });
    expect(jobs[1]!.location).toBe('Bangalore, Chennai');
  });

  it('skips inactive jobs and counts malformed ones', () => {
    const payload = {
      objects: [
        { id: 1, title: 'PM', employer: { company_name: 'A' }, is_active: false },
        { id: 'x', title: 'PM', employer: {} },
        { id: 2, title: 'PM', employer: { company_name: 'B' } },
        { id: 2, title: 'PM', employer: { company_name: 'B' } },
      ],
    };
    const r = parseInstahyreCapture(payload, 'instahyre-search', NOW);
    expect(r.jobs.map((j) => j.jobId)).toEqual(['instahyre-2']);
    expect(r.jobs[0]!.naukriUrl).toBe('https://www.instahyre.com/job-2/');
    expect(r.rejected).toBe(1);
    expect(r.firstError).toMatch(/^id:/);
  });

  it('ignores responses that are not job lists', () => {
    expect(parseInstahyreCapture({ meta: {} }, 'instahyre-search', NOW)).toEqual({ jobs: [], rejected: 0, firstError: null });
    expect(parseInstahyreCapture(null, 'instahyre-search', NOW).jobs).toEqual([]);
  });
});
