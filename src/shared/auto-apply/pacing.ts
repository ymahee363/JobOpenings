/** When the agent may run (PRD-auto-apply AR-7): daily cap, random gaps, waking hours only. */
import type { Rand } from '../safety';
import { MIN_ANY_GAP_SECONDS } from './config';
import { siteOfJobId } from './job-page';
import type { Attempt } from './config';

const MINUTE = 60_000;
export const GAP_MIN_MS = 3 * MINUTE;
export const GAP_MAX_MS = 8 * MINUTE;
/** A run pushed to the morning lands in the first half hour after the window opens. */
const MORNING_SPREAD_MS = 30 * MINUTE;
/** An attempt still pending after this long was cut off (browser closed, worker stopped). */
export const STALE_ATTEMPT_MS = 5 * MINUTE;

function at(t: number, dayOffset: number, hour: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function startOfDay(t: number): number {
  return at(t, 0, 0);
}

/** Job pages the agent opened today on each platform (local time), live and dry run alike. */
export function attemptsTodayBySite(attempts: Attempt[], now: number): Record<string, number> {
  const from = startOfDay(now);
  const out: Record<string, number> = {};
  for (const a of attempts) {
    if (a.startedAt < from) continue;
    // Your own "Apply with AI" runs are not the agent's pages: they do not use up its daily limit (2026-11-10).
    if (a.matched?.some((m) => /started by you/i.test(m))) continue;
    const site = siteOfJobId(a.jobId) ?? 'other';
    out[site] = (out[site] ?? 0) + 1;
  }
  return out;
}

/** The ticked platforms that have used today's page limit (the limit is per platform). */
export function cappedSites(sites: string[], cap: number, attempts: Attempt[], now: number): string[] {
  const today = attemptsTodayBySite(attempts, now);
  return sites.filter((s) => (today[s] ?? 0) >= cap);
}

/** Job pages the agent opened today (local time), live and dry run alike. */
export function attemptsToday(attempts: Attempt[], now: number): number {
  const from = startOfDay(now);
  return attempts.filter((a) => a.startedAt >= from).length;
}

/** A random gap between two attempts: 3 to 8 minutes. */
export function gapMs(rand: Rand): number {
  return GAP_MIN_MS + Math.floor(rand() * (GAP_MAX_MS - GAP_MIN_MS));
}

/**
 * The agent's working hours: from `activeStartHour`:00 up to `activeEndHour`:00 (24 means midnight). A start later
 * than the end is an overnight window: 21 to 2 runs from 21:00 until 2:00 the next morning.
 */
export interface AgentHours {
  activeStartHour: number;
  activeEndHour: number;
}

export const DEFAULT_HOURS: AgentHours = { activeStartHour: 9, activeEndHour: 22 };

/** Is `t` inside the agent's working hours? */
export function inAgentHours(t: number, h: AgentHours = DEFAULT_HOURS): boolean {
  const afterStart = t >= at(t, 0, h.activeStartHour);
  const beforeEnd = t < at(t, 0, h.activeEndHour);
  return isOvernight(h) ? afterStart || beforeEnd : afterStart && beforeEnd;
}

function isOvernight(h: AgentHours): boolean {
  return h.activeStartHour > h.activeEndHour;
}

/** Length of the working window in hours. */
function windowHours(h: AgentHours): number {
  return isOvernight(h) ? h.activeEndHour + 24 - h.activeStartHour : h.activeEndHour - h.activeStartHour;
}

/** "9:00 to 22:00". */
export function hoursLabel(h: AgentHours): string {
  return `${h.activeStartHour}:00 to ${h.activeEndHour === 24 ? 'midnight' : `${h.activeEndHour}:00`}${isOvernight(h) ? ' (next day)' : ''}`;
}

/** The next start of the working hours, spread over its first half hour (less if the window is shorter). */
function nextOpening(t: number, rand: Rand, h: AgentHours): number {
  const today = at(t, 0, h.activeStartHour);
  const spread = Math.min(MORNING_SPREAD_MS, (windowHours(h) * 60 * MINUTE) / 2);
  return (t < today ? today : at(t, 1, h.activeStartHour)) + Math.floor(rand() * spread);
}

/**
 * When the next attempt may start: a random gap after the last one, and only inside your working hours. Once
 * today's cap is used, the next day's opening.
 */
export function nextAgentRunAt(
  now: number, lastStartedAt: number | null, todayCount: number, cap: number, rand: Rand, h: AgentHours = DEFAULT_HOURS,
): number {
  if (todayCount >= cap) return nextOpening(Math.max(now, at(now, 0, h.activeStartHour)), rand, h);
  let when = Math.max(now + MINUTE, lastStartedAt === null ? 0 : lastStartedAt + gapMs(rand));
  if (!inAgentHours(when, h)) when = nextOpening(when, rand, h);
  return when;
}

/** Attempts left pending by a closed browser or a stopped worker. */
export function staleAttempts(attempts: Attempt[], now: number): Attempt[] {
  return attempts.filter((a) => a.outcome === 'pending' && now - a.startedAt > STALE_ATTEMPT_MS);
}

/** The header's one-line agent status (PRD-auto-apply section 9). */
export function agentHeadline(
  config: { autoApply: boolean; dryRun: boolean; dailyCap: number },
  state: { nextRunAt: number | null; haltedAt: number | null; haltReason: string | null },
  refreshHalted: boolean, appliedToday: number | { agent: number; me: number }, formatTime: (t: number) => string,
): { text: string; tone: 'ok' | 'warn' | 'off' } {
  if (!config.autoApply) return { text: 'Auto-apply: Off', tone: 'off' };
  if (refreshHalted) return { text: 'Auto-apply: Stopped (captcha)', tone: 'warn' };
  if (state.haltedAt !== null) return { text: `Auto-apply: Stopped (${state.haltReason ?? 'halted'})`, tone: 'warn' };
  // Total applied today, split by the agent and by you (user, 2026-11-10).
  const today = typeof appliedToday === 'number'
    ? `${appliedToday} applied today`
    : `${appliedToday.agent + appliedToday.me} applied today (agent ${appliedToday.agent} · you ${appliedToday.me})`;
  const parts = [`Auto-apply: On${config.dryRun ? ' (dry run)' : ''}`, today];
  if (state.nextRunAt !== null) parts.push(`next ${formatTime(state.nextRunAt)}`);
  return { text: parts.join(' · '), tone: 'ok' };
}

export interface DaySummary {
  applied: number;
  wouldApply: number;
  needsMe: number;
  failed: number;
  skipped: number;
}

/** AR-12: what the agent did since `from`. */
export function summarize(attempts: Attempt[], from: number): DaySummary {
  const recent = attempts.filter((a) => a.startedAt >= from);
  const count = (o: Attempt['outcome']) => recent.filter((a) => a.outcome === o).length;
  return {
    applied: count('applied'),
    wouldApply: count('would_apply'),
    needsMe: count('needs_me'),
    failed: count('failed'),
    skipped: count('skipped') + count('already_applied'),
  };
}

export interface NextRunInput {
  now: number;
  /** Today's attempts (any order). */
  today: Attempt[];
  /** The site of the next job in the queue, if any. */
  nextSite: string | null;
  /** How many platforms the queue has jobs from. */
  platforms: number;
  gapSeconds: number;
  /** Old total limit; the service worker passes `allCapped` instead (the limit is per platform). */
  cap: number;
  /** Every ticked platform has used today's limit: wait for tomorrow. */
  allCapped?: boolean;
  rand: Rand;
  hours?: AgentHours;
}

/** Up to 15% random extra on a gap, so attempts never land on an exact beat. */
function jittered(ms: number, rand: Rand): number {
  return ms + Math.floor(rand() * ms * 0.15);
}

/**
 * When the next attempt may start. Two applications on the same platform are at least `gapSeconds` apart; any
 * two are at least `gapSeconds / platforms` apart (and never under 10 s). Because the queue alternates platforms,
 * the wait between consecutive applications shrinks as more platforms are in it, while each platform still sees
 * your full gap. Only inside your working hours; after today's cap, the next day's opening.
 */
export function planNextRun(i: NextRunInput): number {
  const h = i.hours ?? DEFAULT_HOURS;
  if (i.allCapped || i.today.length >= i.cap) return nextOpening(Math.max(i.now, at(i.now, 0, h.activeStartHour)), i.rand, h);
  const gapMs = i.gapSeconds * 1_000;
  const anyGapMs = Math.max(MIN_ANY_GAP_SECONDS * 1_000, gapMs / Math.max(1, i.platforms));
  const lastAny = Math.max(0, ...i.today.map((a) => a.startedAt));
  const lastSame = Math.max(0, ...i.today.filter((a) => i.nextSite !== null && siteOfJobId(a.jobId) === i.nextSite).map((a) => a.startedAt));
  let when = Math.max(
    i.now + 15_000,
    lastAny ? lastAny + jittered(anyGapMs, i.rand) : 0,
    lastSame ? lastSame + jittered(gapMs, i.rand) : 0,
  );
  if (!inAgentHours(when, h)) when = nextOpening(when, i.rand, h);
  return when;
}
