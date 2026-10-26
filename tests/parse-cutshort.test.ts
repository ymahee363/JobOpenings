import { describe, expect, it } from 'vitest';
import { cutshortSalaryLpa, parseCutshortCapture } from '../src/shared/parse-cutshort';

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

// Trimmed from a cutshort.io /findjobs/q response on 2026-10-26 (each real job carries ~56 fields).
const page = {
  page_size: 5,
  total_count: 56,
  page: 2,
  totalPages: 12,
  results: [
    {
      _id: '6a5f1fdb022d82f19debe51b',
      expRange: { min: 5, maxInternal: 8, max: 8, minVanity: 5, maxVanity: 8 },
      salaryRange: { currency: 'INR', min: 1500000, max: 6000000, minVanity: 3000000, maxVanity: 6000000 },
      locations: ['Bengaluru (Bangalore)'],
      roleTypes: ['full_time'],
      remoteType: 'remote_not_okay',
      remoteRole: false,
      isExpired: false,
      isHidden: false,
      isMarkedDeleted: false,
      creationDate: '2026-07-21T07:29:31.283Z',
      hiringIntentShownOn: '2026-07-21T08:56:31.894Z',
      lastUpdateDate: '2026-10-26T02:40:10.470Z',
      short_id: 'ejpSDbkK',
      headline: 'Associate Product Manager',
      company: 'Impact Analytics',
      companyAlias: 'impact-analytics-4wuhlpjs',
      publicUrl: 'https://cutshort.io/job/Associate-Product-Manager-Bengaluru-Bangalore-Impact-Analytics-ejpSDbkK',
      allSkills: ['Agile/Scrum', 'PRD', 'BRD', 'SQL', 'Stakeholder management', 'Go to market'],
      companyDetails: { _id: '5b868b41f8e5a30e36c049ef', name: 'Impact Analytics' },
      salaryRangeText: '₹30L - ₹60L / yr',
    },
    {
      _id: '6a8f00aa022d82f19debe777',
      expRange: { min: 2, max: 20, minVanity: 2, maxVanity: 20 },
      locations: [],
      remoteType: 'remote_only',
      hiringIntentShownOn: '2026-09-25T16:26:13.772Z',
      short_id: 'xYz12345',
      headline: 'Product manager',
      companyDetails: { name: 'UNIABROAD' },
      salaryRangeText: 'Best in industry',
    },
    { _id: '6a8f00aa022d82f19debe778', headline: 'Expired PM', isExpired: true },
    { _id: 'not-an-id', headline: 'Broken' },
  ],
};

describe('parseCutshortCapture', () => {
  it('reads a job-list page', () => {
    const r = parseCutshortCapture(page, 'cutshort-search', NOW);
    expect(r.rejected).toBe(1);
    expect(r.firstError).toMatch(/^_id:/);
    expect(r.jobs.map((j) => j.jobId)).toEqual(['cutshort-6a5f1fdb022d82f19debe51b', 'cutshort-6a8f00aa022d82f19debe777']);
    expect(r.jobs[0]).toEqual({
      jobId: 'cutshort-6a5f1fdb022d82f19debe51b',
      site: 'cutshort',
      title: 'Associate Product Manager',
      company: 'Impact Analytics',
      location: 'Bengaluru (Bangalore)',
      experience: '5-8 yrs',
      expMin: 5,
      expMax: 8,
      salary: '₹30L - ₹60L / yr',
      salaryMinLpa: 30,
      salaryMaxLpa: 60,
      skills: ['Agile/Scrum', 'PRD', 'BRD', 'SQL', 'Stakeholder management', 'Go to market'],
      postedAt: Date.parse('2026-07-21T08:56:31.894Z'),
      postedLabel: '',
      postedApprox: false,
      sourceFeeds: ['cutshort-search'],
      applyType: 'easy_apply',
      naukriUrl: 'https://cutshort.io/job/Associate-Product-Manager-Bengaluru-Bangalore-Impact-Analytics-ejpSDbkK',
      externalUrl: null,
      titleCompanyKey: 'associate product manager|impact analytics',
    });
  });

  it('handles remote-only jobs, hidden pay and a missing public link', () => {
    const job = parseCutshortCapture(page, 'cutshort-search', NOW).jobs[1]!;
    expect([job.company, job.location, job.salary, job.salaryMinLpa]).toEqual(['UNIABROAD', 'Remote only', 'Not disclosed', null]);
    expect(job.naukriUrl).toBe('https://cutshort.io/job/xYz12345');
  });

  it('ignores responses that are not job lists', () => {
    expect(parseCutshortCapture({ companies: [] }, 'cutshort-search', NOW)).toEqual({ jobs: [], rejected: 0, firstError: null });
  });
});

describe('cutshortSalaryLpa', () => {
  it('reads the range shown on the card', () => {
    expect(cutshortSalaryLpa('₹25L - ₹42L / yr')).toEqual([25, 42]);
    expect(cutshortSalaryLpa('Best in industry')).toEqual([null, null]);
  });
});
