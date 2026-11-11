import { describe, expect, it } from 'vitest';
import { buildAnswers } from '../src/shared/ai-apply/flow';
import { gpaOption, isGpaLabel } from '../src/shared/ai-apply/answer-rules';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { FormField } from '../src/shared/ai-apply/types';

const profile = { ...DEFAULT_PROFILE, education: [{ institution: 'IIT Guwahati', degree: 'B.Tech', gpa: '7.05' }] };
const field = (label: string, required: boolean, options: string[] = []): FormField =>
  ({ id: label, label, type: options.length ? 'select' : 'text', required, options, current_value: '' }) as FormField;
// The AI would fill every field, GPA included: the rule must win.
const deps = {
  profile, resume: null, memory: {}, bank: [], now: () => 0,
  generate: async (req: { fields: FormField[] }) => req.fields.map((f) => ({ field_id: f.id, answer: '9.1', confidence: 0.9, source: 'llm', needs_user_input: false })),
};

describe('CGPA only on required fields (user, 2026-11-11)', () => {
  it('knows GPA questions', () => {
    expect(isGpaLabel('CGPA*')).toBe(true);
    expect(isGpaLabel('Undergraduate GPA')).toBe(true);
    expect(isGpaLabel('Grade point average')).toBe(true);
    expect(isGpaLabel('GPA scale')).toBe(false);
    expect(isGpaLabel('Company name')).toBe(false);
  });

  it('answers a required CGPA with the profile value and leaves an optional one empty', async () => {
    const built = await buildAnswers({ url: '', title: '', page_text: '', fields: [field('What is your CGPA?', true), field('GPA', false)] }, deps as never, '', false);
    expect(built.answers.find((a) => a.field_id === 'What is your CGPA?')?.answer).toBe('7.05');
    expect(built.answers.find((a) => a.field_id === 'GPA')).toBeUndefined();
  });

  it('picks the range that holds it on a dropdown', () => {
    expect(gpaOption(['Below 6', '6.0 - 7.0', '7.0 - 8.0', '8.0 - 10'], '7.05')).toBe('7.0 - 8.0');
  });
});
