/**
 * Lever's applier, in the page (jobs.lever.co/<company>/<posting id>[/apply]).
 *
 * Seen on jobs.lever.co/fampay/b11c81ce-…/apply (2026-11-10, read only) and the saved Lever forms in
 * tests/fixtures/forms/lever-*.html:
 *  - the posting page has "Apply for this job" (`a.postings-btn` to …/apply); the form is `form#application-form`;
 *  - the resume goes into `input#resume-upload-input` (name=resume). Lever reads it and may fill name, email, phone
 *    and company itself; `.resume-upload-success` shows when it is done. The resume goes in first, then your profile
 *    values replace whatever Lever read;
 *  - basics are plain inputs by name: name (full name), email, phone, org (current company), urls[LinkedIn],
 *    urls[Twitter], urls[GitHub], urls[Portfolio], urls[Other];
 *  - "Current location" is `#location-input` with suggestions (`.dropdown-results` > `.dropdown-location`); picking
 *    one fills the hidden `selectedLocation`;
 *  - the employer's questions are `cards[<id>][fieldN]` / `surveysResponses[…]` boxes, plus EEO selects and consent
 *    boxes on some postings: the general engine and the AI answer those;
 *  - "Submit application" is `#btn-submit`. It runs an invisible hCaptcha first, which sometimes shows a challenge
 *    that only you solve. A sent application goes to …/thanks ("Application submitted!").
 *
 * Messages (from src/shared/ats/lever-flow.ts): LV_STATE, LV_START, LV_FILL, LV_SUBMIT.
 */

export interface LvState {
  page: 'job' | 'form' | 'submitted' | 'unknown';
  /** An hCaptcha challenge is open for you to solve. */
  challenge: boolean;
  errors: string[];
}

export interface LvFillInput {
  name: string;
  email: string;
  phone: string;
  location: string;
  company: string;
  linkedin?: string;
  portfolio?: string;
  websites: string[];
  resume?: { name: string; type: string; data: string } | null;
}

export interface LvFillResult {
  filled: string[];
  failed: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const visible = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const SUBMITTED = /application submitted|thanks? (you )?for applying|we('ve| have) received your application/i;

const form = () => document.querySelector<HTMLFormElement>('form#application-form');
const submitButton = () => document.querySelector<HTMLElement>('#btn-submit');
const applyLink = () => [...document.querySelectorAll<HTMLAnchorElement>('a.postings-btn, a[href$="/apply"]')].find((a) => visible(a) && /\/apply\/?$/.test(a.getAttribute('href') ?? '') && /apply/i.test(text(a)));
const input = (name: string) => form()?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? null;

/** An hCaptcha challenge on screen: its iframe ("hCaptcha challenge") shown at a real size. */
function challengeOpen(): boolean {
  return [...document.querySelectorAll<HTMLIFrameElement>('iframe')].some((f) => /hcaptcha/i.test(f.src) && /challenge/i.test(`${f.title} ${f.src}`)
    && visible(f) && f.getBoundingClientRect().height > 100);
}

export function lvState(): LvState {
  const errors = [...new Set([...document.querySelectorAll<HTMLElement>('.error-message, .application-error, [role="alert"]')]
    .filter(visible).map(text).filter((t) => t && t.length < 200))].slice(0, 10);
  const base = { challenge: challengeOpen(), errors };
  if (/\/thanks\/?$/.test(location.pathname) || (SUBMITTED.test(document.body?.innerText.slice(0, 4000) ?? '') && !form())) return { ...base, page: 'submitted' };
  if (form() && submitButton()) return { ...base, page: 'form' };
  if (applyLink()) return { ...base, page: 'job' };
  return { ...base, page: 'unknown' };
}

export async function lvStart(): Promise<LvState> {
  const a = applyLink();
  if (a) {
    // Same tab: the form is a page of its own (…/apply).
    a.removeAttribute('target');
    a.click();
  }
  for (let i = 0; i < 30 && lvState().page !== 'form'; i += 1) await sleep(400);
  return lvState();
}

/** Type a value the way the page listens (native setter, input, change, blur). */
function setText(el: HTMLInputElement | HTMLTextAreaElement | null, value: string | undefined): boolean {
  if (!el || !value) return false;
  if (el.value.trim() === value.trim()) return true;
  el.focus();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.blur();
  return el.value === value;
}

function attach(el: HTMLInputElement | null, file: LvFillInput['resume']): boolean {
  if (!el || !file?.data) return false;
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], file.name, { type: file.type || 'application/pdf' }));
  el.files = dt.files;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return !!el.files?.length;
}

/** "Current location": type it, then pick the suggestion that matches (else the first); Lever needs a picked one. */
async function setLocation(value: string): Promise<boolean> {
  const box = document.querySelector<HTMLInputElement>('#location-input') ?? input('location');
  if (!box || !value) return false;
  const picked = () => !!document.querySelector<HTMLInputElement>('#selected-location, input[name="selectedLocation"]')?.value;
  if (box.value.trim() && picked()) return true;
  const city = value.split(',')[0]!.trim();
  setText(box, '');
  box.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, city);
  box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: city }));
  // Lever's retrieveLocations.js searches on keydown (debounced), reading the box's value then.
  for (const type of ['keydown', 'keyup'] as const) box.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: city.slice(-1) }));
  let options: HTMLElement[] = [];
  for (let i = 0; i < 25 && !options.length; i += 1) {
    await sleep(300);
    options = [...document.querySelectorAll<HTMLElement>('.dropdown-results .dropdown-location, .dropdown-results > div')].filter(visible);
  }
  // No suggestion: typed text alone is not a location Lever accepts.
  if (!options.length) return picked();
  const want = city.toLowerCase();
  const alias = /bengaluru|bangalore/i.test(city) ? /bengaluru|bangalore/i : null;
  const choice = options.find((o) => text(o).toLowerCase().startsWith(want) || (alias?.test(text(o)) ?? false)) ?? options[0]!;
  choice.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  choice.click();
  await sleep(400);
  return picked();
}

/** Fill the resume and your details; the employer's questions are left to the general engine. */
export async function lvFill(p: LvFillInput): Promise<LvFillResult> {
  const r: LvFillResult = { filled: [], failed: [] };
  const track = (what: string, ok: boolean) => (ok ? r.filled : r.failed).push(what);

  // 1. Resume first: Lever reads it and may overwrite the boxes, so your values go in after it is done.
  const file = document.querySelector<HTMLInputElement>('#resume-upload-input, input[type="file"][name="resume"]');
  if (p.resume && file && !file.files?.length && !visible(document.querySelector('.resume-upload-success'))) {
    const ok = attach(file, p.resume);
    track('resume', ok);
    for (let i = 0; ok && i < 40; i += 1) {
      await sleep(400);
      if (visible(document.querySelector('.resume-upload-success')) || visible(document.querySelector('.resume-upload-failure'))) break;
    }
    if (visible(document.querySelector('.resume-upload-failure'))) r.failed.push('resume (Lever could not read it)');
  }

  // 2. Your details, from your profile (they replace what Lever read from the resume).
  const site = (re: RegExp) => p.websites.find((w) => re.test(w));
  const basics: Array<[string, string | undefined]> = [
    ['name', p.name], ['email', p.email], ['phone', p.phone], ['org', p.company],
    ['urls[LinkedIn]', p.linkedin ?? site(/linkedin\.com/i)],
    ['urls[GitHub]', site(/github\.com/i)], ['urls[Github]', site(/github\.com/i)],
    ['urls[Twitter]', site(/twitter\.com|x\.com/i)],
    ['urls[Portfolio]', p.portfolio ?? site(/^(?!.*(linkedin|github|twitter|x)\.com)/i)],
  ];
  for (const [name, value] of basics) {
    const el = input(name);
    if (el && value) track(name, setText(el, value));
  }
  if (p.location) track('location', await setLocation(p.location));
  return r;
}

export async function lvSubmit(): Promise<LvState & { moved: boolean }> {
  const btn = submitButton();
  if (!btn) return { ...lvState(), moved: false };
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const s = lvState();
    if (s.page === 'submitted') return { ...s, moved: true };
    // A challenge to solve, or errors under the fields: the flow takes it from here.
    if (s.challenge || (s.errors.length && i > 4)) return { ...s, moved: false };
  }
  return { ...lvState(), moved: false };
}

/**
 * The job description: the /apply page has none, so read the posting page (the same address without /apply, same
 * origin). Empty when it cannot be read.
 */
export async function lvPosting(): Promise<{ text: string }> {
  const desc = (doc: Document) => text(doc.querySelector('.posting-page .content, .content-wrapper .content, [data-qa="job-description"]') ?? doc.body).slice(0, 8000);
  if (document.querySelector('[data-qa="job-description"], .posting-page .section-wrapper')) return { text: desc(document) };
  const url = location.href.split(/[?#]/)[0]!.replace(/\/apply\/?$/, '');
  if (url === location.href.split(/[?#]/)[0]) return { text: '' };
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { text: '' };
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    doc.querySelectorAll('script, style, form').forEach((n) => n.remove());
    return { text: desc(doc) };
  } catch {
    return { text: '' };
  }
}

export function handleLeverMessage(message: { type: string; input?: LvFillInput }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => {
    p.then((r) => sendResponse({ ok: true, ...(r as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e).slice(0, 200) }));
    return true;
  };
  switch (message.type) {
    case 'LV_STATE': return reply(Promise.resolve(lvState()));
    case 'LV_START': return reply(lvStart());
    case 'LV_FILL': return message.input ? reply(lvFill(message.input)) : (sendResponse({ ok: false, error: 'no input' }), true);
    case 'LV_SUBMIT': return reply(lvSubmit());
    case 'LV_POSTING': return reply(lvPosting());
    default: return false;
  }
}
