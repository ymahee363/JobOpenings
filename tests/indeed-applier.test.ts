// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { inState } from '../src/content/ats/indeed';
import { runIndeedApply } from '../src/shared/ats/indeed-flow';
import type { FlowDeps } from '../src/shared/ai-apply/flow';

function page(html: string) {
  document.body.innerHTML = html;
  // happy-dom has no layout: everything counts as shown.
  for (const el of document.querySelectorAll('*')) (el as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
}

// An expired Indeed job as seen on 2026-11-11 (jk=fddbd84641b96aed): an alert and no Apply button. It was reported
// as "Indeed: no application step found (unknown)" (needs me) after 40 s of waiting.
const EXPIRED = `<div data-testid="alert" role="alert"><b>This job has expired on Indeed</b><p>Reasons could include: the employer is not accepting applications</p></div><main><h1>Staff Product Manager</h1></main>`;

describe('Indeed expired job', () => {
  it('reads "This job has expired on Indeed" as closed', () => {
    page(EXPIRED);
    expect(inState().page).toBe('closed');
  });

  it('still reads a live job with Apply now as a job', () => {
    page(`<main><h1>PM</h1><button data-testid="viewjob-indeed-apply">Apply now</button></main>`);
    expect(inState().page).toBe('job');
  });

  it('skips the job as closed instead of needing you', async () => {
    page(EXPIRED);
    const deps = {
      frames: async () => [0],
      send: async (_f: number, m: { type: string }) => (m.type === 'IN_STATE' ? inState() : { ok: true }),
      sleep: async () => {},
      mayClick: async () => null,
      status: () => {},
    } as unknown as FlowDeps;
    const r = await runIndeedApply(deps, 'submit', { title: 'Staff Product Manager', company: 'X' }, 'https://in.indeed.com/viewjob?jk=fddbd84641b96aed');
    expect(r.result).toBe('closed');
    expect(r.reason).toMatch(/expired/);
  });
});
