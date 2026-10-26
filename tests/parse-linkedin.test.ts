import { describe, expect, it } from 'vitest';
import { parseLinkedInCapture } from '../src/shared/parse-linkedin';

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);
const HOUR = 3_600_000;

// Card text as read from www.linkedin.com/jobs/search-results on 2026-10-26.
const cards = [
  {
    jobId: '4482930457',
    lines: ['Director of Product (Verified job)', 'Director of Product', 'Cyware', 'Bengaluru (On-site)',
      '2 connections work here', 'Posted 4 hours ago', '4 hours ago', '·', 'Be an early applicant', '·', 'Easy Apply'],
  },
  {
    jobId: '4482941372',
    lines: ['Product Manager (Verified job)', 'Product Manager', 'Edstruments', 'Bengaluru (Hybrid)', 'Applied', '·',
      'Be an early applicant', '·', 'Easy Apply'],
  },
  {
    jobId: '4481407827',
    lines: ['Product Management Specialist - Fintech', 'Product Management Specialist - Fintech', 'FastFlowPe™',
      'Bengaluru (On-site)', 'Actively reviewing applicants', 'Posted 6 hours ago', '6 hours ago'],
  },
];

describe('parseLinkedInCapture', () => {
  it('reads title, company, location, posted time and apply type from card text', () => {
    const r = parseLinkedInCapture({ cards }, 'linkedin-search', NOW);
    expect(r.rejected).toBe(0);
    expect(r.jobs[0]).toEqual({
      jobId: 'linkedin-4482930457',
      site: 'linkedin',
      title: 'Director of Product',
      company: 'Cyware',
      location: 'Bengaluru (On-site)',
      experience: '',
      expMin: null,
      expMax: null,
      salary: 'Not disclosed',
      salaryMinLpa: null,
      salaryMaxLpa: null,
      skills: [],
      postedAt: NOW - 4 * HOUR,
      postedLabel: '4 hours ago',
      postedApprox: false,
      sourceFeeds: ['linkedin-search'],
      applyType: 'easy_apply',
      naukriUrl: 'https://www.linkedin.com/jobs/view/4482930457/',
      externalUrl: null,
      titleCompanyKey: 'director of product|cyware',
    });
  });

  it('dates cards without a time by first seen, and marks applied ones', () => {
    const r = parseLinkedInCapture({ cards }, 'linkedin-search', NOW);
    const applied = r.jobs[1]!;
    expect(applied.title).toBe('Product Manager');
    expect(applied.postedAt).toBe(NOW);
    expect(applied.postedApprox).toBe(true);
    expect(r.appliedJobIds).toEqual(['linkedin-4482941372']);
  });

  it('reads the card that is open in the side pane', () => {
    const open = {
      jobId: '4482947163',
      lines: ['Selected, Group Product Manager (Verified job)', 'Group Product Manager', 'Licious', 'Bengaluru (On-site)',
        '5 connections work here', 'Viewed', '·', 'Be an early applicant', '·', 'Easy Apply'],
    };
    const [job] = parseLinkedInCapture({ cards: [open] }, 'linkedin-search', NOW).jobs;
    expect([job!.title, job!.company, job!.location]).toEqual(['Group Product Manager', 'Licious', 'Bengaluru (On-site)']);
  });

  it('marks cards without Easy Apply as unknown', () => {
    expect(parseLinkedInCapture({ cards }, 'linkedin-search', NOW).jobs[2]!.applyType).toBe('unknown');
  });

  it('handles a title shown once and rejects malformed cards', () => {
    const r = parseLinkedInCapture({
      cards: [
        { jobId: '123456', lines: ['PM', 'Acme', 'Pune', '1 day ago'] },
        { jobId: 'abc', lines: ['PM', 'Acme', 'Pune'] },
        { jobId: '999999', lines: ['·', '·', '·'] },
      ],
    }, 'linkedin-jobs', NOW);
    expect(r.jobs.map((j) => [j.title, j.company, j.location, j.postedLabel])).toEqual([['PM', 'Acme', 'Pune', '1 day ago']]);
    expect(r.rejected).toBe(2);
    expect(parseLinkedInCapture({ nope: 1 }, 'linkedin-jobs', NOW).jobs).toEqual([]);
  });
});
