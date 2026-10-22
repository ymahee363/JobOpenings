import { describe, expect, it } from 'vitest';
import { formatAge, parseRelativeLabel, resolvePostedAt } from '../src/shared/dates';
import { canAppLoad, clampRefreshMinutes, DEFAULT_SAFETY, pause, recordAppLoad, resume } from '../src/shared/safety';
import { CAPTURE_URL_RE, SEARCH_API_RE } from '../src/shared/constants';
import { jobIdFromJobPath, naukriJobUrl, RECOMMENDED_JOBS_URL, safeExternalUrl, searchPageUrl } from '../src/shared/url';

const NOW = 1792500000000;
const DAY = 86_400_000;

describe('dates', () => {
  it.each([
    ['Just now', NOW, false],
    ['Few Hours Ago', NOW, false],
    ['Today', NOW, false],
    ['Yesterday', NOW - DAY, false],
    ['1 Day Ago', NOW - DAY, false],
    ['3 Days Ago', NOW - 3 * DAY, false],
    ['30+ Days Ago', NOW - 30 * DAY, true],
    ['2 Weeks Ago', NOW - 14 * DAY, false],
    ['5 hours ago', NOW - 5 * 3_600_000, false],
    ['', NOW, true],
    ['sometime', NOW, true],
  ])('parses "%s"', (label, postedAt, approx) => {
    expect(parseRelativeLabel(label, NOW)).toEqual({ postedAt, approx });
  });

  it('prefers a plausible createdDate and rejects bad ones', () => {
    expect(resolvePostedAt(NOW - 1000, '3 Days Ago', NOW)).toEqual({ postedAt: NOW - 1000, approx: false });
    expect(resolvePostedAt(0, '3 Days Ago', NOW).postedAt).toBe(NOW - 3 * DAY);
    expect(resolvePostedAt(NOW + 10 * DAY, '1 Day Ago', NOW).postedAt).toBe(NOW - DAY);
    expect(resolvePostedAt('123', '1 Day Ago', NOW).postedAt).toBe(NOW - DAY);
  });

  it('formats ages', () => {
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(formatAge(NOW - 2 * DAY, NOW)).toBe('2d ago');
  });
});

describe('url safety', () => {
  it('only allows https external links', () => {
    expect(safeExternalUrl('https://jobs.example.com/a?b=1')).toBe('https://jobs.example.com/a?b=1');
    expect(safeExternalUrl('http://jobs.example.com')).toBeNull();
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    // Relative links resolve against Naukri (its own redirect pages).
    expect(safeExternalUrl('/applyRedirect?id=1')).toBe('https://www.naukri.com/applyRedirect?id=1');
  });

  it('keeps Naukri job links on naukri.com', () => {
    expect(naukriJobUrl('/job-listings-x-1234567')).toBe('https://www.naukri.com/job-listings-x-1234567');
    expect(naukriJobUrl('https://evil.example/job')).toBe(RECOMMENDED_JOBS_URL);
    expect(naukriJobUrl('https://naukri.com.evil.example/job')).toBe(RECOMMENDED_JOBS_URL);
    expect(naukriJobUrl(undefined)).toBe(RECOMMENDED_JOBS_URL);
  });

  it('reads job IDs from job page paths', () => {
    expect(jobIdFromJobPath('/job-listings-pm-acme-bengaluru-2-to-6-years-100826018354')).toBe('100826018354');
    expect(jobIdFromJobPath('/mnjuser/homepage')).toBeNull();
  });

  it('builds saved-search page URLs, newest first', () => {
    const query = 'k=%22product%20manager%22&nignbevent_src=jobsearchDeskGNB&jobAge=30&functionAreaIdGid=10&experience=6&cityTypeGid=97&sort=f';
    expect(searchPageUrl(1)).toBe(`https://www.naukri.com/product-manager-jobs?${query}`);
    expect(searchPageUrl(3)).toBe(`https://www.naukri.com/product-manager-jobs-3?${query}`);
  });
});

describe('capture URLs', () => {
  it('captures recom-jobs feeds and search results only', () => {
    expect(CAPTURE_URL_RE.test('/jobapi/v2/search/recom-jobs')).toBe(true);
    expect(CAPTURE_URL_RE.test('https://www.naukri.com/jobapi/v3/search?noOfResults=20&pageNo=1')).toBe(true);
    expect(CAPTURE_URL_RE.test('/jobapi/v3/search/suggestor')).toBe(false);
    expect(CAPTURE_URL_RE.test('/jobapi/v4/job/123')).toBe(false);
  });

  it('tags search results separately', () => {
    expect(SEARCH_API_RE.test('/jobapi/v3/search?pageNo=2')).toBe(true);
    expect(SEARCH_API_RE.test('/jobapi/v2/search/recom-jobs')).toBe(false);
  });
});

describe('account safety', () => {
  it('allows one app load per 15 minutes', () => {
    expect(canAppLoad(DEFAULT_SAFETY, NOW)).toEqual({ ok: true });
    const s = recordAppLoad(DEFAULT_SAFETY, NOW);
    const blocked = canAppLoad(s, NOW + 60_000);
    expect(blocked).toMatchObject({ ok: false, reason: 'too_soon', retryAt: NOW + 15 * 60_000 });
    expect(canAppLoad(s, NOW + 15 * 60_000)).toEqual({ ok: true });
  });

  it('pauses for an hour and can resume', () => {
    const s = pause(DEFAULT_SAFETY, NOW, 'captcha');
    expect(canAppLoad(s, NOW + 59 * 60_000)).toMatchObject({ ok: false, reason: 'paused', detail: 'captcha' });
    expect(canAppLoad(s, NOW + 60 * 60_000)).toEqual({ ok: true });
    expect(canAppLoad(resume(s), NOW)).toEqual({ ok: true });
  });

  it('clamps the schedule to the 15-minute floor', () => {
    expect(clampRefreshMinutes(5)).toBe(15);
    expect(clampRefreshMinutes(30)).toBe(30);
    expect(clampRefreshMinutes(99999)).toBe(1440);
    expect(clampRefreshMinutes(Number.NaN)).toBe(30);
  });
});
