// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { companyApplyUrl, liState } from '../src/content/ats/linkedin';
import { runLinkedinApply } from '../src/shared/ats/linkedin-flow';
import type { FlowDeps } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';

const GH = 'https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited/jobs/4712345';
const SAFETY = `https://www.linkedin.com/safety/go/?url=${encodeURIComponent(GH)}&urlhash=abcd&mt=x&isSdui=true`;

describe('LinkedIn company-site jobs (2026-11-11)', () => {
  it('unwraps LinkedIn\'s redirect to the company page, and refuses anything else', () => {
    expect(companyApplyUrl(SAFETY)).toBe(GH);
    expect(companyApplyUrl('https://careers.example.com/apply/1')).toBe('https://careers.example.com/apply/1');
    expect(companyApplyUrl('https://www.linkedin.com/jobs/view/1')).toBeNull();
    expect(companyApplyUrl('https://www.linkedin.com/safety/go/?url=javascript%3Aalert(1)')).toBeNull();
    expect(companyApplyUrl('https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fwww.linkedin.com%2Ffeed')).toBeNull();
  });

  it('reads the company link from the job page (as seen on Razorpay)', () => {
    Element.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
    document.body.innerHTML = `<main><h1>Senior Product Manager</h1><a aria-label="Apply on company website" target="_blank" href="${SAFETY}">Apply</a></main>`;
    expect(liState()).toMatchObject({ page: 'external', externalUrl: GH });
  });

  const fake = (externalUrl?: string) => {
    let url = 'https://www.linkedin.com/jobs/view/4487990883/';
    const sent: string[] = [];
    const deps = {
      frames: async () => [0], sleep: async () => {}, now: () => 0, profile: DEFAULT_PROFILE, resume: null, memory: {}, bank: [],
      generate: async () => [], saveMemory: async () => {}, mayClick: async () => null, currentUrl: async () => url,
      send: async (_f: number, msg: { type: string }) => {
        sent.push(msg.type);
        if (msg.type === 'LI_STATE') return { ok: true, page: 'external', step: '', errors: [], externalUrl };
        if (msg.type === 'LI_LOCATION') return { ok: true, location: 'Bengaluru, India' };
        if (msg.type === 'LI_GO_EXTERNAL') { url = GH; return { ok: true, url: GH }; }
        return { ok: true };
      },
    } as unknown as FlowDeps;
    return { deps, sent, url: () => url };
  };

  it('opens the company page in the same tab when applying', async () => {
    const f = fake(GH);
    const r = await runLinkedinApply(f.deps, 'submit', { title: 'Senior PM', company: 'Razorpay' }, 'https://www.linkedin.com/jobs/view/4487990883/');
    expect(r.result).toBe('external');
    expect(f.sent).toContain('LI_GO_EXTERNAL');
    expect(f.url()).toBe(GH);
    expect(r.reason).toContain('job-boards.greenhouse.io');
  });

  it('never leaves LinkedIn in a dry run', async () => {
    const f = fake(GH);
    await runLinkedinApply(f.deps, 'preview', { title: '', company: '' }, 'https://www.linkedin.com/jobs/view/4487990883/');
    expect(f.sent).not.toContain('LI_GO_EXTERNAL');
  });
});
