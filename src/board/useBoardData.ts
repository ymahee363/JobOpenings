import { useCallback, useEffect, useRef, useState } from 'react';
import { getDb } from '../db/db';
import { DEFAULT_FILTERS, DEFAULT_HIDDEN_TITLE_WORDS, normalizeFilters, type Filters } from '../shared/board';
import { DB_CHANGED } from '../shared/messages';
import {
  DEFAULT_AGENT_STATE, normalizeAgentConfig, DEFAULT_AGENT_CONFIG, type AgentConfig, type AgentState,
} from '../shared/auto-apply/config';
import { DEFAULT_SAFETY, type SafetyState } from '../shared/safety';
import { load, save, type PendingApply } from '../shared/store';
import type { Attempt } from '../shared/auto-apply/config';
import { DEFAULT_HEALTH, DEFAULT_SETTINGS, type Health, type Job, type JobStatus, type Settings } from '../shared/types';

export interface BoardData {
  loaded: boolean;
  jobs: Job[];
  statuses: JobStatus[];
  /** The auto-apply agent's attempts, for the Extra Details tab. */
  attempts: Attempt[];
  health: Health;
  safety: SafetyState;
  settings: Settings;
  filters: Filters;
  hiddenTitleWords: string[];
  agent: AgentConfig;
  agentState: AgentState;
  pendingApply: PendingApply | null;
  /** Previous visit time; jobs first seen after it are "new". */
  lastVisitAt: number | null;
  now: number;
}

const TICK_MS = 30_000;

export function useBoardData() {
  const db = getDb();
  const [data, setData] = useState<BoardData>({
    loaded: false,
    jobs: [],
    statuses: [],
    attempts: [],
    health: DEFAULT_HEALTH,
    safety: DEFAULT_SAFETY,
    settings: DEFAULT_SETTINGS,
    filters: DEFAULT_FILTERS,
    hiddenTitleWords: DEFAULT_HIDDEN_TITLE_WORDS,
    agent: DEFAULT_AGENT_CONFIG,
    agentState: DEFAULT_AGENT_STATE,
    pendingApply: null,
    lastVisitAt: null,
    now: Date.now(),
  });
  const mounted = useRef(true);

  const reloadDb = useCallback(async () => {
    const [jobs, statuses, attempts] = await Promise.all([db.jobs.toArray(), db.statuses.toArray(), db.attempts.toArray()]);
    if (mounted.current) setData((d) => ({ ...d, jobs, statuses, attempts, loaded: true, now: Date.now() }));
  }, [db]);

  const reloadStore = useCallback(async () => {
    const [health, safety, settings, filters, pendingApply, hiddenTitleWords, agent, agentState] = await Promise.all([
      load('health'), load('safety'), load('settings'), load('filters'), load('pendingApply'), load('hiddenTitleWords'),
      load('agent'), load('agentState'),
    ]);
    if (mounted.current) {
      setData((d) => ({
        ...d, health, safety, settings, filters: normalizeFilters(filters), pendingApply, hiddenTitleWords,
        agent: normalizeAgentConfig(agent), agentState,
      }));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      const prev = await load('lastVisitAt');
      await save('lastVisitAt', Date.now());
      if (mounted.current) setData((d) => ({ ...d, lastVisitAt: prev }));
      // Store first: `loaded` (set by reloadDb) must mean filters and settings are in too.
      await reloadStore();
      await reloadDb();
    })().catch(() => undefined);

    const onMessage = (msg: unknown) => {
      if ((msg as { type?: unknown } | null)?.type === DB_CHANGED) reloadDb().catch(() => undefined);
    };
    const onStorage = (_c: unknown, area: string) => {
      if (area === 'local') reloadStore().catch(() => undefined);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorage);
    const tick = setInterval(() => setData((d) => ({ ...d, now: Date.now() })), TICK_MS);
    return () => {
      mounted.current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
      clearInterval(tick);
    };
  }, [reloadDb, reloadStore]);

  const markAllSeen = useCallback(() => {
    const now = Date.now();
    save('lastVisitAt', now).catch(() => undefined);
    setData((d) => ({ ...d, lastVisitAt: now }));
  }, []);

  return { data, reloadDb, markAllSeen };
}
