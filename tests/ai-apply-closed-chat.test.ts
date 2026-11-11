import { describe, expect, it } from 'vitest';
import { runAiApply, type FlowDeps } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';

// Darwinbox (Pixxel Space, 2026-11-11): the job is closed ("Job not found or closed") and the only field on the page
// is the careers chat bot's message box. The run reported "page 1: no Next or Submit button" instead of closed.
function deps(): FlowDeps {
  let clock = 0;
  const engine = async (msg: Record<string, unknown>) => {
    switch (msg.type) {
      case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://acme.darwinbox.in/ms/candidate/careers/x', title: 'Careers', page_text: 'Oops! Job not found or closed', fields: [
        { id: 'm', label: 'Type your message here', type: 'textarea', required: false, options: [], current_value: '' }] } };
      case 'PAGE_SIGNALS': return { ok: true, confirmed: false, captcha: false, closed: true };
      default: return { ok: true, found: false };
    }
  };
  return { frames: async () => [0], send: (_f: number, m: Record<string, unknown>) => engine(m), sleep: async (ms: number) => { clock += ms; }, now: () => clock,
    profile: DEFAULT_PROFILE, resume: null, memory: {}, bank: [], generate: async () => [], saveMemory: async () => {}, mayClick: async () => null } as unknown as FlowDeps;
}
describe('closed job with only a chat widget on the page', () => {
  it('reports closed, not "no Next or Submit button"', async () => {
    const r = await runAiApply(deps(), { mode: 'submit', job: { title: 'PM', company: 'Acme', url: 'https://acme.darwinbox.in/x' }, pageWaitMs: 2_000, settleMs: 2_000 } as never);
    expect(`${r.result}: ${r.reason}`).toMatch(/^closed/); void r; expect(r.result).toBe('closed');
  });
});
