import { describe, expect, it } from 'vitest';
import search from './fixtures/wellfound-search.json';
import { parseWellfoundCapture, wellfoundSalaryLpa } from '../src/shared/parse-wellfound';

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

describe('parseWellfoundCapture', () => {
  it('reads jobs from regular and promoted companies', () => {
    const r = parseWellfoundCapture(search, 'wellfound-search', NOW);
    expect(r.rejected).toBe(0);
    expect(r.jobs.map((j) => [j.jobId, j.company])).toEqual([
      ['wellfound-4735114', 'SciSpace'],
      ['wellfound-4875034', 'Kulfi'],
      ['wellfound-4881320', 'Trackier'],
    ]);
    expect(r.jobs[0]).toEqual({
      jobId: 'wellfound-4735114',
      site: 'wellfound',
      title: 'AI Product Manager (With Software Engineering Experience)',
      company: 'SciSpace',
      location: 'Bengaluru',
      experience: '',
      expMin: null,
      expMax: null,
      salary: '₹20L – ₹35L • 0.05% – 0.1%',
      salaryMinLpa: 20,
      salaryMaxLpa: 35,
      skills: [],
      postedAt: 1791718583_000,
      postedLabel: '',
      postedApprox: false,
      sourceFeeds: ['wellfound-search'],
      applyType: 'easy_apply',
      naukriUrl: 'https://wellfound.com/jobs/4735114-senior-ai-product-manager-with-software-engineering-experience-clone',
      externalUrl: null,
      titleCompanyKey: 'ai product manager (with software engineering experience)|scispace',
    });
  });

  it('marks remote jobs, undisclosed pay and jobs already applied to', () => {
    const r = parseWellfoundCapture(search, 'wellfound-search', NOW);
    const [, kulfi, trackier] = r.jobs;
    expect(kulfi!.salary).toBe('Not disclosed');
    expect(kulfi!.salaryMinLpa).toBeNull();
    expect(trackier!.location).toBe('Noida, Remote');
    expect(r.appliedJobIds).toEqual(['wellfound-4875034']);
  });

  it('counts malformed listings and ignores other responses', () => {
    const bad = { data: { x: { name: 'Acme', highlightedJobListings: [{ id: 'abc', title: 'PM' }, { id: '7', title: 'PM' }] } } };
    const r = parseWellfoundCapture(bad, 'wellfound-search', NOW);
    expect(r.jobs.map((j) => j.jobId)).toEqual(['wellfound-7']);
    expect(r.jobs[0]!.naukriUrl).toBe('https://wellfound.com/jobs/7');
    expect(r.jobs[0]!.postedApprox).toBe(true);
    expect(r.rejected).toBe(1);
    expect(parseWellfoundCapture({ data: { currentUser: { id: '1' } } }, 'wellfound-search', NOW).jobs).toEqual([]);
  });
});

describe('wellfoundSalaryLpa', () => {
  it('reads rupee lakh ranges only', () => {
    expect(wellfoundSalaryLpa('₹5L – ₹7.5L • 0.0% – 0.5%')).toEqual([5, 7.5]);
    expect(wellfoundSalaryLpa('₹12L')).toEqual([12, 12]);
    expect(wellfoundSalaryLpa('$100k – $150k • 0.1%')).toEqual([null, null]);
    expect(wellfoundSalaryLpa('')).toEqual([null, null]);
  });
});
