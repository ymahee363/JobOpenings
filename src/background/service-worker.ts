import { getDb } from '../db/db';
import { log, purge, setStatus, upsertJobs } from '../db/repo';
import { BoardMessage, CollectorMessage, DB_CHANGED, type RefreshResponse } from '../shared/messages';
import { parseCapture } from '../shared/parse';
import { canAppLoad, clampRefreshMinutes, pause, recordAppLoad, REFRESH_TIMEOUT_MS, resume } from '../shared/safety';
import { load, save, update } from '../shared/store';
import { RECOMMENDED_JOBS_URL, searchPageUrl } from '../shared/url';

const db = getDb();
const BOARD_URL = chrome.runtime.getURL('board.html');
const ALARM_REFRESH = 'refresh';
const ALARM_PURGE = 'purge';
const LOGGED_OUT = 'Logged out of Naukri';

// ---------- helpers ----------

function broadcastChanged(): void {
  chrome.runtime.sendMessage({ type: DB_CHANGED }).catch(() => undefined);
}

async function schedule(): Promise<void> {
  const settings = await load('settings');
  await chrome.alarms.clear(ALARM_REFRESH);
  if (settings.autoRefresh) {
    await chrome.alarms.create(ALARM_REFRESH, { periodInMinutes: clampRefreshMinutes(settings.refreshMinutes) });
  }
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

async function handleCapture(msg: Extract<CollectorMessage, { type: 'capture' }>): Promise<number> {
  const now = Date.now();
  const result = parseCapture(msg.payload, msg.feed, now);
  if (result.jobs.length === 0 && result.rejected === 0) return 0;

  const { added } = await upsertJobs(db, result.jobs, now);
  await update('health', (h) => ({
    ...h,
    lastCaptureAt: now,
    pageState: 'ok',
    parser: result.jobs.length === 0 && result.rejected > 0 ? 'needs_update' : 'ok',
    lastError: result.firstError ? `Parser: ${result.firstError}` : h.lastError,
  }));
  if (result.rejected > 0) {
    await log(db, 'warn', `${result.rejected} job(s) failed validation (${msg.source}, feed ${msg.feed ?? 'auto'}): ${result.firstError ?? ''}`);
  }
  await log(db, 'info', `Captured ${result.jobs.length} jobs from ${msg.source} (${msg.feed ?? 'network'}), ${added.length} new`);
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

/** Search results come 20 per page; the saved search has about 150 jobs. */
const MAX_SEARCH_PAGES = 10;
/** Pause between page loads within one refresh, so it reads like someone paging through. */
const PAGE_GAP_MS = 3_000;

interface PendingRefresh {
  resolve: (outcome: LoadOutcome) => void;
  added: number;
}
const pendingRefresh = new Map<number, PendingRefresh>();
let refreshInFlight: Promise<RefreshResponse> | null = null;

type LoadOutcome = 'done' | 'logged_out' | 'captcha' | 'timeout';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Open one Naukri page in a background tab, wait for its captures, then close it. */
async function loadAndCapture(url: string): Promise<{ result: LoadOutcome; added: number }> {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (tabId === undefined) return { result: 'timeout', added: 0 };

  const entry: PendingRefresh = { resolve: () => undefined, added: 0 };
  const result = await new Promise<LoadOutcome>((resolve) => {
    entry.resolve = resolve;
    pendingRefresh.set(tabId, entry);
    setTimeout(() => resolve('timeout'), REFRESH_TIMEOUT_MS);
  });
  pendingRefresh.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => undefined);
  return { result, added: entry.added };
}

async function refresh(trigger: 'manual' | 'scheduled'): Promise<RefreshResponse> {
  refreshInFlight ??= doRefresh(trigger).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(trigger: 'manual' | 'scheduled'): Promise<RefreshResponse> {
  const now = Date.now();
  const safety = await load('safety');
  const decision = canAppLoad(safety, now);
  if (!decision.ok) {
    if (trigger === 'manual') await log(db, 'info', `Refresh skipped: ${decision.detail}`);
    return { ok: false, reason: decision.detail, retryAt: decision.retryAt };
  }
  await save('safety', recordAppLoad(safety, now));

  // Recommended feeds first, then the saved search newest first. Later search pages load only while
  // the previous page still turned up new jobs, so a routine refresh usually stops after page 1.
  let added = 0;
  let outcome = await loadAndCapture(RECOMMENDED_JOBS_URL);
  added += outcome.added;
  for (let page = 1; outcome.result === 'done' && page <= MAX_SEARCH_PAGES; page++) {
    await delay(PAGE_GAP_MS);
    outcome = await loadAndCapture(searchPageUrl(page));
    added += outcome.added;
    if (outcome.added === 0) break;
  }
  await update('health', (h) => ({ ...h, lastRefreshAt: Date.now() }));

  switch (outcome.result) {
    case 'done':
      await log(db, 'info', `${trigger} refresh finished, ${added} new`);
      broadcastChanged();
      return { ok: true, added };
    case 'logged_out':
      return { ok: false, reason: 'Logged out of Naukri. Log in, then refresh.' };
    case 'captcha':
      return { ok: false, reason: 'Naukri showed a captcha. App refresh paused for 1 hour.' };
    default:
      await update('health', (h) => ({ ...h, lastError: 'Refresh timed out' }));
      await log(db, 'warn', 'Refresh timed out waiting for the Naukri page');
      return { ok: false, reason: 'Naukri took too long to load. Try again later.' };
  }
}

async function handlePageState(state: 'ok' | 'logged_out' | 'captcha', tabId: number | undefined): Promise<void> {
  await update('health', (h) => ({ ...h, pageState: state }));
  if (state === 'ok') {
    // Logging back in lifts a logged-out pause; a captcha pause always runs its full hour.
    await update('safety', (s) => (s.pauseReason === LOGGED_OUT ? resume(s) : s));
    return;
  }
  const now = Date.now();
  const reason = state === 'captcha' ? 'Naukri showed a captcha' : LOGGED_OUT;
  await update('safety', (s) => pause(s, now, reason));
  await log(db, state === 'captcha' ? 'error' : 'warn', `${reason}; app refresh paused for 1 hour`);
  if (tabId !== undefined) pendingRefresh.get(tabId)?.resolve(state);
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
    if (msg.type === 'resume') {
      update('safety', resume).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'reschedule') {
      schedule().then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  }

  // Everything else must come from our content script on www.naukri.com.
  if (!sender.tab || !sender.url?.startsWith('https://www.naukri.com/')) return false;
  const parsed = CollectorMessage.safeParse(raw);
  if (!parsed.success) return false;
  const msg = parsed.data;
  const tabId = sender.tab.id;

  switch (msg.type) {
    case 'capture':
      handleCapture(msg).then((added) => {
        const p = tabId !== undefined ? pendingRefresh.get(tabId) : undefined;
        if (p) p.added += added;
      }).catch((e: unknown) => log(db, 'error', `Capture failed: ${String(e)}`));
      break;
    case 'capture-done':
      if (tabId !== undefined) {
        // Give in-flight capture writes a moment to land before closing the tab.
        setTimeout(() => pendingRefresh.get(tabId)?.resolve('done'), 1_000);
      }
      break;
    case 'page-state':
      handlePageState(msg.state, tabId).catch(() => undefined);
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

chrome.runtime.onInstalled.addListener(() => {
  schedule().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  schedule().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REFRESH) refresh('scheduled').catch(() => undefined);
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
