import { describe, expect, it } from 'vitest';
import { ignoredCapture } from '../src/shared/page';
import { parseIimjobsCapture } from '../src/shared/parse-iimjobs';

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

// Trimmed from a gladiator.iimjobs.com /job/search response on 2026-10-26.
const page = {
  data: [
    {
      id: 1741367,
      title: 'Tracxn - Product Manager',
      min: 5,
      max: 8,
      jobdesignation: 'Product Manager',
      status: 1,
      jobDetailUrl: 'https://www.iimjobs.com/j/tracxn-product-manager-1741367',
      workFromHome: 0,
      confidential: 0,
      createdTimeMs: 1792731514995,
      createdTime: 1792693800000,
      tags: [{ id: 80, name: 'IT Product Management', isMandatory: true }, { id: 1185032, name: 'IT Product Strategy' }],
      locations: [{ id: 3, name: 'Bangalore' }],
      applyUrl: '',
      minSal: 0,
      maxSal: 0,
      hideSal: 1,
      otherLocation: '',
      companyData: { companyId: 0, companyName: 'Tracxn Technologies Ltd' },
      applied: 0,
    },
    {
      id: 1740001,
      title: 'Meesho - Senior Product Manager',
      min: 6,
      max: 10,
      status: 1,
      createdTime: 1792500000000,
      locations: [{ id: 3, name: 'Bangalore' }],
      workFromHome: 1,
      applyUrl: 'https://jobs.lever.co/meesho/2028b73c-2ae0-4fca-903e-481b8c5',
      minSal: 40,
      maxSal: 60,
      hideSal: 0,
      companyData: { companyName: 'Meesho' },
      applied: 1,
    },
    { id: 5, title: 'Closed', status: 0 },
    { id: 'x', title: 'Broken' },
  ],
  page: '0',
  limit: 50,
  totalJobs: 3905,
  hasMore: true,
};

describe('parseIimjobsCapture', () => {
  it('reads a search page', () => {
    const r = parseIimjobsCapture(page, 'iimjobs-search', NOW);
    expect(r.rejected).toBe(1);
    expect(r.jobs.map((j) => j.jobId)).toEqual(['iimjobs-1741367', 'iimjobs-1740001']);
    expect(r.jobs[0]).toEqual({
      jobId: 'iimjobs-1741367',
      site: 'iimjobs',
      title: 'Tracxn - Product Manager',
      company: 'Tracxn Technologies Ltd',
      location: 'Bangalore',
      experience: '5-8 yrs',
      expMin: 5,
      expMax: 8,
      salary: 'Not disclosed',
      salaryMinLpa: null,
      salaryMaxLpa: null,
      skills: ['IT Product Management', 'IT Product Strategy'],
      postedAt: 1792731514995,
      postedLabel: '',
      postedApprox: false,
      sourceFeeds: ['iimjobs-search'],
      applyType: 'easy_apply',
      externalUrl: null,
      naukriUrl: 'https://www.iimjobs.com/j/tracxn-product-manager-1741367',
      titleCompanyKey: 'tracxn - product manager|tracxn technologies ltd',
    });
  });

  it('sends off-site apply links to Company Site and reads shown salary, remote and applied', () => {
    const r = parseIimjobsCapture(page, 'iimjobs-search', NOW);
    const job = r.jobs[1]!;
    expect([job.applyType, job.externalUrl]).toEqual(['company_site', 'https://jobs.lever.co/meesho/2028b73c-2ae0-4fca-903e-481b8c5']);
    expect([job.salaryMinLpa, job.salaryMaxLpa, job.salary]).toEqual([40, 60, '40-60 LPA']);
    expect(job.location).toBe('Bangalore, Work from home');
    expect(job.naukriUrl).toBe('https://www.iimjobs.com/j/1740001');
    expect(r.appliedJobIds).toEqual(['iimjobs-1740001']);
  });
});

describe('iimjobs experience filter', () => {
  it('ignores searches that carry an experience range, keeping the unfiltered one', () => {
    const base = 'https://gladiator.iimjobs.com/job/search?query=Product+Manager&page=0&searchType=1';
    expect(ignoredCapture('iimjobs', `${base}&minexp=7&maxexp=10`)).toBe(true);
    expect(ignoredCapture('iimjobs', `${base}&minexp=0&maxexp=0`)).toBe(false);
    expect(ignoredCapture('iimjobs', base)).toBe(false);
    expect(ignoredCapture('naukri', 'https://www.naukri.com/jobapi/v3/search?minexp=7')).toBe(false);
  });
});
