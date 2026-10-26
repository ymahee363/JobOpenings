/**
 * Runs in the page's own JS world (MAIN) at document_start on the job sites.
 * It wraps fetch and XHR so we can read the job responses the page already requests: Naukri's recom-jobs
 * and search calls, Indeed's GraphQL job cards, Instahyre's job-search results and Wellfound's GraphQL job
 * search. On Indeed it also forwards the job lists the page embeds in `window.mosaic.providerData`.
 * It never sends requests of its own and never changes what the page receives.
 */
import {
  CAPTURE_URL_RE, HOOK_TAG, INDEED_CAPTURE_URL_RE, INSTAHYRE_CAPTURE_URL_RE, MAX_CAPTURE_CHARS, WELLFOUND_CAPTURE_URL_RE,
} from '../shared/constants';
import { indeedModelsFrom, siteOfHost } from '../shared/page';

const site = siteOfHost(location.hostname);
const isIndeed = site === 'indeed';
const CAPTURE_RE = {
  naukri: CAPTURE_URL_RE, indeed: INDEED_CAPTURE_URL_RE, instahyre: INSTAHYRE_CAPTURE_URL_RE, wellfound: WELLFOUND_CAPTURE_URL_RE,
};
const captureRe = CAPTURE_RE[site];

function forward(url: string, text: string): void {
  if (text.length > MAX_CAPTURE_CHARS) return;
  // Most Indeed and Wellfound GraphQL calls are not job lists; skip them before parsing.
  if (isIndeed && !text.includes('jobkey')) return;
  if (site === 'wellfound' && !text.includes('highlightedJobListings')) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return;
  }
  window.postMessage({ tag: HOOK_TAG, url, body }, window.location.origin);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wellfound's GraphQL client aborts each request once it has read the response, which also cancels a clone
 * we are still reading. So forward the text the page itself reads: same body, same result for the page.
 */
function readAlongsidePage(response: Response, url: string): void {
  const text = response.text.bind(response);
  response.text = () => text().then((t) => {
    try {
      forward(url, t);
    } catch {
      // Never break the page.
    }
    return t;
  });
  response.json = () => response.text().then((t) => JSON.parse(t) as unknown);
}

const originalFetch = window.fetch;
window.fetch = async function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
  const response = await originalFetch.apply(this, args);
  try {
    const url = urlOf(args[0]);
    if (captureRe.test(url) && response.ok) {
      if (site === 'wellfound') readAlongsidePage(response, url);
      else response.clone().text().then((t) => forward(url, t), () => undefined);
    }
  } catch {
    // Never break the page.
  }
  return response;
};

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const urls = new WeakMap<XMLHttpRequest, string>();

XMLHttpRequest.prototype.open = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]) {
  try {
    urls.set(this, String(args[1]));
  } catch {
    // ignore
  }
  return (originalOpen as (...a: unknown[]) => void).apply(this, args);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const url = urls.get(this);
  if (url && captureRe.test(url)) {
    this.addEventListener('load', () => {
      try {
        if (this.status >= 200 && this.status < 300 && (this.responseType === '' || this.responseType === 'text')) {
          forward(url, this.responseText);
        }
      } catch {
        // ignore
      }
    });
  }
  return originalSend.call(this, body);
};

// Indeed renders its first job cards from data embedded in the page rather than a request. Read it once the
// page's scripts have run; if it is not there yet (scripts still loading), try again at window load.
if (isIndeed) {
  const postEmbedded = (): boolean => {
    try {
      const models = indeedModelsFrom((window as { mosaic?: { providerData?: unknown } }).mosaic?.providerData);
      for (const body of models) window.postMessage({ tag: HOOK_TAG, url: location.href, body }, window.location.origin);
      return models.length > 0;
    } catch {
      return true; // Never break the page, and do not retry.
    }
  };
  document.addEventListener('DOMContentLoaded', () => {
    if (!postEmbedded()) window.addEventListener('load', () => postEmbedded(), { once: true });
  }, { once: true });
}
