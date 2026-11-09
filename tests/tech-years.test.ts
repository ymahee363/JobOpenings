import { describe, expect, it } from 'vitest';
import { directMapAnswer, techYears } from '../src/shared/ai-apply/answer-rules';

const now = new Date(2026, 10, 6);
const field = (label: string, options: string[] = []) => ({ id: 'q', label, type: options.length ? 'select' : 'text', options, required: true, current_value: '' }) as never;

describe('years of <skill> experience', () => {
  it('answers 5 years for established skills', () => {
    expect(techYears('How many years of SQL experience do you have?', now)).toBe(5);
    expect(techYears('How many years of CRM and Marketing Analytics experience do you have?', now)).toBe(5);
    expect(techYears('How many years of no code/low code automation experience do you have?', now)).toBe(5);
  });

  it('answers fewer years for technology younger than 5 years', () => {
    expect(techYears('How many years of building real AI workflows experience do you have?', now)).toBe(2);
    expect(techYears('How many years of Generative AI / LLM experience?', now)).toBe(3);
    expect(techYears('Years of experience with MCP servers', now)).toBe(1);
  });

  it('leaves total experience questions to your profile', () => {
    expect(techYears('Total years of experience', now)).toBeNull();
    expect(techYears('Years of experience', now)).toBeNull();
  });

  it('picks the matching option in a list', () => {
    expect(directMapAnswer(field('How many years of SQL experience do you have?', ['0-1 years', '2-4 years', '5-7 years', '8+ years']), { custom_fields: [], experience: [] } as never)).toBe('5-7 years');
  });
});
