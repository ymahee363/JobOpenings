/** Account-safety rules (PRD section 10). Pure functions so they can be unit tested. */

/** Floor between app refreshes of Naukri. */
export const MIN_APP_LOAD_INTERVAL_MS = 15 * 60_000;
/** Floor between app refreshes of each site other than Naukri (opening the board can trigger one). */
export const MIN_INDEED_LOAD_INTERVAL_MS = 60 * 60_000;
export const PAUSE_MS = 60 * 60_000;
export const REFRESH_TIMEOUT_MS = 45_000;

export interface SafetyState {
  /** Last app refresh of Naukri. */
  lastAppLoadAt: number | null;
  /** Last app refresh of Indeed, from any trigger. */
  lastIndeedLoadAt: number | null;
  /** Last app refresh of Instahyre, from any trigger. */
  lastInstahyreLoadAt: number | null;
  /** Last app refresh of Wellfound, from any trigger. */
  lastWellfoundLoadAt: number | null;
  /** Last app refresh of Cutshort, from any trigger. */
  lastCutshortLoadAt: number | null;
  /** Last app refresh of foundit, from any trigger. */
  lastFounditLoadAt: number | null;
  /** Last app refresh of iimjobs, from any trigger. */
  lastIimjobsLoadAt: number | null;
  /** Last run of the once-a-day refresh of Indeed, Instahyre and Wellfound. */
  lastIndeedDailyAt: number | null;
  /** A Naukri logout pause; it holds Naukri refreshes only. */
  pausedUntil: number | null;
  pauseReason: string | null;
  /** Set when a site showed a captcha: all app refreshes stop until you press Resume. */
  haltedAt: number | null;
  haltReason: string | null;
}

export const DEFAULT_SAFETY: SafetyState = {
  lastAppLoadAt: null, lastIndeedLoadAt: null, lastInstahyreLoadAt: null, lastWellfoundLoadAt: null, lastCutshortLoadAt: null, lastFounditLoadAt: null, lastIimjobsLoadAt: null,
  lastIndeedDailyAt: null,
  pausedUntil: null, pauseReason: null, haltedAt: null, haltReason: null,
};

type SiteName = 'naukri' | 'indeed' | 'instahyre' | 'wellfound' | 'cutshort' | 'foundit' | 'iimjobs'; // AppSite: LinkedIn is never opened by the app
type HourlySite = Exclude<SiteName, 'naukri'>;

/** The sites refreshed at most hourly, with where each one's last app refresh is kept. */
type HourlyKey = 'lastIndeedLoadAt' | 'lastInstahyreLoadAt' | 'lastWellfoundLoadAt' | 'lastCutshortLoadAt' | 'lastFounditLoadAt'
  | 'lastIimjobsLoadAt';
const HOURLY: Record<HourlySite, { key: HourlyKey; name: string }> = {
  indeed: { key: 'lastIndeedLoadAt', name: 'Indeed' },
  instahyre: { key: 'lastInstahyreLoadAt', name: 'Instahyre' },
  wellfound: { key: 'lastWellfoundLoadAt', name: 'Wellfound' },
  cutshort: { key: 'lastCutshortLoadAt', name: 'Cutshort' },
  foundit: { key: 'lastFounditLoadAt', name: 'foundit' },
  iimjobs: { key: 'lastIimjobsLoadAt', name: 'iimjobs' },
};

export type LoadDecision =
  | { ok: true }
  | { ok: false; reason: 'halted'; detail: string }
  | { ok: false; reason: 'paused' | 'too_soon'; retryAt: number; detail: string };

/** May the app refresh this site by itself right now? Pages the user opens never count. */
export function canAppLoad(state: SafetyState, now: number, site: SiteName = 'naukri'): LoadDecision {
  if (state.haltedAt !== null) {
    return { ok: false, reason: 'halted', detail: `${state.haltReason ?? 'Stopped'}. Press Resume to start again` };
  }
  if (site !== 'naukri') {
    const { key, name } = HOURLY[site];
    const last = state[key];
    if (last && now - last < MIN_INDEED_LOAD_INTERVAL_MS) {
      const retryAt = last + MIN_INDEED_LOAD_INTERVAL_MS;
      return { ok: false, reason: 'too_soon', retryAt, detail: `${name}: at most one app refresh an hour` };
    }
    return { ok: true };
  }
  if (state.pausedUntil && now < state.pausedUntil) {
    return { ok: false, reason: 'paused', retryAt: state.pausedUntil, detail: state.pauseReason ?? 'Paused' };
  }
  if (state.lastAppLoadAt && now - state.lastAppLoadAt < MIN_APP_LOAD_INTERVAL_MS) {
    const retryAt = state.lastAppLoadAt + MIN_APP_LOAD_INTERVAL_MS;
    return { ok: false, reason: 'too_soon', retryAt, detail: 'Naukri: at most one app refresh every 15 minutes' };
  }
  return { ok: true };
}

export function recordAppLoad(state: SafetyState, now: number, site: SiteName = 'naukri'): SafetyState {
  return site === 'naukri' ? { ...state, lastAppLoadAt: now } : { ...state, [HOURLY[site].key]: now };
}

export function pause(state: SafetyState, now: number, reason: string, ms = PAUSE_MS): SafetyState {
  return { ...state, pausedUntil: now + ms, pauseReason: reason };
}

/** Stop every app refresh until the user resumes. Used when a site shows a captcha. */
export function halt(state: SafetyState, now: number, reason: string): SafetyState {
  return { ...state, haltedAt: now, haltReason: reason, pausedUntil: null, pauseReason: null };
}

export function resume(state: SafetyState): SafetyState {
  return { ...state, pausedUntil: null, pauseReason: null, haltedAt: null, haltReason: null };
}

// ---------- randomised timing ----------
// Each call takes a random source so tests can pin it; production passes Math.random.

export type Rand = () => number;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Extra time added to every scheduled refresh: 30 s up to half the interval, capped at 15 min. */
export function refreshJitterMs(minutes: number, rand: Rand): number {
  const max = Math.min(15 * MINUTE, (clampRefreshMinutes(minutes) * MINUTE) / 2);
  return 30 * SECOND + Math.floor(rand() * (max - 30 * SECOND));
}

/** Morning start spread: a refresh pushed out of the night lands 0 to 30 minutes after the window opens. */
const MORNING_SPREAD_MS = 30 * MINUTE;

/**
 * When the next automatic Naukri refresh should run: the chosen interval plus fresh random jitter, never
 * before a pause ends or the 15-minute floor allows, and only in waking hours (9:00 to 22:00): a time that
 * falls at night moves to a random moment in the first half hour of the next morning.
 * Returns null while refresh is halted.
 */
export function nextRefreshAt(now: number, minutes: number, state: SafetyState, rand: Rand): number | null {
  if (state.haltedAt !== null) return null;
  const jitter = refreshJitterMs(minutes, rand);
  let at = now + clampRefreshMinutes(minutes) * MINUTE + jitter;
  if (state.pausedUntil && state.pausedUntil > now) at = Math.max(at, state.pausedUntil + jitter);
  if (state.lastAppLoadAt) at = Math.max(at, state.lastAppLoadAt + MIN_APP_LOAD_INTERVAL_MS);
  if (!inActiveHours(at)) {
    const opensToday = atHour(at, 0, ACTIVE_START_HOUR);
    const opens = at < opensToday ? opensToday : atHour(at, 1, ACTIVE_START_HOUR);
    at = opens + Math.floor(rand() * MORNING_SPREAD_MS);
  }
  return at;
}

/** Waking hours, local time: automatic refreshes of both sites run only inside this window. */
export const ACTIVE_START_HOUR = 9;
export const ACTIVE_END_HOUR = 22;

function atHour(t: number, dayOffset: number, hour: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Is `t` inside waking hours? */
export function inActiveHours(t: number): boolean {
  return t >= atHour(t, 0, ACTIVE_START_HOUR) && t < atHour(t, 0, ACTIVE_END_HOUR);
}

/**
 * When Indeed's once-a-day refresh should next run: a random moment between 9:00 and 22:00, later today if it
 * has not run today and the window is still open (at least 5 minutes from now), otherwise tomorrow.
 * Returns null while refresh is halted.
 */
export function nextDailyAt(now: number, state: SafetyState, rand: Rand): number | null {
  if (state.haltedAt !== null) return null;
  const ranToday = state.lastIndeedDailyAt !== null && state.lastIndeedDailyAt >= atHour(now, 0, 0);
  if (!ranToday) {
    const from = Math.max(now + 5 * MINUTE, atHour(now, 0, ACTIVE_START_HOUR));
    const to = atHour(now, 0, ACTIVE_END_HOUR);
    if (from < to) return from + Math.floor(rand() * (to - from));
  }
  const from = atHour(now, 1, ACTIVE_START_HOUR);
  const to = atHour(now, 1, ACTIVE_END_HOUR);
  return from + Math.floor(rand() * (to - from));
}

/** How long a page the app opened stays open: at least 2 minutes, plus up to 90 random seconds. */
export const DWELL_MIN_MS = 2 * MINUTE;
export const DWELL_JITTER_MS = 90 * SECOND;
export function dwellMs(rand: Rand): number {
  return DWELL_MIN_MS + Math.floor(rand() * DWELL_JITTER_MS);
}

/** Pause between closing one page and opening the next within a refresh: 5 to 20 seconds. */
export function pageGapMs(rand: Rand): number {
  return 5 * SECOND + Math.floor(rand() * 15 * SECOND);
}

/** Clamp the user's chosen schedule to the safety floor. */
export function clampRefreshMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 30;
  return Math.min(24 * 60, Math.max(MIN_APP_LOAD_INTERVAL_MS / 60_000, Math.round(minutes)));
}
