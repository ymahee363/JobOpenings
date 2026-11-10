// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { lvFill, lvState } from '../src/content/ats/lever';
import { DEDICATED_ATS, detectAts } from '../src/shared/ats/detect';
import html from './fixtures/forms/lever-paytm.html?raw';

describe('Lever applier', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  });

  it('is a dedicated applier for jobs.lever.co', () => {
    expect(detectAts('https://jobs.lever.co/fampay/b11c81ce-fe5c-4eb6-a3e1-d268dd3ad926/apply')).toBe('lever');
    expect(DEDICATED_ATS).toContain('lever');
  });

  it('sees the application form', () => {
    expect(lvState().page).toBe('form');
  });

  it('fills your details by name and leaves the employer questions to the engine', async () => {
    const r = await lvFill({
      name: 'Mahendra Yadav', email: 'me@example.com', phone: '6264252896', location: '', company: 'Acme',
      linkedin: 'https://www.linkedin.com/in/mahendra-yadav/', websites: ['https://github.com/x'], resume: null,
    });
    const val = (n: string) => document.querySelector<HTMLInputElement>(`input[name="${n}"]`)?.value;
    expect(val('name')).toBe('Mahendra Yadav');
    expect(val('email')).toBe('me@example.com');
    expect(val('phone')).toBe('6264252896');
    expect(val('org')).toBe('Acme');
    expect(val('urls[LinkedIn]')).toBe('https://www.linkedin.com/in/mahendra-yadav/');
    expect(val('urls[Github]')).toBe('https://github.com/x');
    expect(r.failed).toEqual([]);
    expect([...document.querySelectorAll<HTMLTextAreaElement>('textarea')].every((t) => !t.value)).toBe(true);
  });
});
