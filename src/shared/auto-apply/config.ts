/** Auto-apply agent settings, state and audit records (PRD-auto-apply sections 6 and 7). */
import type { Site } from '../types';

/** Your rules: a job is applied to only when it passes every one. */
export interface ApplyRules {
  /** The title must contain one of these phrases (any case). */
  titleIncludes: string[];
  /** The title must contain none of these words (whole words, plurals too). The board's hidden words also apply. */
  titleExcludes: string[];
  /**
   * Your years of experience: a job passes when it asks for at most this many (the low end of its range), so 7
   * applies to 1-3 and 5-8 year jobs but not 10-15. Unset blocks every job until you set it.
   */
  myYears: number | null;
  /** The job's location must contain one of these; empty allows any location. */
  locations: string[];
  /** Remote or work-from-home jobs pass the location rule. */
  allowRemote: boolean;
  /** When a job shows a salary, its top must be at least this (LPA). Undisclosed salaries pass. */
  salaryFloorLpa: number | null;
  /** Companies never to apply to (the company name contains the text, any case). */
  companyBlocklist: string[];
  /** Only jobs posted within this many days. */
  maxPostedDays: number;
}

/** One stored answer. `question` is a pattern: words that must all appear; "a / b" means either. */
export interface AnswerEntry {
  question: string;
  answer: string;
}

export interface AgentConfig {
  /** Master switch (AR-9). Off until you turn it on. */
  autoApply: boolean;
  /** Check pages and log "would apply" without clicking (AR-10). On until you turn it off. */
  dryRun: boolean;
  /** Job pages the agent may open a day on each platform, dry run included (AR-7). 1 to 100. */
  dailyCap: number;
  /**
   * Seconds between two applications on the same platform. Platforms take turns in the queue, so with several in it
   * applications come about every `gapSeconds / platforms` seconds (never under `MIN_ANY_GAP_SECONDS`).
   */
  gapSeconds: number;
  /**
   * Sites it applies on. iimjobs only until you tick others. Indeed, Cutshort and foundit have no one-click applier,
   * so their jobs need `aiApply`; LinkedIn jobs too (its Easy Apply form goes through AI apply).
   */
  sites: Site[];
  /** Its working hours, local time: it starts attempts from `activeStartHour`:00 until `activeEndHour`:00. */
  activeStartHour: number;
  activeEndHour: number;
  rules: ApplyRules;
  answers: AnswerEntry[];
  /**
   * Off (the default): apply only where one click on Apply is enough; if iimjobs asks for any details, close the
   * form without submitting and leave the job for you. On: fill such forms from the answer bank.
   */
  fillForms: boolean;
  /** Desktop notification with the day's summary at 21:00 (AR-12). */
  dailySummary: boolean;
  /**
   * AI apply (src/shared/ai-apply): fill any application form with your profile, answer bank, form memory and the
   * LLM backend. Takes jobs that apply on a company site, sites without a one-click applier, and one-click jobs whose
   * site asks for details. Off until you turn it on.
   */
  aiApply: boolean;
  /** AI apply presses the final Submit itself. Off: it fills every page and leaves the tab open for you to submit. */
  aiSubmit: boolean;
  /**
   * "Keep awake" on the board: Windows does not sleep when idle, at any hour, so the agent keeps running. Off: it
   * keeps the laptop awake only inside the working hours while auto-apply is on. Closing the lid can still sleep.
   */
  keepAwake: boolean;
  /**
   * Company sites you signed in to from the board's "Sign in once" list, by host, with when. Jobs that stopped at that
   * site's sign-in page before then go back in the queue.
   */
  signedIn: Record<string, number>;
}

/** Sites the agent may be turned on for: every site the board collects. */
export const AUTO_SITES: Site[] = ['iimjobs', 'instahyre', 'naukri', 'wellfound', 'indeed', 'cutshort', 'foundit', 'linkedin'];

/**
 * "Apply to every matching job": every platform, one-click and company-site jobs alike, forms filled by AI apply,
 * the final Submit pressed, live. Applied once to your saved settings (rules, caps and answers are kept).
 */
export function applyEverywhere(c: AgentConfig): AgentConfig {
  const broken = c.activeEndHour - c.activeStartHour === 1 && c.activeStartHour < 6;
  return {
    ...c, autoApply: true, dryRun: false, fillForms: true, aiApply: true, aiSubmit: true, sites: [...AUTO_SITES],
    ...(broken ? { activeStartHour: 9, activeEndHour: 24 } : {}),
  };
}

/** Highest page limit a day per platform you can set. */
export const MAX_DAILY_CAP = 100;
/** Bounds for the same-platform gap, in seconds. */
export const MIN_GAP_SECONDS = 10;
export const MAX_GAP_SECONDS = 3_600;
/** Whatever the gap and the number of platforms, two applications are never closer than this. */
export const MIN_ANY_GAP_SECONDS = 10;

export function clampGapSeconds(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_AGENT_CONFIG.gapSeconds;
  return Math.min(MAX_GAP_SECONDS, Math.max(MIN_GAP_SECONDS, Math.round(n)));
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  autoApply: false,
  dryRun: true,
  dailyCap: 20,
  gapSeconds: 300,
  sites: ['iimjobs'],
  activeStartHour: 9,
  activeEndHour: 22,
  rules: {
    titleIncludes: ['product manager', 'product lead', 'product owner', 'head of product'],
    titleExcludes: ['Intern', 'Marketing', 'Sales'],
    myYears: null,
    locations: [],
    allowRemote: true,
    salaryFloorLpa: null,
    companyBlocklist: [],
    maxPostedDays: 7,
  },
  answers: [],
  fillForms: false,
  dailySummary: false,
  aiApply: false,
  aiSubmit: false,
  keepAwake: false,
  signedIn: {},
};

export function clampDailyCap(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_AGENT_CONFIG.dailyCap;
  return Math.min(MAX_DAILY_CAP, Math.max(1, Math.round(n)));
}

/** Runtime state the service worker keeps between runs. */
export interface AgentState {
  /** When the next attempt is due; null when none is scheduled. */
  nextRunAt: number | null;
  /** "Apply button not found" in a row; three halt the agent (the page probably changed). */
  notFoundStreak: number;
  /**
   * An agent-only stop (logged out of iimjobs, page changed). Refreshes keep going; a captcha instead halts
   * everything through the shared safety state. Both clear on Resume.
   */
  haltedAt: number | null;
  haltReason: string | null;
  /** What the last run did or why it did nothing, shown on the board. */
  lastCheckAt: number | null;
  lastCheck: string | null;
  /**
   * The AI's usage limit ran out: no AI apply before this time (ms). The agent's alarm is set for it, so it carries
   * on by itself, and Chrome fires a missed alarm as soon as the laptop wakes from sleep.
   */
  limitUntil?: number | null;
  /** Limits in a row (each pause waits longer when the reset time was only a guess); 0 after an AI run gets through. */
  limitStreak?: number;
}

export const DEFAULT_AGENT_STATE: AgentState = {
  nextRunAt: null, notFoundStreak: 0, haltedAt: null, haltReason: null, lastCheckAt: null, lastCheck: null,
};

export type AttemptOutcome =
  /** Started, not finished (or the browser closed mid-way). */
  | 'pending'
  | 'applied'
  | 'would_apply'
  /** iimjobs already showed Applied: you applied yourself. */
  | 'already_applied'
  /** Closed, off-site or otherwise not appliable; not retried. */
  | 'skipped'
  /** A question the answer bank cannot answer. */
  | 'needs_me'
  /** AI apply filled the whole form and left the tab open for you to press Submit. */
  | 'filled'
  | 'failed'
  /** Stopped by a captcha, logout or the kill switch. */
  | 'halted';

export interface Attempt {
  id?: number;
  jobId: string;
  title: string;
  company: string;
  startedAt: number;
  finishedAt: number | null;
  mode: 'live' | 'dry_run';
  /** Why the job matched, e.g. "title: product manager". */
  matched: string[];
  /** What was submitted. */
  answers: AnswerEntry[];
  /** Questions with no stored answer (needs_me), or the fields of a dialog the agent did not recognise. */
  questions: string[];
  /** Whether Apply was pressed. */
  clicked: boolean;
  outcome: AttemptOutcome;
  reason: string;
}

/**
 * A stored config with defaults filled in. The store merges only the top level, so rules added in later versions
 * are merged here; the cap is clamped.
 */
export function normalizeAgentConfig(saved: Partial<AgentConfig>): AgentConfig {
  const rules = { ...DEFAULT_AGENT_CONFIG.rules, ...(saved.rules ?? {}) };
  return {
    ...DEFAULT_AGENT_CONFIG,
    ...saved,
    rules,
    answers: Array.isArray(saved.answers) ? saved.answers : [],
    dailyCap: clampDailyCap(saved.dailyCap ?? DEFAULT_AGENT_CONFIG.dailyCap),
    gapSeconds: clampGapSeconds(saved.gapSeconds ?? DEFAULT_AGENT_CONFIG.gapSeconds),
    sites: Array.isArray(saved.sites) ? saved.sites.filter((s) => AUTO_SITES.includes(s)) : DEFAULT_AGENT_CONFIG.sites,
    ...clampHours(saved.activeStartHour ?? DEFAULT_AGENT_CONFIG.activeStartHour, saved.activeEndHour ?? DEFAULT_AGENT_CONFIG.activeEndHour),
  };
}

/**
 * Whole hours: start 0 to 23, end 1 to 24 (midnight), not equal. An end before the start is an overnight window
 * (21 to 2 runs from 21:00 until 2:00 the next morning). Anything else falls back to 9:00 to 22:00.
 */
export function clampHours(start: number, end: number): { activeStartHour: number; activeEndHour: number } {
  const s = Math.round(Number(start));
  const e = Math.round(Number(end));
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || s > 23 || e < 1 || e > 24 || s === e) return { activeStartHour: 9, activeEndHour: 22 };
  return { activeStartHour: s, activeEndHour: e };
}
