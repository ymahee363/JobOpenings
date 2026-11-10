/**
 * The error-fix agent: reads what a form says is wrong with an answer and works out the fix.
 *
 * Most validation errors have a mechanical fix, so they never reach the LLM:
 *  - too long ("at most 500 characters", "maximum 100 words")  → shortened at a sentence or word boundary
 *  - out of range ("between 0 and 30", "must be ≤ 40")         → the number clamped into range
 *  - wrong format: date ("use MM/DD/YYYY"), phone, email, URL  → the same value in the next accepted format
 *  - "numbers only" / "letters only"                           → stripped to digits / letters
 *  - "required" / "please select" on a field already answered  → the value did not stick: set it again by
 *    interacting with the control as a person would (FORCE_INTERACT_FIELD)
 * What needs judgement (too short, "must be in the past", an unknown message) goes back to the LLM with the error
 * and the field's format hint. Each field keeps the answers already tried, so a fix is never repeated.
 *
 * Pure: tested in tests/error-fix.test.ts; the flow (src/shared/ai-apply/flow.ts, autoFixErrors) runs it.
 */
import { classifyField, kindHint, nationalNumber, normalizeForInput, parseDate, parseNumber, profileDialCode, type NormalizeContext } from './input-kinds';
import type { FormField } from './types';

export type ErrorKind =
  | 'required' | 'select' | 'too_long' | 'too_short' | 'range' | 'number' | 'digits_only' | 'letters_only'
  | 'email' | 'phone' | 'url' | 'date' | 'date_future' | 'date_past' | 'pattern' | 'file' | 'duplicate' | 'unknown';

export interface ErrorInfo {
  kind: ErrorKind;
  min?: number;
  max?: number;
  /** Words instead of characters, for too_long / too_short. */
  words?: boolean;
  /** A date format the message names: "MM/DD/YYYY", "dd-mm-yyyy", "YYYY-MM-DD". */
  format?: string;
}

const NUM = String.raw`(-?\d[\d,]*(?:\.\d+)?)`;
const re = (s: string) => new RegExp(s, 'i');

/** What kind of error the page's message describes, and the limits it names. */
export function classifyError(message: string, field?: FormField): ErrorInfo {
  const m = message.replace(/\s+/g, ' ').trim();
  const num = (x: string | undefined) => (x === undefined ? undefined : Number(x.replace(/,/g, '')));
  const words = /\bwords?\b/i.test(m);

  const fmt = /\b((?:dd|mm|yyyy|yy)[\/.\- ](?:dd|mm|yyyy|yy)[\/.\- ](?:dd|mm|yyyy|yy))\b/i.exec(m);
  if (fmt) return { kind: 'date', format: fmt[1]!.toUpperCase() };

  let x = re(String.raw`(?:at most|no more than|maximum(?: of)?|max(?:imum)?\.?|up to|cannot exceed|must not exceed|less than or equal to|exceeds?(?: the)?(?: maximum)?(?: of)?|limit(?:ed)? (?:of|to)|too long[^0-9]*)\s*${NUM}\s*(characters?|chars?|letters?|words?)`).exec(m);
  if (x) return { kind: 'too_long', max: num(x[1]), words: /word/i.test(x[2]!) };
  x = re(String.raw`${NUM}\s*(characters?|chars?|words?)\s*(?:max(?:imum)?|or (?:less|fewer)|limit)`).exec(m);
  if (x) return { kind: 'too_long', max: num(x[1]), words: /word/i.test(x[2]!) };
  if (/too long|is too many characters|shorten/i.test(m)) return { kind: 'too_long', max: field?.max_length ? Number(field.max_length) : undefined, words };

  x = re(String.raw`(?:at least|minimum(?: of)?|min(?:imum)?\.?|no (?:less|fewer) than|more than)\s*${NUM}\s*(characters?|chars?|letters?|words?)`).exec(m);
  if (x) return { kind: 'too_short', min: num(x[1]), words: /word/i.test(x[2]!) };
  if (/too short|lengthen|more detail/i.test(m)) return { kind: 'too_short', words };

  x = re(String.raw`between\s*${NUM}\s*(?:and|-|to)\s*${NUM}`).exec(m);
  if (x) return { kind: 'range', min: num(x[1]), max: num(x[2]) };
  x = re(String.raw`(?:less than or equal to|no (?:more|greater) than|at most|cannot be (?:more|greater) than|must be (?:≤|<=)|maximum(?: value)?(?: is| of)?)\s*${NUM}`).exec(m);
  if (x) return { kind: 'range', max: num(x[1]) };
  x = re(String.raw`(?:greater than or equal to|no less than|at least|cannot be less than|must be (?:≥|>=)|minimum(?: value)?(?: is| of)?|larger than|greater than|more than)\s*${NUM}`).exec(m);
  if (x) return { kind: 'range', min: num(x[1]) };

  if (/(only|just) (numbers|digits|numeric)|numbers? only|digits? only|must be (a )?(whole )?number|numeric value|not a (valid )?number|enter a (valid )?(decimal |whole )?number|invalid number/i.test(m)) {
    return /phone|mobile/i.test(`${m} ${field?.label ?? ''}`) ? { kind: 'phone' } : { kind: 'digits_only' };
  }
  if (/(only|just) letters|letters only|alphabet(ic|s)? only|no (numbers|digits|special characters)/i.test(m)) return { kind: 'letters_only' };
  if (/e-?mail/i.test(m) && /valid|invalid|format|@|address/i.test(m)) return { kind: 'email' };
  if (/phone|mobile|contact number|telephone/i.test(m) && /valid|invalid|format|digits?|number/i.test(m)) return { kind: 'phone' };
  if (/\b(url|link|website|web address)\b/i.test(m) && /valid|invalid|format|http/i.test(m)) return { kind: 'url' };
  if (/(date|day).*(future|after today|later than today|upcoming)|cannot be in the past|must be after/i.test(m)) return { kind: 'date_future' };
  if (/(date|day).*(past|before today|earlier than today)|cannot be in the future|must be before/i.test(m)) return { kind: 'date_past' };
  if (/\bdate\b/i.test(m) && /valid|invalid|format/i.test(m)) return { kind: 'date' };
  if (/already (exists|registered|in use|applied|been used)|duplicate/i.test(m)) return { kind: 'duplicate' };
  if (/file|upload|attachment|resume|\bcv\b/i.test(m) && /\bpdf\b|\bdocx?\b|\bmb\b|\bkb\b|type|format|size|large|upload|attach|required/i.test(m)) return { kind: 'file' };
  if (/please (select|choose)|select an? (option|value|item)|choose an? (option|value)|no option selected|make a selection/i.test(m)) return { kind: 'select' };
  if (/requested format|match the (requested |required )?(format|pattern)|invalid format|incorrect format|not in the (correct|right) format/i.test(m)) return { kind: 'pattern' };
  // Field types the browser's own messages are short for ("Please enter an email address", "Please enter a URL").
  if (/please enter an? (email|e-mail)/i.test(m)) return { kind: 'email' };
  if (/please enter an? url/i.test(m)) return { kind: 'url' };
  if (/please enter a number/i.test(m)) return { kind: 'digits_only' };
  if (/required|can'?t be (blank|empty)|cannot be (blank|empty)|must not be (blank|empty)|is mandatory|please (fill|enter|complete|provide|answer)|this field|missing|please check this box|fill (out|in) this field/i.test(m)) {
    return { kind: 'required' };
  }
  return { kind: 'unknown' };
}

/** Text cut to `max` characters (or words), ending at a sentence, else a word, boundary. */
export function shorten(text: string, max: number, words = false): string {
  const t = text.trim();
  if (words) {
    const w = t.split(/\s+/);
    if (w.length <= max) return t;
    const cut = w.slice(0, max).join(' ');
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end > cut.length * 0.6 ? cut.slice(0, end + 1) : cut.replace(/[,;:\s]+$/, '');
  }
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.endsWith('.') ? cut.length - 1 : -1);
  // A whole sentence reads better than one cut mid-way: end at one when it keeps at least 40% of the limit.
  if (end > max * 0.4) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO date (YYYY-MM-DD) written in a named format ("MM/DD/YYYY", "dd-mm-yy"). */
export function formatDate(iso: string, format: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return format.toUpperCase()
    .replace('YYYY', String(y)).replace('YY', String(y).slice(-2))
    .replace('MM', pad(m)).replace('DD', pad(d));
}

/** Date formats tried in turn when the page only says "invalid date". */
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY'];

/** Phone writings tried in turn: national, +code national, code+national, 0+national. */
function phoneVariants(answer: string, ctx: NormalizeContext): string[] {
  const dial = profileDialCode({ phone: answer.startsWith('+') ? answer : ctx.profile.phone, location: ctx.profile.location });
  const nat = nationalNumber(answer || ctx.profile.phone, dial);
  return [nat, `+${dial} ${nat}`, `+${dial}${nat}`, `${dial}${nat}`, `0${nat}`];
}

export type FixAction =
  /** Write this answer. */
  | { action: 'set'; answer: string; why: string }
  /** The answer is right but did not stick: set it again by interacting with the control. */
  | { action: 'interact'; answer: string; why: string }
  /** Needs judgement: ask the LLM, with this guidance. */
  | { action: 'ask_ai'; guidance: string }
  /** Nothing to do here (a file the agent attaches separately, a duplicate application): leave it for you. */
  | { action: 'give_up'; why: string };

/**
 * The fix for one field's error. `answer` is what was put in (or the field's current value), `tried` the answers
 * already tried for this field: a mechanical fix that was tried already falls through to the LLM.
 */
export function planFix(field: FormField, message: string, answer: string, tried: Set<string>, ctx: NormalizeContext): FixAction {
  const info = classifyError(message, field);
  const a = (answer ?? '').trim();
  const has = !!a && a !== 'NEEDS_USER_INPUT';
  const fresh = (v: string) => !!v && !tried.has(v) && v !== a;
  const set = (v: string, why: string): FixAction | null => (fresh(v) ? { action: 'set', answer: v, why } : null);
  const ai = (guidance: string): FixAction => ({ action: 'ask_ai', guidance: `${guidance} The form said: "${message.slice(0, 200)}".` });
  const kind = classifyField(field);

  // A bare "Invalid input" on an amount, rate or count written with words ("Rs.2700000", "27 LPA", "5 years"):
  // the box wants the number alone (LinkedIn, 2026-11-10).
  if (info.kind === 'unknown' && has && /\d/.test(a) && /\D/.test(a.replace(/[\s,]/g, '')) && /invalid/i.test(message)
    && /charge|salary|ctc|compensation|pay|rate|fee|price|amount|budget|lpa|years?|months?|days?|notice|number|count|how many|how much/i.test(`${field.label} ${a}`)) {
    const n = parseNumber(a);
    const fix = set(n !== null ? String(n) : a.replace(/[^\d.]/g, ''), 'the number alone');
    if (fix) return fix;
  }

  switch (info.kind) {
    case 'too_long': {
      const max = info.max ?? (field.max_length ? Number(field.max_length) : undefined);
      if (has && max) return set(shorten(a, info.words ? max : Math.max(1, max - 1), info.words), `shortened to ${max} ${info.words ? 'words' : 'characters'}`) ?? ai(`Rewrite shorter: at most ${max} ${info.words ? 'words' : 'characters'}.`);
      return ai('Rewrite the answer shorter.');
    }
    case 'too_short':
      return ai(`Rewrite the answer longer and more specific${info.min ? `: at least ${info.min} ${info.words ? 'words' : 'characters'}` : ''}, using only true facts from the profile and resume.`);
    case 'range': {
      const n = parseNumber(a);
      if (n !== null) {
        let v = n;
        if (info.min !== undefined) v = Math.max(v, info.min);
        if (info.max !== undefined) v = Math.min(v, info.max);
        const fix = set(String(v), `kept within ${info.min ?? '…'}–${info.max ?? '…'}`);
        if (fix) return fix;
      }
      return ai(`Answer with a number${info.min !== undefined ? ` of at least ${info.min}` : ''}${info.max !== undefined ? ` and at most ${info.max}` : ''}.`);
    }
    case 'number':
    case 'digits_only': {
      const n = parseNumber(a);
      const digits = n !== null ? String(n) : a.replace(/\D/g, '');
      return set(digits, 'digits only') ?? set(a.replace(/\D/g, ''), 'digits only') ?? ai('Answer with digits only.');
    }
    case 'letters_only':
      return set(a.replace(/[^\p{L}\s'.-]/gu, '').replace(/\s+/g, ' ').trim(), 'letters only') ?? ai('Answer with letters only.');
    case 'email': {
      const e = a.replace(/^mailto:/i, '').replace(/\s+/g, '').toLowerCase();
      return (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? set(e, 'email cleaned') : null) ?? set(ctx.profile.email, 'your profile email') ?? { action: 'give_up', why: 'the form does not accept your email' };
    }
    case 'phone': {
      for (const v of phoneVariants(a, ctx)) {
        const fix = set(v, 'phone written another way');
        if (fix) return fix;
      }
      return { action: 'give_up', why: 'the form accepts none of the usual ways to write your phone number' };
    }
    case 'url': {
      const n = normalizeForInput({ ...field, type: 'url' }, a, ctx);
      const linkedin = /linkedin/i.test(field.label) ? ctx.profile.linkedin : /portfolio|website/i.test(field.label) ? ctx.profile.portfolio : undefined;
      return (n.ok ? set(n.value, 'full web address') : null) ?? set(linkedin ?? '', 'your profile link') ?? ai('Answer with one full web address starting with https://.');
    }
    case 'date':
    case 'pattern': {
      if (info.kind === 'pattern' && (kind === 'phone' || /phone|mobile/i.test(field.label))) {
        for (const v of phoneVariants(a, ctx)) {
          const fix = set(v, 'phone written another way');
          if (fix) return fix;
        }
      }
      const iso = parseDate(a, ctx.today, /^MM/i.test(info.format ?? ''));
      if (iso && (info.kind === 'date' || kind === 'date' || /date|dob|birth/i.test(field.label))) {
        if (info.format) return set(formatDate(iso, info.format), `date as ${info.format}`) ?? ai(`Write the date as ${info.format}.`);
        for (const f of DATE_FORMATS) {
          const fix = set(formatDate(iso, f), `date as ${f}`);
          if (fix) return fix;
        }
      }
      return ai(`Write the answer in the format this field expects.${kindHint(field) ? ` ${kindHint(field)}` : ''}${field.placeholder ? ` Its example is "${field.placeholder}".` : ''}`);
    }
    case 'date_future': {
      const d = new Date(ctx.today.getTime() + 86_400_000);
      const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      const parsed = parseDate(a, ctx.today);
      if (parsed && parsed > iso) return ai('Give a date in the future.');
      return set(iso, 'a date after today') ?? ai('Give a date in the future.');
    }
    case 'date_past':
      return ai('Give a date in the past, from the profile.');
    case 'file':
      return { action: 'give_up', why: 'a file upload the form rejected' };
    case 'duplicate':
      return { action: 'give_up', why: 'the site says this already exists' };
    case 'select':
    case 'required':
      // Answered, yet the page says empty: the value did not stick (a custom dropdown, a date picker). Interact once.
      if (has && !tried.has(`interact:${a}`)) return { action: 'interact', answer: a, why: 'the value did not stick' };
      return ai(field.options.length ? 'Choose exactly one of the options.' : 'This field is required: give an answer from the profile.');
    default:
      if (has && !tried.has(`interact:${a}`) && /select|choose/i.test(message)) return { action: 'interact', answer: a, why: 'the value did not stick' };
      return ai(`Correct the answer.${kindHint(field) ? ` ${kindHint(field)}` : ''}`);
  }
}
