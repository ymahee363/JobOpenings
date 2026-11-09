// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAnswers } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE, type StoredResume } from '../src/shared/ai-apply/profile';
import { seedPatch } from '../src/shared/ai-apply/seed';
import type { AnswerRequest } from '../src/shared/ai-apply/llm';
import type { Answer, FormField } from '../src/shared/ai-apply/types';

const LETTER = 'Dear Hiring Manager,\n\nI built DoMyShoot from 0→1.\n\nBest regards,\nMahendra Yadav';
const coverLetter: StoredResume = { name: 'Mahendra_Cover_Letter.pdf', type: 'application/pdf', data: 'JVBERi0=', text: LETTER };
const f = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({
  id, label, type: 'textarea', required: false, options: [], current_value: '', ...over,
});

async function build(fields: FormField[], letter: StoredResume | null) {
  const calls: AnswerRequest[] = [];
  const built = await buildAnswers({ url: 'https://in.indeed.com/apply', title: 't', page_text: '', fields }, {
    profile: DEFAULT_PROFILE, resume: null, coverLetter: letter, memory: {}, bank: [], now: () => 0,
    generate: async (req) => {
      calls.push(req);
      return req.fields.map((x): Answer => ({ field_id: x.id, answer: 'An AI-written letter', confidence: 0.9, source: 'ai_generated', needs_user_input: false }));
    },
  }, '', false);
  return { answers: built.answers, calls };
}

describe('a cover letter text box (Indeed)', () => {
  it('gets your cover letter word for word, and never goes to the AI', async () => {
    const { answers, calls } = await build([f('c', 'Cover letter'), f('w', 'Write a cover letter (optional)')], coverLetter);
    expect(answers.map((a) => a.answer)).toEqual([LETTER, LETTER]);
    expect(calls).toHaveLength(0);
  });

  it('without a saved cover letter text: stays empty when optional, is left for you when required; never AI-written', async () => {
    const empty = { ...coverLetter, text: '' };
    const { answers, calls } = await build([f('o', 'Cover letter'), f('r', 'Cover letter *', { required: true })], empty);
    expect(answers).toEqual([expect.objectContaining({ field_id: 'r', answer: 'NEEDS_USER_INPUT', needs_user_input: true })]);
    expect(calls).toHaveLength(0);
  });

  it('a cover letter upload slot still takes your PDF, not text', async () => {
    const { answers } = await build([f('u', 'Cover letter', { type: 'file' })], coverLetter);
    expect(answers[0]!.answer).toBe('RESUME_UPLOAD');
  });

  it('the seed adds your letter\'s text to the stored cover letter that has none; your own typed text stays', () => {
    const stored = { ...coverLetter, text: '' };
    expect(seedPatch({ version: 3, coverLetter }, { profileSaved: true, memory: {}, resume: null, coverLetter: stored }).coverLetter?.text).toBe(LETTER);
    const typed = { ...coverLetter, text: 'My own edit' };
    expect(seedPatch({ version: 3, coverLetter }, { profileSaved: true, memory: {}, resume: null, coverLetter: typed }).coverLetter).toBeUndefined();
  });
});

describe('opening Indeed\'s "Write a cover letter" option', () => {
  type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
  let listener: Listener;
  const send = (msg: Record<string, unknown>) => new Promise<{ opened?: boolean }>((res) => { listener(msg, {}, res as (r: unknown) => void); });

  beforeAll(async () => {
    vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (l: Listener) => { listener = l; } }, sendMessage: () => Promise.resolve() } });
    Element.prototype.getClientRects = function (this: Element) { return (this.closest('[hidden]') ? [] : [{ width: 1, height: 1 }]) as unknown as DOMRectList; };
    document.body.innerHTML = `<form><h2>Documents</h2><p>Cover letter (optional)</p>
      <button type="button" id="write">Write a cover letter</button>
      <div id="box" hidden><label for="cl">Cover letter</label><textarea id="cl"></textarea></div></form>`;
    document.getElementById('write')!.addEventListener('click', () => { document.getElementById('box')!.hidden = false; });
    await import('../src/content/form-engine');
  });

  it('presses it when no cover letter box is open, and not again once it is', async () => {
    expect((await send({ type: 'OPEN_COVER_LETTER' })).opened).toBe(true);
    expect(document.getElementById('box')!.hidden).toBe(false);
    expect((await send({ type: 'OPEN_COVER_LETTER' })).opened).toBe(false);
  });
});
