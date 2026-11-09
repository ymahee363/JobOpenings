/**
 * Keka Hire's applier, in the page (career sites on <company>.keka.com/careers).
 *
 * Seen read-only on smartcoin.keka.com/careers/applyjob/146578 (2026-11-06): a plain server-rendered form (jQuery):
 *  - job pages are /careers/jobdetails/<id> with an "Apply" link to /careers/applyjob/<id>, which is the form;
 *  - boxes are named: firstName, middleName, lastName, mobilePhone.countryCode (<select>, "+91"),
 *    mobilePhone.number, email, gender (<select>: Male / Female / …), workExperience.years (text) and
 *    workExperience.months (<select> 0–11), currentSalary.amount, expectedSalary.amount, standardFields.availability.answer
 *    (days), standardFields.currentLocation.answer, standardFields.<uuid>.answer for custom questions (radios, text);
 *  - the resume goes into input#resume-upload (Keka parses it and fills hidden resume.* fields);
 *  - skills: typing into input#skills and pressing Enter adds a hidden skills[n].name (checked live);
 *  - Date of Birth is a read-only jQuery UI datepicker (optional; left alone);
 *  - a consent checkbox (candidateConsent), an image CAPTCHA (#captcha, only you type it) and "Apply Now"
 *    (button[type=submit], disabled until the form is valid).
 *
 * Messages (from src/shared/ats/keka-flow.ts): KK_STATE, KK_START, KK_FILL, KK_SUBMIT.
 */
import type { WdDate, WorkdayPlan } from './workday';
import type { ZhFillResult, ZhState } from './zoho';

export type KkState = Omit<ZhState, 'zoho'> & { keka: boolean };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const visible = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const CONFIRMED = /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received|sent)|successfully (applied|submitted)|we('ve| have) received your application/i;

const byName = <T extends Element = HTMLInputElement>(name: string) => document.querySelector<T & Element>(`[name="${name}"]`) as T | null;
const form = () => byName('firstName')?.closest('form') ?? (byName('firstName') ? document.body : null);
const captchaInput = () => document.querySelector<HTMLInputElement>('#captcha, input[name="captcha"]');
const submitButton = () => [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"], button')].find((b) => visible(b) && /^apply( now)?$/i.test(text(b))) ?? null;
const applyLink = () => [...document.querySelectorAll<HTMLElement>('a, button')].find((b) => visible(b) && /^apply( now| for this job)?$/i.test(text(b))
  && (b.tagName === 'A' ? /applyjob/i.test(b.getAttribute('href') ?? '') : true));

export function kkState(): KkState {
  const keka = /(^|\.)keka\.com$/i.test(location.hostname) || !!document.querySelector('#resume-upload, [name="mobilePhone.number"]');
  const errors = [...new Set([...document.querySelectorAll<HTMLElement>('.invalid-feedback, .text-danger, .error-message, .field-validation-error, [role="alert"], .toast-message')]
    .filter(visible).map(text).filter((t) => t && t !== '*' && t.length < 200))].slice(0, 10);
  const cap = captchaInput();
  const base = { keka, captcha: !!cap && visible(cap), captchaFilled: !!cap?.value.trim(), errors };
  const body = document.body?.innerText ?? '';
  if (CONFIRMED.test(body.slice(0, 6000)) && !form()) return { ...base, page: 'submitted' };
  if (form() && submitButton()) return { ...base, page: 'form' };
  if (applyLink()) return { ...base, page: 'job' };
  return { ...base, page: 'unknown' };
}

/** On a job page: press Apply (it navigates to the form; the flow polls KK_STATE afterwards). */
export async function kkStart(): Promise<KkState> {
  applyLink()?.click();
  for (let i = 0; i < 20 && kkState().page !== 'form'; i += 1) await sleep(400);
  return kkState();
}

function setText(input: HTMLInputElement | HTMLTextAreaElement | null, value: string | undefined): boolean {
  if (!input || !value) return false;
  if (input.value.trim() === value.trim()) return true;
  input.focus();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  input.blur();
  return input.value === value;
}

function choose(select: HTMLSelectElement | null, want: (label: string, value: string) => boolean): boolean {
  if (!select) return false;
  const opt = [...select.options].find((o) => o.value && want(o.text.trim(), o.value));
  if (!opt) return false;
  select.value = opt.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value === opt.value;
}

function attach(input: HTMLInputElement | null | undefined, file: { name: string; type: string; data: string } | null | undefined): boolean {
  if (!input || !file?.data) return false;
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], file.name, { type: file.type || 'application/pdf' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** Months between two dates (to = today when missing). */
function months(from: WdDate, to: WdDate | null, now = new Date()): number {
  const fy = Number(from.year);
  if (!fy) return 0;
  const ty = Number(to?.year) || now.getFullYear();
  const tm = Number(to?.month) || (to?.year ? 12 : now.getMonth() + 1);
  return Math.max(0, (ty - fy) * 12 + (tm - (Number(from.month) || 1)));
}

/** Total work experience from your jobs, overlaps merged by month. */
export function totalExperienceMonths(jobs: WorkdayPlan['jobs'], now = new Date()): number {
  const covered = new Set<number>();
  for (const j of jobs) {
    const start = (Number(j.from.year) || 0) * 12 + (Number(j.from.month) || 1) - 1;
    if (!j.from.year) continue;
    const n = months(j.from, j.current ? null : j.to, now);
    for (let m = 0; m < n; m += 1) covered.add(start + m);
  }
  return covered.size;
}

/** Fill what your profile settles; the rest (salary, notice, location, custom questions) is left to the engine and AI. */
export async function kkFill(plan: WorkdayPlan, email: string): Promise<ZhFillResult> {
  const r: ZhFillResult = { filled: [], failed: [], empty: [] };
  const track = (what: string, ok: boolean) => (ok ? r.filled : r.failed).push(what);
  const fillIfEmpty = (name: string, value: string | undefined) => {
    const input = byName(name);
    if (input && value && !input.value.trim()) track(name, setText(input, value));
  };

  // The resume first: Keka parses it and may fill boxes, which are then left as they are.
  const resumeInput = document.querySelector<HTMLInputElement>('#resume-upload');
  if (plan.resume && resumeInput && !byName('resume.fileName')?.value.trim()) {
    track('resume', attach(resumeInput, plan.resume));
    for (let i = 0; i < 25 && !byName('resume.fileName')?.value.trim(); i += 1) await sleep(400);
  }

  fillIfEmpty('firstName', plan.firstName);
  fillIfEmpty('lastName', plan.lastName);
  fillIfEmpty('email', email);
  const cc = byName<HTMLSelectElement>('mobilePhone.countryCode');
  if (cc && cc.value !== '+91') track('phone country code', choose(cc, (_l, v) => v === '+91'));
  fillIfEmpty('mobilePhone.number', plan.phone.replace(/^\+?91[\s-]*/, '').replace(/\D/g, '').slice(-10));
  fillIfEmpty('standardFields.currentLocation.answer', plan.city);

  const gender = byName<HTMLSelectElement>('gender');
  if (gender && !gender.value && plan.gender.length) {
    track('gender', choose(gender, (l) => plan.gender.some((g) => g.toLowerCase() === l.toLowerCase())));
  }

  const total = totalExperienceMonths(plan.jobs);
  if (total) {
    fillIfEmpty('workExperience.years', String(Math.floor(total / 12)));
    const mo = byName<HTMLSelectElement>('workExperience.months');
    if (mo && (!mo.value || mo.value === '0')) track('experience months', choose(mo, (_l, v) => v === String(total % 12)));
  }

  // Skills: up to 10 tags, each added with Enter.
  const skillBox = document.querySelector<HTMLInputElement>('#skills');
  const have = new Set([...document.querySelectorAll<HTMLInputElement>('input[name^="skills["]')].map((h) => h.value.toLowerCase()));
  if (skillBox) {
    for (const s of plan.skills.slice(0, 10)) {
      if (have.has(s.toLowerCase())) continue;
      setText(skillBox, s);
      for (const t of ['keydown', 'keypress', 'keyup']) skillBox.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await sleep(150);
    }
    const added = document.querySelectorAll('input[name^="skills["]').length;
    if (plan.skills.length) track(`skills (${added})`, added > 0);
  }

  // Consent to the privacy terms (your standing instruction).
  const consent = byName('candidateConsent');
  if (consent && plan.privacyConsent && !consent.checked) {
    consent.click();
    track('consent', consent.checked);
  }

  // Required boxes still empty, the CAPTCHA aside.
  for (const el of document.querySelectorAll<HTMLInputElement>('input[required], select[required], textarea[required]')) {
    if (el === captchaInput() || el.type === 'hidden' || el.type === 'file' || !visible(el) || el.value.trim()) continue;
    r.empty.push(el.name || el.id);
  }
  return r;
}

export async function kkSubmit(): Promise<KkState & { moved: boolean }> {
  const btn = submitButton();
  if (!btn) return { ...kkState(), moved: false };
  if (btn.disabled) return { ...kkState(), errors: [...kkState().errors, 'Apply Now is still disabled: a required box is empty or invalid'], moved: false };
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  for (let i = 0; i < 50; i += 1) {
    await sleep(400);
    const s = kkState();
    if (s.page === 'submitted') return { ...s, moved: true };
    if (s.errors.length && i > 4) return { ...s, moved: false };
  }
  return { ...kkState(), moved: false };
}

export function handleKekaMessage(message: { type: string; plan?: WorkdayPlan; email?: string }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => {
    p.then((r) => sendResponse({ ok: true, ...(r as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e).slice(0, 200) }));
    return true;
  };
  switch (message.type) {
    case 'KK_STATE': return reply(Promise.resolve(kkState()));
    case 'KK_START': return reply(kkStart());
    case 'KK_FILL': return message.plan ? reply(kkFill(message.plan, String(message.email ?? ''))) : (sendResponse({ ok: false, error: 'no plan' }), true);
    case 'KK_SUBMIT': return reply(kkSubmit());
    default: return false;
  }
}
