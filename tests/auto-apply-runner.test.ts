import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_STATE, type AgentConfig, type AgentState, type Attempt } from '../src/shared/auto-apply/config';
import { decide, NOT_FOUND_HALT, runOnce, type ApplyReport, type RunDeps } from '../src/shared/auto-apply/runner';
import { CollectorMessage } from '../src/shared/messages';
import { DEFAULT_SAFETY, type SafetyState } from '../src/shared/safety';
import { blockedByHistory, buildQueue } from '../src/shared/auto-apply/match';
import { planNextRun } from '../src/shared/auto-apply/pacing';
import type { Job, JobStatus } from '../src/shared/types';

const NOW = new Date(2026, 9, 27, 11, 0, 0).getTime();

const job: Job = {
  jobId: 'iimjobs-1742187', site: 'iimjobs', title: 'Paytm - Product Manager', company: 'Paytm', location: 'Noida', experience: '4-8 yrs',
  expMin: 4, expMax: 8, salary: 'Not disclosed', salaryMinLpa: null, salaryMaxLpa: null, skills: [], postedAt: NOW - 3_600_000,
  postedLabel: '', postedApprox: false, firstSeenAt: NOW, lastSeenAt: NOW, sourceFeeds: ['iimjobs-search'], applyType: 'easy_apply',
  naukriUrl: 'https://www.iimjobs.com/j/paytm-product-manager-1742187', externalUrl: null, titleCompanyKey: 'x',
};

const rep = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

interface World {
  config: AgentConfig;
  safety: SafetyState;
  state: AgentState;
  attempts: Attempt[];
  tabs: string[];
  marked: Array<[string, string]>;
  halts: string[];
  logs: string[];
  report: ApplyReport | (() => never);
  now: number;
  queue: Job[];
}

function world(over: Partial<World> = {}): { w: World; deps: RunDeps } {
  const w: World = {
    config: { ...DEFAULT_AGENT_CONFIG, autoApply: true, dryRun: false }, safety: DEFAULT_SAFETY, state: DEFAULT_AGENT_STATE,
    attempts: [], tabs: [], marked: [], halts: [], logs: [], report: rep('applied', { clicked: true }), now: NOW, queue: [job], ...over,
  };
  const seeded = w.attempts.length;
  const deps: RunDeps = {
    now: () => w.now,
    rand: () => 0.5,
    loadConfig: async () => w.config,
    loadSafety: async () => w.safety,
    loadState: async () => w.state,
    saveState: async (s) => { w.state = s; },
    listAttempts: async () => w.attempts,
    queue: async () => w.queue.map((j) => ({ job: j, reasons: ['title: product manager'] })),
    addAttempt: async (a) => {
      // The attempt must be on record before any page opens.
      expect(w.tabs).toHaveLength(w.attempts.length - seeded);
      w.attempts.push({ ...a, id: w.attempts.length + 1 });
      return w.attempts.length;
    },
    finishAttempt: async (id, patch) => { Object.assign(w.attempts[id - 1]!, patch); },
    markApplied: async (jobId, by) => { w.marked.push([jobId, by]); },
    dismiss: async (jobId) => { w.marked.push([jobId, 'dismissed']); },
    runInTab: async (url) => {
      w.tabs.push(url);
      return typeof w.report === 'function' ? w.report() : w.report;
    },
    haltAll: async (reason) => { w.halts.push(reason); },
    log: async (_l, m) => { w.logs.push(m); },
  };
  return { w, deps };
}

describe('runOnce', () => {
  it('dismisses an expired job from the board', async () => {
    const { w, deps } = world({ report: rep('closed', { reason: 'job closed' }) });
    const r = await runOnce(deps);
    expect(r).toMatchObject({ ran: true, outcome: 'skipped' });
    expect(w.marked).toContainEqual([job.jobId, 'dismissed']);
  });

  it('applies live and marks the job applied by the agent', async () => {
    const { w, deps } = world();
    expect(await runOnce(deps)).toEqual({ ran: true, jobId: job.jobId, outcome: 'applied' });
    expect(w.tabs).toEqual([job.naukriUrl]);
    expect(w.marked).toEqual([[job.jobId, 'agent']]);
    expect(w.attempts[0]).toMatchObject({ outcome: 'applied', clicked: true, mode: 'live', matched: ['title: product manager'], finishedAt: NOW });
    expect(w.logs[0]).toContain('Auto-apply applied: Paytm - Product Manager at Paytm');
  });

  it('opens nothing while off, halted, at night or over the cap (AR-7, AR-8, AR-9)', async () => {
    const cases: Array<[Partial<World>, string]> = [
      [{ config: { ...DEFAULT_AGENT_CONFIG } }, 'off'],
      [{ safety: { ...DEFAULT_SAFETY, haltedAt: NOW } }, 'halted'],
      [{ state: { ...DEFAULT_AGENT_STATE, haltedAt: NOW, haltReason: 'x' } }, 'halted'],
      [{ now: new Date(2026, 9, 27, 23, 0).getTime() }, 'night'],
      [{ config: { ...DEFAULT_AGENT_CONFIG, autoApply: true, dailyCap: 1 }, attempts: [{ jobId: 'iimjobs-9', startedAt: NOW - 60_000 } as Attempt] }, 'cap'],
      [{ queue: [] }, 'empty'],
    ];
    for (const [over, reason] of cases) {
      const { w, deps } = world(over);
      expect(await runOnce(deps)).toEqual({ ran: false, reason });
      expect(w.tabs).toEqual([]);
    }
  });

  it('dry run logs "would apply" and changes no status (AR-10)', async () => {
    const { w, deps } = world({ config: { ...DEFAULT_AGENT_CONFIG, autoApply: true }, report: rep('can_apply') });
    expect(await runOnce(deps)).toMatchObject({ outcome: 'would_apply' });
    expect(w.marked).toEqual([]);
    expect(w.attempts[0]!.mode).toBe('dry_run');
    expect(w.logs[0]).toContain('(dry run) would_apply');
  });

  it('a captcha halts everything (AR-8)', async () => {
    const { w, deps } = world({ report: rep('captcha') });
    expect(await runOnce(deps)).toMatchObject({ outcome: 'halted' });
    expect(w.halts).toEqual(['iimjobs showed a captcha']);
  });

  it('a logout stops the agent only, until Resume', async () => {
    const { w, deps } = world({ report: rep('logged_out') });
    await runOnce(deps);
    expect(w.halts).toEqual([]);
    expect(w.state.haltedAt).toBe(NOW);
    expect(w.state.haltReason).toContain('Logged out of iimjobs');
  });

  it(`stops after ${NOT_FOUND_HALT} "Apply button not found" in a row`, async () => {
    const { w, deps } = world({ report: rep('not_found') });
    const go = { ignoreGap: true };
    await runOnce(deps, go);
    await runOnce(deps, go);
    expect(w.state.haltedAt).toBeNull();
    await runOnce(deps, go);
    expect(w.state.haltReason).toBe('iimjobs page changed: auto-apply needs an update');
    expect(w.logs.at(-1)).toContain('Auto-apply stopped');
  });

  it('credits the agent when a retry finds its earlier click went through', async () => {
    const earlier = { jobId: job.jobId, startedAt: NOW - 2 * 3_600_000, clicked: true, outcome: 'failed', reason: 'no "Applied"' } as Attempt;
    const { w, deps } = world({ attempts: [earlier], report: rep('already_applied') });
    await runOnce(deps);
    expect(w.marked).toEqual([[job.jobId, 'agent']]);
    const mine = world({ report: rep('already_applied') });
    await runOnce(mine.deps);
    expect(mine.w.marked).toEqual([[job.jobId, 'me']]);
  });

  it('a recognised page resets the not-found streak', async () => {
    const { w, deps } = world({ state: { ...DEFAULT_AGENT_STATE, notFoundStreak: 2 }, report: rep('closed') });
    await runOnce(deps);
    expect(w.state.notFoundStreak).toBe(0);
  });

  it('records questions for "Needs me" and failures from a broken tab', async () => {
    const { w, deps } = world({ report: rep('needs_me', { clicked: true, questions: ['Why us?'], reason: 'No stored answer for: Why us?' }) });
    await runOnce(deps);
    expect(w.attempts[0]).toMatchObject({ outcome: 'needs_me', questions: ['Why us?'] });
    const broken = world({ report: () => { throw new Error('tab gone'); } });
    await runOnce(broken.deps);
    expect(broken.w.attempts[0]).toMatchObject({ outcome: 'failed', reason: 'Error: tab gone' });
  });
});

describe('same-platform gap in the runner', () => {
  it('skips to a job on another platform, waits when none, and Run now ignores the wait', async () => {
    const naukri = { ...job, jobId: '211026003705', site: 'naukri' as const, naukriUrl: 'https://www.naukri.com/job-listings-x-211026003705' };
    const recentIim = { jobId: 'iimjobs-9', startedAt: NOW - 60_000, outcome: 'applied', clicked: true } as Attempt;
    const a = world({ attempts: [recentIim], queue: [job, naukri] });
    expect(await runOnce(a.deps)).toMatchObject({ ran: true, jobId: '211026003705' });
    const b = world({ attempts: [recentIim], queue: [job] });
    expect(await runOnce(b.deps)).toEqual({ ran: false, reason: 'spacing' });
    expect(await runOnce(b.deps, { ignoreGap: true })).toMatchObject({ ran: true, jobId: job.jobId });
  });
});

describe('decide', () => {
  it('maps every report', () => {
    expect(decide(rep('applied'), false)).toMatchObject({ outcome: 'already_applied', effect: 'mark_applied_me' });
    expect(decide(rep('already_applied'), false)).toMatchObject({ outcome: 'already_applied', effect: 'mark_applied_me' });
    expect(decide(rep('external'), false)).toMatchObject({ outcome: 'skipped' });
    expect(decide(rep('no_confirmation', { clicked: true }), false)).toMatchObject({ outcome: 'failed' });
    expect(decide(rep('stopped', { reason: 'auto-apply was turned off' }), false)).toMatchObject({ outcome: 'halted', effect: 'none' });
    expect(decide(rep('can_apply'), false)).toMatchObject({ outcome: 'failed' });
  });
});

describe('apply-report message', () => {
  const ok = { type: 'apply-report', token: 'abc123def456', result: 'applied', clicked: true, reason: '', questions: [], answers: [], dialogs: [] };
  it('accepts a valid report and rejects junk', () => {
    expect(CollectorMessage.safeParse(ok).success).toBe(true);
    expect(CollectorMessage.safeParse({ ...ok, result: 'hacked' }).success).toBe(false);
    expect(CollectorMessage.safeParse({ ...ok, clicked: 'yes' }).success).toBe(false);
    expect(CollectorMessage.safeParse({ ...ok, questions: Array(31).fill('q') }).success).toBe(false);
  });
});

describe('execution follows the round-robin queue', () => {
  it('2 Naukri, 1 Instahyre, 3 iimjobs are applied as N, I, H, N, I, I', async () => {
    const HOUR = 3_600_000;
    const mk = (site: Job['site'], h: number, id: string): Job => ({
      ...job, site, jobId: id, title: 'Product Manager', company: `${site} co ${h}`, postedAt: NOW - h * HOUR, titleCompanyKey: `pm|${site}${h}`,
      expMin: site === 'instahyre' ? null : 4, expMax: site === 'instahyre' ? null : 10,
      naukriUrl: site === 'naukri' ? `https://www.naukri.com/job-listings-pm-${id}` : site === 'instahyre' ? `https://www.instahyre.com/job-${id.split('-')[1]}/` : `https://www.iimjobs.com/j/pm-${id.split('-')[1]}`,
    });
    const jobs = [mk('naukri', 1, '100000000001'), mk('naukri', 5, '100000000005'), mk('instahyre', 3, 'instahyre-3'),
      mk('iimjobs', 2, 'iimjobs-2'), mk('iimjobs', 4, 'iimjobs-4'), mk('iimjobs', 6, 'iimjobs-6')];
    const config = { ...DEFAULT_AGENT_CONFIG, autoApply: true, dryRun: false, sites: ['iimjobs', 'instahyre', 'naukri'] as AgentConfig['sites'],
      gapSeconds: 300, rules: { ...DEFAULT_AGENT_CONFIG.rules, myYears: 8 } };
    const attempts: Attempt[] = [];
    const statuses: JobStatus[] = [];
    let now = NOW;
    const order: string[] = [];
    const deps: RunDeps = {
      now: () => now, rand: () => 0, loadConfig: async () => config, loadSafety: async () => DEFAULT_SAFETY,
      loadState: async () => DEFAULT_AGENT_STATE, saveState: async () => undefined, listAttempts: async () => attempts,
      queue: async (c, a) => buildQueue(jobs, statuses, a, c, [], now),
      addAttempt: async (a) => { attempts.push({ ...a, id: attempts.length + 1 }); return attempts.length; },
      finishAttempt: async (id, patch) => { Object.assign(attempts[id - 1]!, patch); },
      markApplied: async (jobId) => { statuses.push({ jobId, status: 'applied', statusAt: now }); },
      dismiss: async (jobId) => { statuses.push({ jobId, status: 'dismissed', statusAt: now }); },
      runInTab: async (url) => { order.push(new URL(url).hostname.replace(/^www\./, '').split('.')[0]!); return rep('applied', { clicked: true }); },
      haltAll: async () => undefined, log: async () => undefined,
    };
    for (let i = 0; i < 6; i += 1) {
      // What the scheduler does: wait until the planned time for the queue's first job, then run.
      const queue = await deps.queue(config, attempts);
      now = planNextRun({ now, today: attempts, nextSite: queue[0]?.job.site ?? null, platforms: new Set(queue.map((q) => q.job.site)).size,
        gapSeconds: config.gapSeconds, cap: 20, rand: () => 0 });
      expect(await runOnce(deps)).toMatchObject({ ran: true, outcome: 'applied' });
    }
    expect(order).toEqual(['naukri', 'iimjobs', 'instahyre', 'naukri', 'iimjobs', 'iimjobs']);
  });
});

describe('AI usage limit: pause and carry on when it is back', () => {
  const aiConfig = { ...DEFAULT_AGENT_CONFIG, autoApply: true, dryRun: false, aiApply: true };

  it('pauses the agent until the limit is back, without failing the job', async () => {
    const retryAt = NOW + 40 * 60_000;
    const { w, deps } = world({ config: aiConfig, report: rep('limit', { reason: 'AI usage limit reached', retryAt }) });
    const r = await runOnce(deps);
    expect(r).toMatchObject({ ran: true, outcome: 'halted' });
    expect(w.state.limitUntil).toBe(retryAt);
    expect(w.state.limitStreak).toBe(1);
    expect(w.state.haltedAt).toBeNull();
    expect(w.logs.some((l) => /paused: AI usage limit/.test(l))).toBe(true);
    // The job stays in the queue: a halted attempt does not block it.
    expect(blockedByHistory(w.attempts, aiConfig, NOW + 60 * 60_000)).toBeNull();
  });

  it('opens no page while the limit is out, and runs again once it is back (also right after a wake from sleep)', async () => {
    const until = NOW + 30 * 60_000;
    const { w, deps } = world({ config: aiConfig, state: { ...DEFAULT_AGENT_STATE, limitUntil: until, limitStreak: 1 } });
    expect(await runOnce(deps)).toEqual({ ran: false, reason: 'limit' });
    expect(w.tabs).toHaveLength(0);
    // Hours later (the laptop slept through the reset): the alarm fires on wake and the run goes ahead.
    w.now = until + 3 * 3600_000;
    expect(await runOnce(deps)).toMatchObject({ ran: true, outcome: 'applied' });
    expect(w.state.limitUntil).toBeNull();
    expect(w.state.limitStreak).toBe(0);
  });

  it('waits longer each time the limit is hit again right after a pause', async () => {
    const { w, deps } = world({ config: aiConfig, state: { ...DEFAULT_AGENT_STATE, limitUntil: null, limitStreak: 2 }, report: rep('limit', { retryAt: NOW + 30_000 }) });
    await runOnce(deps);
    expect(w.state.limitStreak).toBe(3);
    // A third limit in a row: at least 15 minutes, whatever "retry in 30 s" said.
    expect(w.state.limitUntil! - NOW).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('carries a limit report through the page message schema', () => {
    expect(decide(rep('limit'), false)).toMatchObject({ outcome: 'halted', effect: 'pause_ai' });
    const msg = { type: 'apply-report', token: 't', result: 'limit', clicked: false, reason: 'x', questions: [], answers: [], dialogs: [] };
    expect(CollectorMessage.safeParse(msg).success).toBe(true);
  });
});
