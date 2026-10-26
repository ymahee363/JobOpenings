import { describe, expect, it } from 'vitest';
import { formatAge, parseRelativeLabel, resolvePostedAt } from '../src/shared/dates';
import {
  canAppLoad, clampRefreshMinutes, DEFAULT_SAFETY, dwellMs, DWELL_JITTER_MS, DWELL_MIN_MS, halt, inActiveHours,
  nextDailyAt, nextRefreshAt, pageGapMs, pause, recordAppLoad, refreshJitterMs, resume,
} from '../src/shared/safety';
import {
  CAPTURE_URL_RE, CUTSHORT_CAPTURE_URL_RE, FOUNDIT_CAPTURE_URL_RE, IIMJOBS_CAPTURE_URL_RE, INSTAHYRE_CAPTURE_URL_RE, SEARCH_API_RE, WELLFOUND_CAPTURE_URL_RE,
} from '../src/shared/constants';
import {
  instahyreJobUrl, jobIdFromJobPath, naukriJobUrl, RECOMMENDED_JOBS_URL, safeExternalUrl, safeJobPageUrl, wellfoundJobUrl,
} from '../src/shared/url';

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
    // Indeed's labels.
    ['Just posted', NOW, false],
    ['30+ days ago', NOW - 30 * DAY, true],
    ['Posted 9 days ago', NOW - 9 * DAY, false],
    ['Active 2 days ago', NOW - 2 * DAY, false],
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
});

describe('Instahyre job links', () => {
  it('uses the public link when it is on instahyre.com, else /job-<id>/', () => {
    const pub = 'https://www.instahyre.com/job-443833-product-manager-at-sahi-bangalore/';
    expect(instahyreJobUrl(443833, pub)).toBe(pub);
    expect(instahyreJobUrl(443833, 'https://instahyre.com.evil.example/x')).toBe('https://www.instahyre.com/job-443833/');
    expect(instahyreJobUrl(443833, null)).toBe('https://www.instahyre.com/job-443833/');
    expect(safeJobPageUrl(pub)).toBe(pub);
  });
});

describe('Wellfound job links', () => {
  it('builds /jobs/<id>-<slug> and drops odd slugs', () => {
    expect(wellfoundJobUrl('4875034', 'product-manager')).toBe('https://wellfound.com/jobs/4875034-product-manager');
    expect(wellfoundJobUrl('4875034', '../x')).toBe('https://wellfound.com/jobs/4875034');
    expect(safeJobPageUrl('https://wellfound.com/jobs/4875034-product-manager')).toBe('https://wellfound.com/jobs/4875034-product-manager');
    expect(safeJobPageUrl('https://www.linkedin.com/jobs/view/4482930457/')).toBe('https://www.linkedin.com/jobs/view/4482930457/');
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

  it('captures Instahyre job-search results but not its recommended feed', () => {
    expect(INSTAHYRE_CAPTURE_URL_RE.test('/api/v1/job_search?company_size=0&jobLocations=Bangalore&skills=x&status=0')).toBe(true);
    expect(INSTAHYRE_CAPTURE_URL_RE.test('https://www.instahyre.com/api/v1/job_search?limit=35&offset=35')).toBe(true);
    expect(INSTAHYRE_CAPTURE_URL_RE.test('/api/v1/job_search/443833')).toBe(false);
    expect(INSTAHYRE_CAPTURE_URL_RE.test('/api/v1/candidate_opportunities/candidate_matching?limit=30')).toBe(false);
  });

  it("captures iimjobs' search results from its API host only", () => {
    expect(IIMJOBS_CAPTURE_URL_RE.test('https://gladiator.iimjobs.com/job/search?query=Product+Manager&page=0')).toBe(true);
    expect(IIMJOBS_CAPTURE_URL_RE.test('https://gladiator.iimjobs.com/job/saved-jobs/count/')).toBe(false);
    expect(IIMJOBS_CAPTURE_URL_RE.test('https://evil.example/job/search?q=1')).toBe(false);
  });

  it("captures foundit's search results only", () => {
    expect(FOUNDIT_CAPTURE_URL_RE.test('https://www.foundit.in/home/api/searchResultsPage?start=0&limit=20')).toBe(true);
    expect(FOUNDIT_CAPTURE_URL_RE.test('/home/api/searchResultsPage?start=20')).toBe(true);
    expect(FOUNDIT_CAPTURE_URL_RE.test('/home/api/recentSearch')).toBe(false);
  });

  it("captures Cutshort's job lists only", () => {
    expect(CUTSHORT_CAPTURE_URL_RE.test('/findjobs/q?page=2&matchesfor=621ce92d9b95180034a9b0e4')).toBe(true);
    expect(CUTSHORT_CAPTURE_URL_RE.test('https://cutshort.io/findjobs/q')).toBe(true);
    expect(CUTSHORT_CAPTURE_URL_RE.test('/findcompanies')).toBe(false);
    expect(CUTSHORT_CAPTURE_URL_RE.test('https://evil.example/findjobs/q')).toBe(false);
  });

  it("captures Wellfound's own GraphQL endpoint only", () => {
    expect(WELLFOUND_CAPTURE_URL_RE.test('https://wellfound.com/graphql')).toBe(true);
    expect(WELLFOUND_CAPTURE_URL_RE.test('/graphql')).toBe(true);
    expect(WELLFOUND_CAPTURE_URL_RE.test('/graphql?operationName=JobSearchResultsX')).toBe(true);
    expect(WELLFOUND_CAPTURE_URL_RE.test('https://evil.example/graphql')).toBe(false);
    expect(WELLFOUND_CAPTURE_URL_RE.test('/graphql-docs')).toBe(false);
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

  it('stops all refreshes after a captcha until resumed, with no automatic restart', () => {
    const s = halt(recordAppLoad(DEFAULT_SAFETY, NOW - DAY), NOW, 'Indeed showed a captcha');
    expect(canAppLoad(s, NOW + 365 * DAY)).toMatchObject({
      ok: false, reason: 'halted', detail: expect.stringContaining('Indeed showed a captcha'),
    });
    expect(canAppLoad(resume(s), NOW)).toEqual({ ok: true });
  });

  it('clamps the schedule to the 15-minute floor', () => {
    expect(clampRefreshMinutes(5)).toBe(15);
    expect(clampRefreshMinutes(30)).toBe(30);
    expect(clampRefreshMinutes(99999)).toBe(1440);
    expect(clampRefreshMinutes(Number.NaN)).toBe(30);
  });
});

describe('randomised timing', () => {
  const MIN = 60_000;
  // Noon local time, so these stay inside waking hours in any time zone.
  const NOON = new Date(2026, 9, 21, 12, 0).getTime();
  const lowest = () => 0;
  const highest = () => 0.999999;

  it('adds 30 s to half the interval (max 15 min) to each automatic refresh', () => {
    expect(refreshJitterMs(30, lowest)).toBe(30_000);
    expect(refreshJitterMs(30, highest)).toBeLessThan(15 * MIN);
    expect(refreshJitterMs(30, highest)).toBeGreaterThan(14.9 * MIN);
    expect(refreshJitterMs(15, highest)).toBeLessThan(7.5 * MIN);
    expect(refreshJitterMs(240, highest)).toBeLessThan(15 * MIN);
  });

  it('gives a different delay each time with a real random source', () => {
    const seen = new Set(Array.from({ length: 50 }, () => nextRefreshAt(NOON, 30, DEFAULT_SAFETY, Math.random)));
    expect(seen.size).toBeGreaterThan(45);
    for (const at of seen) {
      expect(at).toBeGreaterThanOrEqual(NOON + 30 * MIN + 30_000);
      expect(at).toBeLessThan(NOON + 45 * MIN);
    }
  });

  it('never schedules before a pause ends, before the 15-minute floor, or while halted', () => {
    const paused = pause(DEFAULT_SAFETY, NOON, 'Logged out of Naukri');
    expect(nextRefreshAt(NOON, 15, paused, lowest)).toBe(NOON + 60 * MIN + 30_000);
    const justLoaded = recordAppLoad(DEFAULT_SAFETY, NOON + 10 * MIN);
    expect(nextRefreshAt(NOON, 15, justLoaded, lowest)).toBe(NOON + 25 * MIN);
    expect(nextRefreshAt(NOON, 30, halt(DEFAULT_SAFETY, NOON, 'captcha'), lowest)).toBeNull();
  });

  it('keeps automatic Naukri refreshes inside 9:00-22:00, moving night times to 9:00-9:30 next morning', () => {
    const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
    // 21:50 + 30 min lands at night: next morning instead.
    const late = nextRefreshAt(at(21, 21, 50), 30, DEFAULT_SAFETY, lowest)!;
    expect(late).toBe(at(22, 9));
    const lateHigh = nextRefreshAt(at(21, 21, 50), 30, DEFAULT_SAFETY, highest)!;
    expect(lateHigh).toBeGreaterThan(at(22, 9));
    expect(lateHigh).toBeLessThan(at(22, 9, 30));
    // Early morning: same day's window.
    expect(nextRefreshAt(at(21, 3), 30, DEFAULT_SAFETY, lowest)).toBe(at(21, 9));
    // Inside the window: untouched.
    expect(nextRefreshAt(at(21, 12), 30, DEFAULT_SAFETY, lowest)).toBe(at(21, 12, 30) + 30_000);
    for (let i = 0; i < 200; i++) {
      const t = nextRefreshAt(at(21, 0) + Math.floor(Math.random() * 86_400_000), 30, DEFAULT_SAFETY, Math.random)!;
      expect(inActiveHours(t)).toBe(true);
    }
  });

  it('keeps each opened page for 2 minutes plus up to 90 random seconds', () => {
    expect(dwellMs(lowest)).toBe(DWELL_MIN_MS);
    expect(DWELL_MIN_MS).toBe(2 * MIN);
    expect(dwellMs(highest)).toBeLessThan(DWELL_MIN_MS + DWELL_JITTER_MS);
    const samples = new Set(Array.from({ length: 30 }, () => dwellMs(Math.random)));
    expect(samples.size).toBeGreaterThan(25);
  });

  it('waits 5 to 20 seconds between pages', () => {
    expect(pageGapMs(lowest)).toBe(5_000);
    expect(pageGapMs(highest)).toBeLessThan(20_000);
  });
});

describe('per-site refresh rules', () => {
  const MIN = 60_000;

  it('keeps separate floors: 15 minutes for Naukri, 1 hour for Indeed', () => {
    const s = recordAppLoad(recordAppLoad(DEFAULT_SAFETY, NOW, 'naukri'), NOW, 'indeed');
    expect(canAppLoad(s, NOW + 16 * MIN, 'naukri')).toEqual({ ok: true });
    expect(canAppLoad(s, NOW + 16 * MIN, 'indeed')).toMatchObject({ ok: false, reason: 'too_soon', retryAt: NOW + 60 * MIN });
    expect(canAppLoad(s, NOW + 60 * MIN, 'indeed')).toEqual({ ok: true });
  });

  it('does not let a Naukri refresh block Indeed, or the other way round', () => {
    expect(canAppLoad(recordAppLoad(DEFAULT_SAFETY, NOW, 'naukri'), NOW + MIN, 'indeed')).toEqual({ ok: true });
    expect(canAppLoad(recordAppLoad(DEFAULT_SAFETY, NOW, 'indeed'), NOW + MIN, 'naukri')).toEqual({ ok: true });
  });

  it('gives iimjobs its own hourly floor', () => {
    const s = recordAppLoad(DEFAULT_SAFETY, NOW, 'iimjobs');
    expect(s.lastIimjobsLoadAt).toBe(NOW);
    expect(canAppLoad(s, NOW + MIN, 'iimjobs')).toMatchObject({ ok: false, detail: 'iimjobs: at most one app refresh an hour' });
  });

  it('gives foundit its own hourly floor', () => {
    const s = recordAppLoad(DEFAULT_SAFETY, NOW, 'foundit');
    expect(s.lastFounditLoadAt).toBe(NOW);
    expect(canAppLoad(s, NOW + MIN, 'cutshort')).toEqual({ ok: true });
    expect(canAppLoad(s, NOW + MIN, 'foundit')).toMatchObject({ ok: false, detail: 'foundit: at most one app refresh an hour' });
  });

  it('gives Cutshort its own hourly floor', () => {
    const s = recordAppLoad(DEFAULT_SAFETY, NOW, 'cutshort');
    expect(s.lastCutshortLoadAt).toBe(NOW);
    expect(canAppLoad(s, NOW + MIN, 'wellfound')).toEqual({ ok: true });
    expect(canAppLoad(s, NOW + MIN, 'cutshort')).toMatchObject({ ok: false, detail: 'Cutshort: at most one app refresh an hour' });
  });

  it('gives Wellfound its own hourly floor', () => {
    const s = recordAppLoad(DEFAULT_SAFETY, NOW, 'wellfound');
    expect(s.lastWellfoundLoadAt).toBe(NOW);
    expect(canAppLoad(s, NOW + MIN, 'instahyre')).toEqual({ ok: true });
    expect(canAppLoad(s, NOW + MIN, 'wellfound')).toMatchObject({
      ok: false, reason: 'too_soon', detail: 'Wellfound: at most one app refresh an hour',
    });
    expect(canAppLoad(s, NOW + 60 * MIN, 'wellfound')).toEqual({ ok: true });
  });

  it('gives Instahyre its own hourly floor', () => {
    const s = recordAppLoad(DEFAULT_SAFETY, NOW, 'instahyre');
    expect(canAppLoad(s, NOW + MIN, 'indeed')).toEqual({ ok: true });
    expect(canAppLoad(s, NOW + MIN, 'naukri')).toEqual({ ok: true });
    expect(canAppLoad(s, NOW + 59 * MIN, 'instahyre')).toMatchObject({
      ok: false, reason: 'too_soon', retryAt: NOW + 60 * MIN, detail: 'Instahyre: at most one app refresh an hour',
    });
    expect(canAppLoad(s, NOW + 60 * MIN, 'instahyre')).toEqual({ ok: true });
  });

  it('applies a Naukri logout pause to Naukri only, and a captcha halt to both', () => {
    const paused = pause(DEFAULT_SAFETY, NOW, 'Logged out of Naukri');
    expect(canAppLoad(paused, NOW + MIN, 'naukri')).toMatchObject({ ok: false, reason: 'paused' });
    expect(canAppLoad(paused, NOW + MIN, 'indeed')).toEqual({ ok: true });
    const halted = halt(DEFAULT_SAFETY, NOW, 'Naukri showed a captcha');
    expect(canAppLoad(halted, NOW + 365 * 86_400_000, 'indeed')).toMatchObject({ ok: false, reason: 'halted' });
    expect(canAppLoad(halted, NOW + 365 * 86_400_000, 'instahyre')).toMatchObject({ ok: false, reason: 'halted' });
  });
});

describe("Indeed's once-a-day refresh", () => {
  // Local times, so the 9:00-22:00 window is checked in the machine's own time zone.
  const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
  const lowest = () => 0;
  const highest = () => 0.999999;

  it('picks a time later today when it has not run today', () => {
    expect(nextDailyAt(at(23, 7), DEFAULT_SAFETY, lowest)).toBe(at(23, 9));
    expect(nextDailyAt(at(23, 14), DEFAULT_SAFETY, lowest)).toBe(at(23, 14, 5));
    expect(nextDailyAt(at(23, 14), DEFAULT_SAFETY, highest)).toBeLessThan(at(23, 22));
  });

  it("moves to tomorrow once it ran today, or when today's window has closed", () => {
    const ranToday = { ...DEFAULT_SAFETY, lastIndeedDailyAt: at(23, 10) };
    const t = nextDailyAt(at(23, 11), ranToday, lowest)!;
    expect(t).toBe(at(24, 9));
    expect(nextDailyAt(at(23, 21, 58), DEFAULT_SAFETY, lowest)).toBe(at(24, 9));
    expect(nextDailyAt(at(23, 23), DEFAULT_SAFETY, highest)).toBeLessThan(at(24, 22));
  });

  it("treats yesterday's run as not today", () => {
    const ranYesterday = { ...DEFAULT_SAFETY, lastIndeedDailyAt: at(22, 20) };
    expect(nextDailyAt(at(23, 10), ranYesterday, lowest)).toBe(at(23, 10, 5));
  });

  it('lands somewhere different in the window each day', () => {
    const times = new Set(Array.from({ length: 30 }, () => nextDailyAt(at(23, 23), DEFAULT_SAFETY, Math.random)));
    expect(times.size).toBeGreaterThan(25);
    for (const t of times) expect(inActiveHours(t!)).toBe(true);
  });

  it('schedules nothing while halted', () => {
    expect(nextDailyAt(at(23, 10), halt(DEFAULT_SAFETY, NOW, 'captcha'), lowest)).toBeNull();
  });

  it('knows the window edges', () => {
    expect(inActiveHours(at(23, 8, 59))).toBe(false);
    expect(inActiveHours(at(23, 9))).toBe(true);
    expect(inActiveHours(at(23, 21, 59))).toBe(true);
    expect(inActiveHours(at(23, 22))).toBe(false);
  });
});
