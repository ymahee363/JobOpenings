/** Account-safety rules (PRD section 10). Pure functions so they can be unit tested. */

export const MIN_APP_LOAD_INTERVAL_MS = 15 * 60_000;
export const PAUSE_MS = 60 * 60_000;
export const REFRESH_TIMEOUT_MS = 45_000;

export interface SafetyState {
  lastAppLoadAt: number | null;
  pausedUntil: number | null;
  pauseReason: string | null;
}

export const DEFAULT_SAFETY: SafetyState = { lastAppLoadAt: null, pausedUntil: null, pauseReason: null };

export type LoadDecision =
  | { ok: true }
  | { ok: false; reason: 'paused' | 'too_soon'; retryAt: number; detail: string };

/** May the app open a Naukri page by itself right now? Pages the user opens never count. */
export function canAppLoad(state: SafetyState, now: number): LoadDecision {
  if (state.pausedUntil && now < state.pausedUntil) {
    return { ok: false, reason: 'paused', retryAt: state.pausedUntil, detail: state.pauseReason ?? 'Paused' };
  }
  if (state.lastAppLoadAt && now - state.lastAppLoadAt < MIN_APP_LOAD_INTERVAL_MS) {
    const retryAt = state.lastAppLoadAt + MIN_APP_LOAD_INTERVAL_MS;
    return { ok: false, reason: 'too_soon', retryAt, detail: 'At most one app refresh every 15 minutes' };
  }
  return { ok: true };
}

export function recordAppLoad(state: SafetyState, now: number): SafetyState {
  return { ...state, lastAppLoadAt: now };
}

export function pause(state: SafetyState, now: number, reason: string, ms = PAUSE_MS): SafetyState {
  return { ...state, pausedUntil: now + ms, pauseReason: reason };
}

export function resume(state: SafetyState): SafetyState {
  return { ...state, pausedUntil: null, pauseReason: null };
}

/** Clamp the user's chosen schedule to the safety floor. */
export function clampRefreshMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 30;
  return Math.min(24 * 60, Math.max(MIN_APP_LOAD_INTERVAL_MS / 60_000, Math.round(minutes)));
}
