import { describe, expect, it } from 'vitest';
import { runSources, type LoadOutcome } from '../src/shared/refresh';
import type { Source } from '../src/shared/sources';

const RECO = 'https://www.naukri.com/mnjuser/recommendedjobs';
const SEARCH = 'https://www.naukri.com/product-manager-jobs?k=pm';
const INDEED = 'https://in.indeed.com/?from=gnav-homepage--homepage-frontend';
const INDEED_SEARCH = 'https://in.indeed.com/jobs?q=pm';

const src = (url: string, maxPages = 1, enabled = true): Source => ({ url, maxPages, enabled });
const OPTS = { maxLoads: 40, gapMs: () => 7_000 };

/** A fake loader: `plan` maps a URL prefix to the outcomes of its successive loads. */
function harness(
  plan: (url: string, nth: number) => { result?: LoadOutcome; added?: number },
  haltAfterLoads = Infinity,
) {
  const loaded: string[] = [];
  const waits: number[] = [];
  const counts = new Map<string, number>();
  const deps = {
    loadPage: async (url: string) => {
      loaded.push(url);
      const n = (counts.get(url) ?? 0) + 1;
      counts.set(url, n);
      const p = plan(url, n);
      return { result: p.result ?? 'done', added: p.added ?? 0 };
    },
    wait: async (ms: number) => {
      waits.push(ms);
    },
    isHalted: async () => loaded.length >= haltAfterLoads,
  };
  return { deps, loaded, waits };
}

describe('runSources', () => {
  it('loads each source in order, with a gap between pages but not before the first', async () => {
    const h = harness(() => ({ added: 2 }));
    const run = await runSources([src(RECO), src(INDEED)], h.deps, OPTS);
    expect(h.loaded).toEqual([RECO, INDEED]);
    expect(h.waits).toEqual([7_000]);
    expect(run).toEqual({ added: 4, loads: 2, problem: null, halted: false });
  });

  it('pages a search newest first while pages keep adding jobs, up to maxPages', async () => {
    const h = harness(() => ({ added: 20 }));
    const run = await runSources([src(SEARCH, 3)], h.deps, OPTS);
    expect(h.loaded).toEqual([
      'https://www.naukri.com/product-manager-jobs?k=pm&sort=f',
      'https://www.naukri.com/product-manager-jobs-2?k=pm&sort=f',
      'https://www.naukri.com/product-manager-jobs-3?k=pm&sort=f',
    ]);
    expect(run.added).toBe(60);
  });

  it('stops paging at the first page with nothing new', async () => {
    const h = harness((url) => ({ added: url.includes('jobs-2') ? 0 : 5 }));
    await runSources([src(SEARCH, 10), src(INDEED_SEARCH, 2)], h.deps, OPTS);
    expect(h.loaded).toEqual([
      'https://www.naukri.com/product-manager-jobs?k=pm&sort=f',
      'https://www.naukri.com/product-manager-jobs-2?k=pm&sort=f',
      'https://in.indeed.com/jobs?q=pm&sort=date',
      'https://in.indeed.com/jobs?q=pm&sort=date&start=10',
    ]);
  });

  it('loads non-search pages once even if maxPages is higher', async () => {
    const h = harness(() => ({ added: 5 }));
    await runSources([src(RECO, 5)], h.deps, OPTS);
    expect(h.loaded).toEqual([RECO]);
  });

  it('skips disabled sources', async () => {
    const h = harness(() => ({}));
    await runSources([src(RECO, 1, false), src(INDEED)], h.deps, OPTS);
    expect(h.loaded).toEqual([INDEED]);
  });

  it('stops everything on a captcha and reports it', async () => {
    const h = harness((url) => ({ result: url === RECO ? 'captcha' : 'done', added: 1 }));
    const run = await runSources([src(RECO), src(INDEED)], h.deps, OPTS);
    expect(h.loaded).toEqual([RECO]);
    expect(run.problem).toEqual({ site: 'naukri', result: 'captcha' });
  });

  it("skips a logged-out site's other sources but still refreshes the other site", async () => {
    const h = harness((url) => ({ result: url === RECO ? 'logged_out' : 'done', added: 3 }));
    const run = await runSources([src(RECO), src(SEARCH, 5), src(INDEED)], h.deps, OPTS);
    expect(h.loaded).toEqual([RECO, INDEED]);
    expect(run.problem).toEqual({ site: 'naukri', result: 'logged_out' });
    expect(run.added).toBe(6);
  });

  it('moves on to the next source after a timeout, keeping the first problem', async () => {
    const h = harness((url) => ({ result: url.includes('indeed') ? 'timeout' : 'done', added: 1 }));
    const run = await runSources([src(INDEED_SEARCH, 3), src(RECO), src(INDEED)], h.deps, OPTS);
    expect(h.loaded).toEqual(['https://in.indeed.com/jobs?q=pm&sort=date', RECO, INDEED]);
    expect(run.problem).toEqual({ site: 'indeed', result: 'timeout' });
  });

  it('never opens more than maxLoads pages in one refresh', async () => {
    const h = harness(() => ({ added: 1 }));
    const run = await runSources([src(SEARCH, 20), src(INDEED_SEARCH, 20)], h.deps, { maxLoads: 5, gapMs: () => 0 });
    expect(run.loads).toBe(5);
    expect(h.loaded).toHaveLength(5);
  });

  it('does nothing for an empty list', async () => {
    const h = harness(() => ({}));
    expect(await runSources([], h.deps, OPTS)).toEqual({ added: 0, loads: 0, problem: null, halted: false });
  });

  it('asks for a fresh gap before every page after the first', async () => {
    const gaps = [5_000, 19_000, 11_000];
    const h = harness(() => ({ added: 1 }));
    await runSources([src(RECO), src(SEARCH, 2), src(INDEED)], h.deps, { maxLoads: 40, gapMs: () => gaps.shift()! });
    expect(h.waits).toEqual([5_000, 19_000, 11_000]);
  });

  it('stops before the next page once halted, even mid-search', async () => {
    // A captcha on a page you opened yourself halts refresh while this one is between pages.
    const h = harness(() => ({ added: 20 }), 2);
    const run = await runSources([src(SEARCH, 10), src(INDEED)], h.deps, OPTS);
    expect(h.loaded).toHaveLength(2);
    expect(run.halted).toBe(true);
    expect(run.problem).toBeNull();
  });

  it('loads nothing if already halted', async () => {
    const h = harness(() => ({}), 0);
    const run = await runSources([src(RECO)], h.deps, OPTS);
    expect(h.loaded).toEqual([]);
    expect(run).toEqual({ added: 0, loads: 0, problem: null, halted: true });
  });
});
