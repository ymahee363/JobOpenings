/**
 * Isolated-world content script on naukri.com. It:
 *  1. relays feed responses from the MAIN-world hook to the service worker,
 *  2. reads the feeds Naukri caches in localStorage,
 *  3. reports logged-out or captcha pages, and
 *  4. on job pages, reports when Naukri shows the job as applied.
 */
import { FEED_CACHE_KEY_RE, HOOK_TAG, SEARCH_API_RE } from '../shared/constants';
import type { CollectorMessage } from '../shared/messages';
import { jobIdFromJobPath } from '../shared/url';

const SETTLE_MS = 3_000;
const APPLY_WATCH_MS = 30 * 60_000;

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
  const feed = SEARCH_API_RE.test(data.url) ? 'search' : null;
  send({ type: 'capture', source: 'network', feed, url: data.url.slice(0, 2048), payload: data.body });
});

// 2. Read feeds Naukri cached in localStorage.
function readCachedFeeds(): void {
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
      send({ type: 'capture', source: 'storage', feed: m[1] ?? null, url: location.href, payload: parsed.value });
    } catch {
      // Malformed cache entry; skip it.
    }
  }
}

// 3. Page state.
function pageState(): 'ok' | 'logged_out' | 'captcha' {
  if (/\/(nlogin|login)\b/i.test(location.pathname)) return 'logged_out';
  const text = `${document.title} ${document.body?.innerText.slice(0, 2_000) ?? ''}`;
  if (/captcha|are you a robot|unusual traffic|access denied/i.test(text)) return 'captcha';
  return 'ok';
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
  send({ type: 'page-state', state, url: location.href });
  if (state !== 'ok') return;

  const jobId = jobIdFromJobPath(location.pathname);
  if (jobId) watchForApplied(jobId);

  // Let the page finish its feed requests and cache writes, then read the cache and report done.
  setTimeout(() => {
    readCachedFeeds();
    send({ type: 'capture-done', url: location.href });
  }, SETTLE_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady, { once: true });
} else {
  onReady();
}
