/**
 * Isolated-world content script on the job sites. It:
 *  1. relays feed responses from the MAIN-world hook to the service worker,
 *  2. reads the feeds Naukri caches in localStorage (Naukri only),
 *  3. reports logged-out or captcha pages,
 *  4. on job pages, reports when Naukri shows the job as applied, and
 *  5. when the service worker asks (only on pages the app opened itself), runs an Instahyre saved search and
 *     scrolls the page for a few seconds.
 */
import { FEED_CACHE_KEY_RE, HOOK_TAG } from '../shared/constants';
import type { CollectorMessage } from '../shared/messages';
import { detectPageState, feedForCapture, findSavedSearchLink, scrollPlan, siteOfHost } from '../shared/page';
import { jobIdFromJobPath } from '../shared/url';

const SETTLE_MS = 3_000;
/** How long to wait for Instahyre's "Saved Searches" box, which loads after the page. */
const SAVED_SEARCH_WAIT_MS = 15_000;
/** After clicking a saved search, time for its results to arrive. */
const SAVED_SEARCH_SETTLE_MS = 4_000;
const APPLY_WATCH_MS = 30 * 60_000;
const site = siteOfHost(location.hostname);

function send(msg: CollectorMessage): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // Extension was reloaded; this page's script is orphaned.
  }
}

// 1. Relay hook captures. Only accept messages from this window with our tag.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { tag?: unknown; url?: unknown; body?: unknown } | null;
  if (!data || data.tag !== HOOK_TAG || typeof data.url !== 'string') return;
  send({ type: 'capture', site, source: 'network', feed: feedForCapture(site, location.pathname, data.url), url: data.url.slice(0, 2048), payload: data.body });
});

// 2. Read feeds Naukri cached in localStorage.
function readCachedFeeds(): void {
  if (site !== 'naukri') return;
  let keys: string[];
  try {
    keys = Object.keys(window.localStorage);
  } catch {
    return;
  }
  for (const key of keys) {
    const m = FEED_CACHE_KEY_RE.exec(key);
    if (!m) continue;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as { value?: unknown; expiry?: unknown } | null;
      if (!parsed || parsed.value === undefined) continue;
      if (typeof parsed.expiry === 'number' && parsed.expiry < Date.now()) continue;
      send({ type: 'capture', site, source: 'storage', feed: m[1] ?? null, url: location.href, payload: parsed.value });
    } catch {
      // Malformed cache entry; skip it.
    }
  }
}

// 3. Page state.
function pageState(): 'ok' | 'logged_out' | 'captcha' {
  return detectPageState(site, location.pathname, document.title, document.body?.innerText.slice(0, 2_000) ?? '');
}

// 4. Applied detection on job pages. Unverified against a real apply: the board also asks "Applied?".
function watchForApplied(jobId: string): void {
  let reported = false;
  const check = (): boolean => {
    if (reported) return true;
    const candidates = document.querySelectorAll<HTMLElement>('button, [id*="apply" i], [class*="apply" i]');
    for (const el of candidates) {
      const text = el.textContent?.trim() ?? '';
      if (/^applied$/i.test(text) || /successfully applied|application (has been )?(sent|submitted)/i.test(text)) {
        reported = true;
        send({ type: 'applied-detected', jobId });
        return true;
      }
    }
    return false;
  };
  if (check()) return;
  const observer = new MutationObserver(() => {
    if (check()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(() => observer.disconnect(), APPLY_WATCH_MS);
}

function onReady(): void {
  const state = pageState();
  send({ type: 'page-state', site, state, url: location.href });
  if (state !== 'ok') return;

  const jobId = jobIdFromJobPath(location.pathname);
  if (jobId) watchForApplied(jobId);

  // Let the page finish its feed requests and cache writes (and any requested scrolling, which can load
  // more jobs), then read the cache and report done.
  setTimeout(() => {
    (scrolling ?? Promise.resolve()).then(() => {
      readCachedFeeds();
      send({ type: 'capture-done', url: location.href });
    });
  }, SETTLE_MS);
}

// 5. Saved search and scroll on request. The service worker sends this only to tabs it opened for a refresh,
// never to yours.
let scrolling: Promise<void> | null = null;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Instahyre ignores the filters in a pasted search link and shows recommended jobs instead, so click the saved
 * search by name, as you would. The hook captures the results it loads.
 */
async function runSavedSearch(name: string): Promise<void> {
  const until = Date.now() + SAVED_SEARCH_WAIT_MS;
  let link = findSavedSearchLink(document, name);
  while (!link && Date.now() < until) {
    await wait(500);
    link = findSavedSearchLink(document, name);
  }
  if (!link) {
    send({ type: 'saved-search-missing', name });
    return;
  }
  link.click();
  await wait(SAVED_SEARCH_SETTLE_MS);
}

async function scrollAround(): Promise<void> {
  for (const step of scrollPlan(Math.random)) {
    await wait(step.waitMs);
    window.scrollBy({ top: step.dy, left: 0, behavior: 'auto' });
  }
}

try {
  chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
    const m = msg as { type?: unknown; savedSearch?: unknown } | null;
    if (sender.id !== chrome.runtime.id || m?.type !== 'scroll') return false;
    const savedSearch = site === 'instahyre' && typeof m.savedSearch === 'string' ? m.savedSearch : null;
    scrolling ??= (savedSearch ? runSavedSearch(savedSearch) : Promise.resolve())
      .then(scrollAround)
      .catch(() => undefined);
    return false;
  });
} catch {
  // Extension was reloaded; this page's script is orphaned.
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady, { once: true });
} else {
  onReady();
}
