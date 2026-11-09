// @vitest-environment happy-dom
/**
 * The error-fix agent end to end: tests/fixtures/forms/error-form.html rejects the first Submit with six errors
 * written five different ways (Bootstrap .invalid-feedback, aria-describedby, MUI helper text, aria-errormessage,
 * a plain .error) plus a page banner. The real flow and form engine read them, fix each (phone without the code,
 * summary shortened, years clamped, a date rewritten as DD-MM-YYYY, a too-short answer rewritten by the AI) and submit again.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runAiApply, type FlowDeps } from '../src/shared/ai-apply/flow';
import type { AnswerRequest } from '../src/shared/ai-apply/llm';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { Answer } from '../src/shared/ai-apply/types';
import type { ApplyReport } from '../src/shared/auto-apply/runner';
import html from './fixtures/forms/error-form.html?raw';

type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
let listener: Listener;
const send = (msg: Record<string, unknown>) => new Promise<unknown>((resolve) => { if (listener(msg, {}, resolve) !== true) resolve(undefined); });

const LONG_SUMMARY = 'Product manager with seven years in data products. I lead discovery, write PRDs, and ship analytics features with engineering and design teams.';
const GOOD_WHY = 'I want to own the household data products roadmap and grow measurable customer outcomes.';

const aiCalls: AnswerRequest[] = [];
let result: ApplyReport;
const statuses: string[] = [];

beforeAll(async () => {
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (l: Listener) => { listener = l; } } } });
  Element.prototype.getClientRects = function (this: Element) { return (this.closest('[hidden]') ? [] : [{ width: 1, height: 1 }]) as unknown as DOMRectList; };
  const body = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
  document.body.innerHTML = body.replace(/<script>[\s\S]*<\/script>/, '');
  new Function(/<script>([\s\S]*)<\/script>/.exec(body)![1]!)();
  await import('../src/content/form-engine');

  let clock = Date.UTC(2026, 10, 6, 10);
  const deps: FlowDeps = {
    frames: async () => [0],
    send: (_f, msg) => send(msg),
    sleep: async (ms) => { clock += ms; await new Promise((r) => setTimeout(r, 0)); },
    now: () => clock,
    profile: { ...DEFAULT_PROFILE, phone: '+91 62642 52896', location: 'Bangalore, India' },
    resume: null, memory: {}, bank: [], saveMemory: async () => {}, mayClick: async () => null,
    status: (t) => statuses.push(t),
    generate: async (req) => {
      aiCalls.push(req);
      const fixing = /rejected these answers/.test(req.instruction);
      return req.fields.map((f): Answer => {
        const answer = /summary/i.test(f.label) ? LONG_SUMMARY
          : /years in current role/i.test(f.label) ? '35'
            : /why this role/i.test(f.label) ? (fixing ? GOOD_WHY : 'I am keen.')
              : 'NEEDS_USER_INPUT';
        return { field_id: f.id, answer, confidence: 0.9, source: 'ai_generated', needs_user_input: answer === 'NEEDS_USER_INPUT' };
      });
    },
  };
  result = await runAiApply(deps, { mode: 'submit', job: { title: 'PM', company: 'X', url: 'https://x' }, settleMs: 0, pageWaitMs: 2_000 });
}, 120_000);

describe('the error-fix agent on a form that rejects the first Submit', () => {
  it('fixes every error and gets the application through', () => {
    expect(result.result, result.reason).toBe('applied');
    expect((window as unknown as { __submits: number }).__submits).toBe(2);
    expect(document.body.textContent).toMatch(/Thank you for applying/);
  });

  it('fixed the mechanical errors without the AI, and asked it only for the too-short answer', () => {
    // First call: the questions; second: only "Why this role?", with the form's error in the instruction.
    expect(aiCalls).toHaveLength(2);
    expect(aiCalls[1]!.fields.map((f) => f.label)).toEqual(['Why this role? *']);
    expect(aiCalls[1]!.instruction).toMatch(/at least 60 characters/);
    const fixes = statuses.filter((s) => s.startsWith('Fixing:')).join(' ');
    expect(fixes).toMatch(/Mobile number \*: phone written another way/);
    expect(fixes).toMatch(/Professional summary \*: shortened to 100 characters/);
    expect(fixes).toMatch(/Years in current role \*: kept within 0–30/);
    expect(fixes).toMatch(/Available from \*: date as DD-MM-YYYY/);
    expect((window as unknown as { __seen: string[] }).__seen[1]).toMatch(/^\d{2}-\d{2}-2026$/);
  });
});
