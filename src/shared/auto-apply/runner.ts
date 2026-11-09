/**
 * One run of the auto-apply agent (PRD-auto-apply AR-4 to AR-10). Chrome, the database and the clock come in as
 * dependencies, so the whole decision path is tested with fakes; the service worker only wires them up.
 */
import type { Rand, SafetyState } from '../safety';
import type { AgentConfig, AgentState, AnswerEntry, Attempt, AttemptOutcome } from './config';
import type { DialogSnapshot } from './job-page';
import type { QueueItem } from './match';
import { siteOfJobId } from './job-page';
import { cappedSites, inAgentHours } from './pacing';
import { guessLimitReset } from '../ai-apply/llm';

/** What the applier content script reports back from the job page. */
export type ReportResult =
  /** Dry run: the page offers Apply; nothing was clicked. */
  | 'can_apply'
  | 'applied'
  | 'already_applied'
  | 'closed'
  | 'external'
  | 'captcha'
  | 'logged_out'
  | 'not_found'
  | 'needs_me'
  /** Apply was pressed but no confirmation appeared. */
  | 'no_confirmation'
  /** The kill switch, dry run or a halt was seen just before a click. */
  | 'stopped'
  /** AI apply: every page filled, stopped at the final Submit for you (tab left open). */
  | 'ready'
  /** AI apply: the AI's usage limit ran out; nothing submitted, try again at `retryAt`. */
  | 'limit'
  | 'error';

export interface ApplyReport {
  result: ReportResult;
  clicked: boolean;
  reason: string;
  questions: string[];
  answers: AnswerEntry[];
  /** Dialogs seen, kept in the log so the selector file can be extended. */
  dialogs: DialogSnapshot[];
  /** `limit`: when the AI's usage limit is expected back (ms since epoch). */
  retryAt?: number;
}

export interface ApplyRequest {
  dryRun: boolean;
  /** Fill forms from the answer bank; when false, any form means "leave it for me". */
  fillForms: boolean;
  answers: AnswerEntry[];
  /** Let the AI apply flow take forms, company sites and sites without a one-click applier. */
  aiApply: boolean;
  /** AI apply presses the final Submit. */
  aiSubmit: boolean;
}

/** Where to apply to a job: its company page when it applies there and the board knows the link. */
export function applyUrlOf(job: { applyType: string; externalUrl: string | null; naukriUrl: string }): string {
  return job.applyType !== 'easy_apply' && job.externalUrl ? job.externalUrl : job.naukriUrl;
}

/** Three "Apply button not found" in a row: the page probably changed, so the agent stops. */
export const NOT_FOUND_HALT = 3;

/** `dismiss`: the job has expired, so it leaves the board (Dismissed). */
/** `pause_ai`: the AI's usage limit ran out; the agent waits until it is back and the job stays in the queue. */
export type Effect = 'none' | 'mark_applied_agent' | 'mark_applied_me' | 'halt_all' | 'halt_agent' | 'dismiss' | 'pause_ai';

export interface Decision {
  outcome: AttemptOutcome;
  reason: string;
  effect: Effect;
  notFound: boolean;
}

/** Turn a page report into the attempt's outcome and what else must happen. */
export function decide(report: ApplyReport, dryRun: boolean): Decision {
  const d = (outcome: AttemptOutcome, reason: string, effect: Effect = 'none', notFound = false): Decision => ({ outcome, reason, effect, notFound });
  switch (report.result) {
    case 'can_apply': return dryRun ? d('would_apply', 'dry run: would press Apply') : d('failed', 'page ready but not applied');
    case 'applied': return report.clicked ? d('applied', report.reason || 'iimjobs shows Applied', 'mark_applied_agent') : d('already_applied', 'iimjobs already shows Applied', 'mark_applied_me');
    case 'already_applied': return d('already_applied', 'iimjobs already shows Applied', 'mark_applied_me');
    case 'closed': return d('skipped', report.reason || 'job closed', 'dismiss');
    case 'external': return d('skipped', 'applies on a company site');
    case 'captcha': return d('halted', 'iimjobs showed a captcha', 'halt_all');
    case 'logged_out': return d('halted', 'Logged out of iimjobs', 'halt_agent');
    case 'not_found': return d('failed', report.reason || 'Apply button not found', 'none', true);
    case 'needs_me': return d('needs_me', report.reason || 'iimjobs asked for details');
    case 'no_confirmation': return d('failed', report.reason || 'no confirmation after pressing Apply');
    case 'stopped': return d('halted', report.reason || 'stopped before clicking');
    case 'ready': return d('filled', report.reason || 'form filled; waiting for you to press Submit');
    // Not a failure: nothing was submitted, and a halted attempt leaves the job in the queue for the next run.
    case 'limit': return d('halted', report.reason || 'AI usage limit reached', 'pause_ai');
    default: return d('failed', report.reason || 'error on the job page');
  }
}

export interface RunDeps {
  now(): number;
  rand: Rand;
  loadConfig(): Promise<AgentConfig>;
  loadSafety(): Promise<SafetyState>;
  loadState(): Promise<AgentState>;
  saveState(s: AgentState): Promise<void>;
  listAttempts(): Promise<Attempt[]>;
  queue(config: AgentConfig, attempts: Attempt[]): Promise<QueueItem[]>;
  addAttempt(a: Omit<Attempt, 'id'>): Promise<number>;
  finishAttempt(id: number, patch: Partial<Attempt>): Promise<void>;
  markApplied(jobId: string, by: 'me' | 'agent'): Promise<void>;
  /** An expired job: dismiss it from the board. */
  dismiss(jobId: string): Promise<void>;
  /** Open the job page in a background tab the agent owns, run the applier there, close the tab. */
  runInTab(url: string, req: ApplyRequest): Promise<ApplyReport>;
  haltAll(reason: string): Promise<void>;
  log(level: 'info' | 'warn' | 'error', message: string): Promise<void>;
}

/** `spacing`: every queued job's platform had an application less than your gap ago. */
/** `limit`: waiting for the AI's usage limit to come back (`AgentState.limitUntil`). */
export type NoRunReason = 'off' | 'halted' | 'night' | 'cap' | 'empty' | 'spacing' | 'limit';

export type RunResult =
  | { ran: false; reason: NoRunReason }
  | { ran: true; jobId: string; outcome: AttemptOutcome };

/** Is the agent allowed to open a page right now? */
export function blocker(config: AgentConfig, safety: SafetyState, state: AgentState, attempts: Attempt[], now: number): NoRunReason | null {
  if (!config.autoApply) return 'off';
  if (safety.haltedAt !== null || state.haltedAt !== null) return 'halted';
  if (!inAgentHours(now, config)) return 'night';
  if (config.aiApply && (state.limitUntil ?? 0) > now) return 'limit';
  // The page limit is per platform: stop for the day only when every ticked platform has used it.
  if (config.sites.length && cappedSites(config.sites, config.dailyCap, attempts, now).length === config.sites.length) return 'cap';
  return null;
}

/** Apply to (or, in dry run, check) the next job in the queue. */
export async function runOnce(deps: RunDeps, opts: { ignoreGap?: boolean } = {}): Promise<RunResult> {
  const [config, safety, state, attempts] = await Promise.all([deps.loadConfig(), deps.loadSafety(), deps.loadState(), deps.listAttempts()]);
  const blocked = blocker(config, safety, state, attempts, deps.now());
  if (blocked) return { ran: false, reason: blocked };
  const queue = await deps.queue(config, attempts);
  if (!queue.length) return { ran: false, reason: 'empty' };
  // The first job whose platform has had no application within your gap ("Run now" skips this wait).
  const now = deps.now();
  const lastOn = (site: string) => Math.max(0, ...attempts.filter((a) => siteOfJobId(a.jobId) === site).map((a) => a.startedAt));
  const item = opts.ignoreGap ? queue[0] : queue.find((q) => now - lastOn(q.job.site) >= config.gapSeconds * 1_000);
  if (!item) return { ran: false, reason: 'spacing' };

  const { job, reasons } = item;
  const mode = config.dryRun ? 'dry_run' : 'live';
  // Recorded before the page opens, so a cut-off run is found and re-checked later.
  const id = await deps.addAttempt({
    jobId: job.jobId, title: job.title, company: job.company, startedAt: deps.now(), finishedAt: null, mode,
    matched: reasons, answers: [], questions: [], clicked: false, outcome: 'pending', reason: '',
  });

  let report: ApplyReport;
  try {
    report = await deps.runInTab(applyUrlOf(job), {
      dryRun: config.dryRun, fillForms: config.fillForms, answers: config.answers, aiApply: config.aiApply, aiSubmit: config.aiSubmit,
    });
  } catch (e) {
    report = { result: 'error', clicked: false, reason: String(e).slice(0, 200), questions: [], answers: [], dialogs: [] };
  }
  const decision = decide(report, config.dryRun);
  await deps.finishAttempt(id, {
    finishedAt: deps.now(), outcome: decision.outcome, reason: decision.reason, clicked: report.clicked,
    answers: report.answers, questions: report.questions,
  });

  // "Already applied" after an earlier attempt that pressed Apply (no confirmation, or cut off) was the agent's apply.
  const agentClickedBefore = attempts.some((a) => a.jobId === job.jobId && (a.clicked || a.outcome === 'pending' || /interrupted|no report/.test(a.reason)));
  if (decision.effect === 'mark_applied_agent') await deps.markApplied(job.jobId, 'agent');
  if (decision.effect === 'mark_applied_me') await deps.markApplied(job.jobId, agentClickedBefore ? 'agent' : 'me');
  if (decision.effect === 'halt_all') await deps.haltAll(decision.reason);
  if (decision.effect === 'dismiss') await deps.dismiss(job.jobId);

  const streak = decision.notFound ? state.notFoundStreak + 1 : 0;
  let next: AgentState = { ...state, notFoundStreak: streak };
  if (decision.effect === 'pause_ai') {
    // When the limit is back: what the AI provider said, but never sooner than a growing wait when limits repeat
    // (a "retry in 30 s" that keeps failing is really a longer quota).
    const limitStreak = (state.limitStreak ?? 0) + 1;
    const said = report.retryAt ?? 0;
    const floor = limitStreak > 1 ? guessLimitReset(deps.now(), false, limitStreak - 2) : 0;
    next = { ...next, limitUntil: Math.max(said, floor, deps.now() + 60_000), limitStreak };
  } else if (config.aiApply && report.result !== 'error') {
    next = { ...next, limitUntil: null, limitStreak: 0 };
  }
  if (decision.effect === 'halt_agent') next = { ...next, haltedAt: deps.now(), haltReason: `${decision.reason}. Log in, then press Resume` };
  if (streak >= NOT_FOUND_HALT) next = { ...next, haltedAt: deps.now(), haltReason: 'iimjobs page changed: auto-apply needs an update' };
  await deps.saveState(next);

  const level = decision.outcome === 'failed' || decision.outcome === 'halted' ? 'warn' : 'info';
  const dialogs = report.dialogs.length ? `; dialogs: ${JSON.stringify(report.dialogs).slice(0, 200)}` : '';
  await deps.log(level, `Auto-apply ${mode === 'dry_run' ? '(dry run) ' : ''}${decision.outcome}: ${job.title} at ${job.company}. ${decision.reason}${dialogs}`);
  if (next.haltedAt !== null && state.haltedAt === null) await deps.log('error', `Auto-apply stopped: ${next.haltReason}`);
  if (decision.effect === 'pause_ai') await deps.log('warn', `Auto-apply paused: AI usage limit reached; continues after ${new Date(next.limitUntil!).toLocaleString()}`);
  return { ran: true, jobId: job.jobId, outcome: decision.outcome };
}
