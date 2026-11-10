import { describe, expect, it } from 'vitest';
import { runKekaApply } from '../src/shared/ats/zoho-flow';
import type { FlowDeps } from '../src/shared/ai-apply/flow';

// 2026-11-10, eloelo.keka.com: one STATE read found no listener ("Receiving end does not exist") and the whole run
// failed. A STATE read is now asked again once; a press never is.
describe('Keka flow', () => {
  it('asks the page state again once when the content script did not answer', async () => {
    let calls = 0;
    const deps = {
      frames: async () => [0],
      status: () => {},
      sleep: async () => {},
      mayClick: async () => null,
      send: async (_f: number, m: { type: string }) => {
        if (m.type === 'KK_STATE') {
          calls += 1;
          if (calls === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { page: 'submitted', errors: [] };
        }
        return { ok: false };
      },
    } as unknown as FlowDeps;
    const r = await runKekaApply(deps, 'submit' as never, {} as never, 'https://x.keka.com/careers/jobdetails/1', { title: 'PM', company: 'X' });
    expect(calls).toBe(2);
    expect(r.result).toBe('applied');
  });

  it('does not repeat a press that failed', async () => {
    const sent: string[] = [];
    const deps = {
      frames: async () => [0], status: () => {}, sleep: async () => {}, mayClick: async () => null,
      send: async (_f: number, m: { type: string }) => {
        sent.push(m.type);
        if (m.type === 'KK_STATE') return { page: 'job', errors: [] };
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    } as unknown as FlowDeps;
    await runKekaApply(deps, 'submit' as never, {} as never, 'https://x.keka.com/careers/jobdetails/1', { title: 'PM', company: 'X' }).catch(() => null);
    expect(sent.filter((t) => t === 'KK_START')).toHaveLength(1);
  });
});
