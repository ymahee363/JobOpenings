// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isWellfoundJobUrl, runWellfoundApply } from '../src/shared/ats/wellfound-flow';
import type { FlowDeps } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';

const URL_ = 'https://wellfound.com/jobs/5034721-technical-product-manager';

/** A fake Wellfound tab: Apply opens the form with `questions`; Send closes it (or shows `sendError`). */
function fake(questions: string[], opts: { start?: 'job' | 'applied' | 'closed'; sendError?: string; noForm?: boolean; skipFirst?: string } = {}) {
  let calls = 0;
  let page: 'job' | 'form' | 'applied' | 'closed' | 'unknown' = opts.start ?? 'job';
  let clock = 0;
  const filled: string[] = [];
  const sent: string[] = [];
  const state = () => ({ ok: true, page, questions: page === 'form' ? questions.length : 0, errors: [] as string[], note: page === 'closed' ? 'Wellfound shows "Page not found"' : '' });
  const deps = {
    frames: async () => [0],
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    profile: { ...DEFAULT_PROFILE },
    resume: null, memory: {}, bank: [], saveMemory: async () => {}, mayClick: async () => null,
    currentUrl: async () => URL_,
    generate: async (req: { fields: Array<{ id: string; label: string }> }) => {
      calls += 1;
      // The AI leaves `skipFirst` open on its first call, as seen live on 2026-11-11.
      return req.fields.map((f) => calls === 1 && f.label === opts.skipFirst
        ? { field_id: f.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'llm', needs_user_input: true }
        : { field_id: f.id, answer: 'Yes, I ran LLM evals on an agentic product.', confidence: 0.9, source: 'llm', needs_user_input: false });
    },
    send: async (_f: number, msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'WF_STATE': return state();
        case 'WF_START': page = opts.noForm ? 'unknown' : 'form'; return { ...state(), presses: 1 };
        case 'EXTRACT_FORM': return { ok: true, data: { url: URL_, title: 't', page_text: 'APPLY TO The Date Crew', fields: questions.map((q, i) => ({ id: `customQuestionAnswers[${i}][answer]`, label: q, type: 'textarea', required: q.endsWith('*'), options: [], current_value: '' })) } };
        case 'FILL_FIELDS': for (const a of msg.answers as Array<{ answer: string }>) filled.push(a.answer); return { ok: true, filled: (msg.answers as unknown[]).length };
        case 'WF_SEND':
          sent.push('send');
          if (opts.sendError) return { ...state(), errors: [opts.sendError], sent: false };
          page = 'applied';
          return { ...state(), note: 'the application form closed after "Send application" with no errors', sent: true };
        default: return { ok: true };
      }
    },
  } as unknown as FlowDeps;
  return { deps, filled, sent };
}

describe('Wellfound applier', () => {
  it('knows Wellfound job pages', () => {
    expect(isWellfoundJobUrl(URL_)).toBe(true);
    expect(isWellfoundJobUrl('https://wellfound.com/jobs/4607205')).toBe(true);
    expect(isWellfoundJobUrl('https://wellfound.com/jobs?role=product-manager')).toBe(false);
    expect(isWellfoundJobUrl('https://wellfound.com/jobs/applications')).toBe(false);
    expect(isWellfoundJobUrl('https://jobs.lever.co/x/y')).toBe(false);
  });

  it('answers every question, then presses "Send application"', async () => {
    const { deps, filled, sent } = fake(['What interests you about working for this company?', 'Have you built or worked on an agentic Product?*']);
    const r = await runWellfoundApply(deps, 'submit', { title: 'Technical Product Manager', company: 'The Date Crew' }, URL_);
    expect(r.result).toBe('applied');
    expect(r.clicked).toBe(true);
    expect(filled).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it('asks the AI again for a required question it left open (2026-11-11)', async () => {
    const q = 'Have you setup and ran LLM based evals?*';
    const { deps, filled, sent } = fake(['Have you built or worked on an agentic Product?*', q], { skipFirst: q });
    const r = await runWellfoundApply(deps, 'submit', { title: '', company: '' }, URL_);
    expect(r.result).toBe('applied');
    expect(filled).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it('sends a form with no questions', async () => {
    const { deps, sent } = fake([]);
    expect((await runWellfoundApply(deps, 'submit', { title: '', company: '' }, URL_)).result).toBe('applied');
    expect(sent).toHaveLength(1);
  });

  it('never sends outside submit mode; preview presses nothing', async () => {
    const preview = fake(['q']);
    expect((await runWellfoundApply(preview.deps, 'preview', { title: '', company: '' }, URL_)).result).toBe('can_apply');
    expect(preview.filled).toHaveLength(0);
    const fill = fake(['What interests you about working for this company?']);
    const r = await runWellfoundApply(fill.deps, 'fill', { title: '', company: '' }, URL_);
    expect(r.result).toBe('ready');
    expect(r.clicked).toBe(false);
    expect(fill.filled).toHaveLength(1);
    expect(fill.sent).toHaveLength(0);
  });

  it('reports applied and taken-down jobs without pressing anything', async () => {
    const applied = await runWellfoundApply(fake([], { start: 'applied' }).deps, 'submit', { title: '', company: '' }, URL_);
    expect(applied.result).toBe('applied');
    expect(applied.clicked).toBe(false);
    expect((await runWellfoundApply(fake([], { start: 'closed' }).deps, 'submit', { title: '', company: '' }, URL_)).result).toBe('closed');
  });

  it('a rejected Send or a missing form needs you', async () => {
    const rejected = await runWellfoundApply(fake(['Why us?'], { sendError: 'This field is required' }).deps, 'submit', { title: '', company: '' }, URL_);
    expect(rejected.result).toBe('needs_me');
    expect(rejected.reason).toContain('This field is required');
    expect((await runWellfoundApply(fake([], { noForm: true }).deps, 'submit', { title: '', company: '' }, URL_)).result).toBe('needs_me');
  });
});

describe('self-ratings get a fixed answer (Wellfound, 2026-11-11)', () => {
  it('answers 4 of 5, scaled to the range given', async () => {
    const { standingAnswer } = await import('../src/shared/ai-apply/answer-rules');
    const t = (label: string) => standingAnswer({ label, type: 'textarea', options: [] });
    expect(t('What would be your self-rating on database design? RATE YOURSELF ON A SCALE OF (0-5)*')).toBe('4');
    expect(t('Rate yourself on a scale of 1 to 10 in SQL')).toBe('8');
    expect(t('What interests you about working for this company?')).toBeNull();
    expect(standingAnswer({ label: 'Rate yourself on a scale of 1-5', type: 'radio', options: ['1', '2', '3', '4', '5'] })).toBeNull();
  });
});

describe('Wellfound page states, from the live DOM (2026-11-11)', () => {
  const page = (body: string, title = 'AI Product Manager at SciSpace | Wellfound') => {
    document.title = title;
    document.body.innerHTML = body;
    // happy-dom has no layout: every element counts as shown.
    Element.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
  };
  const apply = (t: string) => `<button class="styles_applyButton__7gnpI">${t}</button>`;
  const form = '<div class="ReactModal__Content" role="dialog">APPLY TO SciSpace<form><textarea name="customQuestionAnswers[1][answer]"></textarea>'
    + '<button type="button">Cancel</button><button type="submit" data-test="JobApplicationModal--SubmitButton">Send application</button></form></div>';

  it('reads the job, the open form, the sent state (form gone, "Undo · m:ss") and a 404', async () => {
    const { wfState } = await import('../src/content/ats/wellfound');
    page(apply('Apply') + apply('Apply now'));
    expect(wfState().page).toBe('job');
    page(apply('Apply') + form);
    expect(wfState()).toMatchObject({ page: 'form', questions: 1 });
    page(`${apply('Undo · 4:39')}${apply('Undo · 4:39')}<div class="ReactModal__Content" role="dialog">APPLY TO SciSpace Location Bengaluru</div>`);
    expect(wfState().page).toBe('applied');
    page(apply('Undo · 3:20'));
    expect(wfState().page).toBe('applied');
    page('<h1>Page not found</h1>', 'Page not found - 404 | Wellfound');
    expect(wfState().page).toBe('closed');
  });
});
