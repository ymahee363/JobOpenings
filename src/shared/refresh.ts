/** The refresh sequence over the source list. Pure apart from the injected page loader, so it can be unit tested. */
import { siteOfUrl, sourcePageUrl, type Source } from './sources';
import type { Site } from './types';

export type LoadOutcome = 'done' | 'logged_out' | 'captcha' | 'timeout';

export interface RefreshDeps {
  /** Open a page of `source`, wait for its captures, close it. */
  loadPage: (url: string, source: Source) => Promise<{ result: LoadOutcome; added: number }>;
  wait: (ms: number) => Promise<void>;
  /** Checked before every page: true once refresh was halted (a captcha on any page, even one you opened). */
  isHalted: () => Promise<boolean>;
}

export interface RefreshOptions {
  maxLoads: number;
  /** Pause before each page after the first; called each time so every gap can differ. */
  gapMs: () => number;
}

export interface RefreshRun {
  added: number;
  loads: number;
  /** The first page that did not load cleanly. */
  problem: { site: Site; result: Exclude<LoadOutcome, 'done'> } | null;
  /** Refresh stopped early because it was halted. */
  halted: boolean;
}

/**
 * Load each source in order. A search's later pages load only while the previous page still turned up new
 * jobs, so a routine refresh usually stops after page 1. A captcha stops everything; a logout skips that
 * site's remaining sources; a timeout moves on to the next source. A halt (captcha anywhere) stops it before
 * the next page. At most `maxLoads` pages in total.
 */
export async function runSources(sources: Source[], deps: RefreshDeps, opts: RefreshOptions): Promise<RefreshRun> {
  const run: RefreshRun = { added: 0, loads: 0, problem: null, halted: false };
  const loggedOut = new Set<Site>();
  for (const source of sources) {
    if (!source.enabled) continue;
    const site = siteOfUrl(new URL(source.url));
    if (!site || loggedOut.has(site)) continue;
    for (let page = 1; page <= source.maxPages; page++) {
      const url = sourcePageUrl(source.url, page);
      if (!url || run.loads >= opts.maxLoads) break;
      if (run.loads > 0) await deps.wait(opts.gapMs());
      if (await deps.isHalted()) {
        run.halted = true;
        return run;
      }
      run.loads += 1;
      const outcome = await deps.loadPage(url, source);
      run.added += outcome.added;
      if (outcome.result !== 'done') {
        run.problem ??= { site, result: outcome.result };
        if (outcome.result === 'captcha') return run;
        if (outcome.result === 'logged_out') loggedOut.add(site);
        break;
      }
      if (outcome.added === 0) break;
    }
  }
  return run;
}
