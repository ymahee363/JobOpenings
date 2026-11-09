import { describe, expect, it } from 'vitest';
import { totalExperienceMonths } from '../src/content/ats/keka';
import { DEDICATED_ATS, detectAts } from '../src/shared/ats/detect';

describe('Keka applier', () => {
  it('is a dedicated applier for keka.com career pages', () => {
    expect(detectAts('https://smartcoin.keka.com/careers/applyjob/146578')).toBe('keka');
    expect(DEDICATED_ATS).toContain('keka');
  });

  it('totals experience with overlapping jobs counted once', () => {
    const now = new Date(2026, 10, 6); // Nov 2026
    const jobs = [
      { title: 'PM', company: 'A', from: { year: '2020', month: '1' }, to: {}, current: true },
      { title: 'APM', company: 'B', from: { year: '2018', month: '1' }, to: { year: '2020', month: '6' }, current: false },
    ];
    // Jan 2018 → Nov 2026 = 8 years 10 months.
    expect(totalExperienceMonths(jobs, now)).toBe(8 * 12 + 10);
  });
});
