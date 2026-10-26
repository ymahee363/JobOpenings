/** Typed wrappers over chrome.storage.local for small settings and state. */
import { DEFAULT_FILTERS, DEFAULT_HIDDEN_TITLE_WORDS, type Filters } from './board';
import { DEFAULT_SAFETY, type SafetyState } from './safety';
import type { Source } from './sources';
import { DEFAULT_HEALTH, DEFAULT_SETTINGS, type Health, type Settings } from './types';

export interface PendingApply {
  jobId: string;
  at: number;
}

interface StoreShape {
  settings: Settings;
  health: Health;
  safety: SafetyState;
  filters: Filters;
  lastVisitAt: number | null;
  pendingApply: PendingApply | null;
  /** Your list from the Sources panel; null means use the sources.json defaults. */
  sources: Source[] | null;
  /** Jobs whose title has one of these words are hidden from the board. */
  hiddenTitleWords: string[];
}

const DEFAULTS: StoreShape = {
  settings: DEFAULT_SETTINGS,
  health: DEFAULT_HEALTH,
  safety: DEFAULT_SAFETY,
  filters: DEFAULT_FILTERS,
  lastVisitAt: null,
  pendingApply: null,
  sources: null,
  hiddenTitleWords: DEFAULT_HIDDEN_TITLE_WORDS,
};

export type StoreKey = keyof StoreShape;

export async function load<K extends StoreKey>(key: K): Promise<StoreShape[K]> {
  const got = await chrome.storage.local.get(key);
  const value = got[key] as StoreShape[K] | undefined;
  const fallback = DEFAULTS[key];
  if (value === undefined || value === null) return fallback;
  // Merge objects so fields added in later versions get their defaults. Lists are stored whole.
  if (Array.isArray(fallback) || Array.isArray(value)) return value;
  if (typeof fallback === 'object' && fallback !== null && typeof value === 'object') {
    return { ...fallback, ...value };
  }
  return value;
}

export async function save<K extends StoreKey>(key: K, value: StoreShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function update<K extends StoreKey>(
  key: K,
  fn: (v: StoreShape[K]) => StoreShape[K],
): Promise<StoreShape[K]> {
  const next = fn(await load(key));
  await save(key, next);
  return next;
}
