import { describe, expect, it } from 'vitest';
import { classifyError, formatDate, planFix, shorten } from '../src/shared/ai-apply/error-fix';
import { runAiApply, type FlowDeps } from '../src/shared/ai-apply/flow';
import { AiLimitError, backendClient, guessLimitReset, isLimitReply, limitWaitMs } from '../src/shared/ai-apply/llm';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { FormField } from '../src/shared/ai-apply/types';

const f = (label: string, type = 'text', over: Partial<FormField> = {}): FormField => ({
  id: label, label, type, required: true, options: [], current_value: '', ...over,
});
const ctx = { profile: { ...DEFAULT_PROFILE, phone: '+91 62642 52896', location: 'Bangalore, India', linkedin: 'https://www.linkedin.com/in/x/' }, today: new Date(Date.UTC(2026, 10, 6)) };
const plan = (field: FormField, message: string, answer: string, tried: string[] = []) => planFix(field, message, answer, new Set(tried), ctx);

describe('reading error messages', () => {
  it.each([
    ['Summary must be at most 100 characters.', { kind: 'too_long', max: 100 }],
    ['Maximum 50 words', { kind: 'too_long', max: 50, words: true }],
    ['Please lengthen this text to 60 characters or more', { kind: 'too_short' }],
    ['Please write at least 60 characters.', { kind: 'too_short', min: 60 }],
    ['Value must be between 0 and 30.', { kind: 'range', min: 0, max: 30 }],
    ['Value must be less than or equal to 40.', { kind: 'range', max: 40 }],
    ['Invalid date. Please use the format DD/MM/YYYY.', { kind: 'date', format: 'DD/MM/YYYY' }],
    ['Please enter a valid 10-digit mobile number (digits only).', { kind: 'phone' }],
    ['Please enter a valid email address', { kind: 'email' }],
    ['Please enter a URL.', { kind: 'url' }],
    ['Numbers only', { kind: 'digits_only' }],
    ['Please match the requested format.', { kind: 'pattern' }],
    ['This field is required.', { kind: 'required' }],
    ['Please select an option', { kind: 'select' }],
    ['Start date must be in the future', { kind: 'date_future' }],
    ['File must be a PDF under 5 MB', { kind: 'file' }],
    ['An application with this email already exists', { kind: 'duplicate' }],
  ])('"%s"', (message, want) => {
    expect(classifyError(message)).toMatchObject(want);
  });
});

describe('fixing without the AI', () => {
  it('shortens at a sentence or word boundary', () => {
    expect(shorten('One two three. Four five six seven.', 20)).toBe('One two three.');
    expect(shorten('alpha beta gamma delta', 14)).toBe('alpha beta');
    expect(shorten('a b c d e f', 3, true)).toBe('a b c');
    // Seen live: a whole first sentence (51 of 100 characters) beats a cut mid-way through the second.
    expect(shorten('Product manager with seven years in data products. I lead discovery, write PRDs, and ship analytics features.', 99)).toBe('Product manager with seven years in data products.');
    const long = 'I build data products. '.repeat(10);
    const fix = plan(f('Summary', 'textarea'), 'Summary must be at most 100 characters.', long);
    expect(fix.action).toBe('set');
    expect(fix.action === 'set' && fix.answer.length).toBeLessThanOrEqual(100);
  });

  it('clamps a number, keeps digits, reformats a date', () => {
    expect(plan(f('Years in role'), 'Value must be between 0 and 30.', '35')).toMatchObject({ action: 'set', answer: '30' });
    expect(plan(f('CTC'), 'Numbers only', '27 LPA')).toMatchObject({ action: 'set', answer: '27' });
    expect(plan(f('Available from'), 'Please use the format DD/MM/YYYY', '2026-11-21')).toMatchObject({ action: 'set', answer: '21/11/2026' });
    expect(formatDate('2026-03-04', 'MM-DD-YY')).toBe('03-04-26');
    // Only "invalid date": each common format in turn, never one already tried.
    expect(plan(f('Start date', 'date'), 'Invalid date', '2026-11-21')).toMatchObject({ answer: '21/11/2026' });
    expect(plan(f('Start date', 'date'), 'Invalid date', '21/11/2026', ['2026-11-21'])).toMatchObject({ answer: '11/21/2026' });
  });

  it('writes a phone number another way each time', () => {
    const phone = f('Mobile number');
    expect(plan(phone, 'Please enter a valid 10-digit mobile number', '+91 62642 52896')).toMatchObject({ answer: '6264252896' });
    expect(plan(phone, 'Invalid phone number', '6264252896')).toMatchObject({ answer: '+91 6264252896' });
    expect(plan(phone, 'Invalid phone number', '+91 6264252896', ['6264252896'])).toMatchObject({ answer: '+916264252896' });
  });

  it('fixes links and emails from the profile', () => {
    expect(plan(f('LinkedIn'), 'Please enter a valid URL', 'linkedin.com/in/x')).toMatchObject({ answer: 'https://linkedin.com/in/x' });
    expect(plan(f('Email'), 'Please enter a valid email address', 'Mahendra')).toMatchObject({ answer: DEFAULT_PROFILE.email });
  });

  it('sets a value again by interacting when the page says it is empty but it was answered', () => {
    expect(plan(f('Country', 'combobox', { options: ['India'] }), 'Please select an option', 'India')).toMatchObject({ action: 'interact', answer: 'India' });
    // Already tried once: now the AI.
    expect(plan(f('Country', 'combobox', { options: ['India'] }), 'Please select an option', 'India', ['interact:India']).action).toBe('ask_ai');
  });

  it('asks the AI for what needs judgement, and gives up on what cannot be fixed here', () => {
    expect(plan(f('Why this role?', 'textarea'), 'Please write at least 60 characters.', 'I am keen.')).toMatchObject({ action: 'ask_ai' });
    expect(plan(f('Resume', 'file'), 'File must be a PDF under 5 MB', '').action).toBe('give_up');
    expect(plan(f('Email'), 'An application with this email already exists', 'me@x.com').action).toBe('give_up');
  });
});

describe('AI usage limits', () => {
  it('reads when the limit is back', () => {
    expect(isLimitReply(429, '')).toBe(true);
    expect(isLimitReply(502, 'All LLM providers failed -> Gemini: 429 RESOURCE_EXHAUSTED | Groq: rate limit')).toBe(true);
    expect(isLimitReply(502, 'Gemini: 503 high demand')).toBe(false);
    expect(limitWaitMs('Please retry in 4.46s')).toBe(4460);
    expect(limitWaitMs("'retryDelay': '37s'")).toBe(37_000);
    expect(limitWaitMs('Please try again in 7m12.5s')).toBe(432_500);
    expect(limitWaitMs('try again in 1h2m3s')).toBe(3_723_000);
    expect(limitWaitMs('', '20')).toBe(20_000);
    expect(limitWaitMs('quota exceeded')).toBeNull();
    // A daily quota with no time given: the next reset (08:05 UTC).
    expect(new Date(guessLimitReset(Date.UTC(2026, 10, 6, 10), true, 0)).toISOString()).toBe('2026-11-07T08:05:00.000Z');
  });

  const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const req = { instruction: '', candidate: DEFAULT_PROFILE, job: {}, fields: [f('Q')], filled_summary: [], resume_text: '' };

  it('waits out a short limit and carries on', async () => {
    const replies = [reply(502, 'All LLM providers failed -> Gemini: 429 Please retry in 20s'), reply(200, { answers: [{ field_id: 'Q', answer: 'A' }] })];
    const waits: number[] = [];
    const gen = backendClient({ url: 'http://x', accessKey: '' }, { fetchFn: async () => replies.shift()!, sleep: async (ms) => { waits.push(ms); } });
    expect((await gen(req))[0]!.answer).toBe('A');
    expect(waits[0]).toBe(20_500);
  });

  it('hands a long or daily limit to the agent with when it is back', async () => {
    const now = Date.UTC(2026, 10, 6, 10);
    const gen = backendClient({ url: 'http://x', accessKey: '' }, {
      fetchFn: async () => reply(502, 'Gemini: 429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel quota exceeded'),
      sleep: async () => {}, now: () => now,
    });
    const err = await gen(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiLimitError);
    expect(err.daily).toBe(true);
    expect(new Date(err.retryAt).toISOString()).toBe('2026-11-07T08:05:00.000Z');
  });

  it('ends an AI apply run as "limit", not as a failure', async () => {
    const d: FlowDeps = {
      frames: async () => [0],
      send: async (_f, msg) => (msg.type === 'EXTRACT_FORM'
        ? { ok: true, data: { url: 'https://x', title: 't', page_text: '', fields: [f('Why this role?', 'textarea')] } }
        : msg.type === 'FIND_APPLY' ? { ok: true, found: false } : { ok: true }),
      sleep: async () => {}, now: () => 0, profile: DEFAULT_PROFILE, resume: null, memory: {}, bank: [], saveMemory: async () => {},
      mayClick: async () => null,
      generate: async () => { throw new AiLimitError('AI usage limit reached', 123_000, false); },
    };
    const r = await runAiApply(d, { mode: 'submit', job: { title: 'PM', company: 'X', url: 'https://x' }, settleMs: 0 });
    expect(r).toMatchObject({ result: 'limit', retryAt: 123_000 });
  });
});

import { planFix as planFixLi } from '../src/shared/ai-apply/error-fix';
import { DEFAULT_PROFILE as P0 } from '../src/shared/ai-apply/profile';
describe('LinkedIn number errors (2026-11-10)', () => {
  it('"Rs.2700000" rejected as not a decimal number becomes 2700000', () => {
    const f = { id: 'x', label: 'What is your current usual charges?', type: 'text', required: true, options: [], current_value: 'Rs.2700000' };
    const ctx = { profile: P0, today: new Date('2026-11-10') };
    expect(planFixLi(f, 'Enter a decimal number larger than 0.0', 'Rs.2700000', new Set(['Rs.2700000']), ctx)).toMatchObject({ action: 'set', answer: '2700000' });
    expect(planFixLi(f, 'Enter a whole number between 0 and 99', '5 years', new Set(['5 years']), ctx)).toMatchObject({ action: 'set', answer: '5' });
  });
});

describe('LinkedIn "Invalid input" (2026-11-10)', () => {
  it('turns "Rs.2700000" into 2700000 for a charges box', () => {
    const f = { id: 'x', label: 'What is your current usual charges?', type: 'text', required: true, options: [], current_value: 'Rs.2700000' };
    const ctx = { profile: P0, today: new Date('2026-11-10') };
    expect(planFixLi(f, 'Invalid input', 'Rs.2700000', new Set(['Rs.2700000']), ctx)).toMatchObject({ action: 'set', answer: '2700000' });
  });
});
