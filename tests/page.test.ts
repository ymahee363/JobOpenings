import { describe, expect, it } from 'vitest';
import home from './fixtures/indeed-home.json';
import {
  detectPageState, feedForCapture, findSavedSearchLink, indeedModelsFrom, scrollPlan, siteOfHost,
} from '../src/shared/page';

describe('siteOfHost', () => {
  it('tells Indeed from Naukri', () => {
    expect(siteOfHost('in.indeed.com')).toBe('indeed');
    expect(siteOfHost('www.naukri.com')).toBe('naukri');
    expect(siteOfHost('www.instahyre.com')).toBe('instahyre');
    expect(siteOfHost('wellfound.com')).toBe('wellfound');
  });
});

describe('detectPageState', () => {
  it('spots Naukri login pages', () => {
    expect(detectPageState('naukri', '/nlogin/login', 'Login', '')).toBe('logged_out');
    expect(detectPageState('naukri', '/mnjuser/recommendedjobs', 'Jobs', 'Recommended jobs')).toBe('ok');
  });

  it('spots captchas on both sites', () => {
    expect(detectPageState('naukri', '/', 'Naukri', 'Please complete the captcha')).toBe('captcha');
    expect(detectPageState('indeed', '/', 'Indeed', 'Are you a robot?')).toBe('captcha');
  });

  it("spots Indeed's Cloudflare check", () => {
    expect(detectPageState('indeed', '/', 'Just a moment...', '')).toBe('captcha');
    expect(detectPageState('indeed', '/', 'in.indeed.com', 'Verify you are human by completing the action below.')).toBe('captcha');
    expect(detectPageState('indeed', '/', 'Indeed', 'Additional Verification Required')).toBe('captcha');
  });

  it('does not mistake loading text for a captcha', () => {
    expect(detectPageState('naukri', '/', 'Naukri', 'Just a moment, loading your jobs')).toBe('ok');
    expect(detectPageState('indeed', '/', 'Job Search India | Indeed', 'Just a moment while we load more jobs')).toBe('ok');
  });

  it('spots Instahyre logins and its Cloudflare check', () => {
    expect(detectPageState('instahyre', '/login/', 'Login - Instahyre', '')).toBe('logged_out');
    expect(detectPageState('instahyre', '/candidate/opportunities/', 'Opportunities - Instahyre', 'Saved Searches')).toBe('ok');
    expect(detectPageState('instahyre', '/candidate/opportunities/', 'Just a moment...', '')).toBe('captcha');
  });

  it('spots Wellfound logins and its Cloudflare check', () => {
    expect(detectPageState('wellfound', '/login', 'Log in | Wellfound', '')).toBe('logged_out');
    expect(detectPageState('wellfound', '/jobs', 'Startup Jobs | Wellfound', 'Search for jobs')).toBe('ok');
    expect(detectPageState('wellfound', '/jobs', 'Just a moment...', '')).toBe('captcha');
  });

  it('does not treat Indeed paths as Naukri logins', () => {
    expect(detectPageState('indeed', '/login-help', 'Indeed', '')).toBe('ok');
  });
});

describe('feedForCapture', () => {
  it('names Indeed feeds by page', () => {
    expect(feedForCapture('indeed', '/', 'https://apis.indeed.com/graphql')).toBe('indeed-home');
    expect(feedForCapture('indeed', '/jobs', 'https://apis.indeed.com/graphql')).toBe('indeed-search');
  });

  it('names Instahyre captures as searches', () => {
    expect(feedForCapture('instahyre', '/candidate/opportunities/', '/api/v1/job_search?skills=x')).toBe('instahyre-search');
    expect(feedForCapture('wellfound', '/jobs', 'https://wellfound.com/graphql')).toBe('wellfound-search');
  });

  it('tags Naukri search results and leaves recom-jobs to the parser', () => {
    expect(feedForCapture('naukri', '/pm-jobs', 'https://www.naukri.com/jobapi/v3/search?pageNo=1')).toBe('search');
    expect(feedForCapture('naukri', '/mnjuser/recommendedjobs', '/jobapi/v2/search/recom-jobs')).toBeNull();
  });
});

describe('indeedModelsFrom', () => {
  it('pulls job-card models from homepage and search providers only', () => {
    const wrap = (model: unknown) => ({ metaData: { mosaicProviderJobCardsModel: model } });
    const providers = {
      'mosaic-provider-jobcards-1': wrap(home),
      'mosaic-provider-jobcards': wrap({ results: [] }),
      'mosaic-provider-dislike-feedback': wrap({ results: ['x'] }),
      'mosaic-provider-jobcards-2': { metaData: {} },
      'mosaic-provider-jobcards-3': null,
    };
    expect(indeedModelsFrom(providers)).toEqual([home, { results: [] }]);
  });

  it('copes with a page that has no provider data', () => {
    expect(indeedModelsFrom(undefined)).toEqual([]);
    expect(indeedModelsFrom('x')).toEqual([]);
  });
});

describe('scrollPlan', () => {
  const total = (steps: { waitMs: number }[]) => steps.reduce((t, s) => t + s.waitMs, 0);

  it('scrolls for 5 to 12 seconds in steps at least 900 ms apart', () => {
    for (let i = 0; i < 200; i++) {
      const steps = scrollPlan(Math.random);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(total(steps)).toBeLessThanOrEqual(12_000);
      expect(total(steps)).toBeGreaterThan(5_000 - 2_200);
      for (const s of steps) {
        expect(s.waitMs).toBeGreaterThanOrEqual(900);
        expect(s.waitMs).toBeLessThan(2_200);
        expect(Math.abs(s.dy)).toBeGreaterThanOrEqual(80);
        expect(Math.abs(s.dy)).toBeLessThan(750);
      }
    }
  });

  it('starts by scrolling down and mostly keeps going down', () => {
    let down = 0;
    let up = 0;
    for (let i = 0; i < 200; i++) {
      const steps = scrollPlan(Math.random);
      expect(steps[0]!.dy).toBeGreaterThan(0);
      for (const s of steps) (s.dy > 0 ? down++ : up++);
    }
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(up * 3);
  });

  it('differs from one page to the next', () => {
    const plans = new Set(Array.from({ length: 20 }, () => JSON.stringify(scrollPlan(Math.random))));
    expect(plans.size).toBe(20);
  });
});

describe('findSavedSearchLink', () => {
  // Just enough DOM for the lookup: Instahyre renders .search-info > .search-title + .search-btn > a.
  function box(names: string[]) {
    const items = names.map((name) => {
      const link = { name } as unknown as HTMLElement;
      const info = { querySelector: (sel: string) => (sel === '.search-btn a' ? link : null) };
      return { title: { textContent: `
  ${name}  `, parentElement: info }, link };
    });
    const root = { querySelectorAll: (sel: string) => (sel === '.search-title' ? items.map((i) => i.title) : []) };
    return { root: root as unknown as ParentNode, links: items.map((i) => i.link) };
  }

  it('finds a saved search by name, ignoring case and spacing', () => {
    const { root, links } = box(['Design Pune', 'PM BLR WFH']);
    expect(findSavedSearchLink(root, 'PM Blr  WFH')).toBe(links[1]);
  });

  it('returns null when the search is not there', () => {
    expect(findSavedSearchLink(box(['Design Pune']).root, 'PM BLR WFH')).toBeNull();
    expect(findSavedSearchLink(box([]).root, 'PM BLR WFH')).toBeNull();
  });
});
