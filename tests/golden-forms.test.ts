// @vitest-environment happy-dom
/**
 * The golden form set (tests/fixtures/forms/golden.json): real application forms from Greenhouse, Lever, Ashby,
 * Workable, Phenom and company career sites, saved and run through the real form engine and answer logic. Each case
 * pins what the engine extracts, which answers come straight from the profile (no LLM call), which questions go to
 * the LLM, and that filling puts the profile's answers into the page. A site that changes, or a change that makes
 * the agent slower (more LLM calls) or wrong, fails here first.
 *
 * Captures mark what the real browser did not render (data-golden-hidden), since saved pages have no CSS.
 * To add a form: capture it the same way (see README, "Golden form set"), add a case, run the test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnswers } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { Answer, CandidateProfile, FormData } from '../src/shared/ai-apply/types';
import goldenJson from './fixtures/forms/golden.json';

interface GoldenCase {
  name: string;
  fixture: string;
  fields: Array<[string, string, boolean]>;
  /** Exact profile answers, by label (cases with page selectors). */
  answers?: Record<string, string>;
  /** Profile answers as [label, answer], in field order. */
  direct?: Array<[string, string]>;
  /** The questions that go to the LLM: label starts (`answers` cases) or full labels (`direct` cases). */
  toLLM: string[];
  /** What the fake LLM answers, by label start. */
  llmAnswers?: Record<string, string>;
  /** Page checks after filling. */
  filled?: Record<string, string>;
  checked?: string[];
  unchecked?: string[];
  /** After filling, re-extract and expect every profile answer back in its field. */
  readBack?: boolean;
}

/**
 * Extraction opens each dropdown and waits for its options on real timers (~400 ms each), so a form with many
 * dropdowns (Greenhouse: Discord has 18) takes about 7 s.
 */
const EXTRACT_TIMEOUT_MS = 30_000;

const golden = goldenJson as unknown as { cases: GoldenCase[] };
const pages = import.meta.glob<string>('./fixtures/forms/*.html', { query: '?raw', import: 'default', eager: true });

/** The profile the golden answers are pinned to: the seeded one plus the links and facts your real profile has. */
const PROFILE: CandidateProfile = {
  ...DEFAULT_PROFILE,
  phone: '6264252896',
  linkedin: 'https://www.linkedin.com/in/mahendra-yadav/',
  portfolio: 'https://www.mahendrayadavpm.in/',
  custom_fields: [
    { id: '1', name: 'Github', value: 'https://github.com/ymahee363' },
    { id: '2', name: 'Nationality', value: 'Indian' },
    { id: '3', name: 'Country', value: 'India' },
    { id: '4', name: 'Gender', value: 'Male' },
  ],
};

type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
let listener: Listener;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (msg: Record<string, unknown>) => new Promise<any>((resolve) => listener(msg, {}, resolve));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (l: Listener) => { listener = l; } } } });
  // happy-dom does no layout: what the real browser did not render is marked data-golden-hidden.
  Element.prototype.getClientRects = function (this: Element) {
    return (this.closest('[data-golden-hidden]') ? [] : [{ width: 1, height: 1 }]) as unknown as DOMRectList;
  };
  delete (window as unknown as { __aiFormEngine?: boolean }).__aiFormEngine;
});

describe.each(golden.cases)('golden form: $name', (c) => {
  async function load(): Promise<FormData> {
    const html = pages[`./fixtures/forms/${c.fixture}`];
    if (html === undefined) throw new Error(`missing fixture ${c.fixture}`);
    document.body.innerHTML = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
    await import('../src/content/form-engine');
    const r = await send({ type: 'EXTRACT_FORM' });
    expect(r.ok, String(r.error)).toBe(true);
    return r.data as FormData;
  }

  async function answer(data: FormData) {
    const toLLM: string[] = [];
    const built = await buildAnswers(data, {
      profile: PROFILE, resume: null, memory: {}, bank: [], now: () => 0,
      generate: async (req) => {
        toLLM.push(...req.fields.map((f) => f.label));
        return req.fields.map((f): Answer => {
          const key = Object.keys(c.llmAnswers ?? {}).find((k) => f.label.startsWith(k));
          return key
            ? { field_id: f.id, answer: c.llmAnswers![key]!, confidence: 0.9, source: 'ai_generated', needs_user_input: false }
            : { field_id: f.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'missing', needs_user_input: true };
        });
      },
    }, '', true);
    return { built, toLLM };
  }

  it('extracts every field with a clean label, type and required flag', async () => {
    const data = await load();
    expect(data.fields.map((f) => [f.label, f.type, f.required])).toEqual(c.fields);
  }, EXTRACT_TIMEOUT_MS);

  it('answers from the profile, and asks the LLM only what needs judgement', async () => {
    const data = await load();
    const { built, toLLM } = await answer(data);
    const sourceOf = (id: string) => built.answers.find((a) => a.field_id === id);
    if (c.direct) {
      const direct = data.fields.filter((f) => sourceOf(f.id)?.source === 'direct').map((f) => [f.label, sourceOf(f.id)!.answer]);
      expect(direct).toEqual(c.direct);
      expect(toLLM).toEqual(c.toLLM);
      return;
    }
    const byLabel = Object.fromEntries(data.fields.map((f) => [f.label, sourceOf(f.id)]));
    for (const [label, value] of Object.entries(c.answers ?? {})) {
      expect(byLabel[label]?.answer, label).toBe(value);
      expect(byLabel[label]?.source, label).toBe('direct');
    }
    expect(toLLM.length).toBe(c.toLLM.length);
    c.toLLM.forEach((start, i) => expect(toLLM[i]?.startsWith(start), `LLM question ${i}: ${toLLM[i]}`).toBe(true));
  }, EXTRACT_TIMEOUT_MS);

  it('fills the page with those answers', async () => {
    const data = await load();
    const { built } = await answer(data);
    const answers = built.answers.map((a) => ({ ...a, label: data.fields.find((f) => f.id === a.field_id)?.label }));
    const r = await send({ type: 'FILL_FIELDS', answers });
    expect(r.ok).toBe(true);
    for (const [selector, value] of Object.entries(c.filled ?? {})) {
      expect(document.querySelector<HTMLInputElement>(selector)?.value, selector).toBe(value);
    }
    for (const selector of c.checked ?? []) expect(document.querySelector<HTMLInputElement>(selector)?.checked, selector).toBe(true);
    for (const selector of c.unchecked ?? []) expect(document.querySelector<HTMLInputElement>(selector)?.checked, selector).toBe(false);
    if (c.readBack) {
      const after = (await send({ type: 'EXTRACT_FORM' })).data as FormData;
      for (const a of built.answers.filter((x) => x.source === 'direct')) {
        const label = data.fields.find((f) => f.id === a.field_id)!.label;
        const now = after.fields.find((f) => f.id === a.field_id)?.current_value ?? '';
        // A select shows its option's own text ("India (+91)" for India).
        expect(now === a.answer || now.startsWith(`${a.answer} `), `${label}: wanted "${a.answer}", page has "${now}"`).toBe(true);
      }
    }
  }, EXTRACT_TIMEOUT_MS);
});
