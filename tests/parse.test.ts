import { describe, expect, it } from 'vitest';
import feed from './fixtures/feed-profile.json';
import { findJobArrays, parseCapture } from '../src/shared/parse';
import { RECOMMENDED_JOBS_URL } from '../src/shared/url';

const NOW = 1792500000000;

describe('parseCapture on a cached feed', () => {
  const result = parseCapture(feed, 'profile', NOW);
  const byId = Object.fromEntries(result.jobs.map((j) => [j.jobId, j]));

  it('keeps valid jobs, drops duplicates and counts malformed ones', () => {
    expect(result.jobs.map((j) => j.jobId)).toEqual(['100000000001', '100000000002', '100000000003', '100000000005']);
    expect(result.rejected).toBe(1);
    expect(result.firstError).toContain('title');
  });

  it('classifies apply type from companyApplyJob', () => {
    expect(byId['100000000001']!.applyType).toBe('easy_apply');
    expect(byId['100000000002']!.applyType).toBe('company_site');
    expect(byId['100000000005']!.applyType).toBe('unknown');
  });

  it('prefers applyRedirectUrl and only keeps https links', () => {
    expect(byId['100000000002']!.externalUrl).toBe('https://globex.wd5.myworkdayjobs.example/job/123');
    expect(byId['100000000003']!.externalUrl).toBeNull();
    // Still a company-site job; the board falls back to the Naukri page.
    expect(byId['100000000003']!.applyType).toBe('company_site');
  });

  it('builds Naukri URLs only on naukri.com', () => {
    expect(byId['100000000001']!.naukriUrl).toBe(
      'https://www.naukri.com/job-listings-senior-product-manager-acme-fintech-bengaluru-5-to-9-years-100000000001');
    expect(byId['100000000003']!.naukriUrl).toBe(RECOMMENDED_JOBS_URL);
  });

  it('uses createdDate when present, else the label', () => {
    expect(byId['100000000001']!.postedAt).toBe(1792414876000);
    expect(byId['100000000001']!.postedApprox).toBe(false);
    expect(byId['100000000003']!.postedAt).toBe(NOW - 30 * 86_400_000);
    expect(byId['100000000003']!.postedApprox).toBe(true);
  });

  it('parses placeholders, salary, experience and skills', () => {
    const j = byId['100000000001']!;
    expect(j).toMatchObject({
      location: 'Bengaluru', experience: '5-9 Yrs', salary: '25-35 Lacs PA',
      salaryMinLpa: 25, salaryMaxLpa: 35, expMin: 5, expMax: 9,
      skills: ['Product management', 'Roadmap', 'SQL', 'Agile'], sourceFeeds: ['profile'],
      titleCompanyKey: 'senior product manager|acme fintech',
    });
    expect(byId['100000000002']!.salaryMinLpa).toBeNull();
    expect(byId['100000000005']!.salary).toBe('Not disclosed');
  });
});

describe('findJobArrays on a network response', () => {
  it('finds nested job arrays and names them by their key', () => {
    const response = { meta: { ok: true }, clusters: { similar_jobs: { jobDetails: [{ jobId: '1', title: 'A' }] } } };
    expect(findJobArrays(response)).toEqual([{ key: 'jobDetails', items: [{ jobId: '1', title: 'A' }] }]);
    const parsed = parseCapture(response, null, NOW);
    expect(parsed.jobs[0]!.sourceFeeds).toEqual(['jobDetails']);
  });

  it('ignores payloads without jobs', () => {
    expect(parseCapture({ a: [1, 2, 3] }, null, NOW)).toEqual({ jobs: [], rejected: 0, firstError: null });
    expect(parseCapture(null, null, NOW).jobs).toEqual([]);
  });
});
