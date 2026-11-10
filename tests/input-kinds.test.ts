import { describe, expect, it } from 'vitest';
import {
  classifyField, directKindAnswer, INPUT_CATEGORY, kindHint, nationalNumber, normalizeForInput, parseDate, parseMonth, parseNumber,
  parseTime, profileDialCode, type InputKind,
} from '../src/shared/ai-apply/input-kinds';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { FormField } from '../src/shared/ai-apply/types';

const f = (label: string, type: string, over: Partial<FormField> = {}): FormField => ({
  id: label, label, type, required: true, options: [], current_value: '', ...over,
});
const today = new Date(Date.UTC(2026, 10, 6));
const ctx = { profile: { ...DEFAULT_PROFILE, phone: '+91 62642 52896', location: 'Bangalore, India' }, today };
const norm = (field: FormField, answer: string) => normalizeForInput(field, answer, ctx);

describe('classifying the 20 input types into 6 groups', () => {
  const cases: Array<[FormField, InputKind]> = [
    [f('Full name', 'text'), 'text'],
    [f('Cover note', 'textarea'), 'textarea'],
    [f('Preferred work mode', 'radio', { options: ['Remote', 'Hybrid', 'On-site'] }), 'choice'],
    [f('Tools used', 'checkbox', { options: ['Jira', 'SQL', 'Figma'] }), 'checkboxes'],
    [f('Highest degree', 'select', { options: ['BA', 'MA', 'PhD'] }), 'dropdown'],
    [f('Willing to relocate?', 'radio', { options: ['Yes', 'No'] }), 'toggle'],
    [f('Start date', 'date'), 'date'],
    [f('Best time to call', 'time'), 'time'],
    [f('Employment period (date range)', 'text'), 'date_range'],
    [f('Years of experience', 'number'), 'number'],
    [f('Resume', 'file'), 'file'],
    [f('Portfolio', 'text'), 'url'],
    [f('Email', 'email'), 'email'],
    [f('Phone number', 'tel'), 'phone'],
    [f('Street address', 'text'), 'address'],
    [f('Rate your SQL skills', 'radio', { options: ['1', '2', '3', '4', '5'] }), 'rating'],
    [f('Comfort with travel', 'range'), 'slider'],
    [f('Open to night shifts', 'switch', { options: ['Yes', 'No'] }), 'toggle'],
    [f('Signature', 'signature'), 'signature'],
    [f('Current city', 'combobox', { options: ['Bangalore', 'Pune'] }), 'searchable'],
    [f('Country code', 'select', { options: ['India (+91)', 'United States (+1)'] }), 'phone_code'],
    [f('Graduation month', 'month'), 'month'],
    [f('Interview slot', 'datetime-local'), 'datetime'],
  ];
  it.each(cases)('%# %o is %s', (field, kind) => {
    expect(classifyField(field)).toBe(kind);
  });

  it('puts every kind in one of the six groups', () => {
    expect(new Set(Object.values(INPUT_CATEGORY))).toEqual(new Set(['text', 'selection', 'numeric', 'datetime', 'file', 'other']));
  });

  it('does not take "design" for an e-signature', () => {
    expect(classifyField(f('How do you use AI tools in research, PRDs and design brainstorming?', 'textarea'))).toBe('textarea');
  });
});

describe('parsing', () => {
  it('reads dates in many writings, day-first when ambiguous', () => {
    expect(parseDate('2026-12-15', today)).toBe('2026-12-15');
    expect(parseDate('15/12/2026', today)).toBe('2026-12-15');
    expect(parseDate('05/06/2026', today)).toBe('2026-06-05');
    expect(parseDate('05/06/2026', today, true)).toBe('2026-05-06');
    expect(parseDate('12/25/2026', today)).toBe('2026-12-25');
    expect(parseDate('15 Dec 2026', today)).toBe('2026-12-15');
    expect(parseDate('December 15th, 2026', today)).toBe('2026-12-15');
    expect(parseDate('Immediately', today)).toBe('2026-11-07');
    expect(parseDate('in 30 days', today)).toBe('2026-12-06');
    expect(parseDate('2 months', today)).toBe('2027-01-06');
    expect(parseDate('Jan 2020', today)).toBe('2020-01-01');
    expect(parseDate('31/02/2026', today)).toBeNull();
    expect(parseDate('whenever', today)).toBeNull();
  });

  it('reads times as 24-hour HH:MM', () => {
    expect(parseTime('3:30 pm')).toBe('15:30');
    expect(parseTime('9 AM')).toBe('09:00');
    expect(parseTime('12 am')).toBe('00:00');
    expect(parseTime('14:05')).toBe('14:05');
    expect(parseTime('noon')).toBe('12:00');
    expect(parseTime('Any weekday after 3 pm')).toBe('15:00');
    expect(parseTime('25:00')).toBeNull();
  });

  it('reads months and numbers', () => {
    expect(parseMonth('June 2015')).toBe('2015-06');
    expect(parseMonth('06/2015')).toBe('2015-06');
    expect(parseNumber('27 LPA')).toBe(27);
    expect(parseNumber('₹ 1,20,000')).toBe(120000);
    expect(parseNumber('5+ years')).toBe(5);
    expect(parseNumber('none')).toBeNull();
  });

  it('works out the country code and national number', () => {
    expect(profileDialCode({ phone: '+44 7700 900123', location: '' })).toBe('44');
    expect(profileDialCode({ phone: '9876543210', location: 'London, UK' })).toBe('44');
    expect(profileDialCode({ phone: '9876543210', location: 'Bangalore' })).toBe('91');
    expect(nationalNumber('+91 62642 52896', '91')).toBe('6264252896');
    expect(nationalNumber('09876543210', '91')).toBe('9876543210');
    expect(nationalNumber('919876543210', '91')).toBe('9876543210');
  });
});

describe('shaping answers for each control', () => {
  it('dates, times, months, weeks, datetimes and ranges', () => {
    expect(norm(f('Start', 'date'), '15/12/2026').value).toBe('2026-12-15');
    expect(norm(f('Start', 'date', { placeholder: 'MM/DD/YYYY' }), '05/06/2026').value).toBe('2026-05-06');
    expect(norm(f('Call', 'time'), '3:30 pm').value).toBe('15:30');
    expect(norm(f('Grad', 'month'), 'June 2015').value).toBe('2015-06');
    expect(norm(f('Week', 'week'), '2026-11-06').value).toBe('2026-W45');
    expect(norm(f('Slot', 'datetime-local'), '2026-11-20 4 pm').value).toBe('2026-11-20T16:00');
    expect(norm(f('Employment period (date range)', 'text'), 'Jan 2020 to present').value).toBe('2020-01-01 to 2026-11-06');
    expect(norm(f('Start', 'date'), 'whenever').ok).toBe(false);
  });

  it('numbers, sliders and ratings within their bounds', () => {
    expect(norm(f('Years', 'number', { min: '0', max: '40' }), '5+ years').value).toBe('5');
    expect(norm(f('Years', 'number', { max: '10' }), '15').value).toBe('10');
    expect(norm(f('Travel', 'range', { min: '0', max: '100', step: '10' }), 'about 72').value).toBe('70');
    expect(norm(f('Travel', 'range', { min: '0', max: '100' }), 'Intermediate').value).toBe('50');
    expect(norm(f('Rate SQL', 'radio', { options: ['1', '2', '3', '4', '5'] }), '4 out of 5').value).toBe('4');
    expect(norm(f('Rate SQL', 'radio', { options: ['1', '2', '3', '4', '5'] }), '8/10').value).toBe('4');
    expect(norm(f('Rate SQL', 'radio', { options: ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'] }), 'Expert').value).toBe('5 stars');
    expect(norm(f('Rating', 'range', { min: '1', max: '10' }), '7/10').value).toBe('7');
    expect(norm(f('Years', 'number'), 'many').ok).toBe(false);
  });

  it('yes/no toggles from any wording', () => {
    const sw = f('Night shifts', 'switch', { options: ['Yes', 'No'] });
    expect(norm(sw, 'Yes, happy to').value).toBe('Yes');
    expect(norm(sw, 'Sure').value).toBe('Yes');
    expect(norm(sw, 'No thanks').value).toBe('No');
    expect(norm(f('Relocate?', 'radio', { options: ['Yes', 'No'] }), 'true').value).toBe('Yes');
  });

  it('emails, links and phone numbers', () => {
    expect(norm(f('Email', 'email'), ' mailto:me@x.com ').value).toBe('me@x.com');
    expect(norm(f('Email', 'email'), 'Mahendra Yadav').ok).toBe(false);
    expect(norm(f('LinkedIn', 'url'), 'linkedin.com/in/mahendra-yadav').value).toBe('https://linkedin.com/in/mahendra-yadav');
    expect(norm(f('LinkedIn', 'url'), 'https://www.linkedin.com/in/x/').value).toBe('https://www.linkedin.com/in/x/');
    expect(norm(f('Portfolio', 'url'), 'N/A').ok).toBe(true);
    expect(norm(f('Phone', 'tel', { has_code_picker: true }), '+91 62642 52896').value).toBe('6264252896');
    expect(norm(f('Phone', 'tel', { max_length: '10' }), '+91-6264252896').value).toBe('6264252896');
    expect(norm(f('Phone', 'tel', { placeholder: '+1 555 123 4567' }), '6264252896').value).toBe('+91 6264252896');
    expect(norm(f('Phone', 'tel'), '12').ok).toBe(false);
    expect(norm(f('Country code', 'select', { options: ['United States (+1)', 'India (+91)'] }), '+91').value).toBe('India (+91)');
  });

  it('leaves text, choices and the resume marker alone', () => {
    expect(norm(f('Why us?', 'textarea'), 'Because…').value).toBe('Because…');
    expect(norm(f('Mode', 'radio', { options: ['Remote', 'Hybrid'] }), 'Hybrid').value).toBe('Hybrid');
    expect(norm(f('Resume', 'file'), 'RESUME_UPLOAD').value).toBe('RESUME_UPLOAD');
    expect(norm(f('Start', 'date'), 'NEEDS_USER_INPUT').value).toBe('NEEDS_USER_INPUT');
  });
});

describe('answers from the kind alone, and hints for the AI', () => {
  it('signs with your name, dates a signature today, and picks your country code', () => {
    expect(directKindAnswer(f('Signature', 'signature'), ctx)).toBe(DEFAULT_PROFILE.name);
    expect(directKindAnswer(f("Today's date", 'date'), ctx)).toBe('2026-11-06');
    expect(directKindAnswer(f('Country code', 'select', { options: ['United States (+1)', 'India (+91)'] }), ctx)).toBe('India (+91)');
    expect(directKindAnswer(f('Why us?', 'textarea'), ctx)).toBeNull();
  });

  it('tells the AI the shape', () => {
    expect(kindHint(f('Call', 'time'))).toMatch(/HH:MM/);
    expect(kindHint(f('Travel', 'range', { min: '0', max: '100', step: '10' }))).toMatch(/between 0 and 100, in steps of 10/);
    expect(kindHint(f('Why us?', 'textarea'))).toBeUndefined();
  });
});

describe('mobile number on a job outside India (2026-11-10)', () => {
  it('writes +91 in a mobile box with no code picker; keeps the picker at +91', () => {
    const abroad = { ...ctx, profile: { ...ctx.profile, phone: '6264252896' }, abroad: true };
    expect(normalizeForInput(f('Mobile phone number', 'tel'), '6264252896', abroad).value).toBe('+91 6264252896');
    expect(normalizeForInput(f('Mobile phone number', 'tel', { has_code_picker: true }), '6264252896', abroad).value).toBe('6264252896');
    expect(normalizeForInput(f('Phone country code', 'select', { options: ['United States (+1)', 'India (+91)'] }), '+1', { ...abroad }).value).toBe('India (+91)');
    expect(directKindAnswer(f('Phone country code', 'select', { options: ['United States (+1)', 'India (+91)'] }), abroad)).toBe('India (+91)');
  });
});
