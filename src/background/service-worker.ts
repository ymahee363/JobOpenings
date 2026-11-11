import { getDb } from '../db/db';
import {
  addAttempt, ATTEMPT_RETENTION_MS, finishAttempt, listAttempts, log, markAppliedFromSite, purge, setStatus, upsertJobs,
} from '../db/repo';
import { runAiApply, type FlowDeps, type FlowMode } from '../shared/ai-apply/flow';
import { backendClient, backendHealth } from '../shared/ai-apply/llm';
import { normalizeProfile } from '../shared/ai-apply/profile';
import { buildWorkdayPlan } from '../shared/ats/workday-plan';
import { seedPatch, type AiSeed } from '../shared/ai-apply/seed';
import { normalizeLabel, rememberAnswers } from '../shared/ai-apply/memory';
import { isProductTitle } from '../shared/board';
import { applyEverywhere, normalizeAgentConfig } from '../shared/auto-apply/config';
import { AGENT_SITES, confirmedJobIds, jobPageOf, naukriApplyResult, SITE_PAGES, type AgentSite } from '../shared/auto-apply/job-page';
import { buildQueue, explainEmptyQueue } from '../shared/auto-apply/match';
import { cappedSites, hoursLabel, inAgentHours, planNextRun, staleAttempts, startOfDay, summarize } from '../shared/auto-apply/pacing';
import { manualOutcome, runOnce, type ApplyReport, type ApplyRequest, type NoRunReason, type RunDeps } from '../shared/auto-apply/runner';
import { BoardMessage, CollectorMessage, DB_CHANGED, type RefreshResponse } from '../shared/messages';
import { parseCapture, type CaptureResult } from '../shared/parse';
import { parseIndeedCapture } from '../shared/parse-indeed';
import { parseInstahyreCapture } from '../shared/parse-instahyre';
import { parseLinkedInCapture } from '../shared/parse-linkedin';
import { parseWellfoundCapture } from '../shared/parse-wellfound';
import { parseCutshortCapture } from '../shared/parse-cutshort';
import { parseFounditCapture } from '../shared/parse-foundit';
import { parseIimjobsCapture } from '../shared/parse-iimjobs';
import {
  canAppLoad, dwellMs, halt, inActiveHours, nextDailyAt, nextRefreshAt, pageGapMs, pause, recordAppLoad,
  REFRESH_TIMEOUT_MS, resume,
} from '../shared/safety';
import { runSources, type LoadOutcome } from '../shared/refresh';
import { effectiveSources, siteOfUrl, type Source } from '../shared/sources';
import { load, save, update } from '../shared/store';
import type { AppSite, Site } from '../shared/types';

const db = getDb();
const BOARD_URL = chrome.runtime.getURL('board.html');
/** Naukri's automatic refresh (interval plus jitter). The name predates Indeed support. */
const ALARM_REFRESH = 'refresh';
/** The once-a-day refresh of Indeed, Instahyre and Wellfound at a random time. The name predates the other two. */
const ALARM_INDEED_DAILY = 'indeed-daily';
const ALARM_PURGE = 'purge';
const LOGGED_OUT = 'Logged out of Naukri';
const SITE_NAME: Record<Site, string> = {
  naukri: 'Naukri', indeed: 'Indeed', instahyre: 'Instahyre', wellfound: 'Wellfound', linkedin: 'LinkedIn', cutshort: 'Cutshort', foundit: 'foundit', iimjobs: 'iimjobs',
};

/** The site a content-script message came from, judged by the sender's URL rather than the message. */
function siteOfSender(url: string | undefined): Site | null {
  if (url?.startsWith('https://www.naukri.com/')) return 'naukri';
  if (url?.startsWith('https://in.indeed.com/')) return 'indeed';
  if (url?.startsWith('https://www.instahyre.com/')) return 'instahyre';
  if (url?.startsWith('https://wellfound.com/')) return 'wellfound';
  if (url?.startsWith('https://cutshort.io/')) return 'cutshort';
  if (url?.startsWith('https://www.foundit.in/')) return 'foundit';
  if (url?.startsWith('https://www.iimjobs.com/')) return 'iimjobs';
  if (url?.startsWith('https://www.linkedin.com/')) return 'linkedin';
  return null;
}

// ---------- helpers ----------

function broadcastChanged(): void {
  chrome.runtime.sendMessage({ type: DB_CHANGED }).catch(() => undefined);
}

/**
 * Set the next automatic Naukri refresh: the chosen interval plus a new random delay each time, as a one-shot
 * alarm that is set again after every Naukri refresh. Nothing is scheduled while auto-refresh is off or halted.
 */
async function scheduleNaukri(): Promise<void> {
  const [settings, safety] = await Promise.all([load('settings'), load('safety')]);
  await chrome.alarms.clear(ALARM_REFRESH);
  const when = settings.autoRefresh ? nextRefreshAt(Date.now(), settings.refreshMinutes, safety, Math.random) : null;
  if (when !== null) await chrome.alarms.create(ALARM_REFRESH, { when });
  await update('health', (h) => ({ ...h, nextAutoRefreshAt: when }));
}

/**
 * Set the once-a-day Indeed, Instahyre and Wellfound refresh at a random time between 9:00 and 22:00. An existing alarm is kept unless
 * `reroll` is set (after the daily run), so restarts and setting changes do not keep moving it.
 */
async function scheduleIndeedDaily(reroll: boolean): Promise<void> {
  const [settings, safety] = await Promise.all([load('settings'), load('safety')]);
  const existing = await chrome.alarms.get(ALARM_INDEED_DAILY);
  let when: number | null = null;
  if (settings.autoRefresh && safety.haltedAt === null) {
    if (existing && !reroll) {
      when = existing.scheduledTime;
    } else {
      await chrome.alarms.clear(ALARM_INDEED_DAILY);
      when = nextDailyAt(Date.now(), safety, Math.random);
      if (when !== null) await chrome.alarms.create(ALARM_INDEED_DAILY, { when });
    }
  } else {
    await chrome.alarms.clear(ALARM_INDEED_DAILY);
  }
  await update('health', (h) => ({ ...h, nextIndeedRefreshAt: when }));
}

async function schedule(): Promise<void> {
  await scheduleNaukri();
  await scheduleIndeedDaily(false);
  await recoverAttempts();
  await scheduleAgent(false);
  const purgeAlarm = await chrome.alarms.get(ALARM_PURGE);
  if (!purgeAlarm) await chrome.alarms.create(ALARM_PURGE, { periodInMinutes: 24 * 60, delayInMinutes: 1 });
}

async function openBoard(): Promise<void> {
  const [existing] = await chrome.tabs.query({ url: BOARD_URL });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: BOARD_URL });
  }
}

// ---------- capture ----------

type Capture = Extract<CollectorMessage, { type: 'capture' }>;

/** Parse a capture with its site's parser. `appliedJobIds` are jobs the site says you already applied to. */
function parseFor(msg: Capture, now: number): CaptureResult & { appliedJobIds?: string[] } {
  switch (msg.site) {
    case 'indeed': return parseIndeedCapture(msg.payload, msg.feed ?? 'indeed-home', now);
    case 'instahyre': return parseInstahyreCapture(msg.payload, msg.feed ?? 'instahyre-search', now);
    case 'wellfound': return parseWellfoundCapture(msg.payload, msg.feed ?? 'wellfound-search', now);
    case 'cutshort': return parseCutshortCapture(msg.payload, msg.feed ?? 'cutshort-search', now);
    case 'foundit': return parseFounditCapture(msg.payload, msg.feed ?? 'foundit-search', now);
    case 'iimjobs': return parseIimjobsCapture(msg.payload, msg.feed ?? 'iimjobs-search', now);
    case 'linkedin': return parseLinkedInCapture(msg.payload, msg.feed ?? 'linkedin', now);
    default: return parseCapture(msg.payload, msg.feed, now);
  }
}

async function handleCapture(msg: Capture): Promise<number> {
  const now = Date.now();
  const result = parseFor(msg, now);
  if (result.jobs.length === 0 && result.rejected === 0) return 0;

  // Only product roles go on the board (the title must say "product").
  const productJobs = result.jobs.filter((j) => isProductTitle(j.title));
  const { added } = await upsertJobs(db, productJobs, now);
  if (result.appliedJobIds?.length) {
    const marked = await markAppliedFromSite(db, result.appliedJobIds, now);
    if (marked) await log(db, 'info', `${SITE_NAME[msg.site]} shows ${marked} job(s) as already applied`);
  }
  await update('health', (h) => ({
    ...h,
    lastCaptureAt: now,
    pageState: 'ok',
    parser: result.jobs.length === 0 && result.rejected > 0 ? 'needs_update' : 'ok',
    lastError: result.firstError ? `Parser: ${result.firstError}` : h.lastError,
  }));
  if (result.rejected > 0) {
    await log(db, 'warn', `${result.rejected} ${SITE_NAME[msg.site]} job(s) failed validation (${msg.source}, feed ${msg.feed ?? 'auto'}): ${result.firstError ?? ''}`);
  }
  const skipped = result.jobs.length - productJobs.length;
  await log(db, 'info', `Captured ${productJobs.length} ${SITE_NAME[msg.site]} jobs from ${msg.source} (${msg.feed ?? 'network'}), ${added.length} new${skipped ? `, ${skipped} without "product" in the title skipped` : ''}`);
  if (added.length) await maybeNotify(added.length);
  // AR-15: new iimjobs jobs make sure an agent run is coming (an existing one is kept).
  if (added.length && msg.site === 'iimjobs') await scheduleAgent(false);
  broadcastChanged();
  return added.length;
}

async function maybeNotify(count: number): Promise<void> {
  const settings = await load('settings');
  if (!settings.notifyNewJobs) return;
  chrome.notifications.create('new-jobs', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title: 'New Naukri openings',
    message: `${count} new job${count === 1 ? '' : 's'} on your board`,
  });
}

// ---------- refresh (FR-2 / FR-10) ----------

/** Upper bound on pages one refresh opens, whatever the sources ask for. Each page stays open 2+ minutes. */
const MAX_LOADS_PER_REFRESH = 15;
/** Chrome stops an idle service worker after ~30 s; an extension API call this often keeps it alive mid-refresh. */
const KEEPALIVE_MS = 20_000;

interface PendingRefresh {
  resolve: (outcome: LoadOutcome) => void;
  added: number;
  /** Captures from this tab still being stored; "done" waits for them so `added` is complete. */
  inflight: Array<Promise<unknown>>;
  /** Instahyre: the saved search the page should run once it is ready. */
  savedSearch?: string;
}
const pendingRefresh = new Map<number, PendingRefresh>();

/**
 * What started a refresh, and which sites it covers: the Refresh button does all of them, Naukri's timer does
 * Naukri, and the others refresh once a day and when you open the board. LinkedIn is in none of them: the app
 * never opens it, and its jobs come only from pages you open.
 */
type Trigger = 'manual' | 'scheduled' | 'daily' | 'board';
const SITES_FOR: Record<Trigger, AppSite[]> = {
  manual: ['naukri', 'indeed', 'instahyre', 'wellfound', 'cutshort', 'foundit', 'iimjobs', 'linkedin'],
  scheduled: ['naukri'],
  daily: ['indeed', 'instahyre', 'wellfound', 'cutshort', 'foundit', 'iimjobs', 'linkedin'],
  board: ['indeed', 'instahyre', 'wellfound', 'cutshort', 'foundit', 'iimjobs', 'linkedin'],
};

/** Refreshes run one at a time; a new one waits for the current one to finish. */
let refreshChain: Promise<unknown> = Promise.resolve();
let manualInFlight: Promise<RefreshResponse> | null = null;

/** Waits that end early when refresh is halted, so a captcha stops everything at once. */
const haltWaiters = new Set<() => void>();
function wakeOnHalt(): void {
  for (const wake of haltWaiters) wake();
  haltWaiters.clear();
}
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      haltWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    haltWaiters.add(done);
  });
}

async function isHalted(): Promise<boolean> {
  return (await load('safety')).haltedAt !== null;
}

/**
 * Open one page in a background tab, wait for its captures, keep it open for at least 2 minutes plus a
 * random extra (a different one each page), then close it. A halt closes it at once.
 */
async function loadAndCapture(url: string, source: Source): Promise<{ result: LoadOutcome; added: number }> {
  // The agent and a refresh never have pages of the same site open at once: wait for an agent attempt to finish.
  const refreshSite = siteOfUrl(new URL(url));
  const agentSite = AGENT_SITES.find((s) => s === refreshSite) ?? null;
  if (agentSite) await agentIdle();
  const openedAt = Date.now();
  const stayMs = dwellMs(Math.random);
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (tabId === undefined) return { result: 'timeout', added: 0 };
  if (agentSite) refreshSiteTabs[agentSite] += 1;

  try {
    const entry: PendingRefresh = { resolve: () => undefined, added: 0, inflight: [], savedSearch: source.savedSearch };
    const result = await new Promise<LoadOutcome>((resolve) => {
      entry.resolve = resolve;
      pendingRefresh.set(tabId, entry);
      setTimeout(() => resolve('timeout'), REFRESH_TIMEOUT_MS);
    });
    pendingRefresh.delete(tabId);
    if (result === 'done' && !(await isHalted())) await delay(openedAt + stayMs - Date.now());
    return { result, added: entry.added };
  } finally {
    if (agentSite) refreshSiteTabs[agentSite] -= 1;
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

function refresh(trigger: Trigger): Promise<RefreshResponse> {
  if (trigger === 'manual' && manualInFlight) return manualInFlight;
  const run = refreshChain.then(() => runRefresh(trigger));
  refreshChain = run.catch(() => undefined);
  if (trigger === 'manual') {
    manualInFlight = run;
    run.finally(() => {
      manualInFlight = null;
    }).catch(() => undefined);
  }
  return run;
}

async function runRefresh(trigger: Trigger): Promise<RefreshResponse> {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
  try {
    return await doRefresh(trigger);
  } finally {
    clearInterval(keepAlive);
    // A Naukri refresh sets the next automatic one from now with fresh jitter; the daily run picks tomorrow.
    if (SITES_FOR[trigger].includes('naukri')) await scheduleNaukri().catch(() => undefined);
    if (trigger === 'daily') await scheduleIndeedDaily(true).catch(() => undefined);
  }
}

async function doRefresh(trigger: Trigger): Promise<RefreshResponse> {
  const now = Date.now();
  const safety = await load('safety');
  const allowed: AppSite[] = [];
  const skipped = new Set<string>();
  let retryAt: number | undefined;
  for (const site of SITES_FOR[trigger]) {
    const decision = canAppLoad(safety, now, site);
    if (decision.ok) {
      allowed.push(site);
    } else {
      skipped.add(decision.detail);
      if ('retryAt' in decision) retryAt = Math.min(retryAt ?? Infinity, decision.retryAt);
    }
  }
  const skippedText = [...skipped].join('; ');
  if (!allowed.length) {
    if (trigger === 'manual') await log(db, 'info', `Refresh skipped: ${skippedText}`);
    return { ok: false, reason: skippedText, retryAt };
  }
  let next = safety;
  for (const site of allowed) next = recordAppLoad(next, now, site);
  if (trigger === 'daily') next = { ...next, lastIndeedDailyAt: now };
  await save('safety', next);

  const loaded = await effectiveSources(await load('sources'));
  for (const e of loaded.errors) await log(db, 'warn', `Sources: ${e}`);
  const unreadable = loaded.sources.filter((src) => siteOfUrl(new URL(src.url)) === null);
  if (trigger === 'manual' && unreadable.length) {
    await log(db, 'info', `Sources: ${unreadable.length} link(s) on sites refresh cannot read yet were skipped`);
  }
  const sources = loaded.sources.filter((src) => allowed.includes(siteOfUrl(new URL(src.url))!));
  if (!sources.length) {
    const names = allowed.map((x) => SITE_NAME[x]).join(' or ');
    return { ok: false, reason: `No ${names} links to refresh from. Add one in the Sources panel.` };
  }

  const deps = { loadPage: loadAndCapture, wait: delay, isHalted };
  const { added, loads, problem, halted } = await runSources(sources, deps, {
    maxLoads: MAX_LOADS_PER_REFRESH,
    gapMs: () => pageGapMs(Math.random),
  });
  await update('health', (h) => ({ ...h, lastRefreshAt: Date.now() }));
  broadcastChanged();

  const got = added ? ` (${added} new job${added === 1 ? '' : 's'} saved)` : '';
  if (halted && problem?.result !== 'captcha') {
    const { haltReason } = await load('safety');
    return { ok: false, reason: `Stopped: ${haltReason ?? 'a captcha was shown'}. Press Resume to start again${got}.` };
  }
  if (!problem) {
    await log(db, 'info', `${trigger} refresh of ${allowed.map((x) => SITE_NAME[x]).join(' + ')} finished: ${loads} page(s), ${added} new`);
    return skipped.size ? { ok: true, added, note: skippedText } : { ok: true, added };
  }
  const name = SITE_NAME[problem.site];
  switch (problem.result) {
    case 'logged_out':
      return { ok: false, reason: `Logged out of ${name}. Log in, then refresh${got}.` };
    case 'captcha':
      return { ok: false, reason: `${name} showed a captcha. All refreshes stopped until you press Resume${got}.` };
    default:
      await update('health', (h) => ({ ...h, lastError: `${name} refresh timed out` }));
      await log(db, 'warn', `Refresh timed out waiting for a ${name} page`);
      return { ok: false, reason: `${name} took too long to load. Try again later${got}.` };
  }
}

async function handlePageState(site: Site, state: 'ok' | 'logged_out' | 'captcha', tabId: number | undefined): Promise<void> {
  // The logged-out banner is about Naukri; an Indeed page must not clear or set it.
  if (site === 'naukri' || state === 'captcha') await update('health', (h) => ({ ...h, pageState: state }));
  if (state === 'ok') {
    // A page this refresh opened: run its saved search (Instahyre), then scroll it for a few seconds, like
    // someone looking through the list.
    const pending = tabId !== undefined ? pendingRefresh.get(tabId) : undefined;
    if (tabId !== undefined && pending) {
      chrome.tabs.sendMessage(tabId, { type: 'scroll', savedSearch: pending.savedSearch }).catch(() => undefined);
    }
    // Logging back in lifts a logged-out pause. A captcha halt stays until you press Resume.
    if (site === 'naukri') await update('safety', (s) => (s.pauseReason === LOGGED_OUT ? resume(s) : s));
    return;
  }
  if (state === 'captcha') {
    await haltAll(site);
    return;
  }
  // The logout pause holds Naukri refreshes only, so only a Naukri logout sets it.
  if (site === 'naukri') {
    const now = Date.now();
    await update('safety', (s) => pause(s, now, LOGGED_OUT));
    await log(db, 'warn', `${LOGGED_OUT}; app refresh paused for 1 hour`);
  } else {
    await log(db, 'warn', `Logged out of ${SITE_NAME[site]}; log in to get its jobs again`);
  }
  if (tabId !== undefined) pendingRefresh.get(tabId)?.resolve(state);
}

/**
 * A captcha on any page, including one you opened yourself: stop everything. The scheduled refresh is
 * cancelled, a refresh in progress closes its tab and loads nothing more, and nothing restarts until Resume.
 */
async function haltAll(site: Site): Promise<void> {
  const already = (await load('safety')).haltedAt !== null;
  const reason = `${SITE_NAME[site]} showed a captcha`;
  await update('safety', (s) => (s.haltedAt !== null ? s : halt(s, Date.now(), reason)));
  await chrome.alarms.clear(ALARM_REFRESH);
  await chrome.alarms.clear(ALARM_INDEED_DAILY);
  await chrome.alarms.clear(ALARM_AGENT);
  await update('health', (h) => ({ ...h, nextAutoRefreshAt: null, nextIndeedRefreshAt: null }));
  await update('agentState', (st) => ({ ...st, nextRunAt: null }));
  for (const p of pendingRefresh.values()) p.resolve('captcha');
  agentRun?.resolve(agentFail('captcha', reason));
  wakeOnHalt();
  if (already) return;
  await log(db, 'error', `${reason}; all app refreshes stopped until you press Resume`);
  chrome.notifications.create('halted', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title: `${SITE_NAME[site]} showed a captcha`,
    message: 'Job board refreshes and auto-apply are stopped. Solve the captcha on the site if asked, then press Resume on the board.',
    priority: 2,
  });
  broadcastChanged();
}

// ---------- auto-apply agent (PRD-auto-apply) ----------

const ALARM_AGENT = 'auto-apply';
const ALARM_AGENT_SUMMARY = 'auto-apply-summary';
const AGENT_PAGE_LOAD_MS = 30_000;
/** The applier needs up to ~20 s to find the button and ~25 s per dialog step; this bounds a stuck page. */
const AGENT_REPORT_MS = 150_000;
const SUMMARY_HOUR = 21;
/** Checks that the agent still has its next run set (a sleep or a stopped worker can lose it) and keeps the laptop awake in working hours. */
const ALARM_AGENT_WATCHDOG = 'auto-apply-watchdog';
const WATCHDOG_MINUTES = 5;
/** A run still busy after this long is stuck (it hung across a sleep): the watchdog lets the next one start. */
const AGENT_STUCK_MS = 20 * 60_000;

/** The one job page the agent has open. Reports are accepted only from this tab, with this token. */
interface AgentRun {
  tabId: number;
  token: string;
  /** `iimjobs-<id>` of the job being applied to, to match iimjobs' confirmation page. */
  jobId: string;
  /** The applier has been asked to run; from now on the page leaving the job means Apply was pressed. */
  sent: boolean;
  /** The applier said it is pressing a button: a reload, a timeout or leaving the page now needs a check. */
  clicked: boolean;
  resolve: (r: ApplyReport) => void;
}
let agentRun: AgentRun | null = null;

const loadAgent = async () => normalizeAgentConfig(await load('agent'));

function agentFail(result: ApplyReport['result'], reason: string): ApplyReport {
  return { result, clicked: false, reason, questions: [], answers: [], dialogs: [] };
}

function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Set the next agent run: your gap after the last attempt on the next job's platform (shorter between different
 * platforms, which take turns), in your working hours, under the daily cap.
 * An existing alarm is kept unless `reroll` is set (after a run), so new captures do not keep moving it.
 */
async function scheduleAgent(reroll: boolean): Promise<void> {
  const [config, safety, state] = await Promise.all([loadAgent(), load('safety'), load('agentState')]);
  let when: number | null = null;
  if (config.autoApply && safety.haltedAt === null && state.haltedAt === null) {
    const existing = await chrome.alarms.get(ALARM_AGENT);
    if (existing && !reroll) {
      when = existing.scheduledTime;
    } else {
      const now = Date.now();
      const [today, all] = await Promise.all([listAttempts(db, startOfDay(now)), agentDeps.listAttempts()]);
      const queue = await agentDeps.queue(config, all);
      when = planNextRun({
        now, today, nextSite: queue[0]?.job.site ?? null, platforms: new Set(queue.map((q) => q.job.site)).size,
        gapSeconds: config.gapSeconds, cap: Infinity, rand: Math.random, hours: config,
        allCapped: config.sites.length > 0 && cappedSites(config.sites, config.dailyCap, all, now).length === config.sites.length,
      });
      // Out of AI quota: the next run is when the limit is back. A Chrome alarm also fires right after the laptop
      // wakes if that time passed while it slept, and the watchdog re-plans a lost one.
      if (config.aiApply && (state.limitUntil ?? 0) > when) when = state.limitUntil! + Math.floor(Math.random() * 60_000);
      await chrome.alarms.create(ALARM_AGENT, { when });
    }
  } else {
    await chrome.alarms.clear(ALARM_AGENT);
  }
  await update('agentState', (s) => ({ ...s, nextRunAt: when }));
  await updateKeepAwake(config.keepAwake || (config.autoApply && safety.haltedAt === null && state.haltedAt === null && inAgentHours(Date.now(), config)));
  if (config.autoApply || config.keepAwake) {
    if (!(await chrome.alarms.get(ALARM_AGENT_WATCHDOG))) await chrome.alarms.create(ALARM_AGENT_WATCHDOG, { periodInMinutes: WATCHDOG_MINUTES, delayInMinutes: 1 });
  } else {
    await chrome.alarms.clear(ALARM_AGENT_WATCHDOG);
  }

  // AR-12: the 21:00 summary notification, when turned on.
  if (config.dailySummary) {
    if (!(await chrome.alarms.get(ALARM_AGENT_SUMMARY))) {
      const at = new Date();
      at.setHours(SUMMARY_HOUR, 0, 0, 0);
      if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
      await chrome.alarms.create(ALARM_AGENT_SUMMARY, { when: at.getTime(), periodInMinutes: 24 * 60 });
    }
  } else {
    await chrome.alarms.clear(ALARM_AGENT_SUMMARY);
  }
}

/** While auto-apply is on and in its working hours, stop Windows from sleeping when idle (the screen may still turn off). */
async function updateKeepAwake(on: boolean): Promise<void> {
  if (on) chrome.power.requestKeepAwake('system');
  else chrome.power.releaseKeepAwake();
}

/**
 * After the laptop wakes (Chrome fires the overdue watchdog alarm at once) or the worker restarts: set the next
 * agent run again if it was lost, and free the agent if a run hung across the sleep.
 */
async function agentWatchdog(): Promise<void> {
  if (agentBusy && agentBusySince !== null && Date.now() - agentBusySince > AGENT_STUCK_MS) {
    await log(db, 'warn', 'Auto-apply: a run hung (likely across a sleep); starting again');
    agentBusy = false;
    agentBusySince = null;
    agentChain = Promise.resolve();
    agentRun?.resolve(agentFail('error', 'the run hung across a sleep'));
  }
  if (agentBusy) return;
  const existing = await chrome.alarms.get(ALARM_AGENT);
  // A missing alarm, or one long overdue, means the next run was lost: plan it again.
  await scheduleAgent(!existing || existing.scheduledTime < Date.now() - WATCHDOG_MINUTES * 60_000);
  broadcastChanged();
}

/** Attempts left pending by a closed browser or a stopped worker become failures, retried later (AR-14). */
async function recoverAttempts(): Promise<void> {
  const now = Date.now();
  for (const a of staleAttempts(await listAttempts(db, now - 2 * 86_400_000), now)) {
    await finishAttempt(db, a.id!, { finishedAt: now, outcome: 'failed', reason: 'interrupted (browser closed or extension restarted)' });
    await log(db, 'warn', `Auto-apply attempt for ${a.title} at ${a.company} was interrupted; it will be re-checked later`);
  }
}

async function waitForTabComplete(tabId: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return true;
    await delay(500);
  }
  return false;
}

/** The applier may still be loading when the page completes, so the request is resent until it answers. */
async function sendApplyRun(tabId: number, msg: object): Promise<boolean> {
  for (let i = 0; i < 8; i += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, msg);
      return true;
    } catch {
      await delay(1_000);
    }
  }
  return false;
}

/**
 * Open one job page in a background tab, run the site's one-click applier there (or AI apply, for a company site or a
 * site without one), then close it. A tab where AI apply filled the form and waits for your Submit stays open.
 */
/**
 * What a job page shows, read straight from the page (no content-script message): "applied" when an apply control
 * reads Applied / "Application sent!", "closed" when the page says the job no longer takes applications. Used when
 * the applier's report is missing (2026-11-10: three Instahyre applies went through but were logged "no report from
 * the job page", because the report was lost while the service worker was stopped).
 */
async function pageVerdictByScript(tabId: number, site: AgentSite, waitMs = 15_000): Promise<'applied' | 'closed' | 'unknown'> {
  const until = Date.now() + waitMs;
  for (;;) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [SITE_PAGES[site].applySelector],
      func: (selector: string) => {
        const clean = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
        const texts = [...document.querySelectorAll<HTMLElement>(selector)].filter((b) => b.getClientRects().length > 0).map((b) => clean(b.textContent));
        if (texts.some((t) => /^(applied|application sent!?|you applied|application submitted|undo\s*·\s*\d+:\d{2})$/i.test(t))) return 'applied';
        if (/no longer (accepting|available|active)|job (has )?expired|this job (is|has been) closed/i.test(clean(document.body?.innerText ?? '').slice(0, 5000))) return 'closed';
        return 'unknown';
      },
    }).catch(() => [{ result: 'unknown' as const }]);
    const v = (res?.result ?? 'unknown') as 'applied' | 'closed' | 'unknown';
    if (v !== 'unknown' || Date.now() >= until) return v;
    await delay(1_500);
  }
}

async function runInAgentTab(url: string, req: ApplyRequest): Promise<ApplyReport> {
  // Keep the service worker awake while it waits for the page's report: a stopped worker loses it (2026-11-10).
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
  try {
    return await runInAgentTabInner(url, req);
  } finally {
    clearInterval(keepAlive);
  }
}

async function runInAgentTabInner(url: string, req: ApplyRequest): Promise<ApplyReport> {
  const target = new URL(url);
  const page = jobPageOf(target.href);
  if (!page) {
    if (!req.aiApply) return agentFail('error', `not a job page on a site auto-apply supports: ${url}`);
    return runAiInNewTab(target.href, req.dryRun ? 'preview' : req.aiSubmit ? 'submit' : 'fill', { agent: true, active: false });
  }
  const tab = await chrome.tabs.create({ url: target.href, active: false });
  const tabId = tab.id;
  if (tabId === undefined) return agentFail('error', 'could not open a tab');
  let keepOpen = false;
  try {
    if (!(await waitForTabComplete(tabId, AGENT_PAGE_LOAD_MS))) return agentFail('error', 'job page did not load');
    const landed = new URL((await chrome.tabs.get(tabId)).url ?? target.href);
    if (landed.origin !== SITE_PAGES[page.site].origin) return agentFail('error', `the page moved to ${landed.hostname}`);
    if (/^\/(login|signup|accounts\/login|nlogin)\b/i.test(landed.pathname)) return agentFail('logged_out', '');
    if (!jobPageOf(landed.href)) return agentFail('closed', 'redirected away from the job page');
    if (await isHalted()) return agentFail('captcha', 'halted while loading');

    // Wellfound's Apply opens an application form with the employer's questions: its own applier answers them
    // (src/shared/ats/wellfound-flow.ts), so the one-click agent never fills that form from the answer bank.
    if (page.site === 'wellfound' && req.aiApply) {
      const ai = await runAi(tabId, landed.href, req.dryRun ? 'preview' : req.aiSubmit ? 'submit' : 'fill', { agent: true });
      keepOpen = ai.keepOpen;
      return ai.report;
    }
    const { jobId } = jobPageOf(landed.href)!;
    const token = newToken();
    const run: AgentRun = { tabId, token, jobId, sent: false, clicked: false, resolve: () => undefined };
    const result = new Promise<ApplyReport>((resolve) => {
      run.resolve = resolve;
      agentRun = run;
      setTimeout(() => resolve({ ...agentFail('error', 'no report from the job page'), clicked: run.clicked }), AGENT_REPORT_MS);
    });
    if (!(await sendApplyRun(tabId, { type: 'apply-run', token, dryRun: req.dryRun, fillForms: req.fillForms, answers: req.answers }))) {
      return agentFail('not_found', 'the applier did not start on the job page');
    }
    run.sent = true;
    let report = await result;
    agentRun = null;
    // No report from the page: read the page itself before calling it a failure.
    if (/^no report from the job page/.test(report.reason) && !req.dryRun) {
      const seen = await pageVerdictByScript(tabId, page.site, 5_000);
      if (seen === 'applied') return { ...report, result: report.clicked ? 'applied' : 'already_applied', reason: 'the job page shows it as applied (read from the page)' };
      if (seen === 'closed') return { ...report, result: 'closed', reason: 'the job is no longer accepting applications' };
    }
    // The site asked for details, or applies on the company site: AI apply takes over (a dry run only says so).
    if (req.aiApply && (report.result === 'needs_me' || report.result === 'external')) {
      if (req.dryRun) return { ...report, result: 'can_apply', reason: `dry run: AI apply would take over (${report.reason || report.result})` };
      // On iimjobs' screening form the questions are already open: answer them there; anywhere else reopen the job.
      const onScreening = screeningTabs.delete(tabId);
      if (onScreening) {
        await waitForTabComplete(tabId, AGENT_PAGE_LOAD_MS);
        await delay(1_500);
      } else {
        await chrome.tabs.update(tabId, { url: target.href });
        await delay(1_000);
        if (!(await waitForTabComplete(tabId, AGENT_PAGE_LOAD_MS))) return { ...report, reason: `${report.reason}; the page did not reload for AI apply` };
      }
      const ai = await runAi(tabId, onScreening ? ((await chrome.tabs.get(tabId)).url ?? target.href) : target.href, req.aiSubmit ? 'submit' : 'fill', { agent: true });
      keepOpen = ai.keepOpen;
      return { ...ai.report, clicked: ai.report.clicked || report.clicked, dialogs: report.dialogs };
    }
    // Anything but a clear result after pressing Apply: reload the job page and look for "Applied" there.
    if (report.clicked && !['applied', 'captcha', 'logged_out', 'stopped'].includes(report.result) && !req.dryRun) {
      report = await verifyApplied(tabId, target.href, report);
    }
    // Stay on the page a few seconds, as a person would, unless everything was just halted.
    if (report.result !== 'captcha' && !(await isHalted())) await delay(pageGapMs(Math.random));
    return report;
  } finally {
    agentRun = null;
    screeningTabs.delete(tabId);
    if (!keepOpen) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

// ---------- AI apply (src/shared/ai-apply) ----------

const FORM_ENGINE = 'form-engine.js';
/** Host access AI apply needs to read and fill forms on any site; asked for from the Agent panel. */
const ALL_SITES = { origins: ['https://*/*', 'http://*/*'] };
/** Set by the board's Stop button: the running AI apply's next click is refused. */
/** Bumped by Stop: every AI apply started before it stops at its next click (runs can be in parallel). */
let aiStopGen = 0;
/** Tabs opened by a tab AI apply is working in (an Apply button with target=_blank), newest last. */
const aiChildTabs = new Map<number, number[]>();

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined && tab.id !== undefined) aiChildTabs.get(tab.openerTabId)?.push(tab.id);
});

// ---------- real keystrokes (chrome.debugger) ----------

/** Tabs the debugger is attached to for typing. */
const debuggerTabs = new Set<number>();

/**
 * Type into the focused element with real (trusted) key events, then Tab. Workday's date boxes ignore scripted
 * values and synthetic key events; only real keys commit them (GSK wd3, 2026-11-05). Chrome shows its "started
 * debugging this browser" bar while attached; the run detaches when it ends.
 */
/**
 * A real mouse click at a point of the tab's viewport (CSS px), through chrome.debugger like typeWithDebugger: for a
 * button that ignores scripted clicks (Workday's Create Account on Cisco, 2026-11-06). Detached when the run ends.
 */
async function clickWithDebugger(tabId: number, x: number, y: number): Promise<boolean> {
  const target = { tabId };
  try {
    if (!debuggerTabs.has(tabId)) {
      await chrome.debugger.attach(target, '1.3');
      debuggerTabs.add(tabId);
    }
    const mouse = (type: string, extra: Record<string, unknown> = {}) =>
      chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
    await mouse('mouseMoved', { button: 'none', clickCount: 0 });
    await delay(80);
    await mouse('mousePressed', { buttons: 1 });
    await delay(60);
    await mouse('mouseReleased', { buttons: 0 });
    return true;
  } catch (e) {
    await log(db, 'warn', `AI apply: could not click with a real mouse press: ${String(e).slice(0, 160)}`);
    return false;
  }
}

async function typeWithDebugger(tabId: number, text: string): Promise<boolean> {
  const target = { tabId };
  try {
    if (!debuggerTabs.has(tabId)) {
      await chrome.debugger.attach(target, '1.3');
      debuggerTabs.add(tabId);
    }
    const key = async (k: string, code: string, vk: number, txt?: string) => {
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: txt, unmodifiedText: txt });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    };
    for (const ch of text) {
      const digit = /\d/.test(ch);
      await key(ch, digit ? `Digit${ch}` : `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), ch);
      await delay(40);
    }
    await key('Tab', 'Tab', 9);
    await delay(250);
    return true;
  } catch (e) {
    await log(db, 'warn', `AI apply: could not type with real keys: ${String(e).slice(0, 160)}`);
    return false;
  }
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!debuggerTabs.has(tabId)) return;
  debuggerTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

/** Inject the form engine into every frame of the tab (a second copy stays silent) and list the frames it reached. */
async function engineFrames(tabId: number): Promise<number[]> {
  const results = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [FORM_ENGINE] }), ENGINE_INJECT_MS, 'injecting the form engine',
  ).catch(() => []);
  return results.map((r) => r.frameId);
}

/**
 * Time limits for AI apply's calls into a tab. A call that never answers (seen after Submit on Greenhouse, 2026-11-05:
 * the run stopped at "Pressing Submit" and never finished) now fails, and the flow retries or ends with a reason.
 */
const ENGINE_INJECT_MS = 20_000;
/** Reading a big form opens every dropdown (Greenhouse: about 7 s for 18) and a heavy page can freeze for 45 s. */
const ENGINE_MESSAGE_MS = 90_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer from the page after ${Math.round(ms / 1000)} s (${what})`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

interface AiRunOptions {
  /** Started by the agent: its switches and halts are re-read before every click. Otherwise you started it. */
  agent: boolean;
  status?: (text: string) => void;
}

/**
 * Run AI apply in a tab that shows the job or its form. `keepOpen`: the tab should stay for you (the form waits for
 * your Submit, or you started the run). `tabId` is where the run ended, which may be a tab the Apply button opened.
 */
async function runAi(tabId: number, url: string, mode: FlowMode, opts: AiRunOptions): Promise<{ report: ApplyReport; keepOpen: boolean; tabId: number }> {
  if (!(await chrome.permissions.contains(ALL_SITES))) {
    const report = { ...agentFail('needs_me', 'AI apply needs access to all sites: press "Allow AI apply on all sites" in the Agent panel'), questions: ['Allow AI apply on all sites'] };
    return { report, keepOpen: false, tabId };
  }
  const [config, profile, backend, resume, coverLetter, memory] = await Promise.all([
    loadAgent(), load('aiProfile'), load('aiBackend'), load('aiResume'), load('aiCoverLetter'), load('formMemory'),
  ]);
  const down = await backendHealth(backend);
  if (down) return { report: agentFail('error', `AI ${down}`), keepOpen: false, tabId };

  let current = tabId;
  let frameCache: { at: number; ids: number[] } | null = null;
  aiChildTabs.set(tabId, []);
  const chainTabs = new Set<number>([tabId]);
  const stopGen = aiStopGen;
  const deps: FlowDeps = {
    frames: async () => {
      if (!frameCache || Date.now() - frameCache.at > 2_000) frameCache = { at: Date.now(), ids: await engineFrames(current) };
      return frameCache.ids;
    },
    send: (frameId, msg) => withTimeout(chrome.tabs.sendMessage(current, msg, { frameId }), ENGINE_MESSAGE_MS, String(msg.type)),
    currentUrl: async () => (await chrome.tabs.get(current)).url ?? '',
    typeTrusted: (text) => typeWithDebugger(current, text),
    clickTrusted: (x, y) => clickWithDebugger(current, x, y),
    workdayPlan: buildWorkdayPlan(normalizeProfile(profile), resume ? { name: resume.name, type: resume.type, data: resume.data } : null),
    account: await loadAccount(),
    sleep: delay,
    now: () => Date.now(),
    profile: normalizeProfile(profile),
    resume,
    coverLetter,
    memory,
    bank: config.answers,
    generate: backendClient(backend),
    saveMemory: (m) => save('formMemory', m),
    mayClick: async () => {
      if (aiStopGen !== stopGen) return 'stopped from the board';
      if (!opts.agent) return null;
      const [c, safety, state] = await Promise.all([loadAgent(), load('safety'), load('agentState')]);
      if (!c.autoApply) return 'auto-apply was turned off';
      if (c.dryRun) return 'dry run was turned on';
      if (!c.aiApply) return 'AI apply was turned off';
      if (safety.haltedAt !== null) return 'refreshes are halted';
      if (state.haltedAt !== null) return 'auto-apply is halted';
      return null;
    },
    beforeClick: async () => {
      frameCache = null;
    },
    afterApplyClick: async () => {
      // An Apply button that opens the form in a new tab: carry on there. Chains are followed too: Indeed → the
      // company's careers page (new tab) → its "Apply now" → Workday (another new tab), seen on Allstate
      // 2026-11-05, where the run stayed on the careers page and found no form.
      await delay(800);
      // Only a tab opened by the tab we are on now: falling back to the first tab's children jumped back from
      // Workday to the careers page after "Apply Manually" (no new tab) and filled the careers page's search box.
      const child = (aiChildTabs.get(current) ?? []).at(-1);
      if (child !== undefined && child !== current) {
        current = child;
        if (!aiChildTabs.has(child)) aiChildTabs.set(child, []);
        chainTabs.add(child);
        await waitForTabComplete(current, AGENT_PAGE_LOAD_MS).catch(() => false);
      }
      frameCache = null;
    },
    status: opts.status,
  };
  try {
    // The job's title and company, for the pre-submit check (a message may name the company you apply to).
    const job = await db.jobs.filter((j) => j.naukriUrl === url || j.externalUrl === url).first().catch(() => undefined);
    const report = await runAiApply(deps, { mode, job: { title: job?.title ?? '', company: job?.company ?? '', url } });
    return { report, keepOpen: !opts.agent || report.result === 'ready', tabId: current };
  } finally {
    await detachDebugger(current);
    await detachDebugger(tabId);
    // Close the extra tabs the run opened (at every hop of a chain), except the one it ended in.
    const children = [...chainTabs].flatMap((t) => aiChildTabs.get(t) ?? []);
    for (const t of chainTabs) aiChildTabs.delete(t);
    for (const child of new Set(children)) if (child !== current) await chrome.tabs.remove(child).catch(() => undefined);
  }
}

/**
 * Your career-site account (dist/account.json, built from ACCOUNT_EMAIL / ACCOUNT_PASSWORD in .env by
 * scripts/build.mjs), or null. Read fresh per run and never logged.
 */
async function loadAccount(): Promise<{ email: string; password: string } | null> {
  try {
    const res = await fetch(chrome.runtime.getURL('account.json'));
    if (!res.ok) return null;
    const a = (await res.json()) as { email?: unknown; password?: unknown };
    return typeof a.email === 'string' && typeof a.password === 'string' && a.email && a.password ? { email: a.email, password: a.password } : null;
  } catch {
    return null;
  }
}

/** Saves an answer you gave on a form to form memory, marked as yours (one write at a time). */
let memoryWrites: Promise<void> = Promise.resolve();
function rememberYourAnswer(label: string, answer: string, host: string): Promise<void> {
  memoryWrites = memoryWrites.then(async () => {
    const memory = await load('formMemory');
    const key = normalizeLabel(label);
    if (memory[key]?.answer === answer && memory[key]?.by === 'you') return;
    await save('formMemory', rememberAnswers(memory, [{ label, answer }], Date.now(), 'you'));
    await log(db, 'info', `Remembered your answer on ${host}: "${label.slice(0, 80)}" → "${answer.slice(0, 80)}"`);
  }).catch(() => undefined);
  return memoryWrites;
}

/** Open `url` in a new tab and run AI apply there. An agent tab closes afterwards unless a filled form waits in it. */
async function runAiInNewTab(url: string, mode: FlowMode, opts: AiRunOptions & { active: boolean }): Promise<ApplyReport> {
  const tab = await chrome.tabs.create({ url, active: opts.active });
  const tabId = tab.id;
  if (tabId === undefined) return agentFail('error', 'could not open a tab');
  let keep = !opts.agent;
  let lastTab = tabId;
  try {
    if (!(await waitForTabComplete(tabId, AGENT_PAGE_LOAD_MS))) return agentFail('error', 'the page did not load');
    if (opts.agent && (await isHalted())) return agentFail('stopped', 'halted while loading');
    const ai = await runAi(tabId, url, mode, opts);
    keep = ai.keepOpen;
    lastTab = ai.tabId;
    if (opts.agent && ai.report.result !== 'ready') await delay(pageGapMs(Math.random));
    return ai.report;
  } finally {
    if (!keep) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
      if (lastTab !== tabId) await chrome.tabs.remove(lastTab).catch(() => undefined);
    } else if (lastTab !== tabId) {
      // The form moved to a tab the Apply button opened; the posting tab is no longer needed.
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }
}

/**
 * "Apply with AI" from the board, on a board job or any URL (a company career page): runs now in a tab you can watch,
 * whatever the agent's switches, and is logged like an agent attempt. Presses Submit only when "AI apply presses
 * Submit" is on; otherwise it stops at the final step for you.
 */
let manualRuns = 0;
async function runAiManual(url: string, jobId: string | null): Promise<unknown> {
  {
    manualRuns += 1;
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
    try {
      const job = jobId ? await db.jobs.get(jobId) : undefined;
      const host = new URL(url).hostname.replace(/^www\./, '');
      const config = await loadAgent();
      const id = await addAttempt(db, {
        jobId: job?.jobId ?? `url-${host}`, title: job?.title ?? url, company: job?.company ?? host, startedAt: Date.now(), finishedAt: null,
        mode: 'live', matched: ['started by you (Apply with AI)'], answers: [], questions: [], clicked: false, outcome: 'pending', reason: '',
      });
      broadcastChanged();
      const report = await runAiInNewTab(url, config.aiSubmit ? 'submit' : 'fill', {
        agent: false, active: true, status: (t) => { noteAgentCheck(`AI apply: ${t}`).then(broadcastChanged).catch(() => undefined); },
      }).catch((e: unknown) => agentFail('error', String(e).slice(0, 200)));
      const outcome = manualOutcome(report.result);
      await finishAttempt(db, id, { finishedAt: Date.now(), outcome, reason: report.reason, clicked: report.clicked, answers: report.answers, questions: report.questions });
      if (outcome === 'applied' && job) await setStatus(db, job.jobId, 'applied', Date.now(), 'agent');
      // An expired job leaves the board.
      if (report.result === 'closed' && job) await setStatus(db, job.jobId, 'dismissed', Date.now());
      await log(db, outcome === 'failed' ? 'warn' : 'info', `AI apply ${outcome.replace('_', ' ')}: ${job?.title ?? url}. ${report.reason}`);
      await noteAgentCheck(`AI apply: ${outcome.replace('_', ' ')} (${report.reason || 'done'})`);
    } finally {
      manualRuns -= 1;
      clearInterval(keepAlive);
      broadcastChanged();
    }
  }
  return undefined;
}

/**
 * After a click without a clear answer, reload the job page and check it without clicking (a dry run). If the page
 * now shows Applied, the apply went through.
 */
async function verifyApplied(tabId: number, url: string, report: ApplyReport): Promise<ApplyReport> {
  try {
    await chrome.tabs.update(tabId, { url });
    await delay(1_000);
    if (!(await waitForTabComplete(tabId, AGENT_PAGE_LOAD_MS))) return report;
    const landed = await chrome.tabs.get(tabId);
    const where = jobPageOf(landed.url ?? url);
    const jobId = where?.jobId;
    if (!jobId) return report;
    // Read the reloaded page directly first: it does not depend on the applier's message getting through.
    const direct = await pageVerdictByScript(tabId, where.site);
    if (direct === 'applied') return { ...report, result: 'applied', reason: 'job page shows Applied after reload' };
    if (direct === 'closed') return { ...report, result: 'closed', reason: 'the job is no longer accepting applications' };
    const token = newToken();
    const check = new Promise<ApplyReport>((resolve) => {
      agentRun = { tabId, token, jobId, sent: false, clicked: false, resolve };
      setTimeout(() => resolve(agentFail('error', 'no report')), 60_000);
    });
    if (!(await sendApplyRun(tabId, { type: 'apply-run', token, dryRun: true, fillForms: false, answers: [] }))) return report;
    const seen = await check;
    if (seen.result === 'already_applied') return { ...report, result: 'applied', reason: 'job page shows Applied after reload' };
    return { ...report, reason: `${report.reason}; after reload the page shows ${seen.result.replace('_', ' ')}` };
  } finally {
    agentRun = null;
  }
}

const agentDeps: RunDeps = {
  now: () => Date.now(),
  rand: Math.random,
  loadConfig: loadAgent,
  loadSafety: () => load('safety'),
  loadState: () => load('agentState'),
  saveState: (s) => save('agentState', s),
  listAttempts: () => listAttempts(db, Date.now() - ATTEMPT_RETENTION_MS),
  queue: async (config, attempts) => {
    const [jobs, statuses, hideWords] = await Promise.all([db.jobs.toArray(), db.statuses.toArray(), load('hiddenTitleWords')]);
    return buildQueue(jobs, statuses, attempts, config, hideWords, Date.now());
  },
  addAttempt: (a) => addAttempt(db, a),
  finishAttempt: (id, patch) => finishAttempt(db, id, patch),
  markApplied: async (jobId, by) => {
    await setStatus(db, jobId, 'applied', Date.now(), by);
  },
  dismiss: async (jobId) => {
    await setStatus(db, jobId, 'dismissed', Date.now());
  },
  runInTab: runInAgentTab,
  haltAll: () => haltAll('iimjobs'),
  log: (level, message) => log(db, level, message),
};

/** Pages of each agent site a refresh has open right now; the agent waits while its next site has any. */
const refreshSiteTabs: Record<AgentSite, number> = { iimjobs: 0, instahyre: 0, naukri: 0, wellfound: 0 };
/** Agent runs go one at a time, on their own chain: a long refresh of other sites must not hold them up. */
let agentChain: Promise<unknown> = Promise.resolve();
let agentBusy = false;
let agentBusySince: number | null = null;
const AGENT_BUSY_RETRY_MS = 2 * 60_000;

/** Resolves once no agent attempt is running (a refresh calls it before opening an iimjobs page). */
async function agentIdle(): Promise<void> {
  while (agentBusy) await delay(2_000);
}

/** Why a run did nothing, in words for the board and the log. */
async function explainNoRun(reason: NoRunReason): Promise<string> {
  switch (reason) {
    case 'off': return 'Auto-apply is off';
    case 'halted': return 'Stopped; press Resume';
    case 'night': {
      const c = await loadAgent();
      return `Outside working hours; runs ${hoursLabel(c)}`;
    }
    case 'cap': return 'Every platform has reached its daily page limit; continues tomorrow';
    case 'spacing': return 'Waiting for the gap between applications on the same platform';
    case 'limit': {
      const st = await load('agentState');
      return `AI usage limit reached; continues by itself after ${new Date(st.limitUntil ?? Date.now()).toLocaleString()}`;
    }
    default: {
      const [config, jobs, statuses, attempts, hideWords] = await Promise.all([
        loadAgent(), db.jobs.toArray(), db.statuses.toArray(), listAttempts(db, Date.now() - ATTEMPT_RETENTION_MS), load('hiddenTitleWords'),
      ]);
      return explainEmptyQueue(jobs, statuses, attempts, config, hideWords, Date.now());
    }
  }
}

/** Record what the last run did, for the header and the Agent panel; a new kind of result also goes to the log. */
async function noteAgentCheck(text: string): Promise<void> {
  const prev = await load('agentState');
  await save('agentState', { ...prev, lastCheckAt: Date.now(), lastCheck: text });
  if (prev.lastCheck !== text) await log(db, 'info', `Auto-apply: ${text}`);
}

/** One agent run. It waits only while a refresh has an iimjobs page open, then tries again in 2 minutes. */
function runAgent(opts: { ignoreGap?: boolean } = {}): Promise<unknown> {
  const run = agentChain.then(async () => {
    const onSites = (await loadAgent()).sites;
    const busySite = AGENT_SITES.find((s) => refreshSiteTabs[s] > 0 && onSites.includes(s));
    if (busySite) {
      await noteAgentCheck(`Waiting for a refresh to close its ${SITE_PAGES[busySite].name} page`);
      await chrome.alarms.create(ALARM_AGENT, { when: Date.now() + AGENT_BUSY_RETRY_MS });
      await update('agentState', (s) => ({ ...s, nextRunAt: Date.now() + AGENT_BUSY_RETRY_MS }));
      broadcastChanged();
      return;
    }
    agentBusy = true;
    agentBusySince = Date.now();
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
    try {
      await recoverAttempts();
      const result = await runOnce(agentDeps, opts);
      await noteAgentCheck(result.ran ? `Last attempt: ${result.outcome.replace('_', ' ')}` : await explainNoRun(result.reason));
    } finally {
      agentBusy = false;
      agentBusySince = null;
      clearInterval(keepAlive);
      broadcastChanged();
      await scheduleAgent(true).catch(() => undefined);
    }
  });
  agentChain = run.catch(() => undefined);
  return run;
}

async function notifySummary(): Promise<void> {
  const from = startOfDay(Date.now());
  const s = summarize(await listAttempts(db, from), from);
  const parts = [`${s.applied} applied`, `${s.needsMe} need you`, `${s.failed} failed`];
  if (s.wouldApply) parts.push(`${s.wouldApply} would apply (dry run)`);
  chrome.notifications.create('agent-summary', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title: 'iimjobs auto-apply today',
    message: parts.join(', '),
  });
}

// ---------- message routing ----------

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromBoard = sender.url?.startsWith(BOARD_URL) ?? false;

  if (fromBoard) {
    const parsed = BoardMessage.safeParse(raw);
    if (!parsed.success) return false;
    const msg = parsed.data;
    if (msg.type === 'refresh') {
      refresh('manual').then(sendResponse, (e: unknown) => sendResponse({ ok: false, reason: String(e) }));
      return true;
    }
    if (msg.type === 'board-opened') {
      load('settings').then((s) => (s.indeedOnBoardOpen ? refresh('board') : undefined)).catch(() => undefined);
      return false;
    }
    if (msg.type === 'resume') {
      update('safety', resume)
        .then(() => update('agentState', (st) => ({ ...st, haltedAt: null, haltReason: null, notFoundStreak: 0 })))
        .then(() => log(db, 'info', 'Refresh and auto-apply resumed'))
        .then(schedule)
        .then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'ai-apply') {
      // Applies you start run in parallel, each in its own tab, alongside the agent.
      runAiManual(msg.url, msg.jobId).catch((e: unknown) => log(db, 'error', `AI apply failed: ${String(e)}`));
      sendResponse({ ok: true, running: manualRuns + 1 });
      return false;
    }
    if (msg.type === 'ai-apply-stop') {
      aiStopGen += 1;
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'agent-run-now') {
      // Still bound by the switch, halts, waking hours and the daily limit; only the 3 to 8 minute gap is skipped.
      chrome.alarms.clear(ALARM_AGENT).then(() => runAgent({ ignoreGap: true })).catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'reschedule') {
      // Agent settings may have changed (switch, cap), so its next run is picked again.
      schedule().then(() => scheduleAgent(true)).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  }

  // Your own answer on an application form, from the form engine in a tab the agent works in (any career site, not
  // only the job boards): remembered as yours, so the agent gives it next time (user, 2026-11-06).
  if (sender.tab && (raw as { type?: unknown })?.type === 'user-answer') {
    const parsed = CollectorMessage.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'user-answer') return false;
    const { label, answer, host } = parsed.data;
    rememberYourAnswer(label, answer, host).catch(() => undefined);
    return false;
  }

  // Everything else must come from our content script on one of the job sites.
  const site = siteOfSender(sender.url);
  if (!sender.tab || !site) return false;
  const parsed = CollectorMessage.safeParse(raw);
  if (!parsed.success) return false;
  const msg = parsed.data;
  if ('site' in msg && msg.site !== site) return false;
  const tabId = sender.tab.id;

  switch (msg.type) {
    case 'capture': {
      const p = tabId !== undefined ? pendingRefresh.get(tabId) : undefined;
      const work = handleCapture(msg).then((added) => {
        if (p) p.added += added;
      }).catch((e: unknown) => log(db, 'error', `Capture failed: ${String(e)}`));
      p?.inflight.push(work);
      break;
    }
    case 'capture-done':
      if (tabId !== undefined) {
        // Give the last relayed messages a moment to arrive, then wait for every capture to be stored,
        // so the refresh knows how many jobs this page added before deciding whether to load the next page.
        setTimeout(() => {
          const p = pendingRefresh.get(tabId);
          if (p) Promise.allSettled(p.inflight).then(() => p.resolve('done'));
        }, 1_000);
      }
      break;
    case 'page-state':
      handlePageState(site, msg.state, tabId).catch(() => undefined);
      break;
    case 'saved-search-missing': {
      const text = `Instahyre saved search "${msg.name}" was not found on the opportunities page`;
      update('health', (h) => ({ ...h, lastError: text }))
        .then(() => log(db, 'warn', `${text}; check the name in the Sources panel`))
        .then(broadcastChanged)
        .catch(() => undefined);
      break;
    }
    case 'apply-progress':
      if (site !== 'linkedin' && agentRun && tabId === agentRun.tabId && msg.token === agentRun.token) agentRun.clicked = true;
      break;
    case 'apply-report':
      // Only the tab the agent opened, with the token it was given, can report a result.
      if ((AGENT_SITES as string[]).includes(site) && agentRun && tabId === agentRun.tabId && msg.token === agentRun.token) {
        const { type: _type, token: _token, ...report } = msg;
        agentRun.resolve(report);
      }
      break;
    case 'applied-detected':
      db.jobs.get(msg.jobId).then(async (job) => {
        if (!job) return;
        await setStatus(db, msg.jobId, 'applied', Date.now());
        await log(db, 'info', `Detected apply on Naukri: ${job.title} at ${job.company}`);
        broadcastChanged();
      }).catch(() => undefined);
      break;
  }
  return false;
});

// ---------- lifecycle ----------

/**
 * Load your job-apply-ai-mvp data (seed/ai-seed.json, bundled by the build) once per seed version. Your own edits
 * win: a saved profile or an uploaded file is kept, and remembered answers are merged.
 */
async function loadAiSeed(): Promise<void> {
  const res = await fetch(chrome.runtime.getURL('ai-seed.json')).catch(() => null);
  if (!res?.ok) return;
  const seed = (await res.json()) as AiSeed;
  if (!Number.isFinite(seed.version) || (await load('aiSeedVersion')) === seed.version) return;
  const stored = await chrome.storage.local.get('aiProfile');
  const [memory, resume, coverLetter] = await Promise.all([load('formMemory'), load('aiResume'), load('aiCoverLetter')]);
  const patch = seedPatch(seed, {
    profileSaved: stored.aiProfile !== undefined,
    savedProfile: stored.aiProfile !== undefined ? normalizeProfile(stored.aiProfile) : undefined,
    memory, resume, coverLetter,
  });
  if (patch.profile) await save('aiProfile', patch.profile);
  if (patch.memory) await save('formMemory', patch.memory);
  if (patch.resume) await save('aiResume', patch.resume);
  if (patch.coverLetter) await save('aiCoverLetter', patch.coverLetter);
  await save('aiSeedVersion', seed.version);
  const what = [patch.profile && 'profile', patch.memory && `${Object.keys(patch.memory).length - Object.keys(memory).length} remembered answers`, patch.resume && 'resume', patch.coverLetter && 'cover letter'].filter(Boolean);
  if (what.length) await log(db, 'info', `AI apply: loaded your job-apply-ai-mvp data (${what.join(', ')})`);
}

chrome.runtime.onInstalled.addListener(() => {
  loadAiSeed().catch((e: unknown) => log(db, 'warn', `AI apply: could not load seed data: ${String(e)}`));
  schedule().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  loadAiSeed().catch(() => undefined);
  schedule().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Chrome fires alarms it missed while closed on the next start; outside 9:00-22:00, pick a new time instead.
  if (alarm.name === ALARM_REFRESH) {
    if (inActiveHours(Date.now())) refresh('scheduled').catch(() => undefined);
    else scheduleNaukri().catch(() => undefined);
  }
  if (alarm.name === ALARM_INDEED_DAILY) {
    if (inActiveHours(Date.now())) refresh('daily').catch(() => undefined);
    else scheduleIndeedDaily(true).catch(() => undefined);
  }
  if (alarm.name === ALARM_AGENT) runAgent().catch(() => undefined);
  if (alarm.name === ALARM_AGENT_WATCHDOG) agentWatchdog().catch(() => undefined);
  if (alarm.name === ALARM_AGENT_SUMMARY) notifySummary().catch(() => undefined);
  if (alarm.name === ALARM_PURGE) {
    purge(db, Date.now())
      .then((n) => (n ? log(db, 'info', `Purged ${n} jobs older than 60 days`) : undefined))
      .then(broadcastChanged)
      .catch(() => undefined);
  }
});

// After Apply, iimjobs leaves the job page for its confirmation page, which ends the applier on the old page. Watch
// the agent's tab instead: the confirmation for this job means applied; any other move (to another page or another
// job) gets checked by reopening the job page.
/** Agent tabs that moved to iimjobs' screening form after Apply: AI apply answers it there, without reloading. */
const screeningTabs = new Set<number>();

function isIimjobsScreening(raw: string, jobId: string): boolean {
  try {
    const u = new URL(raw);
    return u.hostname === 'www.iimjobs.com' && u.pathname.replace(/\/$/, '') === `/job/${jobId.replace(/^iimjobs-/, '')}/screening`;
  } catch {
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  const run = agentRun;
  if (!run || tabId !== run.tabId || !run.sent) return;
  // The same page reloading after Apply (Instahyre does) ends the applier mid-run: check by reopening the job.
  if (!change.url && change.status === 'loading' && run.clicked) {
    run.resolve({ ...agentFail('no_confirmation', 'the job page reloaded after Apply'), clicked: true });
    return;
  }
  if (!change.url) return;
  // iimjobs asks screening questions after Apply on /job/<id>/screening ("current / expected salary in LPA", then
  // Next): a form, not a failure. AI apply answers it on that page (2026-11-10: 2 jobs were logged "page moved to
  // /job/<id>/screening after Apply" and never applied).
  if (isIimjobsScreening(change.url, run.jobId)) {
    screeningTabs.add(tabId);
    run.resolve({ ...agentFail('needs_me', 'iimjobs screening questions after Apply'), clicked: true });
    return;
  }
  // Naukri opens its confirmation page on failure too: only its 200 for this job is "applied", and its message is kept.
  const naukri = naukriApplyResult(change.url, run.jobId);
  if (naukri.status === 'failed') {
    run.resolve({ ...agentFail('error', naukri.message), clicked: true });
  } else if (confirmedJobIds(change.url).includes(run.jobId)) {
    run.resolve({ ...agentFail('applied', naukri.status === 'applied' ? naukri.message : `${new URL(change.url).hostname.replace(/^www\./, '')} confirmed: application submitted`), clicked: true });
  } else if (jobPageOf(change.url)?.jobId !== run.jobId || run.clicked) {
    // Left this job's page, to another page or another job, or reloaded it after Apply: check by reopening the job.
    run.resolve({ ...agentFail('no_confirmation', `page moved to ${new URL(change.url).pathname} after Apply`), clicked: run.clicked || jobPageOf(change.url)?.jobId !== run.jobId });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (agentRun?.tabId === tabId) agentRun.resolve(agentFail('error', 'the job page tab was closed'));
});

chrome.action.onClicked.addListener(() => {
  openBoard().catch(() => undefined);
});

chrome.notifications.onClicked.addListener(() => {
  openBoard().catch(() => undefined);
});

/** Once: switch the agent to "apply to every matching job" (your request of 2026-11-04). Later changes in the panel stay. */
async function switchToApplyEverywhere(): Promise<void> {
  if ((await load('agentEverywhereAt')) !== null) return;
  const next = applyEverywhere(await loadAgent());
  await save('agent', next);
  await save('agentEverywhereAt', Date.now());
  await log(db, 'info', `Auto-apply: now applies to every matching job on all platforms (one-click and company sites, live, AI presses Submit), ${hoursLabel(next)}`);
  await scheduleAgent(true);
  broadcastChanged();
}

// Every worker start (also after the laptop wakes): make sure the agent's next run and keep-awake are in place.
switchToApplyEverywhere().catch(() => undefined).then(() => agentWatchdog()).catch(() => undefined);
