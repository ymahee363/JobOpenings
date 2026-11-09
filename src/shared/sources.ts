/**
 * The pages refresh loads. Defaults come from sources.json at the project root (copied into dist by the build);
 * once you edit the list in the board's Sources panel, your copy in chrome.storage is used instead.
 */
import { z } from 'zod';
import type { AppSite } from './types';

export const MAX_PAGES_PER_SOURCE = 20;

/** The site of a link refresh reads jobs from, or null for any other link (saved, but refresh cannot read it yet). */
export function siteOfUrl(url: URL): AppSite | null {
  if (url.protocol !== 'https:') return null;
  if (url.hostname === 'www.naukri.com') return 'naukri';
  if (url.hostname === 'in.indeed.com') return 'indeed';
  if (url.hostname === 'www.instahyre.com') return 'instahyre';
  if (url.hostname === 'wellfound.com') return 'wellfound';
  if (url.hostname === 'cutshort.io') return 'cutshort';
  if (url.hostname === 'www.foundit.in') return 'foundit';
  if (url.hostname === 'www.iimjobs.com') return 'iimjobs';
  if (url.hostname === 'www.linkedin.com' || url.hostname === 'linkedin.com') return 'linkedin';
  return null;
}

function siteOf(raw: string): AppSite | null {
  try {
    return siteOfUrl(new URL(raw));
  } catch {
    return null;
  }
}

const Source = z.object({
  name: z.string().max(200).optional(),
  url: z.string().max(4096).refine((u) => {
    try {
      return new URL(u.trim()).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https link'),
  /**
   * Instahyre only: the name of a saved search to run once the page opens. Instahyre ignores the filters in a
   * pasted search link and shows recommended jobs instead, so refresh clicks the saved search.
   */
  savedSearch: z.string().trim().min(1).max(200).optional(),
  maxPages: z.number().int().min(1).max(MAX_PAGES_PER_SOURCE).default(1),
  enabled: z.boolean().default(true),
}).superRefine((s, ctx) => {
  const instahyre = siteOf(s.url) === 'instahyre';
  if (instahyre && !s.savedSearch) {
    ctx.addIssue({ code: 'custom', path: ['savedSearch'], message: 'is needed for Instahyre links (the name of one of your saved searches)' });
  }
  if (!instahyre && s.savedSearch) {
    ctx.addIssue({ code: 'custom', path: ['savedSearch'], message: 'works only with Instahyre links' });
  }
});
export type Source = z.infer<typeof Source>;

export const SourcesFile = z.object({ sources: z.array(Source).min(1) }).passthrough();

/**
 * Naukri search pages have paths like /product-manager-jobs or /jobs-in-pune; account pages (/mnjuser/...)
 * and job pages (/job-listings-...) are not searches.
 */
function isNaukriSearch(url: URL): boolean {
  // City slugs are letters only, so a pasted page-2 link (/pm-jobs-in-pune-2) is not paged again.
  return /^\/[a-z0-9-]*jobs(-in-[a-z-]+)?\/?$/i.test(url.pathname);
}

function isIndeedSearch(url: URL): boolean {
  return url.pathname === '/jobs';
}

function isFounditSearch(url: URL): boolean {
  return url.pathname.startsWith('/search/');
}

/**
 * The URL of result page `page` (1-based) of a source, sorted newest first unless the link sets a sort.
 * Naukri puts the page in the path (/product-manager-jobs-2); Indeed uses start=10, 20, …; foundit start=1, 2, …
 * Returns null when the source is not a paged search and page > 1.
 */
export function sourcePageUrl(raw: string, page: number): string | null {
  const url = new URL(raw);
  const site = siteOfUrl(url);
  if (site === 'naukri' && isNaukriSearch(url)) {
    if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'f');
    if (page > 1) url.pathname = `${url.pathname.replace(/\/$/, '')}-${page}`;
    return url.href;
  }
  if (site === 'indeed' && isIndeedSearch(url)) {
    if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'date');
    if (page > 1) url.searchParams.set('start', String((page - 1) * 10));
    else url.searchParams.delete('start');
    return url.href;
  }
  // foundit's `start` is the page number (1, 2, …); its jobFreshness filter keeps results recent.
  if (site === 'foundit' && isFounditSearch(url)) {
    url.searchParams.set('start', String(page));
    return url.href;
  }
  return page === 1 ? url.href : null;
}

/** Validate one entry, e.g. a link added in the board. */
export function parseSource(item: unknown): { ok: true; source: Source } | { ok: false; error: string } {
  const parsed = Source.safeParse(item);
  if (parsed.success) return { ok: true, source: parsed.data };
  return { ok: false, error: parsed.error.issues.map((x) => `${x.path.join('.') || 'entry'} ${x.message}`).join('; ') };
}

/** List edits used by the Sources panel. Each returns a new list. */
export function addSource(
  list: Source[],
  entry: { url: string; name?: string; maxPages?: number; savedSearch?: string },
): { ok: true; list: Source[] } | { ok: false; error: string } {
  const name = entry.name?.trim();
  const savedSearch = entry.savedSearch?.trim();
  const parsed = parseSource({
    url: entry.url.trim(), maxPages: entry.maxPages, ...(name ? { name } : {}), ...(savedSearch ? { savedSearch } : {}),
  });
  if (!parsed.ok) return parsed;
  // Instahyre sources share one page and differ by saved search.
  const key = `${new URL(parsed.source.url).href} ${parsed.source.savedSearch?.toLowerCase() ?? ''}`;
  if (list.some((s) => `${new URL(s.url).href} ${s.savedSearch?.toLowerCase() ?? ''}` === key)) {
    return { ok: false, error: 'That link is already in the list.' };
  }
  return { ok: true, list: [...list, parsed.source] };
}

export function updateSource(list: Source[], index: number, patch: Partial<Pick<Source, 'name' | 'maxPages' | 'enabled'>>): Source[] {
  return list.map((s, i) => {
    if (i !== index) return s;
    const next = { ...s, ...patch };
    if (!next.name) delete next.name;
    next.maxPages = clampPages(next.maxPages);
    return next;
  });
}

export function moveSource(list: Source[], index: number, by: -1 | 1): Source[] {
  const to = index + by;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

export function removeSource(list: Source[], index: number): Source[] {
  return list.filter((_, i) => i !== index);
}

/** Page counts typed in the panel: whole numbers from 1 to MAX_PAGES_PER_SOURCE. */
export function clampPages(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_PAGES_PER_SOURCE, Math.max(1, n)) : 1;
}

export interface LoadedSources {
  /** Enabled entries, in order: what refresh loads. */
  sources: Source[];
  /** Every valid entry, disabled ones included: what the Sources panel shows. */
  all: Source[];
  /** Problems with individual entries; those entries are skipped. */
  errors: string[];
}

/** Validate a parsed sources list. Bad entries are skipped and reported rather than failing the whole list. */
export function readSources(data: unknown): LoadedSources {
  const list = (data as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(list)) return { sources: [], all: [], errors: ['sources.json has no "sources" list'] };
  const all: Source[] = [];
  const errors: string[] = [];
  list.forEach((item, i) => {
    const parsed = parseSource(item);
    if (parsed.ok) all.push(parsed.source);
    else errors.push(`sources[${i}]: ${parsed.error}`);
  });
  return { sources: all.filter((s) => s.enabled), all, errors };
}

/** The defaults bundled from sources.json. */
export async function fetchDefaultSources(): Promise<LoadedSources> {
  try {
    const res = await fetch(chrome.runtime.getURL('sources.json'));
    return readSources(await res.json());
  } catch (e) {
    return { sources: [], all: [], errors: [`could not read sources.json: ${String(e)}`] };
  }
}

/** Your edited list if you have one, else the sources.json defaults. */
export function effectiveSources(stored: Source[] | null): Promise<LoadedSources> {
  return stored ? Promise.resolve(readSources({ sources: stored })) : fetchDefaultSources();
}
