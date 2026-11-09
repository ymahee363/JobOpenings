import { describe, expect, it } from 'vitest';
import { buildAnswers, runAiApply, SUBMIT_WAIT_MS, type FlowDeps } from '../src/shared/ai-apply/flow';
import { isValidAgainstOptions } from '../src/shared/ai-apply/answer-rules';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import { degreeChoices } from '../src/shared/ats/workday-plan';
import type { Answer, FormData, FormField } from '../src/shared/ai-apply/types';

const f = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({
  id, label, type: 'text', required: true, options: [], current_value: '', ...over,
});

/** Answers with an AI that says `ai[label]`. */
async function answers(fields: FormField[], ai: Record<string, string> = {}, bank: Array<{ question: string; answer: string }> = []) {
  const asked: string[] = [];
  const data: FormData = { url: 'https://x', title: 't', page_text: '', fields };
  const built = await buildAnswers(data, {
    profile: DEFAULT_PROFILE, resume: null, memory: {}, bank: bank as never, now: () => Date.UTC(2026, 10, 6),
    generate: async (req) => req.fields.map((x): Answer => {
      asked.push(x.label);
      const a = ai[x.label] ?? 'NEEDS_USER_INPUT';
      return { field_id: x.id, answer: a, confidence: 0.9, source: 'ai_generated', needs_user_input: a === 'NEEDS_USER_INPUT' };
    }),
  }, '', false);
  return { by: Object.fromEntries(built.answers.map((a) => [fields.find((x) => x.id === a.field_id)!.label, a.answer])), asked };
}

describe('your answer rules (2026-11-06)', () => {
  it('Karnataka matches "Karnātaka" wherever an ATS writes it that way', () => {
    expect(isValidAgainstOptions(f('s', 'State', { type: 'select', options: ['Kerala', 'Karnātaka', 'Goa'] }), 'Karnataka')).toBe(true);
  });

  it('degree: B.Tech / Bachelor of Technology first, then Bachelor of Engineering, then a general bachelor\'s', async () => {
    const deg = (options: string[]) => f('d', 'Degree', { type: 'select', options });
    expect((await answers([deg(["Bachelor's Degree", 'Bachelor of Technology', "Master's Degree"])], { Degree: "Bachelor's Degree" })).by.Degree).toBe('Bachelor of Technology');
    expect((await answers([deg(["Bachelor's Degree", 'Bachelor of Engineering', "Master's Degree"])], { Degree: "Bachelor's Degree" })).by.Degree).toBe('Bachelor of Engineering');
    expect((await answers([deg(["Bachelor's Degree", "Master's Degree"])], { Degree: "Bachelor's Degree" })).by.Degree).toBe("Bachelor's Degree");
    expect((await answers([deg(['B.Tech', 'B.E.', 'MBA'])], { Degree: 'B.E.' })).by.Degree).toBe('B.Tech');
    expect(degreeChoices('B.Tech').slice(0, 6)).toEqual(['B.Tech', 'B. Tech', 'BTech', 'Bachelor of Technology', 'Bachelor of Engineering', 'B.E.']);
  });

  it('a job\'s location is filled only when the form requires it', async () => {
    const loc = (required: boolean) => f(`l${required}`, 'Location', { entry_type: 'experience', entry_index: 1, required });
    const optional = await answers([loc(false)], { Location: 'Bengaluru' });
    expect(optional.by).toEqual({});
    expect(optional.asked).toEqual([]);
    const required = await answers([loc(true)], { Location: 'Bengaluru' });
    expect(required.by.Location).toBe('Bengaluru');
  });
});

describe('the wait before the final Submit', () => {
  /** A one-page form; `changeAt`: seconds into the wait when you change something on the page. */
  async function run(changeAt: number[] = []) {
    let clock = 0;
    let waitStarted: number | null = null;
    let submittedAt: number | null = null;
    let confirmed = false;
    const engine = async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://x', title: 't', page_text: '', fields: [f('n', 'Full name')] } };
        case 'FIND_SUBMIT': return { ok: true, found: true, text: 'Submit' };
        case 'USER_ACTIVITY': {
          waitStarted ??= clock;
          const secs = (clock - waitStarted) / 1000;
          return { ok: true, count: changeAt.filter((s) => s <= secs).length };
        }
        case 'CLICK_SUBMIT': submittedAt = clock - (waitStarted ?? 0); confirmed = true; return { ok: true };
        case 'FILL_FIELDS': return { ok: true, results: [{ filled: true }] };
        case 'DETECT_ERRORS': return { ok: true, errors: [] };
        case 'PAGE_SIGNALS': return { ok: true, confirmed, captcha: false, closed: false };
        default: return { ok: true, found: false };
      }
    };
    const deps: FlowDeps = {
      frames: async () => [0], send: (_f, m) => engine(m), sleep: async (ms) => { clock += ms; }, now: () => clock,
      profile: DEFAULT_PROFILE, resume: null, memory: {}, bank: [], saveMemory: async () => {}, mayClick: async () => null,
      generate: async () => [],
    };
    const r = await runAiApply(deps, { mode: 'submit', job: { title: 'PM', company: 'X', url: 'https://x' }, settleMs: 0 });
    return { r, submittedAt };
  }

  it('presses Submit 30 s after the form is ready', async () => {
    const { r, submittedAt } = await run();
    expect(r.result).toBe('applied');
    expect(submittedAt).toBeGreaterThanOrEqual(SUBMIT_WAIT_MS);
    expect(submittedAt).toBeLessThan(SUBMIT_WAIT_MS + 3_000);
  });

  it('waits 30 s after your last change when you edit the form meanwhile', async () => {
    const { submittedAt } = await run([10, 25]);
    // Last change at 25 s: Submit at 25 + 30 = 55 s.
    expect(submittedAt).toBeGreaterThanOrEqual(55_000);
    expect(submittedAt).toBeLessThan(58_000);
  });
});
