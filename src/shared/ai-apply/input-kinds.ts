/**
 * The input-type agent: what kind of control each form field is, how the answer must be written for it, and the
 * answer reshaped into exactly that form before the form engine (src/content/form-engine.ts) puts it on the page.
 *
 * Twenty kinds in six groups:
 *  - text:      text, textarea, email, url, phone, phone_code, address, signature
 *  - selection: choice (radio / multiple choice), checkboxes, dropdown, searchable (autocomplete), toggle (yes/no)
 *  - numeric:   number, slider, rating
 *  - datetime:  date, time, datetime, month, week, date_range
 *  - file:      file
 *  - other:     color, password, unknown
 *
 * Why: a native control silently drops a value in the wrong shape. <input type="time"> keeps nothing but "HH:MM",
 * a number box nothing but digits, a range input clamps to its own bounds, a URL box rejects "linkedin.com/in/x"
 * under validation, a phone box with a separate country picker fails "+91 98…" on length. The LLM is told the
 * shape (`kindHint`, sent as the field's `hint`) and every answer, from any source, is reshaped here
 * (`normalizeForInput`), so the page gets a value it keeps.
 *
 * Pure: no DOM, no chrome. Tested in tests/input-kinds.test.ts.
 */
import type { CandidateProfile, FormField } from './types';

export type InputKind =
  | 'text' | 'textarea' | 'email' | 'url' | 'phone' | 'phone_code' | 'address' | 'signature'
  | 'choice' | 'checkboxes' | 'dropdown' | 'searchable' | 'toggle'
  | 'number' | 'slider' | 'rating'
  | 'date' | 'time' | 'datetime' | 'month' | 'week' | 'date_range'
  | 'file' | 'color' | 'password' | 'unknown';

export type InputCategory = 'text' | 'selection' | 'numeric' | 'datetime' | 'file' | 'other';

export const INPUT_CATEGORY: Record<InputKind, InputCategory> = {
  text: 'text', textarea: 'text', email: 'text', url: 'text', phone: 'text', phone_code: 'text', address: 'text', signature: 'text',
  choice: 'selection', checkboxes: 'selection', dropdown: 'selection', searchable: 'selection', toggle: 'selection',
  number: 'numeric', slider: 'numeric', rating: 'numeric',
  date: 'datetime', time: 'datetime', datetime: 'datetime', month: 'datetime', week: 'datetime', date_range: 'datetime',
  file: 'file', color: 'other', password: 'other', unknown: 'other',
};

const NEEDS = 'NEEDS_USER_INPUT';

const RATING_LABEL = /\brat(e|ing)\b|on a scale|scale of|\bstars?\b|how (likely|satisfied|confident|comfortable|proficient)|proficiency level|self[- ]?assess/i;
const PHONE_CODE_LABEL = /(country|dial(ing)?|calling|phone|mobile|isd)[\s_-]*code|\bisd\b|country\/region (phone|code)/i;
const ADDRESS_LABEL = /address|street|\bcity\b|\btown\b|\bstate\b|province|\bregion\b|zip|postal|pin ?code|postcode|locality|landmark|current location|where are you (based|located)/i;
// Whole words only: "design" must not read as "e-sign" (Ramp's AI-workflow question got your name, 2026-11-06).
const SIGNATURE_LABEL = /\b(e-?)?signature\b|\bsign here\b|\be-?sign\b|type your (full )?name to (sign|confirm|acknowledge)|\bsigned by\b/i;
const DATE_RANGE_LABEL = /date range|from\s*[-–]\s*to|(start|from) and (end|to) date|period of (employment|study)|dates? (attended|employed)/i;

const numbersIn = (opts: string[]) => opts.map((o) => Number((/-?\d+(\.\d+)?/.exec(o) ?? [])[0])).filter((n) => !Number.isNaN(n));

/** What kind of control a field is, from the engine's type, its label and its options. */
export function classifyField(f: FormField): InputKind {
  const type = (f.type || 'text').toLowerCase();
  const label = f.label || '';
  if (type === 'file') return 'file';
  if (type === 'password') return 'password';
  if (type === 'signature') return 'signature';
  if (type === 'switch') return 'toggle';
  if (type === 'color') return 'color';
  if (type === 'time') return 'time';
  if (type === 'datetime-local' || type === 'datetime') return 'datetime';
  if (type === 'month') return 'month';
  if (type === 'week') return 'week';
  if (type === 'range' || type === 'slider') return RATING_LABEL.test(label) ? 'rating' : 'slider';
  if (type === 'date') {
    // Only the year or only the month of a date ("Start date year"): not a full date.
    const year = /\byear\b/i.test(label);
    const month = /\bmonth\b/i.test(label);
    if (year && !month) return 'number';
    if (month && !year) return 'text';
    return DATE_RANGE_LABEL.test(label) ? 'date_range' : 'date';
  }
  if (type === 'radio' || type === 'checkbox' || type === 'select' || type === 'combobox') {
    const opts = f.options ?? [];
    const yesNo = opts.length === 2 && opts.every((o) => /^(yes|no|true|false|on|off)$/i.test(o.trim()));
    if (yesNo) return 'toggle';
    // A 1-5 / 1-10 scale of numbers or stars is a rating, whatever the widget.
    const nums = numbersIn(opts);
    if (opts.length >= 3 && nums.length === opts.length && RATING_LABEL.test(label)) return 'rating';
    if (opts.length >= 3 && opts.every((o) => /^\s*\d+\s*(stars?)?\s*$/i.test(o)) && Math.max(...nums) <= 10) return 'rating';
    if (type === 'radio') return 'choice';
    if (type === 'checkbox') return 'checkboxes';
    if (type === 'combobox') return PHONE_CODE_LABEL.test(label) ? 'phone_code' : 'searchable';
    return PHONE_CODE_LABEL.test(label) ? 'phone_code' : 'dropdown';
  }
  if (type === 'multi-select') return 'checkboxes';
  if (type === 'textarea') return SIGNATURE_LABEL.test(label) ? 'signature' : 'textarea';
  if (type === 'number') return RATING_LABEL.test(label) ? 'rating' : 'number';
  if (type === 'email' || /\be-?mail\b/i.test(label)) return 'email';
  if (type === 'url' || /\b(url|website|web site|portfolio|linkedin|github|link to)\b/i.test(label)) return 'url';
  if (PHONE_CODE_LABEL.test(label)) return 'phone_code';
  if (type === 'tel' || /\b(phone|mobile|cell|contact number|whatsapp)\b/i.test(label)) return 'phone';
  if (SIGNATURE_LABEL.test(label)) return 'signature';
  if (DATE_RANGE_LABEL.test(label)) return 'date_range';
  if (ADDRESS_LABEL.test(label)) return 'address';
  if (type === 'text' || type === 'search' || type === '') return 'text';
  return 'unknown';
}

/** The answer's shape, told to the LLM with the field (the backend prompt reads `hint`). */
export function kindHint(f: FormField): string | undefined {
  const k = classifyField(f);
  const bounds = f.min !== undefined || f.max !== undefined ? ` between ${f.min ?? 'any'} and ${f.max ?? 'any'}` : '';
  switch (k) {
    case 'date': return 'A date, as YYYY-MM-DD.';
    case 'date_range': return 'A start and end date, as "YYYY-MM-DD to YYYY-MM-DD".';
    case 'time': return 'A time of day, 24-hour, as HH:MM.';
    case 'datetime': return 'A date and time, as YYYY-MM-DDTHH:MM.';
    case 'month': return 'A month, as YYYY-MM.';
    case 'week': return 'A week, as a date (YYYY-MM-DD) inside that week.';
    case 'number': return `Only a number${bounds}, no units or words.`;
    case 'slider': return `Only a number${bounds}${f.step ? `, in steps of ${f.step}` : ''}.`;
    case 'rating': return f.options.length ? 'Exactly one of the options (the rating).' : `A rating number${bounds}.`;
    case 'toggle': return 'Yes or No.';
    case 'email': return 'One email address.';
    case 'url': return 'One full web address starting with https://.';
    case 'phone': return f.has_code_picker ? 'The phone number without the country code (the form has a separate country-code picker).' : 'The phone number with its country code, as +<code> <number>.';
    case 'phone_code': return 'The phone country code (for example +91), or the option that has it.';
    case 'address': return 'The address part this field asks for (street, city, state, postal code or country), from the candidate\'s location.';
    case 'signature': return 'The candidate\'s full legal name, as a typed signature.';
    case 'checkboxes': return 'All options that apply, from the options only, separated by commas.';
    default: return undefined;
  }
}

/** The field as it goes to the LLM: with its `hint`. */
export function withKindHint(f: FormField): FormField {
  const hint = kindHint(f);
  return hint ? { ...f, hint } : f;
}

// ------------------------------------------------------------------ dates and times

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const validYmd = (y: number, m: number, d: number) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1;
};
const addDays = (today: Date, n: number) => {
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + n));
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};
const monthOf = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

/**
 * A date in any common writing, as YYYY-MM-DD; null when it is not one. Day-first for an ambiguous 05/06/2026
 * (Indian and most non-US forms), unless the field's own format says month-first.
 */
export function parseDate(raw: string, today: Date, monthFirst = false): string | null {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^(immediate(ly)?|asap|as soon as possible|right away)$/i.test(s)) return addDays(today, 1);
  if (/^today$/i.test(s)) return addDays(today, 0);
  if (/^tomorrow$/i.test(s)) return addDays(today, 1);
  const rel = /^(?:in |after )?(\d+)\s*(day|week|month)s?(?: from (?:now|today))?$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (unit === 'day') return addDays(today, n);
    if (unit === 'week') return addDays(today, n * 7);
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth() + n, today.getDate()));
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return validYmd(+m[1]!, +m[2]!, +m[3]!) ? iso(+m[1]!, +m[2]!, +m[3]!) : null;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    let a = +m[1]!;
    let b = +m[2]!;
    let y = +m[3]!;
    if (y < 100) y += 2000;
    // a is the day unless the form is month-first or a cannot be a month's day order (13/05 is day-first anyway).
    let [d, mo] = monthFirst ? [b, a] : [a, b];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return validYmd(y, mo, d) ? iso(y, mo, d) : null;
  }
  m = /^(\d{1,2}) ([a-z]{3,9}) (\d{4})$/i.exec(s);
  if (m && monthOf(m[2]!) > 0) return validYmd(+m[3]!, monthOf(m[2]!), +m[1]!) ? iso(+m[3]!, monthOf(m[2]!), +m[1]!) : null;
  m = /^([a-z]{3,9}) (\d{1,2}) (\d{4})$/i.exec(s);
  if (m && monthOf(m[1]!) > 0) return validYmd(+m[3]!, monthOf(m[1]!), +m[2]!) ? iso(+m[3]!, monthOf(m[1]!), +m[2]!) : null;
  // A month alone ("Jan 2026", "2026-01", "01/2026"): its first day.
  const mo = parseMonth(s);
  return mo ? `${mo}-01` : null;
}

/** A month as YYYY-MM. */
export function parseMonth(raw: string): string | null {
  const s = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m && +m[2]! >= 1 && +m[2]! <= 12) return `${m[1]}-${pad(+m[2]!)}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && +m[1]! >= 1 && +m[1]! <= 12) return `${m[2]}-${pad(+m[1]!)}`;
  m = /^([a-z]{3,9})\.? (\d{4})$/i.exec(s);
  if (m && monthOf(m[1]!) > 0) return `${m[2]}-${pad(monthOf(m[1]!))}`;
  m = /^(\d{4})[-/.](\d{1,2})[-/.]\d{1,2}$/.exec(s);
  if (m && +m[2]! >= 1 && +m[2]! <= 12) return `${m[1]}-${pad(+m[2]!)}`;
  return null;
}

/** A time of day as 24-hour HH:MM ("9 am", "2:30 PM", "14:00", "0930", "noon"). */
export function parseTime(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = /^(\d{1,2})(?::?(\d{2}))?(?::\d{2})? ?(am|pm|a|p)?(?: ?(ist|utc|gmt|[a-z]{2,4}))?$/.exec(s);
  if (!m) {
    // The time inside a longer answer ("Any weekday after 3 pm") or a datetime.
    const inner = /(\d{1,2}(?::\d{2})? ?(?:am|pm))|T?(\d{2}:\d{2})/.exec(s);
    return inner && (inner[1] || inner[2]) !== s ? parseTime(inner[1] || inner[2]!) : null;
  }
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (!m[2] && !ap && m[1]!.length > 2) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap.startsWith('p') && h !== 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
  }
  return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : null;
}

function isoWeek(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((dt.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${pad(week)}`;
}

// ------------------------------------------------------------------ numbers

/**
 * The number in an answer: "27 LPA" → 27, "1,20,000" → 120000, "5+" → 5, "₹ 85,000.50" → 85000.5, "-3" → -3.
 * Indian and Western digit grouping both read as thousands separators.
 */
export function parseNumber(raw: string): number | null {
  const m = /-?\d[\d,]*(\.\d+)?/.exec(raw.replace(/\s(?=\d{3}\b)/g, ''));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const toNum = (v: string | number | undefined) => (v === undefined || v === '' ? undefined : Number(v));

/** Kept within the field's min/max, and on its step (counted from min). */
export function fitNumber(n: number, f: Pick<FormField, 'min' | 'max' | 'step'>): number {
  const min = toNum(f.min);
  const max = toNum(f.max);
  const step = toNum(f.step);
  let v = n;
  if (min !== undefined && !Number.isNaN(min)) v = Math.max(v, min);
  if (max !== undefined && !Number.isNaN(max)) v = Math.min(v, max);
  if (step !== undefined && step > 0 && !Number.isNaN(step)) {
    const base = min !== undefined && !Number.isNaN(min) ? min : 0;
    v = base + Math.round((v - base) / step) * step;
    v = Number(v.toFixed(10));
    if (max !== undefined && v > max) v -= step;
  }
  return v;
}

/** A level word on a scale: "Expert" on 1-10 → 10, "Intermediate" → the middle. */
function levelOnScale(answer: string, min: number, max: number): number | null {
  const s = answer.toLowerCase();
  const at = (p: number) => min + (max - min) * p;
  if (/\b(none|never|not at all|no experience)\b/.test(s)) return min;
  if (/\b(beginner|basic|novice|low|poor|slightly|rarely|elementary)\b/.test(s)) return at(0.25);
  if (/\b(intermediate|medium|moderate|average|fair|somewhat|sometimes|working)\b/.test(s)) return at(0.5);
  if (/\b(advanced|high|good|very|proficient|often|strong|fluent)\b/.test(s)) return at(0.75);
  if (/\b(expert|excellent|native|always|extremely|master)\b/.test(s)) return max;
  return null;
}

// ------------------------------------------------------------------ contact

/** The country calling code from the profile: "+91 …" in the phone, else from the location (default India). */
export function profileDialCode(p: Pick<CandidateProfile, 'phone' | 'location'>): string {
  const m = /^\s*\+(\d{1,3})[\s-]/.exec(p.phone || '') ?? /^\s*\+(\d{1,3})(?=\d{8,})/.exec((p.phone || '').replace(/[\s()-]/g, ''));
  if (m) return m[1]!;
  const loc = (p.location || '').toLowerCase();
  const byCountry: Array<[RegExp, string]> = [
    [/united states|\busa?\b|new york|california|seattle|san francisco/, '1'], [/canada|toronto|vancouver/, '1'],
    [/united kingdom|\buk\b|london|england/, '44'], [/singapore/, '65'], [/\buae\b|dubai|abu dhabi/, '971'],
    [/germany|berlin|munich/, '49'], [/australia|sydney|melbourne/, '61'], [/netherlands|amsterdam/, '31'],
  ];
  return byCountry.find(([re]) => re.test(loc))?.[1] ?? '91';
}

/** The national part of a phone number (digits only, no country code, no trunk 0). */
export function nationalNumber(phone: string, dial: string): string {
  let d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1).startsWith(dial) ? d.slice(1 + dial.length) : d.slice(1);
  else if (d.startsWith('00' + dial)) d = d.slice(2 + dial.length);
  else if (d.length > 10 && d.startsWith(dial)) d = d.slice(dial.length);
  return d.replace(/^0+/, '');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ------------------------------------------------------------------ the agent

export interface NormalizeContext {
  profile: CandidateProfile;
  today: Date;
}

export interface Normalized {
  value: string;
  /** False: the answer cannot be written into this kind of control (the caller leaves the field for you). */
  ok: boolean;
  reason?: string;
}

const ok = (value: string): Normalized => ({ value, ok: true });
const bad = (value: string, reason: string): Normalized => ({ value, ok: false, reason });

/** Closest option for a number on a rating/scale ("4/5" on options 1..5 → "4"; "8 out of 10" on 1..5 → "4"). */
function ratingOption(answer: string, options: string[]): string | null {
  const exact = options.find((o) => o.trim().toLowerCase() === answer.trim().toLowerCase());
  if (exact) return exact;
  const nums = numbersIn(options);
  if (nums.length !== options.length || !nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const frac = /(\d+(?:\.\d+)?)\s*(?:\/|out of|of)\s*(\d+)/i.exec(answer);
  let n: number | null = frac ? (Number(frac[1]) / Number(frac[2])) * max : parseNumber(answer);
  if (n === null) n = levelOnScale(answer, min, max);
  if (n === null) return null;
  const want = n;
  let best = 0;
  nums.forEach((v, i) => {
    if (Math.abs(v - want) < Math.abs(nums[best]! - want)) best = i;
  });
  return options[best]!;
}

/**
 * An answer reshaped for the control it goes into. Answers that are already right pass through unchanged; an
 * answer that cannot fit (a word for a number box, an address in an email box) comes back `ok: false`.
 */
export function normalizeForInput(f: FormField, answer: string, ctx: NormalizeContext): Normalized {
  const a = (answer ?? '').trim();
  if (!a || a === NEEDS || a === 'RESUME_UPLOAD') return ok(answer);
  const k = classifyField(f);
  const monthFirst = /mm\/dd/i.test(f.placeholder ?? '');
  switch (k) {
    case 'date': {
      const d = parseDate(a, ctx.today, monthFirst);
      return d ? ok(d) : bad(a, 'not a date');
    }
    case 'date_range': {
      const parts = a.split(/\s+(?:to|until|till|-|–|—)\s+/i);
      if (parts.length !== 2) {
        const one = parseDate(a, ctx.today, monthFirst);
        return one ? ok(one) : bad(a, 'not a date range');
      }
      const [s, e] = parts.map((p) => parseDate(p, ctx.today, monthFirst) ?? (/^(present|current|now|till date)$/i.test(p.trim()) ? addDays(ctx.today, 0) : null));
      return s && e ? ok(`${s} to ${e}`) : bad(a, 'not a date range');
    }
    case 'time': {
      const t = parseTime(a);
      return t ? ok(t) : bad(a, 'not a time');
    }
    case 'datetime': {
      const [dPart, ...rest] = a.split(/[T ]/);
      const d = parseDate(dPart ?? '', ctx.today, monthFirst) ?? parseDate(a.replace(/\s+\d{1,2}(:\d{2})?\s*(am|pm)?$/i, ''), ctx.today, monthFirst);
      const t = parseTime(rest.join(' ')) ?? parseTime(a) ?? '10:00';
      return d ? ok(`${d}T${t}`) : bad(a, 'not a date and time');
    }
    case 'month': {
      const m = parseMonth(a) ?? parseDate(a, ctx.today, monthFirst)?.slice(0, 7) ?? null;
      return m ? ok(m) : bad(a, 'not a month');
    }
    case 'week': {
      if (/^\d{4}-W\d{2}$/i.test(a)) return ok(a.toUpperCase());
      const d = parseDate(a, ctx.today, monthFirst);
      return d ? ok(isoWeek(d)) : bad(a, 'not a week');
    }
    case 'number': {
      const n = parseNumber(a);
      return n === null ? bad(a, 'not a number') : ok(String(fitNumber(n, f)));
    }
    case 'slider': {
      const min = toNum(f.min) ?? 0;
      const max = toNum(f.max) ?? 100;
      const n = parseNumber(a) ?? levelOnScale(a, min, max);
      return n === null ? bad(a, 'not a value on the slider') : ok(String(fitNumber(n, { min: String(min), max: String(max), step: f.step })));
    }
    case 'rating': {
      if (f.options.length) {
        const o = ratingOption(a, f.options);
        return o ? ok(o) : bad(a, 'not one of the ratings');
      }
      const min = toNum(f.min) ?? 1;
      const max = toNum(f.max) ?? 5;
      const frac = /(\d+(?:\.\d+)?)\s*(?:\/|out of|of)\s*(\d+)/i.exec(a);
      const n = frac ? (Number(frac[1]) / Number(frac[2])) * max : parseNumber(a) ?? levelOnScale(a, min, max);
      return n === null ? bad(a, 'not a rating') : ok(String(fitNumber(Math.round(n), { min: String(min), max: String(max), step: f.step })));
    }
    case 'toggle': {
      if (/^(yes|y|true|on|agree|i agree|accept|accepted|checked|1|sure|of course|definitely)\b/i.test(a)) return ok(f.options.find((o) => /^(yes|true|on)$/i.test(o)) ?? 'Yes');
      if (/^(no|n|false|off|disagree|decline|unchecked|0|not)\b/i.test(a)) return ok(f.options.find((o) => /^(no|false|off)$/i.test(o)) ?? 'No');
      return f.options.includes(a) ? ok(a) : bad(a, 'not yes or no');
    }
    case 'email': {
      const e = a.replace(/^mailto:/i, '').trim();
      return EMAIL.test(e) ? ok(e) : bad(a, 'not an email address');
    }
    case 'url': {
      if (!/[.]/.test(a) || /\s/.test(a.trim())) return /^(n\/?a|none|not applicable)$/i.test(a) ? ok(a) : bad(a, 'not a web address');
      const withScheme = /^https?:\/\//i.test(a) ? a : `https://${a.replace(/^\/+/, '')}`;
      try {
        return ok(new URL(withScheme).toString().replace(/\/$/, a.endsWith('/') ? '/' : ''));
      } catch {
        return bad(a, 'not a web address');
      }
    }
    case 'phone': {
      const digits = a.replace(/\D/g, '');
      if (digits.length < 6) return bad(a, 'not a phone number');
      const dial = profileDialCode({ phone: a.startsWith('+') ? a : ctx.profile.phone, location: ctx.profile.location });
      const national = nationalNumber(a, dial);
      // A separate country-code picker, or a box sized for a national number: no code in the number.
      const max = toNum(f.max_length);
      if (f.has_code_picker || (max !== undefined && max <= 10)) return ok(national);
      // A box that shows "+" in its example wants the code.
      if (/\+/.test(f.placeholder ?? '')) return ok(`+${dial} ${national}`);
      return ok(a.startsWith('+') ? a : national);
    }
    case 'phone_code': {
      const dial = /^\+?\d{1,3}$/.test(a.replace(/\s/g, '')) ? a.replace(/[\s+]/g, '') : profileDialCode(ctx.profile);
      if (!f.options.length) return ok(`+${dial}`);
      const re = new RegExp(`(^|[^\\d])\\+?\\s?${dial}(?!\\d)`);
      // "+1" is shared (US, Canada): prefer the option naming the country in your location.
      const loc = (ctx.profile.location || '').toLowerCase().split(/[,\s]+/).filter((w) => w.length > 3);
      const matching = f.options.filter((o) => re.test(o));
      const hit = matching.find((o) => loc.some((w) => o.toLowerCase().includes(w)) || (dial === '91' && /india/i.test(o))) ?? matching[0];
      return hit ? ok(hit) : ok(a);
    }
    case 'signature':
      return ok(a);
    case 'color':
      return /^#[0-9a-f]{6}$/i.test(a) ? ok(a.toLowerCase()) : bad(a, 'not a colour');
    default:
      return ok(answer);
  }
}

/**
 * Answers that come from the kind alone, without the LLM: a signature is your full name; "Date" next to a
 * signature or "Today's date" is today; a phone country code is yours.
 */
export function directKindAnswer(f: FormField, ctx: NormalizeContext): string | null {
  const k = classifyField(f);
  if (k === 'signature' && ctx.profile.name) return ctx.profile.name;
  if (k === 'phone_code') return normalizeForInput(f, `+${profileDialCode(ctx.profile)}`, ctx).value;
  if (k === 'date' && /today'?s date|date signed|signature date|current date|date of (signing|signature|application)/i.test(f.label)) {
    return addDays(ctx.today, 0);
  }
  return null;
}
