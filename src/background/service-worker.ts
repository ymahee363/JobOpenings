import { getDb } from '../db/db';
import { log, markAppliedFromSite, purge, setStatus, upsertJobs } from '../db/repo';
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

  const { added } = await upsertJobs(db, result.jobs, now);
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
  await log(db, 'info', `Captured ${result.jobs.length} ${SITE_NAME[msg.site]} jobs from ${msg.source} (${msg.feed ?? 'network'}), ${added.length} new`);
  if (added.length) await maybeNotify(added.length);
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
  manual: ['naukri', 'indeed', 'instahyre', 'wellfound', 'cutshort', 'foundit', 'iimjobs'],
  scheduled: ['naukri'],
  daily: ['indeed', 'instahyre', 'wellfound', 'cutshort', 'foundit', 'iimjobs'],
  board: ['indeed', 'instahyre', 'wellfound', 'cutshort', 'foundit', 'iimjobs'],
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
  // Belt and braces: sources never accept LinkedIn, but make sure the app can never open it.
  if (/(^|\.)linkedin\.com$/i.test(new URL(url).hostname)) return { result: 'timeout', added: 0 };
  const openedAt = Date.now();
  const stayMs = dwellMs(Math.random);
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (tabId === undefined) return { result: 'timeout', added: 0 };

  const entry: PendingRefresh = { resolve: () => undefined, added: 0, inflight: [], savedSearch: source.savedSearch };
  const result = await new Promise<LoadOutcome>((resolve) => {
    entry.resolve = resolve;
    pendingRefresh.set(tabId, entry);
    setTimeout(() => resolve('timeout'), REFRESH_TIMEOUT_MS);
  });
  pendingRefresh.delete(tabId);
  if (result === 'done' && !(await isHalted())) await delay(openedAt + stayMs - Date.now());
  await chrome.tabs.remove(tabId).catch(() => undefined);
  return { result, added: entry.added };
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
  await update('health', (h) => ({ ...h, nextAutoRefreshAt: null, nextIndeedRefreshAt: null }));
  for (const p of pendingRefresh.values()) p.resolve('captcha');
  wakeOnHalt();
  if (already) return;
  await log(db, 'error', `${reason}; all app refreshes stopped until you press Resume`);
  chrome.notifications.create('halted', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title: `${SITE_NAME[site]} showed a captcha`,
    message: 'Job board refreshes are stopped. Solve the captcha on the site if asked, then press Resume on the board.',
    priority: 2,
  });
  broadcastChanged();
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
        .then(() => log(db, 'info', 'Refresh resumed'))
        .then(schedule)
        .then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'reschedule') {
      schedule().then(() => sendResponse({ ok: true }));
      return true;
    }
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

chrome.runtime.onInstalled.addListener(() => {
  schedule().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
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
  if (alarm.name === ALARM_PURGE) {
    purge(db, Date.now())
      .then((n) => (n ? log(db, 'info', `Purged ${n} jobs older than 60 days`) : undefined))
      .then(broadcastChanged)
      .catch(() => undefined);
  }
});

chrome.action.onClicked.addListener(() => {
  openBoard().catch(() => undefined);
});

chrome.notifications.onClicked.addListener(() => {
  openBoard().catch(() => undefined);
});
