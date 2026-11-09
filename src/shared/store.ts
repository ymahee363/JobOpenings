/** Typed wrappers over chrome.storage.local for small settings and state. */
import { DEFAULT_AGENT_CONFIG, DEFAULT_AGENT_STATE, type AgentConfig, type AgentState } from './auto-apply/config';
import type { MemoryMap } from './ai-apply/memory';
import { DEFAULT_BACKEND, DEFAULT_PROFILE, type AiBackend, type StoredResume } from './ai-apply/profile';
import type { CandidateProfile } from './ai-apply/types';
import { DEFAULT_FILTERS, DEFAULT_HIDDEN_TITLE_WORDS, type Filters, type TabOverrides } from './board';
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
  /** The iimjobs auto-apply agent's switches, rules and answer bank. */
  agent: AgentConfig;
  agentState: AgentState;
  /** AI apply: your candidate profile (read through `normalizeProfile`). */
  aiProfile: CandidateProfile;
  /** AI apply: the LLM backend's address and key. */
  aiBackend: AiBackend;
  /** AI apply: your resume file and text; null until you add one. */
  aiResume: StoredResume | null;
  /** AI apply: answers remembered across sites, by question. */
  formMemory: MemoryMap;
  /** AI apply: your cover letter, attached to cover letter upload fields; null until you add one. */
  aiCoverLetter: StoredResume | null;
  /** The version of seed/ai-seed.json already loaded (job-apply-ai-mvp data); null before the first. */
  aiSeedVersion: number | null;
  /** When the "apply to every matching job" settings were switched on (once); null before. */
  agentEverywhereAt: number | null;
  /** Jobs you dragged to another tab on the board. */
  tabOverrides: TabOverrides;
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
  agent: DEFAULT_AGENT_CONFIG,
  agentState: DEFAULT_AGENT_STATE,
  aiProfile: DEFAULT_PROFILE,
  aiBackend: DEFAULT_BACKEND,
  aiResume: null,
  formMemory: {},
  aiCoverLetter: null,
  aiSeedVersion: null,
  agentEverywhereAt: null,
  tabOverrides: {},
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
