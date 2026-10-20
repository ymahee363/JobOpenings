/**
 * Runs in the page's own JS world (MAIN) at document_start on naukri.com.
 * It wraps fetch and XHR so we can read the recom-jobs feed responses the page already requests.
 * It never sends requests of its own and never changes what the page receives.
 */
import { CAPTURE_URL_RE, HOOK_TAG, MAX_CAPTURE_CHARS } from '../shared/constants';

function forward(url: string, text: string): void {
  if (text.length > MAX_CAPTURE_CHARS) return;
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

const originalFetch = window.fetch;
window.fetch = async function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
  const response = await originalFetch.apply(this, args);
  try {
    const url = urlOf(args[0]);
    if (CAPTURE_URL_RE.test(url) && response.ok) {
      response.clone().text().then((t) => forward(url, t), () => undefined);
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
  if (url && CAPTURE_URL_RE.test(url)) {
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
