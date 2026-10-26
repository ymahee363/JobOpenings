import { describe, expect, it } from 'vitest';
import home from './fixtures/indeed-home.json';
import { parseIndeedCapture } from '../src/shared/parse-indeed';

const NOW = 1792500000000;

describe('parseIndeedCapture on the embedded homepage model', () => {
  const result = parseIndeedCapture(home, 'indeed-home', NOW);
  const byId = Object.fromEntries(result.jobs.map((j) => [j.jobId, j]));

  it('keeps valid open jobs, drops expired and duplicate ones, and counts malformed ones', () => {
    expect(result.jobs.map((j) => j.jobId)).toEqual([
      'indeed-a10763a21af31e90', 'indeed-b20763a21af31e91', 'indeed-c30763a21af31e92',
    ]);
    expect(result.rejected).toBe(1);
    expect(result.firstError).toContain('jobkey');
  });

  it('maps fields onto the board job', () => {
    expect(byId['indeed-a10763a21af31e90']).toMatchObject({
      site: 'indeed', title: 'Senior Product Manager', company: 'Skyleaf Consultants', location: 'Mumbai, Maharashtra',
      salary: '₹20,00,000 - ₹30,00,000 a year', salaryMinLpa: 20, salaryMaxLpa: 30, expMin: null, expMax: null,
      postedAt: 1792368000000, postedApprox: false, sourceFeeds: ['indeed-home'], applyType: 'easy_apply',
      naukriUrl: 'https://in.indeed.com/viewjob?jk=a10763a21af31e90', externalUrl: null,
      titleCompanyKey: 'senior product manager|skyleaf consultants',
    });
  });

  it('classifies apply type from indeedApplyable and keeps only https apply links', () => {
    const b = byId['indeed-b20763a21af31e91']!;
    expect(b.applyType).toBe('company_site');
    expect(b.externalUrl).toBe('https://in.indeed.com/applystart?jk=b20763a21af31e91');
    const c = byId['indeed-c30763a21af31e92']!;
    expect(c.applyType).toBe('unknown');
    expect(c.externalUrl).toBeNull();
  });

  it('converts monthly salaries to LPA, ignores hourly ones, and falls back to createDate or the label', () => {
    const b = byId['indeed-b20763a21af31e91']!;
    expect([b.salaryMinLpa, b.salaryMaxLpa]).toEqual([18, 24]);
    expect(b.postedAt).toBe(1792300000000);
    const c = byId['indeed-c30763a21af31e92']!;
    expect([c.salaryMinLpa, c.salaryMaxLpa, c.salary]).toEqual([null, null, 'Not disclosed']);
    expect(c.postedAt).toBe(NOW - 30 * 86_400_000);
    expect(c.postedApprox).toBe(true);
  });

  it('reports jobs Indeed shows as applied', () => {
    expect(result.appliedJobIds).toEqual(['indeed-b20763a21af31e91']);
  });
});

describe('parseIndeedCapture on a GraphQL pagination response', () => {
  it('unpacks the job cards blob string', () => {
    const response = {
      data: {
        getJobCardsModel: {
          response: [{ groupName: 'jobsForYou', transitionalJobCardsModelBlob: JSON.stringify(home), paginationInfo: {} }],
        },
      },
    };
    const parsed = parseIndeedCapture(response, 'indeed-home', NOW);
    expect(parsed.jobs).toHaveLength(3);
  });

  it('ignores responses without job cards', () => {
    expect(parseIndeedCapture({ data: { viewer: { id: 'x' } } }, 'indeed-home', NOW).jobs).toEqual([]);
    expect(parseIndeedCapture(null, 'indeed-home', NOW).jobs).toEqual([]);
  });
});
