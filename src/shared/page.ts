// Page-level helpers for the content scripts. Dependency-free (constants only) so the scripts stay tiny.
import { SEARCH_API_RE } from './constants';

export type PageSite = 'naukri' | 'indeed' | 'instahyre' | 'wellfound' | 'linkedin' | 'cutshort' | 'foundit' | 'iimjobs';
export type PageStateValue = 'ok' | 'logged_out' | 'captcha';

export function siteOfHost(hostname: string): PageSite {
  if (hostname.endsWith('indeed.com')) return 'indeed';
  if (hostname.endsWith('instahyre.com')) return 'instahyre';
  if (hostname.endsWith('wellfound.com')) return 'wellfound';
  if (hostname.endsWith('cutshort.io')) return 'cutshort';
  if (hostname.endsWith('foundit.in')) return 'foundit';
  if (hostname.endsWith('iimjobs.com')) return 'iimjobs';
  if (hostname.endsWith('linkedin.com')) return 'linkedin';
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
  if ((site === 'instahyre' || site === 'wellfound' || site === 'cutshort' || site === 'iimjobs') && /^\/(login|signup)\b/i.test(pathname)) {
    return 'logged_out';
  }
  if (site === 'foundit' && /^\/(rio\/)?login\b/i.test(pathname)) return 'logged_out';
  if (site === 'linkedin') {
    // LinkedIn's security check ("Let's do a quick security check") lives under /checkpoint/challenge.
    if (/^\/checkpoint\/challenge/i.test(pathname)) return 'captcha';
    if (/^\/(login|authwall|uas\/login|signup)\b/i.test(pathname)) return 'logged_out';
  }
  const all = `${title} ${text}`;
  if (/captcha|are you a robot|unusual traffic|access denied/i.test(all)) return 'captcha';
  if (site !== 'naukri') {
    if (/^\s*just a moment/i.test(title)) return 'captcha';
    if (/verify you are human|additional verification required/i.test(all)) return 'captcha';
  }
  return 'ok';
}

/**
 * Captures to drop. iimjobs first runs a search with the experience range from your profile (minexp=7&maxexp=10)
 * before the unfiltered one; you asked for no experience filter, so any iimjobs search with a range is ignored.
 */
export function ignoredCapture(site: PageSite, url: string): boolean {
  if (site !== 'iimjobs') return false;
  try {
    const q = new URL(url, 'https://gladiator.iimjobs.com').searchParams;
    return Number(q.get('minexp') ?? 0) > 0 || Number(q.get('maxexp') ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Feed name for a hook capture. Naukri feeds are named by the parser from the response; Indeed's by page;
 * the other sites' captures are all searches.
 */
export function feedForCapture(site: PageSite, pathname: string, url: string): string | null {
  if (site === 'instahyre') return 'instahyre-search';
  if (site === 'wellfound') return 'wellfound-search';
  if (site === 'cutshort') return 'cutshort-search';
  if (site === 'foundit') return 'foundit-search';
  if (site === 'iimjobs') return 'iimjobs-search';
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

export interface LinkedInCard {
  jobId: string;
  lines: string[];
}

const LINKEDIN_CARD_KEY = /^job-card-component-ref-(\d{5,20})$/;

/**
 * The LinkedIn job cards rendered on the page: `div[componentkey="job-card-component-ref-<jobId>"]`, with the
 * visible text split into lines. Cards LinkedIn has not rendered yet (far down the list) are skipped.
 */
export function linkedInCardsFrom(root: ParentNode): LinkedInCard[] {
  const cards: LinkedInCard[] = [];
  const seen = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>('[componentkey^="job-card-component-ref-"]')) {
    const jobId = LINKEDIN_CARD_KEY.exec(el.getAttribute('componentkey') ?? '')?.[1];
    if (!jobId || seen.has(jobId)) continue;
    const lines = (el.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60);
    if (lines.length < 3) continue;
    seen.add(jobId);
    cards.push({ jobId, lines: lines.map((s) => s.slice(0, 500)) });
  }
  return cards;
}
