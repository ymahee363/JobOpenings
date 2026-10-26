import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILTERS } from '../src/shared/board';
import { BoardMessage, CollectorMessage } from '../src/shared/messages';
import { load, save } from '../src/shared/store';

describe('store defaults', () => {
  let data: Record<string, unknown>;
  beforeEach(() => {
    data = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
          set: async (items: Record<string, unknown>) => {
            Object.assign(data, items);
          },
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('turns on refresh-Indeed-on-open for settings saved before it existed', async () => {
    data.settings = { autoRefresh: true, refreshMinutes: 45, notifyNewJobs: true };
    expect(await load('settings')).toEqual({ autoRefresh: true, refreshMinutes: 45, notifyNewJobs: true, indeedOnBoardOpen: true });
  });

  it('hides Designer and Engineer titles by default and keeps your edited list as a list', async () => {
    expect(await load('hiddenTitleWords')).toEqual(['Designer', 'Engineer']);
    await save('hiddenTitleWords', ['Designer', 'Engineer', 'Intern']);
    expect(await load('hiddenTitleWords')).toEqual(['Designer', 'Engineer', 'Intern']);
    await save('hiddenTitleWords', []);
    expect(await load('hiddenTitleWords')).toEqual([]);
  });

  it('starts with no saved sources, so sources.json is used', async () => {
    expect(await load('sources')).toBeNull();
  });

  it('keeps a saved sources list as a list, and clears it on reset', async () => {
    const list = [{ url: 'https://in.indeed.com/jobs?q=pm', maxPages: 2, enabled: true }];
    await save('sources', list);
    expect(await load('sources')).toEqual(list);
    await save('sources', null);
    expect(await load('sources')).toBeNull();
  });

  it('gives filters saved before the Sites filter existed the "All" default', async () => {
    const { sites: _sites, ...old } = DEFAULT_FILTERS;
    data.filters = { ...old, location: 'Pune' };
    expect(await load('filters')).toEqual({ ...DEFAULT_FILTERS, location: 'Pune', sites: [] });
  });
});

describe('CollectorMessage', () => {
  const capture = { type: 'capture', source: 'network', feed: null, url: 'https://in.indeed.com/', payload: {} };

  it('requires a known site on captures and page states', () => {
    expect(CollectorMessage.safeParse({ ...capture, site: 'indeed' }).success).toBe(true);
    expect(CollectorMessage.safeParse({ ...capture, site: 'linkedin', source: 'page' }).success).toBe(true);
    expect(CollectorMessage.safeParse({ ...capture, site: 'monster' }).success).toBe(false);
    expect(CollectorMessage.safeParse(capture).success).toBe(false);
    expect(CollectorMessage.safeParse({ type: 'page-state', site: 'naukri', state: 'captcha', url: '/' }).success).toBe(true);
    expect(CollectorMessage.safeParse({ type: 'page-state', state: 'captcha', url: '/' }).success).toBe(false);
  });

  it('accepts the board-opened message from the board', () => {
    expect(BoardMessage.safeParse({ type: 'board-opened' }).success).toBe(true);
    expect(BoardMessage.safeParse({ type: 'open-sesame' }).success).toBe(false);
  });

  it('accepts applied-detected only for Naukri job IDs', () => {
    expect(CollectorMessage.safeParse({ type: 'applied-detected', jobId: '100826018354' }).success).toBe(true);
    expect(CollectorMessage.safeParse({ type: 'applied-detected', jobId: 'indeed-a10763a21af31e90' }).success).toBe(false);
  });
});
