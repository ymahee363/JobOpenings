// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isNaukriJobUrl, runNaukriApply } from '../src/shared/ats/naukri-flow';
import type { FlowDeps } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';

const URL_ = 'https://www.naukri.com/job-listings-product-manager-azentio-software-bengaluru-7-to-10-years-101126006440';

/** A fake Naukri tab: Apply opens a chatbot with `questions`, the last Save lands on the confirmation. */
function fake(questions: string[], opts: { external?: boolean; failCode?: number; expired?: boolean } = {}) {
  const failCode = opts.failCode;
  let page: 'job' | 'chat' | 'applied' | 'external' = opts.external ? 'external' : 'job';
  let at = 0;
  let clock = 0;
  const filled: string[] = [];
  const state = () => ({ ok: true, page, question: page === 'chat' ? questions[at] : '', errors: [] });
  const deps = {
    frames: async () => [0],
    // A clock that moves with every sleep, so the 30 s wait before Save ends.
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    profile: { ...DEFAULT_PROFILE, notice_period: '0' },
    resume: null, memory: {}, bank: [], saveMemory: async () => {}, mayClick: async () => null,
    currentUrl: async () => opts.expired ? 'https://www.naukri.com/product-manager-jobs-in-bengaluru?expJD=true' : (page === 'applied' ? `https://www.naukri.com/myapply/saveApply?multiApplyResp=${encodeURIComponent(JSON.stringify({ '101126006440': failCode ?? 200 }))}&jobTitle=Product%20Manager` : URL_),
    generate: async (req: { fields: Array<{ id: string }> }) => req.fields.map((f) => ({ field_id: f.id, answer: '5', confidence: 0.9, source: 'llm', needs_user_input: false })),
    send: async (_f: number, msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'NK_STATE': return state();
        case 'NK_START': page = questions.length ? 'chat' : 'applied'; return state();
        case 'EXTRACT_FORM': return { ok: true, data: { url: URL_, title: 't', page_text: '', fields: [{ id: 'naukri-chat-answer', label: questions[at], type: 'textarea', required: true, options: [], current_value: '' }] } };
        case 'FILL_FIELDS': filled.push(String((msg.answers as Array<{ answer: string }>)[0]?.answer)); return { ok: true, filled: 1 };
        case 'NK_SEND':
          at += 1;
          if (at >= questions.length) { page = 'applied'; throw new Error('page navigated'); } // the confirmation page ends the reply
          return { ...state(), moved: true };
        default: return { ok: true };
      }
    },
  } as unknown as FlowDeps;
  return { deps, filled };
}

describe('Naukri applier', () => {
  it('knows Naukri job pages', () => {
    expect(isNaukriJobUrl(URL_)).toBe(true);
    expect(isNaukriJobUrl('https://www.naukri.com/product-manager-jobs')).toBe(false);
    expect(isNaukriJobUrl('https://jobs.lever.co/x/y')).toBe(false);
  });

  it('applies in one click when Naukri asks nothing', async () => {
    const { deps } = fake([]);
    const r = await runNaukriApply(deps, 'submit', { title: 'PM', company: 'Azentio' });
    expect(r.result).toBe('applied');
    expect(r.clicked).toBe(true);
  });

  it('answers each chatbot question, presses Save, and confirms on the Applied page', async () => {
    const { deps, filled } = fake(['How many years of product management experience do you have?', 'What is your notice period?']);
    const r = await runNaukriApply(deps, 'submit', { title: 'PM', company: 'Azentio' });
    expect(r.result).toBe('applied');
    expect(filled).toHaveLength(2);
    expect(r.answers.map((a) => a.question)).toHaveLength(2);
  });

  it('never presses Apply outside submit mode, and leaves company-site jobs to the general flow', async () => {
    expect((await runNaukriApply(fake(['q']).deps, 'fill', { title: '', company: '' })).result).toBe('can_apply');
    expect((await runNaukriApply(fake([], { external: true }).deps, 'submit', { title: '', company: '' })).result).toBe('external');
  });
});

describe('Naukri success is only its own 200 for this job (2026-11-10)', () => {
  it('a confirmation page with another code is a failure, not applied', async () => {
    const r = await runNaukriApply(fake([], { failCode: 409 }).deps, 'submit', { title: 'PM', company: 'Azentio' });
    expect(r.result).toBe('error');
    expect(r.reason).toContain('Naukri did not apply (101126006440: 409)');
  });

  it('records the success message', async () => {
    const r = await runNaukriApply(fake([]).deps, 'submit', { title: 'PM', company: 'Azentio' });
    expect(r.reason).toContain('Naukri: Applied to "Product Manager" (response 200 for job 101126006440)');
  });

  it('reads the response per job', async () => {
    const { naukriApplyResult } = await import('../src/shared/auto-apply/job-page');
    const u = (resp: object) => `https://www.naukri.com/myapply/saveApply?multiApplyResp=${encodeURIComponent(JSON.stringify(resp))}&jobTitle=PM`;
    expect(naukriApplyResult(u({ 261026030203: 200 }), '261026030203').status).toBe('applied');
    expect(naukriApplyResult(u({ 261026030203: 200 }), '101126006440').status).toBe('failed');
    expect(naukriApplyResult(u({ 261026030203: 500 })).status).toBe('failed');
    expect(naukriApplyResult('https://www.naukri.com/job-listings-pm-261026030203').status).toBe('none');
  });
});

describe('expired Naukri jobs (2026-11-10)', () => {
  it('a job page that redirects to a search with expJD=true is closed, so it leaves the board', async () => {
    const { isNaukriExpired, isNaukriJobUrl } = await import('../src/shared/ats/naukri-flow');
    const expired = 'https://www.naukri.com/product-manager-jobs-in-bengaluru?expJD=true';
    expect(isNaukriExpired(expired)).toBe(true);
    expect(isNaukriJobUrl(expired)).toBe(true);
    const r = await runNaukriApply(fake([], { expired: true }).deps, 'submit', { title: 'PM', company: 'X' });
    expect(r.result).toBe('closed');
    expect(r.clicked).toBe(false);
  });
});

describe('Naukri answers are at most 99 characters (2026-11-10)', () => {
  it('cuts a long answer at the last whole word', async () => {
    const { capAnswer } = await import('../src/shared/ats/naukri-flow');
    const long = 'I led the end-to-end launch of an AI claims product, growing weekly active users by 40% while cutting costs significantly';
    const c = capAnswer(long);
    expect(c.length).toBeLessThanOrEqual(99);
    expect(long.startsWith(c)).toBe(true);
    expect(c.endsWith(' ')).toBe(false);
    expect(capAnswer('5')).toBe('5');
  });

  it('a chatbot text answer the AI wrote too long goes in at 99 characters or fewer', async () => {
    const { deps } = fake(['Describe your biggest product launch']);
    const long = 'x '.repeat(80).trim();
    (deps as unknown as { generate: unknown }).generate = async (req: { fields: Array<{ id: string }> }) => req.fields.map((f) => ({ field_id: f.id, answer: long, confidence: 0.9, source: 'llm', needs_user_input: false }));
    const r = await runNaukriApply(deps, 'submit', { title: 'PM', company: 'X' });
    expect(r.result).toBe('applied');
    expect(r.answers[0]!.answer.length).toBeLessThanOrEqual(99);
  });
});
