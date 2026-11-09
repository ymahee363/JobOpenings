// @vitest-environment happy-dom
/**
 * Every input type through the real form engine and the input-type agent: tests/fixtures/forms/input-types.html
 * (also used for live checks in Chrome) is read, answered (the "AI" answers in loose wording on purpose: "3:30 pm",
 * "15/12/2026", "about 72", "4 out of 5"), shaped by src/shared/ai-apply/input-kinds.ts and filled. The page's own
 * widget script (switch, ARIA slider, city suggestions, signature pad) runs here too.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAnswers } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { Answer, FormData } from '../src/shared/ai-apply/types';
import html from './fixtures/forms/input-types.html?raw';

type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
let listener: Listener;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (msg: Record<string, unknown>) => new Promise<any>((resolve) => listener(msg, {}, resolve));

const PROFILE = { ...DEFAULT_PROFILE, phone: '+91 62642 52896', location: 'Bangalore, India', linkedin: '' };
const NOW = Date.UTC(2026, 10, 6, 12);

/** What the fake AI says, by label start: loose wording a model really returns. */
const AI: Record<string, string> = {
  'Why do you want': 'I like building data products.',
  'LinkedIn profile': 'linkedin.com/in/mahendra-yadav',
  'Street address': '12 MG Road',
  'Postal code': '560001',
  'Preferred work mode': 'Hybrid',
  'Which tools': 'Jira, SQL',
  'Highest degree': "Bachelor's degree",
  'Are you willing to relocate': 'Yes, happy to',
  'Open to night shifts': 'Sure',
  'Current city': 'Bangalore',
  'Years of product management': '5+ years',
  'Comfort with travel': 'about 72',
  'Preferred team size': '8 people',
  'Rate your SQL': '4 out of 5',
  'Best time to call': '3:30 pm',
  'Graduation month': 'June 2015',
  'Preferred interview slot': '2026-11-20 4 pm',
  'Employment period': 'Jan 2020 to present',
};

let data: FormData;
let answers: Answer[];
let hints: Record<string, string | undefined> = {};
let fillResults: Array<{ filled: boolean }> = [];

beforeAll(async () => {
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (l: Listener) => { listener = l; } } } });
  // No CSS here: what the page hides with the hidden attribute is not shown.
  Element.prototype.getClientRects = function (this: Element) { return (this.closest('[hidden]') ? [] : [{ width: 1, height: 1 }]) as unknown as DOMRectList; };
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100, toJSON: () => ({}) } as DOMRect;
  };
  const body = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
  document.body.innerHTML = body.replace(/<script>[\s\S]*<\/script>/, '');
  // The page's widget script, as the browser would run it.
  new Function(/<script>([\s\S]*)<\/script>/.exec(body)![1]!)();
  await import('../src/content/form-engine');
  const r = await send({ type: 'EXTRACT_FORM' });
  data = r.data as FormData;
  const built = await buildAnswers(data, {
    profile: PROFILE, resume: null, memory: {}, bank: [], now: () => NOW,
    generate: async (req) => req.fields.map((f): Answer => {
      hints[f.label] = f.hint;
      const key = Object.keys(AI).find((k) => f.label.startsWith(k));
      return key
        ? { field_id: f.id, answer: AI[key]!, confidence: 0.9, source: 'ai_generated', needs_user_input: false }
        : { field_id: f.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'missing', needs_user_input: true };
    }),
  }, '', true);
  answers = built.answers;
  const withLabels = answers.map((a) => ({ ...a, label: data.fields.find((f) => f.id === a.field_id)?.label }));
  const filled = await send({ type: 'FILL_FIELDS', answers: withLabels });
  fillResults = filled.results;
}, 60_000);

const answerOf = (labelStart: string) => {
  const f = data.fields.find((x) => x.label.startsWith(labelStart));
  return answers.find((a) => a.field_id === f?.id)?.answer;
};
const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector(sel) as unknown as T;

describe('the input-type agent on a form with every input type', () => {
  it('reads every control, with the new kinds and their bounds', () => {
    const byLabel = Object.fromEntries(data.fields.map((f) => [f.label.replace(/\s*\*$/, ''), f]));
    expect(byLabel['Open to night shifts']?.type).toBe('switch');
    expect(byLabel['Preferred team size']).toMatchObject({ type: 'range', min: '1', max: '20' });
    expect(byLabel['Comfort with travel (0-100)']).toMatchObject({ type: 'range', min: '0', max: '100', step: '10' });
    expect(byLabel['Signature']?.type).toBe('signature');
    expect(byLabel['Best time to call']?.type).toBe('time');
    expect(byLabel['Graduation month']?.type).toBe('month');
    expect(byLabel['Preferred interview slot']?.type).toBe('datetime-local');
    expect(byLabel['Phone number']).toMatchObject({ type: 'tel', max_length: '10', has_code_picker: true });
    expect(byLabel['Resume']?.type).toBe('file');
    expect(data.fields.length).toBe(25);
  });

  it('tells the AI the shape of each answer', () => {
    expect(hints['Best time to call']).toMatch(/HH:MM/);
    expect(hints['Comfort with travel (0-100)']).toMatch(/between 0 and 100/);
    expect(hints['Open to night shifts']).toBe('Yes or No.');
  });

  it('shapes loose answers into what each control keeps', () => {
    expect(answerOf('Best time to call')).toBe('15:30');
    // From your notice period (15 days), by the profile rules before the AI is asked.
    expect(answerOf('Earliest start date')).toBe('2026-11-21');
    expect(answerOf('Graduation month')).toBe('2015-06');
    expect(answerOf('Preferred interview slot')).toBe('2026-11-20T16:00');
    expect(answerOf('Employment period')).toBe('2020-01-01 to 2026-11-06');
    expect(answerOf('Years of product management')).toBe('5');
    expect(answerOf('Comfort with travel')).toBe('70');
    expect(answerOf('Preferred team size')).toBe('8');
    expect(answerOf('Rate your SQL')).toBe('4');
    expect(answerOf('Are you willing to relocate')).toBe('Yes');
    expect(answerOf('Open to night shifts')).toBe('Yes');
    expect(answerOf('LinkedIn profile')).toBe('https://linkedin.com/in/mahendra-yadav');
    expect(answerOf('Phone number')).toBe('6264252896');
    expect(answerOf('Country code')).toBe('India (+91)');
    expect(answerOf('Signature')).toBe(DEFAULT_PROFILE.name);
  });

  it('fills text, selection, numeric and date controls on the page', () => {
    expect($('#name').value).toBe(DEFAULT_PROFILE.name);
    expect($<HTMLTextAreaElement>('#why').value).toBe('I like building data products.');
    expect($('#email').value).toBe(DEFAULT_PROFILE.email);
    expect($('#li').value).toBe('https://linkedin.com/in/mahendra-yadav');
    expect($<HTMLSelectElement>('#code').value).toBe('91');
    expect($('#phone').value).toBe('6264252896');
    expect($('#street').value).toBe('12 MG Road');
    expect($('#postal').value).toBe('560001');
    expect($('input[name=mode][value=Hybrid]').checked).toBe(true);
    expect([...document.querySelectorAll<HTMLInputElement>('input[name=tools]:checked')].map((x) => x.value)).toEqual(['Jira', 'SQL']);
    expect($<HTMLSelectElement>('#degree').value).toBe("Bachelor's degree");
    expect($('input[name=reloc][value=Yes]').checked).toBe(true);
    expect($('#yrs').value).toBe('5');
    expect($('#travel').value).toBe('70');
    expect($('input[name=sql][value="4"]').checked).toBe(true);
    expect($('#start').value).toBe('2026-11-21');
    expect($('#call').value).toBe('15:30');
    expect($('#grad').value).toBe('2015-06');
    expect($('#slot').value).toBe('2026-11-20T16:00');
    expect($('#period').value).toBe('2020-01-01 to 2026-11-06');
  });

  it('works the custom widgets: switch, ARIA slider, city suggestions, signature pad', () => {
    expect($('#night').getAttribute('aria-checked')).toBe('true');
    expect($('#team').getAttribute('aria-valuenow')).toBe('8');
    expect($('#city').value).toBe('Bangalore');
    expect(Number($<HTMLCanvasElement>('#sig').dataset.strokes)).toBeGreaterThan(10);
  });

  it('reports every answered control as filled', () => {
    const notFilled = answers
      .map((a, i) => ({ label: data.fields.find((f) => f.id === a.field_id)?.label, ok: fillResults[i]?.filled, answer: a.answer }))
      .filter((x) => !x.ok && x.answer !== 'RESUME_UPLOAD' && x.answer !== 'NEEDS_USER_INPUT');
    expect(notFilled).toEqual([]);
  });
});
