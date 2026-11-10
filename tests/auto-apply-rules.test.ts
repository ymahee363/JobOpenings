import { describe, expect, it } from 'vitest';
import { allAnswered, findAnswer, patternMatches, planDialog } from '../src/shared/auto-apply/answers';
import { applyEverywhere, AUTO_SITES, clampDailyCap, clampGapSeconds, clampHours, DEFAULT_AGENT_CONFIG, normalizeAgentConfig, type AgentConfig, type Attempt } from '../src/shared/auto-apply/config';
import type { DialogSnapshot } from '../src/shared/auto-apply/job-page';
import { blockedByHistory, buildQueue, signInHostOf, explainEmptyQueue, interleaveBySite, matchRules } from '../src/shared/auto-apply/match';
import { agentHeadline, attemptsToday, cappedSites, gapMs, hoursLabel, inAgentHours, nextAgentRunAt, planNextRun, staleAttempts, summarize } from '../src/shared/auto-apply/pacing';
import type { Job, JobStatus } from '../src/shared/types';

const NOW = new Date(2026, 9, 27, 11, 0, 0).getTime();
const HOUR = 3_600_000;

let n = 0;
function job(over: Partial<Job> = {}): Job {
  n += 1;
  const title = over.title ?? 'Product Manager';
  const company = over.company ?? `Company ${n}`;
  return {
    jobId: `iimjobs-${n}`, site: 'iimjobs', title, company, location: 'Bangalore', experience: '5-10 yrs', expMin: 5, expMax: 10,
    salary: 'Not disclosed', salaryMinLpa: null, salaryMaxLpa: null, skills: [], postedAt: NOW - HOUR, postedLabel: '', postedApprox: false,
    firstSeenAt: NOW - HOUR, lastSeenAt: NOW, sourceFeeds: ['iimjobs-search'], applyType: 'easy_apply',
    naukriUrl: `https://www.iimjobs.com/j/x-${n}`, externalUrl: null, titleCompanyKey: `${title}|${company}`.toLowerCase(), ...over,
  };
}

const config = (over: Partial<AgentConfig['rules']> = {}, rest: Partial<AgentConfig> = {}): AgentConfig => ({
  ...DEFAULT_AGENT_CONFIG,
  rules: { ...DEFAULT_AGENT_CONFIG.rules, myYears: 8, locations: ['bangalore'], ...over },
  ...rest,
});

function attempt(jobId: string, over: Partial<Attempt> = {}): Attempt {
  return {
    jobId, title: 'Product Manager', company: 'X', startedAt: NOW - 2 * HOUR, finishedAt: NOW - 2 * HOUR, mode: 'live',
    matched: [], answers: [], questions: [], clicked: false, outcome: 'applied', reason: '', ...over,
  };
}

describe('buildQueue (PRD AR-1/AR-2 acceptance)', () => {
  it('queues exactly the jobs that match every rule', () => {
    const matching = [job(), job(), job(), job()];
    const external = [job({ applyType: 'company_site' }), job({ applyType: 'company_site' })];
    const blocked = [job({ company: 'Acme Corp' }), job({ company: 'acme labs' })];
    const done = [job(), job()];
    const statuses: JobStatus[] = done.map((j) => ({ jobId: j.jobId, status: 'applied', statusAt: NOW }));
    const q = buildQueue([...matching, ...external, ...blocked, ...done], statuses, [], config({ companyBlocklist: ['acme'] }), [], NOW);
    expect(q.map((i) => i.job.jobId).sort()).toEqual(matching.map((j) => j.jobId).sort());
  });

  it('orders newest posted first and keeps reasons', () => {
    const older = job({ postedAt: NOW - 5 * HOUR });
    const newer = job({ postedAt: NOW - HOUR });
    const q = buildQueue([older, newer], [], [], config(), [], NOW);
    expect(q.map((i) => i.job.jobId)).toEqual([newer.jobId, older.jobId]);
    expect(q[0]!.reasons).toEqual(['title: product manager', 'experience 5-10 yrs: needs 5, you have 8', 'location: bangalore']);
  });

  it('skips other sites, dismissed, old and reposted jobs', () => {
    const applied = job({ title: 'Product Manager', company: 'Same' });
    const repost = job({ title: 'Product Manager', company: 'Same' });
    const jobs = [job({ site: 'naukri' }), job({ postedAt: NOW - 8 * 24 * HOUR }), applied, repost, job()];
    const statuses: JobStatus[] = [{ jobId: applied.jobId, status: 'applied', statusAt: NOW }, { jobId: jobs[4]!.jobId, status: 'dismissed', statusAt: NOW }];
    expect(buildQueue(jobs, statuses, [], config(), [], NOW)).toEqual([]);
  });

  it('caps applies per company over 7 days (AR-16)', () => {
    const jobs = [job({ company: 'Paytm' }), job({ company: 'Paytm' })];
    const past = [attempt('old-1', { company: 'Paytm' })];
    expect(buildQueue(jobs, [], past, config(), [], NOW)).toHaveLength(1);
    expect(buildQueue(jobs, [], [...past, attempt('old-2', { company: 'paytm ' })], config(), [], NOW)).toHaveLength(0);
    expect(buildQueue([job({ company: 'Confidential' }), job({ company: 'Confidential' }), job({ company: 'Confidential' })], [], [], config(), [], NOW)).toHaveLength(3);
  });
});

describe('matchRules', () => {
  const base = config().rules;
  it('needs your experience set', () => {
    expect(matchRules(job(), { ...base, myYears: null }, [])).toEqual({ ok: false, reason: 'set your years of experience in the agent rules' });
  });
  it('checks title phrases, excluded and hidden words', () => {
    expect(matchRules(job({ title: 'Software Engineer' }), base, []).ok).toBe(false);
    expect(matchRules(job({ title: 'Product Manager - Sales' }), base, []).ok).toBe(false);
    expect(matchRules(job({ title: 'Product Manager, Payments' }), base, ['Payments']).ok).toBe(false);
  });
  it('checks experience, location, remote and salary', () => {
    expect(matchRules(job({ expMin: 10, expMax: 15, experience: '10-15 yrs' }), base, []).ok).toBe(false);
    expect(matchRules(job({ expMin: null, expMax: null, experience: '' }), base, []).ok).toBe(false);
    expect(matchRules(job({ location: 'Mumbai' }), base, []).ok).toBe(false);
    expect(matchRules(job({ location: 'Mumbai, Work from home' }), base, [])).toMatchObject({ ok: true });
    expect(matchRules(job({ location: 'Mumbai, Work from home' }), { ...base, allowRemote: false }, []).ok).toBe(false);
    expect(matchRules(job({ location: 'Mumbai' }), { ...base, locations: [] }, []).ok).toBe(true);
    expect(matchRules(job({ salary: '20-25 LPA', salaryMinLpa: 20, salaryMaxLpa: 25 }), { ...base, salaryFloorLpa: 30 }, []).ok).toBe(false);
    expect(matchRules(job(), { ...base, salaryFloorLpa: 30 }, []).ok).toBe(true);
  });
});

describe('blockedByHistory', () => {
  it('keeps a job that stopped at a company sign-in out of the queue until you mark that site signed in', () => {
    const host = 'sabre.wd1.myworkdayjobs.com';
    const at = NOW - 3_600_000;
    const stopped = attempt('j1', { outcome: 'needs_me', startedAt: at, finishedAt: at,
      reason: `${host} wants you to sign in or create an account first; do that once in this browser, then run Apply with AI again` });
    expect(blockedByHistory([stopped], config(), NOW)).toBe('needs a sign-in on the company site');
    expect(blockedByHistory([stopped], config({}, { signedIn: { [host]: at - 1 } }), NOW)).toBe('needs a sign-in on the company site');
    expect(blockedByHistory([stopped], config({}, { signedIn: { [host]: at + 1 } }), NOW)).toBeNull();
    expect(blockedByHistory([stopped], config({}, { signedIn: { 'other.example.com': NOW } }), NOW)).toBe('needs a sign-in on the company site');
    expect(signInHostOf(stopped.reason)).toBe(host);
    expect(signInHostOf('the site wants you to log in or create an account first')).toBe('');
    expect(signInHostOf('required questions with no answer: Notice period')).toBeNull();
  });

  it('retries a click whose report was lost (the pre-fix "no report from the job page" bug), but no other unconfirmed click', () => {
    const c = config({}, { dryRun: false });
    const old = NOW - 2 * 3_600_000;
    const lost = (reason: string) => attempt('131026026730', { outcome: 'failed', clicked: true, reason, startedAt: old, finishedAt: old });
    expect(blockedByHistory([lost('no report from the job page; after reload the page shows error')], c, NOW)).toBeNull();
    expect(blockedByHistory([lost('no report from the job page'), lost('no report from the job page')], c, NOW)).toBeNull();
    expect(blockedByHistory([lost('no "Applied" after pressing Apply')], c, NOW)).toBe('pressed Apply, not confirmed');
  });

  it('"apply everywhere" turns on every platform, AI apply and its Submit, live, and keeps your rules', () => {
    const before = config({}, { activeStartHour: 1, activeEndHour: 2 });
    const after = applyEverywhere(before);
    expect(after).toMatchObject({ autoApply: true, dryRun: false, aiApply: true, aiSubmit: true, fillForms: true, activeStartHour: 9, activeEndHour: 24 });
    expect(after.sites).toEqual(AUTO_SITES);
    expect(after.sites).toContain('linkedin');
    expect(after.rules).toEqual(before.rules);
    expect(applyEverywhere(config({}, { activeStartHour: 8, activeEndHour: 23 }))).toMatchObject({ activeStartHour: 8, activeEndHour: 23 });
  });

  const c = config();
  it('never repeats an applied, skipped or pending job', () => {
    expect(blockedByHistory([attempt('a')], c, NOW)).toBe('applied');
    expect(blockedByHistory([attempt('a', { outcome: 'already_applied' })], c, NOW)).toBe('applied');
    expect(blockedByHistory([attempt('a', { outcome: 'skipped', reason: 'closed' })], c, NOW)).toBe('closed');
    expect(blockedByHistory([attempt('a', { outcome: 'pending' })], c, NOW)).toBe('in progress');
  });
  it('retries a failure once, after an hour (AR-14)', () => {
    expect(blockedByHistory([attempt('a', { outcome: 'failed', finishedAt: NOW - 10 * 60_000 })], c, NOW)).toBe('retry later');
    expect(blockedByHistory([attempt('a', { outcome: 'failed' })], c, NOW)).toBeNull();
    expect(blockedByHistory([attempt('a', { outcome: 'failed' }), attempt('a', { outcome: 'failed', startedAt: NOW - HOUR })], c, NOW)).toBe('failed twice');
  });
  it('brings back dry-run and answered "Needs me" jobs (AR-10, AR-13)', () => {
    const dry = [attempt('a', { outcome: 'would_apply', mode: 'dry_run' })];
    expect(blockedByHistory(dry, c, NOW)).toBe('dry run done');
    expect(blockedByHistory(dry, { ...c, dryRun: false }, NOW)).toBeNull();
    const needs = [attempt('a', { outcome: 'needs_me', questions: ['Notice period (days)'] })];
    const answered = { ...c, answers: [{ question: 'notice period', answer: '30' }] };
    expect(blockedByHistory(needs, c, NOW)).toBe('needs your details');
    // One-click only (default): a job that asked for details is never retried by the agent.
    expect(blockedByHistory(needs, answered, NOW)).toBe('needs your details');
    expect(blockedByHistory(needs, { ...answered, fillForms: true }, NOW)).toBeNull();
  });
});

describe('answer bank', () => {
  const bank = [
    { question: 'ctc', answer: '40' },
    { question: 'expected ctc / expected salary', answer: '55' },
    { question: 'notice period', answer: '30 days' },
    { question: 'relocate', answer: 'Yes' },
  ];
  it('matches words and alternatives, most specific first', () => {
    expect(patternMatches('expected ctc / expected salary', 'What is your Expected Salary?')).toBe(true);
    expect(patternMatches('notice period', 'Notice?')).toBe(false);
    expect(findAnswer('Expected CTC (LPA)*', bank)?.answer).toBe('55');
    expect(findAnswer('Current CTC (LPA)', bank)?.answer).toBe('40');
    expect(findAnswer('Why us?', bank)).toBeNull();
  });

  const dialog = (fields: DialogSnapshot['fields'], buttons = ['Cancel', 'Submit']): DialogSnapshot => ({ title: 'Questions', fields, buttons });

  it('fills a dialog it can fully answer (AR-6)', () => {
    const plan = planDialog(dialog([
      { label: 'Expected CTC', kind: 'number', required: true, options: [] },
      { label: 'Notice period', kind: 'select', required: true, options: ['Immediate', '15 days', '30 days', '60 days'] },
      { label: 'Willing to relocate?', kind: 'radio', required: false, options: ['Yes', 'No'] },
      { label: 'Anything else?', kind: 'textarea', required: false, options: [] },
    ]), bank);
    expect(plan).toEqual({
      ok: true, submit: 'Submit',
      fills: [{ index: 0, value: '55' }, { index: 1, value: '30 days' }, { index: 2, value: 'Yes' }],
      answers: [{ question: 'Expected CTC', answer: '55' }, { question: 'Notice period', answer: '30 days' }, { question: 'Willing to relocate?', answer: 'Yes' }],
    });
  });

  it('never submits what it cannot answer', () => {
    expect(planDialog(dialog([{ label: 'Why us?', kind: 'textarea', required: true, options: [] }]), bank))
      .toMatchObject({ ok: false, questions: ['Why us?'] });
    expect(planDialog(dialog([{ label: 'Notice period', kind: 'select', required: true, options: ['Immediate', '90 days'] }]), bank))
      .toMatchObject({ ok: false, questions: ['Notice period'] });
    expect(planDialog(dialog([{ label: 'Resume', kind: 'file', required: true, options: [] }]), bank)).toMatchObject({ ok: false });
    expect(planDialog(dialog([{ label: 'Expected CTC', kind: 'number', required: true, options: [] }], ['Submit', 'Apply']), bank).ok).toBe(false);
    expect(planDialog(dialog([]), bank)).toMatchObject({ ok: false, questions: ['Questions'] });
    expect(planDialog(dialog([{ label: 'Expected CTC', kind: 'number', required: true, options: [] }]), [{ question: 'expected ctc', answer: 'lots' }]).ok).toBe(false);
  });

  it('knows when every question has an answer', () => {
    expect(allAnswered(['Notice period'], bank)).toBe(true);
    expect(allAnswered(['Notice period', 'Why us?'], bank)).toBe(false);
    expect(allAnswered([], bank)).toBe(false);
  });
});

describe('pacing (AR-7 acceptance)', () => {
  it('counts today only', () => {
    const list = [attempt('a', { startedAt: NOW - HOUR }), attempt('b', { startedAt: NOW - 24 * HOUR })];
    expect(attemptsToday(list, NOW)).toBe(1);
  });
  it('spaces attempts 3 to 8 minutes apart', () => {
    expect(gapMs(() => 0)).toBe(3 * 60_000);
    expect(gapMs(() => 0.999)).toBeLessThan(8 * 60_000);
    expect(nextAgentRunAt(NOW, NOW, 0, 20, () => 0)).toBe(NOW + 3 * 60_000);
    expect(nextAgentRunAt(NOW, null, 0, 20, () => 0)).toBe(NOW + 60_000);
  });
  it('never runs at night, and stops for the day at the cap', () => {
    const late = new Date(2026, 9, 27, 21, 58).getTime();
    const run = new Date(nextAgentRunAt(late, late, 0, 20, () => 0));
    expect([run.getDate(), run.getHours()]).toEqual([28, 9]);
    const capped = new Date(nextAgentRunAt(NOW, NOW, 20, 20, () => 0));
    expect([capped.getDate(), capped.getHours()]).toEqual([28, 9]);
    const early = new Date(2026, 9, 27, 6, 0).getTime();
    expect(new Date(nextAgentRunAt(early, null, 0, 20, () => 0)).getHours()).toBe(9);
  });
  it('40 matching jobs give at most 20 attempts a day, none closer than 3 minutes', () => {
    let t = new Date(2026, 9, 27, 9, 0).getTime();
    const starts: number[] = [];
    let last: number | null = null;
    for (let i = 0; i < 40; i += 1) {
      const todayCount = starts.filter((s) => new Date(s).getDate() === new Date(t).getDate()).length;
      t = nextAgentRunAt(t, last, todayCount, 20, Math.random);
      starts.push(t);
      last = t;
    }
    const day1 = starts.filter((s) => new Date(s).getDate() === 27);
    expect(day1.length).toBe(20);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(3 * 60_000);
    for (const s of starts) expect(new Date(s).getHours()).toBeGreaterThanOrEqual(9);
    for (const s of starts) expect(new Date(s).getHours()).toBeLessThan(22);
  });
  it('finds cut-off attempts and summarises a day', () => {
    const list = [attempt('a', { outcome: 'pending', startedAt: NOW - 10 * 60_000 }), attempt('b', { outcome: 'pending', startedAt: NOW - 60_000 }),
      attempt('c', { outcome: 'needs_me' }), attempt('d', { outcome: 'already_applied' })];
    expect(staleAttempts(list, NOW).map((a) => a.jobId)).toEqual(['a']);
    expect(summarize(list, NOW - 3 * HOUR)).toEqual({ applied: 0, wouldApply: 0, needsMe: 1, failed: 0, skipped: 1 });
  });
});

describe('agentHeadline', () => {
  const t = (x: number) => `@${x}`;
  const state = { nextRunAt: null, haltedAt: null, haltReason: null };
  it('shows off, stopped and running states', () => {
    expect(agentHeadline({ autoApply: false, dryRun: true, dailyCap: 20 }, state, false, 0, t)).toEqual({ text: 'Auto-apply: Off', tone: 'off' });
    expect(agentHeadline({ autoApply: true, dryRun: true, dailyCap: 20 }, state, true, 0, t).text).toBe('Auto-apply: Stopped (captcha)');
    expect(agentHeadline({ autoApply: true, dryRun: false, dailyCap: 20 }, { ...state, haltedAt: 1, haltReason: 'Logged out' }, false, 0, t).text)
      .toBe('Auto-apply: Stopped (Logged out)');
    expect(agentHeadline({ autoApply: true, dryRun: true, dailyCap: 20 }, { ...state, nextRunAt: 5 }, false, 3, t))
      .toEqual({ text: 'Auto-apply: On (dry run) · 3 applied today · next @5', tone: 'ok' });
  });
});

describe('explainEmptyQueue', () => {
  it('says why nothing matches', () => {
    expect(explainEmptyQueue([], [], [], config(), [], NOW)).toContain('No iimjobs jobs on the board yet');
    expect(explainEmptyQueue([job()], [], [], config({ myYears: null }), [], NOW)).toContain('Set "My years of experience"');
    const text = explainEmptyQueue([job({ expMin: 10, expMax: 15 }), job({ expMin: 12, expMax: 16 }), job({ applyType: 'company_site' })], [], [], config(), [], NOW);
    expect(text.startsWith('No matching job among 3 iimjobs jobs. Most common reasons: needs more experience than yours (2), applies on a company site (1)')).toBe(true);
  });
});

describe('sites and working hours', () => {
  it('applies only on the ticked sites; Instahyre jobs pass without an experience range', () => {
    const insta = job({ site: 'instahyre', expMin: null, expMax: null, experience: '' });
    const iim = job();
    expect(buildQueue([insta, iim], [], [], config(), [], NOW).map((i) => i.job.jobId)).toEqual([iim.jobId]);
    const both = buildQueue([insta, iim], [], [], config({}, { sites: ['iimjobs', 'instahyre'] }), [], NOW);
    expect(both.map((i) => i.job.jobId).sort()).toEqual([iim.jobId, insta.jobId].sort());
    expect(both.find((i) => i.job.site === 'instahyre')!.reasons).toContain('experience not shown on Instahyre');
    expect(matchRules(job({ expMin: null, expMax: null, experience: '' }), config().rules, []).ok).toBe(false);
    expect(explainEmptyQueue([], [], [], config({}, { sites: [] }), [], NOW)).toContain('No site is ticked');
  });

  it('runs inside your hours, up to midnight', () => {
    const h = { activeStartHour: 7, activeEndHour: 24 };
    const late = new Date(2026, 9, 27, 23, 0).getTime();
    expect(nextAgentRunAt(late, late, 0, 20, () => 0, h)).toBe(late + 3 * 60_000);
    const pushed = new Date(nextAgentRunAt(new Date(2026, 9, 27, 23, 59, 30).getTime(), null, 0, 20, () => 0, h));
    expect([pushed.getDate(), pushed.getHours()]).toEqual([28, 7]);
    const capped = new Date(nextAgentRunAt(NOW, NOW, 20, 20, () => 0, h));
    expect([capped.getDate(), capped.getHours()]).toEqual([28, 7]);
    expect(inAgentHours(new Date(2026, 9, 27, 6, 59).getTime(), h)).toBe(false);
    expect(hoursLabel(h)).toBe('7:00 to midnight');
  });

  it('runs overnight when the stop hour is before the start hour', () => {
    const h = { activeStartHour: 21, activeEndHour: 2 };
    const t = (d: number, hr: number, m = 0) => new Date(2026, 9, d, hr, m).getTime();
    expect(inAgentHours(t(27, 23), h)).toBe(true);
    expect(inAgentHours(t(28, 1, 30), h)).toBe(true);
    expect(inAgentHours(t(28, 2), h)).toBe(false);
    expect(inAgentHours(t(28, 12), h)).toBe(false);
    expect(inAgentHours(t(28, 20, 59), h)).toBe(false);
    const late = t(28, 1);
    expect(nextAgentRunAt(late, late, 0, 20, () => 0, h)).toBe(late + 3 * 60_000);
    const pushed = new Date(nextAgentRunAt(t(28, 1, 58), t(28, 1, 58), 0, 20, () => 0, h));
    expect([pushed.getDate(), pushed.getHours()]).toEqual([28, 21]);
    expect(hoursLabel(h)).toBe('21:00 to 2:00 (next day)');
  });

  it('clamps hours to a valid window', () => {
    expect(clampHours(7, 24)).toEqual({ activeStartHour: 7, activeEndHour: 24 });
    expect(clampHours(22, 9)).toEqual({ activeStartHour: 22, activeEndHour: 9 });
    expect(clampHours(9, 9)).toEqual({ activeStartHour: 9, activeEndHour: 22 });
    expect(clampHours(24, 3)).toEqual({ activeStartHour: 9, activeEndHour: 22 });
    expect(clampHours(-1, 30)).toEqual({ activeStartHour: 9, activeEndHour: 22 });
    expect(normalizeAgentConfig({ sites: ['instahyre', 'nosuchsite' as never], activeStartHour: 8, activeEndHour: 23 })).toMatchObject({
      sites: ['instahyre'], activeStartHour: 8, activeEndHour: 23,
    });
  });
});

describe('Naukri in the queue', () => {
  it('queues Naukri Easy Apply jobs only when Naukri is ticked, never company-site ones', () => {
    const easy = job({ site: 'naukri', jobId: '211026003705' });
    const site = job({ site: 'naukri', applyType: 'company_site' });
    expect(buildQueue([easy, site], [], [], config(), [], NOW)).toEqual([]);
    expect(buildQueue([easy, site], [], [], config({}, { sites: ['naukri'] }), [], NOW).map((i) => i.job.jobId)).toEqual(['211026003705']);
    expect(normalizeAgentConfig({ sites: ['naukri'] }).sites).toEqual(['naukri']);
  });
});

describe('platforms take turns', () => {
  it('interleaves 2 Naukri, 1 Instahyre, 3 iimjobs as N, I, H, N, I, I', () => {
    const t = (site: Job['site'], h: number) => job({ site, postedAt: NOW - h * HOUR, jobId: site === 'naukri' ? `${100000 + h}` : `${site}-${h}` });
    const jobs = [t('naukri', 1), t('naukri', 5), t('instahyre', 3), t('iimjobs', 2), t('iimjobs', 4), t('iimjobs', 6)];
    const q = buildQueue(jobs, [], [], config({}, { sites: ['iimjobs', 'instahyre', 'naukri'] }), [], NOW);
    expect(q.map((i) => i.job.site)).toEqual(['naukri', 'iimjobs', 'instahyre', 'naukri', 'iimjobs', 'iimjobs']);
    expect(interleaveBySite([])).toEqual([]);
  });
});

describe('planNextRun', () => {
  const at = (jobId: string, startedAt: number) => attempt(jobId, { startedAt });
  const base = { now: NOW, cap: 20, rand: () => 0, gapSeconds: 300 };
  it('waits the full gap on the same platform', () => {
    expect(planNextRun({ ...base, today: [at('iimjobs-1', NOW)], nextSite: 'iimjobs', platforms: 1 })).toBe(NOW + 300_000);
  });
  it('waits gap / platforms when the next job is on another platform', () => {
    expect(planNextRun({ ...base, today: [at('iimjobs-1', NOW)], nextSite: 'naukri', platforms: 3 })).toBe(NOW + 100_000);
    // ...but still the full gap after that platform's own last application.
    expect(planNextRun({ ...base, today: [at('211026003705', NOW - 60_000), at('iimjobs-1', NOW)], nextSite: 'naukri', platforms: 3 }))
      .toBe(NOW + 240_000);
  });
  it('never closer than 10 s, adds up to 15% random, and starts soon when idle', () => {
    expect(planNextRun({ ...base, gapSeconds: 20, today: [at('iimjobs-1', NOW)], nextSite: 'naukri', platforms: 3 })).toBe(NOW + 10_000 + 5_000);
    expect(planNextRun({ ...base, rand: () => 0.999, today: [at('iimjobs-1', NOW)], nextSite: 'iimjobs', platforms: 1 })).toBeLessThan(NOW + 345_001);
    expect(planNextRun({ ...base, today: [], nextSite: 'iimjobs', platforms: 1 })).toBe(NOW + 15_000);
  });
  it('respects the cap and the working hours', () => {
    const capped = new Date(planNextRun({ ...base, cap: 1, today: [at('iimjobs-1', NOW)], nextSite: 'iimjobs', platforms: 1 }));
    expect([capped.getDate(), capped.getHours()]).toEqual([28, 9]);
    const late = new Date(2026, 9, 27, 21, 58).getTime();
    const run = new Date(planNextRun({ ...base, now: late, today: [at('iimjobs-1', late)], nextSite: 'iimjobs', platforms: 1 }));
    expect([run.getDate(), run.getHours()]).toEqual([28, 9]);
  });
  it('clamps the gap setting', () => {
    expect(clampGapSeconds(3)).toBe(10);
    expect(clampGapSeconds(99_999)).toBe(3_600);
    expect(normalizeAgentConfig({}).gapSeconds).toBe(300);
  });
});

describe('Wellfound and unconfirmed clicks', () => {
  it('queues Wellfound jobs when ticked; they pass without an experience range', () => {
    const wf = job({ site: 'wellfound', jobId: 'wellfound-4875034', expMin: null, expMax: null, experience: '' });
    expect(buildQueue([wf], [], [], config(), [], NOW)).toEqual([]);
    const q = buildQueue([wf], [], [], config({}, { sites: ['wellfound'] }), [], NOW);
    expect(q[0]?.reasons).toContain('experience not shown on Wellfound');
  });
  it('never presses Apply again after a click it could not confirm', () => {
    const pressed = [attempt('a', { outcome: 'failed', clicked: true, finishedAt: NOW - 5 * HOUR })];
    expect(blockedByHistory(pressed, config(), NOW)).toBe('pressed Apply, not confirmed');
  });
});

describe('Instahyre retries', () => {
  it('puts outside-match jobs back in the queue, and retries an unconfirmed Instahyre click once after an hour', () => {
    const outside = [attempt('instahyre-1', { outcome: 'needs_me', questions: ['Confirm applying to a job outside your Instahyre matches'] })];
    expect(blockedByHistory(outside, config(), NOW)).toBeNull();
    const unconfirmed = [attempt('instahyre-2', { outcome: 'failed', clicked: true, finishedAt: NOW - 2 * HOUR })];
    expect(blockedByHistory(unconfirmed, config(), NOW)).toBeNull();
    expect(blockedByHistory([...unconfirmed, attempt('instahyre-2', { outcome: 'failed', clicked: true, startedAt: NOW - HOUR })], config(), NOW)).toBe('failed twice');
    expect(blockedByHistory([attempt('iimjobs-2', { outcome: 'failed', clicked: true })], config(), NOW)).toBe('pressed Apply, not confirmed');
  });
});

describe('daily page limit per platform', () => {
  it('a platform at its limit sits out; the others carry on', () => {
    const iim = job();
    const nk = job({ site: 'naukri', jobId: '211026003705' });
    const c = config({}, { sites: ['iimjobs', 'naukri'], dailyCap: 2 });
    const today = [attempt('iimjobs-a', { startedAt: NOW - HOUR }), attempt('iimjobs-b', { startedAt: NOW - 2 * HOUR })];
    expect(buildQueue([iim, nk], [], today, c, [], NOW).map((i) => i.job.site)).toEqual(['naukri']);
    expect(explainEmptyQueue([iim], [], today, { ...c, sites: ['iimjobs'] }, [], NOW)).toContain('daily page limit reached on iimjobs');
    // Yesterday's pages do not count.
    const yesterday = today.map((a) => ({ ...a, startedAt: a.startedAt - 24 * HOUR }));
    expect(buildQueue([iim], [], yesterday, c, [], NOW)).toHaveLength(1);
  });

  it('allows up to 100 pages a day per platform', () => {
    expect(clampDailyCap(100)).toBe(100);
    expect(clampDailyCap(150)).toBe(100);
    expect(cappedSites(['iimjobs', 'naukri'], 1, [attempt('iimjobs-a', { startedAt: NOW - HOUR })], NOW)).toEqual(['iimjobs']);
  });
});

describe('experience: up to your years', () => {
  const r = config({ myYears: 7 }).rules;
  const exp = (expMin: number | null, expMax: number | null) => job({ expMin, expMax, experience: `${expMin ?? ''}-${expMax ?? ''} yrs` });
  it('applies to jobs needing your years or fewer, whatever the top of the range', () => {
    expect(matchRules(exp(1, 3), r, []).ok).toBe(true);
    expect(matchRules(exp(5, 8), r, []).ok).toBe(true);
    expect(matchRules(exp(7, 12), r, []).ok).toBe(true);
    expect(matchRules(exp(0, 2), r, []).ok).toBe(true);
    expect(matchRules(exp(null, 4), r, []).ok).toBe(true);
  });
  it('skips jobs needing more', () => {
    expect(matchRules(exp(8, 12), r, [])).toEqual({ ok: false, reason: 'experience 8-12 yrs needs 8+, you have 7' });
    expect(matchRules(exp(10, 15), r, []).ok).toBe(false);
  });
});

import { blockedByHistory as blocked2 } from '../src/shared/auto-apply/match';
describe('retry after a fix (zero human intervention, 2026-11-10)', () => {
  const att = (over: Record<string, unknown>) => ({ id: 1, jobId: 'linkedin-1', company: 'X', title: 'PM', startedAt: 1000, finishedAt: 1100, mode: 'live', matched: [], answers: [], questions: ['q'], clicked: false, outcome: 'needs_me', reason: 'LinkedIn: stuck', ...over }) as never;
  const cfg = { fillForms: true, aiApply: true, answers: {}, dryRun: false, signedIn: {} } as never;
  it('retries a stopped or failed job once a newer build exists', () => {
    expect(blocked2([att({})], cfg, 5000, 2000)).toBeNull();
    expect(blocked2([att({ outcome: 'failed' })], cfg, 5000, 2000)).toBeNull();
  });
  it('not twice, not after an unconfirmed Apply, not for a sign-in', () => {
    expect(blocked2([att({}), att({ startedAt: 3000, outcome: 'failed', clicked: true, reason: 'x' })], cfg, 5000, 2000)).not.toBeNull();
    expect(blocked2([att({ outcome: 'failed', clicked: true })], cfg, 5000, 2000)).not.toBeNull();
    expect(blocked2([att({ reason: 'example.com wants you to sign in or create an account' })], cfg, 5000, 2000)).not.toBeNull();
  });
});
