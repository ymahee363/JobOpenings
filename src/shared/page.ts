// Page-level helpers for the content scripts. Dependency-free (constants only) so the scripts stay tiny.
import { SEARCH_API_RE } from './constants';

export type PageSite = 'naukri' | 'indeed' | 'instahyre' | 'wellfound';
export type PageStateValue = 'ok' | 'logged_out' | 'captcha';

export function siteOfHost(hostname: string): PageSite {
  if (hostname.endsWith('indeed.com')) return 'indeed';
  if (hostname.endsWith('instahyre.com')) return 'instahyre';
  if (hostname.endsWith('wellfound.com')) return 'wellfound';
  return 'naukri';
}

/**
 * Is this a logged-out or bot-check page? `text` is the start of the page's visible text.
 * Cloudflare's "Just a moment…" is matched only in the title on Indeed, Instahyre and Wellfound (all behind
 * Cloudflare): loading text on a normal page must not
 * look like a captcha, since a captcha stops all refreshes until you resume.
 */
export function detectPageState(site: PageSite, pathname: string, title: string, text: string): PageStateValue {
  if (site === 'naukri' && /\/(nlogin|login)\b/i.test(pathname)) return 'logged_out';
  if ((site === 'instahyre' || site === 'wellfound') && /^\/(login|signup)\b/i.test(pathname)) return 'logged_out';
  const all = `${title} ${text}`;
  if (/captcha|are you a robot|unusual traffic|access denied/i.test(all)) return 'captcha';
  if (site !== 'naukri') {
    if (/^\s*just a moment/i.test(title)) return 'captcha';
    if (/verify you are human|additional verification required/i.test(all)) return 'captcha';
  }
  return 'ok';
}

/**
 * Feed name for a hook capture. Naukri feeds are named by the parser from the response; Indeed's by page;
 * Instahyre's and Wellfound's are all searches.
 */
export function feedForCapture(site: PageSite, pathname: string, url: string): string | null {
  if (site === 'instahyre') return 'instahyre-search';
  if (site === 'wellfound') return 'wellfound-search';
  if (site === 'indeed') return pathname.startsWith('/jobs') ? 'indeed-search' : 'indeed-home';
  return SEARCH_API_RE.test(url) ? 'search' : null;
}

export interface ScrollStep {
  /** Wait before this step. At least 900 ms: Chrome runs timers in background tabs about once a second. */
  waitMs: number;
  /** Pixels to scroll; negative scrolls back up. */
  dy: number;
}

/**
 * A scroll session for a page the app opened: 5 to 12 seconds of uneven steps, mostly down with an
 * occasional step back up. `rand` returns numbers in [0, 1); production passes Math.random.
 */
export function scrollPlan(rand: () => number): ScrollStep[] {
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
  const totalMs = between(5_000, 12_000);
  const steps: ScrollStep[] = [];
  let elapsed = 0;
  while (true) {
    const waitMs = between(900, 2_200);
    if (elapsed + waitMs > totalMs) break;
    elapsed += waitMs;
    const up = steps.length > 0 && rand() < 0.15;
    steps.push({ waitMs, dy: up ? -between(80, 300) : between(250, 750) });
  }
  return steps;
}

/** The job-cards models Indeed embeds in `window.mosaic.providerData` (homepage and search pages). */
export function indeedModelsFrom(providerData: unknown): unknown[] {
  if (!providerData || typeof providerData !== 'object') return [];
  const models: unknown[] = [];
  for (const [key, value] of Object.entries(providerData)) {
    if (!key.startsWith('mosaic-provider-jobcards')) continue;
    const model = (value as { metaData?: { mosaicProviderJobCardsModel?: unknown } } | null)?.metaData
      ?.mosaicProviderJobCardsModel;
    if (model) models.push(model);
  }
  return models;
}

/**
 * The "Search" link of the saved search called `name` (case and spacing ignored) in Instahyre's
 * "Saved Searches" box, or null if it is not on the page (yet).
 */
export function findSavedSearchLink(root: ParentNode, name: string): HTMLElement | null {
  const want = name.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const title of root.querySelectorAll<HTMLElement>('.search-title')) {
    if ((title.textContent ?? '').trim().replace(/\s+/g, ' ').toLowerCase() !== want) continue;
    const link = title.parentElement?.querySelector<HTMLElement>('.search-btn a');
    if (link) return link;
  }
  return null;
}
