import { afterEach, describe, expect, it, vi } from 'vitest';
import file from '../sources.json';
import {
  addSource, clampPages, effectiveSources, fetchDefaultSources, MAX_PAGES_PER_SOURCE, moveSource, parseSource, readSources,
  removeSource, sourcePageUrl, updateSource, type Source,
} from '../src/shared/sources';

describe('sources.json', () => {
  it('is valid and lists the default links', () => {
    const { sources, errors } = readSources(file);
    expect(errors).toEqual([]);
    expect(sources.map((s) => new URL(s.url).hostname))
      .toEqual(['www.naukri.com', 'www.naukri.com', 'in.indeed.com', 'www.instahyre.com', 'wellfound.com', 'cutshort.io', 'www.foundit.in', 'www.iimjobs.com']);
    expect(sources[3]!.savedSearch).toBe('PM BLR WFH');
  });
});

describe('LinkedIn links', () => {
  it('are never accepted as sources, so refresh can never open LinkedIn', () => {
    const url = 'https://www.linkedin.com/jobs/search-results/?keywords=%22Product%20manager%22&f_TPR=r86400&f_AL=true';
    const r = parseSource({ url });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/the app never opens LinkedIn/) });
    expect(parseSource({ url: 'https://linkedin.com/jobs/' }).ok).toBe(false);
    expect(addSource([], { url }).ok).toBe(false);
    expect(readSources({ sources: [{ url }] }).sources).toEqual([]);
  });
});

describe('Wellfound sources', () => {
  it('accept wellfound.com links and load one page', () => {
    expect(parseSource({ url: 'https://wellfound.com/jobs' })).toEqual({
      ok: true, source: { url: 'https://wellfound.com/jobs', maxPages: 1, enabled: true },
    });
    expect(parseSource({ url: 'https://www.wellfound.com/jobs' }).ok).toBe(false);
    expect(sourcePageUrl('https://wellfound.com/jobs', 2)).toBeNull();
  });
});

describe('Instahyre sources', () => {
  const page = 'https://www.instahyre.com/candidate/opportunities/?matching=true';

  it('need a saved search, which only Instahyre links may have', () => {
    expect(parseSource({ url: page, savedSearch: '  PM BLR WFH ' })).toEqual({
      ok: true, source: { url: page, savedSearch: 'PM BLR WFH', maxPages: 1, enabled: true },
    });
    expect(parseSource({ url: page })).toMatchObject({ ok: false, error: expect.stringMatching(/^savedSearch is needed/) });
    expect(parseSource({ url: 'https://www.naukri.com/pm-jobs', savedSearch: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/only with Instahyre/) });
    expect(parseSource({ url: 'https://instahyre.com/candidate/opportunities/', savedSearch: 'x' })).toMatchObject({ ok: false });
  });

  it('load one page only', () => {
    expect(sourcePageUrl(page, 1)).toBe(page);
    expect(sourcePageUrl(page, 2)).toBeNull();
  });

  it('can share a link when the saved searches differ', () => {
    const one = addSource([], { url: page, savedSearch: 'PM BLR WFH' });
    expect(one.ok).toBe(true);
    const list = one.ok ? one.list : [];
    expect(addSource(list, { url: page, savedSearch: 'pm blr wfh' })).toEqual({ ok: false, error: 'That link is already in the list.' });
    expect(addSource(list, { url: page, savedSearch: 'Design Pune' }).ok).toBe(true);
  });
});

describe('readSources', () => {
  it('fills defaults, skips disabled entries and reports bad ones', () => {
    const { sources, all, errors } = readSources({
      sources: [
        { url: 'https://in.indeed.com/jobs?q=pm' },
        { url: 'https://www.naukri.com/pm-jobs', enabled: false },
        { url: 'https://evil.example/jobs' },
        { url: 'http://www.naukri.com/pm-jobs' },
        { url: 'https://www.naukri.com/pm-jobs', maxPages: 0 },
      ],
    });
    expect(sources).toEqual([{ url: 'https://in.indeed.com/jobs?q=pm', maxPages: 1, enabled: true }]);
    expect(all).toHaveLength(2);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^sources\[2\]: url must be an https link/);
  });

  it('rejects a file without a sources list', () => {
    expect(readSources({}).errors).toEqual(['sources.json has no "sources" list']);
  });
});

describe('sourcePageUrl', () => {
  it('pages Naukri searches in the path and sorts them by date', () => {
    const url = 'https://www.naukri.com/product-manager-jobs?k=%22product%20manager%22&experience=6';
    expect(sourcePageUrl(url, 1)).toBe('https://www.naukri.com/product-manager-jobs?k=%22product+manager%22&experience=6&sort=f');
    expect(sourcePageUrl(url, 3)).toBe('https://www.naukri.com/product-manager-jobs-3?k=%22product+manager%22&experience=6&sort=f');
    expect(sourcePageUrl('https://www.naukri.com/jobs-in-pune?sort=r', 2)).toBe('https://www.naukri.com/jobs-in-pune-2?sort=r');
    expect(sourcePageUrl('https://www.naukri.com/pm-jobs-in-bengaluru', 2)).toBe('https://www.naukri.com/pm-jobs-in-bengaluru-2?sort=f');
  });

  it('loads a pasted page-2 Naukri link as-is instead of paging it again', () => {
    expect(sourcePageUrl('https://www.naukri.com/pm-jobs-in-pune-2', 1)).toBe('https://www.naukri.com/pm-jobs-in-pune-2');
    expect(sourcePageUrl('https://www.naukri.com/pm-jobs-in-pune-2', 2)).toBeNull();
  });

  it('pages Indeed searches with start and sorts them by date', () => {
    expect(sourcePageUrl('https://in.indeed.com/jobs?q=pm&start=30', 1)).toBe('https://in.indeed.com/jobs?q=pm&sort=date');
    expect(sourcePageUrl('https://in.indeed.com/jobs?q=pm', 3)).toBe('https://in.indeed.com/jobs?q=pm&sort=date&start=20');
  });

  it('pages foundit searches by page number in start', () => {
    const url = 'https://www.foundit.in/search/product-manager-jobs-in-bengaluru-bangalore?start=1&limit=20&query=product+manager&jobFreshness=3';
    expect(sourcePageUrl(url, 1)).toBe(url);
    expect(sourcePageUrl(url, 3)).toBe(url.replace('start=1', 'start=3'));
    expect(sourcePageUrl('https://www.foundit.in/rio/recommended-jobs', 2)).toBeNull();
  });

  it('loads non-search pages once, unchanged', () => {
    expect(sourcePageUrl('https://www.naukri.com/mnjuser/recommendedjobs', 1)).toBe('https://www.naukri.com/mnjuser/recommendedjobs');
    expect(sourcePageUrl('https://www.naukri.com/mnjuser/recommendedjobs', 2)).toBeNull();
    expect(sourcePageUrl('https://in.indeed.com/?from=gnav-homepage--homepage-frontend', 2)).toBeNull();
  });
});

describe('Sources panel list edits', () => {
  const a: Source = { url: 'https://www.naukri.com/mnjuser/recommendedjobs', maxPages: 1, enabled: true };
  const b: Source = { name: 'PM', url: 'https://www.naukri.com/pm-jobs', maxPages: 5, enabled: true };
  const c: Source = { url: 'https://in.indeed.com/jobs?q=pm', maxPages: 2, enabled: false };

  it('adds a valid link, trimming input and dropping an empty name', () => {
    const res = addSource([a], { url: '  https://in.indeed.com/jobs?q=pm  ', name: '  ', maxPages: 3 });
    expect(res).toEqual({ ok: true, list: [a, { url: 'https://in.indeed.com/jobs?q=pm', maxPages: 3, enabled: true }] });
  });

  it('refuses other sites, http, junk and duplicates', () => {
    expect(addSource([], { url: 'https://www.linkedin.com/jobs' })).toMatchObject({ ok: false });
    expect(addSource([], { url: 'http://in.indeed.com/jobs?q=pm' })).toMatchObject({ ok: false });
    expect(addSource([], { url: 'not a link' })).toMatchObject({ ok: false });
    expect(addSource([b], { url: 'https://www.naukri.com/pm-jobs' })).toEqual({ ok: false, error: 'That link is already in the list.' });
    // The same page written differently (explicit default port) is still a duplicate.
    expect(addSource([b], { url: 'https://www.naukri.com:443/pm-jobs' })).toMatchObject({ ok: false });
  });

  it('updates fields, clamps pages and removes a blank name', () => {
    expect(updateSource([a, b], 1, { maxPages: 99 })[1]!.maxPages).toBe(MAX_PAGES_PER_SOURCE);
    expect(updateSource([a, b], 1, { maxPages: 0 })[1]!.maxPages).toBe(1);
    expect(updateSource([a, b], 1, { name: '' })[1]).toEqual({ url: b.url, maxPages: 5, enabled: true });
    expect(updateSource([a, b], 0, { enabled: false })).toEqual([{ ...a, enabled: false }, b]);
  });

  it('moves and removes, ignoring moves past either end', () => {
    expect(moveSource([a, b, c], 2, -1)).toEqual([a, c, b]);
    expect(moveSource([a, b, c], 0, 1)).toEqual([b, a, c]);
    expect(moveSource([a, b, c], 0, -1)).toEqual([a, b, c]);
    expect(moveSource([a, b, c], 2, 1)).toEqual([a, b, c]);
    expect(removeSource([a, b, c], 1)).toEqual([a, c]);
  });

  it('clamps typed page counts', () => {
    expect([clampPages('3'), clampPages('2.6'), clampPages(''), clampPages('abc'), clampPages(-4), clampPages(1e9)])
      .toEqual([3, 3, 1, 1, 1, MAX_PAGES_PER_SOURCE]);
  });
});

describe('effectiveSources', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses your saved list, with disabled entries in `all` only', async () => {
    const stored: Source[] = [
      { url: 'https://in.indeed.com/jobs?q=pm', maxPages: 2, enabled: true },
      { url: 'https://www.naukri.com/pm-jobs', maxPages: 1, enabled: false },
    ];
    const r = await effectiveSources(stored);
    expect(r.sources).toEqual([stored[0]]);
    expect(r.all).toEqual(stored);
  });

  it('falls back to the bundled sources.json when nothing is saved', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://id/${p}` } });
    const fetchMock = vi.fn(async () => ({ json: async () => file }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await effectiveSources(null);
    expect(fetchMock).toHaveBeenCalledWith('chrome-extension://id/sources.json');
    expect(r.sources).toHaveLength(8);
  });

  it('reports a missing or broken sources.json instead of throwing', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => p } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => { throw new SyntaxError('bad json'); } })));
    const r = await fetchDefaultSources();
    expect(r.sources).toEqual([]);
    expect(r.errors[0]).toMatch(/could not read sources\.json/);
  });
});
