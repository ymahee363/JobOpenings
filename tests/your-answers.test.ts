import { describe, expect, it } from 'vitest';
import { buildAnswers } from '../src/shared/ai-apply/flow';
import { rememberAnswers, yourAnswer, yourFacts, type MemoryMap } from '../src/shared/ai-apply/memory';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import { seedPatch } from '../src/shared/ai-apply/seed';
import type { AnswerRequest } from '../src/shared/ai-apply/llm';
import type { Answer, FormField } from '../src/shared/ai-apply/types';
// Your personal seed (git-ignored): these checks run only where it exists.
const seeds = import.meta.glob<{ formMemory: MemoryMap }>('../seed/ai-seed.json', { eager: true, import: 'default' });
const seedJson = Object.values(seeds)[0];

const f = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({
  id, label, type: 'text', required: true, options: [], current_value: '', ...over,
});
const yesNo = (id: string, label: string) => f(id, label, { type: 'radio', options: ['Yes', 'No'] });

async function build(fields: FormField[], memory: MemoryMap) {
  const calls: AnswerRequest[] = [];
  const built = await buildAnswers({ url: 'https://x', title: 't', page_text: '', fields }, {
    profile: { ...DEFAULT_PROFILE, notice_period: '15 days' }, resume: null, memory, bank: [], now: () => Date.UTC(2026, 10, 6),
    generate: async (req) => {
      calls.push(req);
      return req.fields.map((x): Answer => ({ field_id: x.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'missing', needs_user_input: true }));
    },
  }, '', false);
  return { by: Object.fromEntries(built.answers.map((a) => [fields.find((x) => x.id === a.field_id)!.label, a.answer])), calls };
}

describe('answers you gave yourself', () => {
  it('are kept apart from the agent\'s: the agent never overwrites one of yours', () => {
    let m = rememberAnswers({}, [{ label: 'Notice period (days)', answer: '0' }], 1, 'you');
    m = rememberAnswers(m, [{ label: 'Notice period (days)', answer: '15' }], 2);
    expect(yourAnswer(m, 'Notice period (days)')).toBe('0');
    m = rememberAnswers(m, [{ label: 'Notice period (days)', answer: '30' }], 3, 'you');
    expect(yourAnswer(m, 'notice period days')).toBe('30');
  });

  it('come first, even before your profile (you typed 0 for notice period; the profile says 15 days)', async () => {
    const memory = rememberAnswers({}, [{ label: 'What is your current notice period?', answer: '0' }], 1, 'you');
    const { by } = await build([f('n', 'What is your current notice period?')], memory);
    expect(by['What is your current notice period?']).toBe('0');
  });

  it('are told to the AI as facts for questions worded differently', async () => {
    const memory = rememberAnswers({}, [{ label: 'Will you require visa sponsorship?', answer: 'No' }], 1, 'you');
    const { calls } = await build([yesNo('v', 'Do you need a work permit or sponsorship to work in India?')], memory);
    expect(calls[0]!.instruction).toMatch(/Facts the candidate gave[\s\S]*Will you require visa sponsorship\? → No/);
    expect(yourFacts(memory)).toEqual(['Will you require visa sponsorship? → No']);
  });
});

describe('your answers to the Nielsen screening questions (seed, 2026-11-06)', () => {
  const memory = seedJson?.formMemory ?? {};
  it.skipIf(!seedJson)('answer those questions wherever they are asked the same way', async () => {
    const fields = [
      yesNo('a', 'Are you at least 18 years of age or older? *'),
      yesNo('b', 'Are you legally authorized to work in the country for which you are applying? *'),
      yesNo('c', 'Will you now or at any point in the future require employment visa sponsorship to work or continue working in the country of application? *'),
      yesNo('d', 'Are you an OCI (Overseas Citizenship of India) Card Holder? *'),
      yesNo('e', 'Are you currently employed by Nielsen or have you previously worked for the company as an employee, contractor and/or temporary associate? *'),
      f('g', 'What is your expected yearly gross total compensation for this position in your local currency (base plus any variable pay)? *'),
      f('h', 'What is your current notice period or date you are available to start a new position? *'),
    ];
    const { by, calls } = await build(fields, memory);
    expect(Object.values(by)).toEqual(['Yes', 'Yes', 'No', 'No', 'No', '2700000', '0']);
    expect(calls).toHaveLength(0);
  });

  it('a newer seed answer replaces an older remembered one; an older one does not', () => {
    const mine: MemoryMap = { q: { label: 'Q', answer: 'old', category: 'Other', updatedAt: 5 } };
    const newer = seedPatch({ version: 2, formMemory: { q: { label: 'Q', answer: 'new', category: 'Other', updatedAt: 9, by: 'you' } } }, { profileSaved: true, memory: mine, resume: null, coverLetter: null });
    expect(newer.memory?.q).toMatchObject({ answer: 'new', by: 'you' });
    const older = seedPatch({ version: 2, formMemory: { q: { label: 'Q', answer: 'stale', category: 'Other', updatedAt: 1 } } }, { profileSaved: true, memory: mine, resume: null, coverLetter: null });
    expect(older.memory).toBeUndefined();
  });
});
