import { describe, expect, it } from 'vitest';
import { buildAnswers, MEMORY_MIN_CONFIDENCE } from '../src/shared/ai-apply/flow';
import { backendClient } from '../src/shared/ai-apply/llm';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { FormField } from '../src/shared/ai-apply/types';

const field = (label: string): FormField => ({ id: label, label, type: 'textarea', required: true, options: [], current_value: '' }) as FormField;

describe('AI answers kept for later forms (ML review, 2026-11-11)', () => {
  it('remembers confident AI answers only', async () => {
    const deps = {
      profile: DEFAULT_PROFILE, resume: null, memory: {}, bank: [], now: () => 0,
      generate: async (req: { fields: FormField[] }) => req.fields.map((f) => ({
        field_id: f.id, answer: `answer to ${f.label}`, source: 'ai_generated', needs_user_input: false,
        confidence: f.label.startsWith('Sure') ? 0.9 : MEMORY_MIN_CONFIDENCE - 0.2,
      })),
    };
    const built = await buildAnswers({ url: '', title: '', page_text: '', fields: [field('Sure thing: why this company?'), field('Unsure: describe a failure')] }, deps as never, '', false);
    const remembered = Object.values(built.memory).map((e) => (e as { label: string }).label);
    expect(remembered).toContain('Sure thing: why this company?');
    expect(remembered).not.toContain('Unsure: describe a failure');
  });
});

describe('AI calls have a deadline', () => {
  it('passes an abort signal to every call', async () => {
    let signal: unknown;
    const generate = backendClient({ url: 'http://x', accessKey: '' }, {
      fetchFn: (async (_u: string, init: { signal?: unknown }) => { signal = init.signal; return new Response(JSON.stringify({ answers: [] }), { status: 200 }); }) as never,
    });
    await generate({ instruction: '', candidate: DEFAULT_PROFILE, job: {}, fields: [field('q')], filled_summary: [], resume_text: '' });
    expect(signal).toBeDefined();
  });
});
