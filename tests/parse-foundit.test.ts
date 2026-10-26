import { describe, expect, it } from 'vitest';
import { parseFounditCapture } from '../src/shared/parse-foundit';

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

// Trimmed from a www.foundit.in /home/api/searchResultsPage response on 2026-10-26.
const page = {
  data: [
    {
      id: '69558323',
      jobId: 69558323,
      redirectUrl: 'https://www.linkedin.com/jobs/view/4483353292/',
      title: 'Product Manager | Supplier Management Specialist',
      company: { companyId: 506801, name: 'Avnet' },
      locations: [{ city: 'Bengaluru / Bangalore', country: 'India', state: 'Karnataka' }],
      minimumExperience: { years: 5 },
      maximumExperience: { years: 7 },
      minimumSalary: { currency: 'INR', absoluteValue: 0 },
      maximumSalary: { currency: 'INR', absoluteValue: 0 },
      postedAt: 1792949100000,
      createdAt: 1792949100000,
      companyName: 'Avnet',
      applyUrl: 'https://www.linkedin.com/jobs/view/4483353292/',
      hideSalary: 0,
      hideCompanyName: 0,
      jobSource: 'SCRAPPING',
      activeJob: true,
      quickApplyJob: 0,
      jdUrl: '/job/product-manager-supplier-management-specialist-avnet-bengaluru-bangalore-69558323',
      isApplied: false,
    },
    {
      jobId: 69549098,
      title: 'Senior Product Manager',
      companyName: 'BlueOptima',
      locations: [{ city: 'Bengaluru / Bangalore' }, { city: 'Bengaluru / Bangalore' }],
      minimumExperience: { years: 6 },
      maximumExperience: { years: 9 },
      minimumSalary: { absoluteValue: 2500000 },
      maximumSalary: { absoluteValue: 4000000 },
      skills: [{ text: 'Product Management', synonyms: [] }, { text: 'SaaS', synonyms: [] }],
      postedAt: 1792900000000,
      applyUrl: null,
      jdUrl: '/job/senior-product-manager-blueoptima-bengaluru-bangalore-69549098',
      isApplied: true,
      activeJob: true,
    },
    { jobId: 1, title: 'Closed', activeJob: false },
    { jobId: 'x', title: 'Broken' },
  ],
  meta: { paging: { cursors: { next: '20', previous: '0' }, total: 81, limit: 20 } },
};

describe('parseFounditCapture', () => {
  it('reads a search page and sends off-site apply links to Company Site', () => {
    const r = parseFounditCapture(page, 'foundit-search', NOW);
    expect(r.rejected).toBe(1);
    expect(r.jobs.map((j) => j.jobId)).toEqual(['foundit-69558323', 'foundit-69549098']);
    expect(r.jobs[0]).toEqual({
      jobId: 'foundit-69558323',
      site: 'foundit',
      title: 'Product Manager | Supplier Management Specialist',
      company: 'Avnet',
      location: 'Bengaluru / Bangalore',
      experience: '5-7 Yrs',
      expMin: 5,
      expMax: 7,
      salary: 'Not disclosed',
      salaryMinLpa: null,
      salaryMaxLpa: null,
      skills: [],
      postedAt: 1792949100000,
      postedLabel: '',
      postedApprox: false,
      sourceFeeds: ['foundit-search'],
      applyType: 'company_site',
      externalUrl: 'https://www.linkedin.com/jobs/view/4483353292/',
      naukriUrl: 'https://www.foundit.in/job/product-manager-supplier-management-specialist-avnet-bengaluru-bangalore-69558323',
      titleCompanyKey: 'product manager | supplier management specialist|avnet',
    });
  });

  it('reads salary, skills and on-site apply, and marks applied jobs', () => {
    const r = parseFounditCapture(page, 'foundit-search', NOW);
    const job = r.jobs[1]!;
    expect([job.salaryMinLpa, job.salaryMaxLpa, job.salary]).toEqual([25, 40, '25-40 Lacs PA']);
    expect(job.skills).toEqual(['Product Management', 'SaaS']);
    expect(job.location).toBe('Bengaluru / Bangalore');
    expect([job.applyType, job.externalUrl]).toEqual(['easy_apply', null]);
    expect(r.appliedJobIds).toEqual(['foundit-69549098']);
  });

  it('ignores responses without a job list', () => {
    expect(parseFounditCapture({ meta: {} }, 'foundit-search', NOW).jobs).toEqual([]);
  });
});
