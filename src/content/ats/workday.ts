/**
 * Workday applier, page side (runs inside the form engine on *.myworkdayjobs.com). Built from live applications
 * on Amadeus (wd502), Sabre (wd1) and GSK (wd5), 2026-11-05.
 *
 * Workday's application is a wizard: My Information → My Experience → Application Questions (1..n) → Voluntary
 * Disclosures → (Self Identify) → Review. Every control carries a stable data-automation-id (formField-<name>,
 * pageFooterNextButton, dateSectionMonth-input…), so known steps are filled from your profile without the AI;
 * question pages go through the general engine (and the AI only for what is not known).
 *
 * Things Workday needs that generic filling misses (each cost an attempt to learn):
 *  - A typed value is committed only on a real focus-out: set, then focusout + blur, or it silently drops it
 *    (four filled job blocks showed on screen, only one was saved).
 *  - Dropdowns are buttons (aria-haspopup=listbox) whose options appear as [role=option] after a click.
 *  - Search boxes (School, Field of Study, Skills) search on Enter, and short queries work best ("Guwahati",
 *    "Product"); results are virtualised, so pick the exact text from what is rendered.
 *  - "Back" on a step with unsaved changes opens "Discard Application?": never press Discard.
 *
 * Messages (from src/shared/ats/workday-flow.ts): WD_STATE, WD_START, WD_FILL_STEP, WD_NEXT, WD_SUBMIT.
 */

export interface WdDate { month?: string; day?: string; year?: string }
export interface WdJob { title: string; company: string; location?: string; from: WdDate; to: WdDate; current: boolean; description?: string }
export interface WdEducation { school: string; schoolQuery: string; /** The name as you write it ("IIT Guwahati"), for a plain text School box. */ schoolText?: string; degree: string[]; field?: string; fieldQuery?: string; fromYear?: string; toYear?: string }
export interface WdLanguage { name: string; fluent: boolean; level: string[] }
export interface WdFile { name: string; type: string; data: string }

/** Everything the applier fills, built from your profile by src/shared/ats/workday-plan.ts. */
export interface WorkdayPlan {
  source: string[];
  previousWorker: 'Yes' | 'No';
  country: string;
  firstName: string;
  lastName: string;
  address?: string;
  /** Address line 2 (required on some tenants, e.g. Allstate). */
  address2?: string;
  /** State / region (Karnataka), a dropdown on some tenants. */
  state?: string;
  city?: string;
  postalCode?: string;
  phoneDevice: string[];
  phoneCountry: string;
  phone: string;
  jobs: WdJob[];
  education: WdEducation[];
  languages: WdLanguage[];
  skills: string[];
  websites: string[];
  resume?: WdFile | null;
  gender: string[];
  /** Tick a privacy notice / terms box of the application (your standing instruction). */
  privacyConsent: boolean;
  /** For a "Date of Birth" question (voluntary disclosures on some tenants). */
  dateOfBirth?: WdDate;
  /** Known application questions: label pattern (regex source, case-insensitive) → answers in order of preference. */
  questions: Array<{ pattern: string; answers: string[] }>;
}

export type WdPage = 'job' | 'chooser' | 'signIn' | 'step' | 'review' | 'submitted' | 'closed' | 'unknown';

export interface WdState {
  /** Which fields the page shows: changes when the wizard moves to another step. */
  fingerprint?: string;
  page: WdPage;
  step: string;
  errors: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const visible = (el: Element | null | undefined): el is HTMLElement =>
  !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
// Accents dropped first: "Karnātaka" (some ATS) is "Karnataka".
const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
const auto = (id: string, root: ParentNode = document) => root.querySelector<HTMLElement>(`[data-automation-id="${id}"]`);
const autos = (id: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(`[data-automation-id="${id}"]`)];
/**
 * A field wrapper counts as shown when anything in it is: on newer Workday tenants (GSK wd3, 2026-11-05) the
 * formField-* wrappers are laid out with no box of their own, so checking the wrapper itself hid every field.
 */
const isShown = (e: Element): boolean => visible(e);
/** A Workday field marked required: aria-required/required on its control, or a "*" in its label. */
const isRequiredWd = (f: HTMLElement) =>
  !!f.querySelector('[aria-required="true"], [required]') || /\*/.test(f.querySelector('label, legend')?.textContent ?? '');
const shownField = (f: HTMLElement) => isShown(f) || [...f.querySelectorAll('input:not([type="hidden"]), button, textarea')].some(isShown);

/**
 * The container of a field, by its Workday name. Some controls have no formField-* wrapper at all (GSK: "How did
 * you hear" is input#source--source, "Have you worked for … in the past?" is radios name=candidateIsPreviousWorker),
 * so fall back to the control's own name / id and take the smallest ancestor holding all its parts.
 */
function field(name: string, root: ParentNode = document): HTMLElement | null {
  const byAuto = auto(`formField-${name}`, root);
  if (byAuto) return byAuto;
  const parts = [...root.querySelectorAll<HTMLElement>(`[name="${name}"], [id="${name}--${name}"], [id$="--${name}"]`)];
  if (!parts.length) return null;
  let n: HTMLElement | null = parts[0]!.parentElement;
  while (n && !parts.every((p) => n!.contains(p))) n = n.parentElement;
  // Include the question's label / legend when it sits one level up.
  if (n && !n.querySelector('label, legend') && n.parentElement && n.parentElement !== document.body) n = n.parentElement;
  return n && n !== document.body && n !== document.documentElement ? n : parts[0]!.parentElement;
}
const fields = (name: string, root: ParentNode = document) => autos(`formField-${name}`, root).filter(shownField);

const STEP_NAMES = /^(my information|my experience|application questions.*|voluntary disclosures|self identify|review)$/i;

/** Where the wizard is, and Workday's own error messages. */
export function wdState(): WdState {
  const text = document.body?.innerText ?? '';
  // Workday's error markup varies by tenant (errorMessage, errorBanner, inline…): take any visible error element.
  const errors = [...new Set([...document.querySelectorAll<HTMLElement>('[data-automation-id*="error" i], [role="alert"]')]
    .filter(visible).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 300 && !/successfully uploaded|upload(ed)? successfully/i.test(t)))].slice(0, 12);
  if (/application (has been )?submitted|thank you for (applying|your application)|you have (successfully )?applied/i.test(text.slice(0, 5000))) {
    return { page: 'submitted', step: '', errors };
  }
  // Applied before, or the posting is gone (2026-11-10: 4 Naukri → Workday runs ended "unexpected page (unknown)").
  if (/you('ve| have) already applied|already applied (for|to) this job/i.test(text.slice(0, 5000))) return { page: 'submitted', step: '', errors: ['already applied'] };
  if (/no longer (accepting|available|open)|(job|position|posting) (has been )?(filled|closed|removed)|page you are looking for (doesn't|does not) exist|job you are trying to apply for/i.test(text.slice(0, 5000))) {
    return { page: 'closed', step: '', errors };
  }
  if (auto('applyManually') && visible(auto('applyManually'))) return { page: 'chooser', step: '', errors };
  // Also by the wizard's own step name: on Cisco (2026-11-06) the progress bar said "Create Account/Sign In" while the
  // password boxes were still rendering, so the page was read as a form step and its passwords as questions.
  const accountStep = /create account|sign in/i.test(auto('progressBarActiveStep')?.innerText ?? '') || visible(auto('signInFormo')) || visible(auto('signInContent'));
  const signIn = accountStep || [...document.querySelectorAll('input[type="password"]')].some(visible)
    || visible(auto('signInSubmitButton')) || visible(auto('createAccountSubmitButton'));
  if (signIn) return { page: 'signIn', step: '', errors };
  const active = auto('progressBarActiveStep');
  let step = (active?.innerText ?? '').replace(/current step \d+ of \d+/i, '').replace(/\s+/g, ' ').trim();
  if (!step) {
    step = [...document.querySelectorAll<HTMLElement>('h2, h3')].filter(visible).map((h) => h.innerText.trim()).find((t) => STEP_NAMES.test(t)) ?? '';
  }
  if (/^review$/i.test(step)) return { page: 'review', step, errors };
  if (visible(auto('pageFooterNextButton')) || step) return { page: 'step', step: step || 'unknown', errors, fingerprint: formFingerprint() };
  if (visible(auto('adventureButton'))) return { page: 'job', step: '', errors };
  // Say what the page shows, so an unknown page can be fixed from the log.
  const seen = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, button')].filter(visible).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 60).slice(0, 8);
  return { page: 'unknown', step: '', errors: seen.length ? [`page shows: ${seen.join(' | ')}`.slice(0, 280)] : errors };
}

function formFingerprint(): string {
  return [...document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"]')].filter(shownField)
    .map((f) => f.getAttribute('data-automation-id')).join('|');
}

/** Required fields (label ending in *) still empty: why Workday will not move on when it shows no message. */
export function emptyRequired(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"]')].filter(shownField).flatMap((f) => {
    const label = (f.querySelector('label, legend')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!/\*\s*$/.test(label)) return [];
    const input = f.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])');
    const btn = f.querySelector<HTMLElement>('button[aria-haspopup="listbox"]');
    const radios = [...f.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const chips = f.querySelectorAll('[data-automation-id="selectedItem"]').length;
    const empty = radios.length ? !radios.some((x) => x.checked)
      : btn ? /^select one$/i.test(btn.innerText.trim())
      : f.querySelector('[data-automation-id*="prompt" i], [data-automation-id="multiselectInputContainer"]') ? chips === 0 && !(input?.value)
      : input ? !input.value.trim() : false;
    return empty ? [label.replace(/\*\s*$/, '').trim()] : [];
  });
}

/** Commit a value the way Workday needs: focus, set, input/change, then a real focus-out. */
function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.blur();
  return el.value === value;
}

function textIn(root: HTMLElement | null, value: string | undefined): boolean | null {
  if (!root || !value) return null;
  const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])');
  if (!el) return false;
  if (el.value === value) return true;
  return setText(el, value);
}

function pick<T extends HTMLElement>(items: T[], wanted: string[]): T | undefined {
  const label = (e: HTMLElement) => norm(e.innerText || e.getAttribute('aria-label') || '');
  for (const w of wanted) { const hit = items.find((i) => label(i) === norm(w)); if (hit) return hit; }
  for (const w of wanted) { const hit = items.find((i) => norm(w) && label(i).startsWith(norm(w))); if (hit) return hit; }
  for (const w of wanted) { const hit = items.find((i) => norm(w) && label(i).includes(norm(w))); if (hit) return hit; }
  return undefined;
}

function openOptions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"], [data-automation-id="promptOption"]')].filter(visible);
}

/** A Workday dropdown (button with a listbox): open it and click the first wanted option. */
async function dropdown(root: HTMLElement | null, wanted: string[]): Promise<boolean | null> {
  if (!root || !wanted.length) return null;
  // Only a real list button: never "any button" (that could be Save and Continue).
  const btn = root.querySelector<HTMLElement>('button[aria-haspopup="listbox"]');
  if (!btn) return false;
  if (pick([btn], wanted)) return true;
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  for (let i = 0; i < 10; i += 1) {
    await sleep(200);
    const hit = pick(openOptions(), wanted);
    if (hit) { hit.click(); await sleep(300); return true; }
  }
  // Long lists (State: 36 entries on Allstate, 2026-11-06) draw only the options in view: scroll through the list
  // until the wanted one is rendered. Exact matches only here, so scrolling never settles for a near miss.
  const list = [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(visible).pop();
  if (list) {
    const exact = () => openOptions().find((o) => wanted.some((w) => norm(o.innerText) === norm(w)));
    for (let i = 0; i < 60; i += 1) {
      const hit = exact();
      if (hit) { hit.scrollIntoView({ block: 'nearest' }); hit.click(); await sleep(300); return true; }
      const before = list.scrollTop;
      list.scrollTop += Math.max(40, list.clientHeight - 20);
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(120);
      if (list.scrollTop === before) break;
    }
  }
  await closeList(btn);
  return false;
}

/** A Workday search box (School, Field of Study, Skills): query + Enter, then click the exact result. */
async function search(root: HTMLElement | null, query: string, wanted: string[]): Promise<boolean | null> {
  if (!root || !query) return null;
  const already = [...root.querySelectorAll<HTMLElement>('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] li')].filter(visible);
  if (pick(already, wanted)) return true;
  const input = root.querySelector<HTMLInputElement>('input:not([type="hidden"])');
  if (!input) return false;
  input.scrollIntoView({ block: 'center' });
  input.focus();
  input.click();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  for (let i = 0; i < 15; i += 1) {
    await sleep(250);
    const hit = pick(openOptions().filter((o) => !o.closest('[data-automation-id="selectedItem"]')), wanted);
    if (hit) {
      (hit.querySelector<HTMLElement>('input[type="checkbox"], [role="checkbox"]') ?? hit).click();
      await sleep(400);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    }
  }
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return false;
}

/** Close an open list: Escape, then the button again if it is still open. */
async function closeList(btn: HTMLElement): Promise<void> {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(150);
  if ([...document.querySelectorAll('[role="listbox"]')].some(visible)) { btn.click(); await sleep(150); }
}

function radio(root: HTMLElement | null, wanted: string[]): boolean | null {
  if (!root || !wanted.length) return null;
  const opts = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  const labelled = opts.map((o) => {
    const l = (o.id && root.querySelector<HTMLElement>(`label[for="${CSS.escape(o.id)}"]`)) || o.closest('label') || o.parentElement;
    return { o, text: (l?.innerText || o.value || '').trim() };
  });
  const byValue = wanted.some((w) => /^no$/i.test(w)) ? labelled.find((x) => x.o.value === 'false') : wanted.some((w) => /^yes$/i.test(w)) ? labelled.find((x) => x.o.value === 'true') : undefined;
  const hit = labelled.find((x) => wanted.some((w) => norm(x.text) === norm(w))) ?? byValue;
  if (!hit) return false;
  if (!hit.o.checked) hit.o.click();
  return hit.o.checked;
}

function checkbox(root: HTMLElement | null, on: boolean): boolean | null {
  if (!root) return null;
  const box = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) return false;
  if (box.checked !== on) box.click();
  return box.checked === on;
}

/**
 * Dates to be typed with real keystrokes. Workday's date widget (month / day / year boxes) ignores values set by a
 * script and even synthetic key events: the year stays empty and Save shows "Invalid Date: 04/" (GSK wd3,
 * 2026-11-05; real typing fixed it at once). So a date is queued here, its first box marked, and the agent types it
 * through chrome.debugger (WD_FOCUS + trusted keys, see src/shared/ats/workday-flow.ts).
 */
let typingQueue: Array<{ id: string; text: string; label: string }> = [];
let typingSeq = 0;

async function date(root: HTMLElement | null, d: WdDate, label = 'date'): Promise<boolean | null> {
  if (!root || (!d.month && !d.year)) return null;
  const parts = [...root.querySelectorAll<HTMLInputElement>('input[data-automation-id^="dateSection"][data-automation-id$="-input"]')];
  if (!parts.length) return d.year ? textIn(root, d.month ? `${d.month}/${d.year}` : d.year) : null;
  let text = '';
  for (const p of parts) {
    const kind = p.getAttribute('data-automation-id') ?? '';
    if (/Month/.test(kind)) text += (d.month ?? '').padStart(2, '0');
    else if (/Day/.test(kind)) text += (d.day ?? '').padStart(2, '0');
    else if (/Year/.test(kind)) text += d.year ?? '';
  }
  if (!/^\d+$/.test(text)) return false;
  // Already showing this date: nothing to type.
  const shown = parts.map((p) => p.value.replace(/^0+/, '')).join('');
  if (shown && shown === parts.map((p) => {
    const kind = p.getAttribute('data-automation-id') ?? '';
    return (/Month/.test(kind) ? d.month : /Day/.test(kind) ? d.day : d.year)?.replace(/^0+/, '') ?? '';
  }).join('')) return true;
  const id = `wd-type-${++typingSeq}`;
  parts[0]!.setAttribute('data-wd-type', id);
  typingQueue.push({ id, text, label });
  return true;
}

/** Focus a queued date's first box (selected), ready for trusted typing. */
function focusTyping(id: string): boolean {
  const el = document.querySelector<HTMLInputElement>(`[data-wd-type="${id}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  el.select?.();
  return document.activeElement === el;
}

function section(title: RegExp): HTMLElement | null {
  const h = [...document.querySelectorAll<HTMLElement>('h2, h3, h4')].filter(visible).find((x) => title.test(x.innerText.trim()));
  if (!h) return null;
  let n: HTMLElement | null = h;
  for (let i = 0; i < 6 && n; i += 1) {
    n = n.parentElement;
    if (n && n.querySelector('button') && n.innerText.length > h.innerText.length + 3) return n;
  }
  return h.parentElement;
}

/** Make sure a repeatable section (Work Experience…) has `count` blocks; returns how many it has. */
async function ensureBlocks(title: RegExp, fieldName: string, count: number): Promise<number> {
  for (let i = 0; i < count + 2; i += 1) {
    const have = fields(fieldName).length;
    if (have >= count) return have;
    const sec = section(title);
    const add = sec && [...sec.querySelectorAll<HTMLElement>('button')].filter(visible).find((b) => /^add( another)?$/i.test(b.innerText.trim()));
    if (!add) return have;
    add.scrollIntoView({ block: 'center' });
    add.click();
    await sleep(900);
    // A block whose fields are named differently on this tenant (Allstate's education): do not keep adding
    // empty blocks (it made six "Degree is required" errors); the meaning-based fill handles that one block.
    if (fields(fieldName).length === have) return have;
  }
  return fields(fieldName).length;
}

async function uploadResume(file: WdFile | null | undefined): Promise<boolean | null> {
  if (!file?.data) return null;
  const listed = [...document.querySelectorAll<HTMLElement>('[data-automation-id="file-upload-item"], [data-automation-id="fileName"]')].filter(visible);
  if (listed.some((l) => l.innerText.includes(file.name))) return true;
  const input = auto('file-upload-input-ref') as HTMLInputElement | null ?? document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) return false;
  const bytes = Uint8Array.from(atob(file.data.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], file.name, { type: file.type || 'application/pdf' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(2500);
  return true;
}

type Result = { filled: string[]; failed: string[] };
const track = (r: Result, label: string, ok: boolean | null) => { if (ok === true) r.filled.push(label); else if (ok === false) r.failed.push(label); };

async function fillMyInformation(p: WorkdayPlan, r: Result): Promise<void> {
  // "How did you hear" is a plain dropdown on some tenants (Amadeus) and a search prompt on others (GSK).
  const src = field('source');
  let srcOk = await dropdown(src, p.source);
  if (srcOk === false) srcOk = await search(src, p.source[0] ?? 'LinkedIn', p.source);
  track(r, 'How did you hear', srcOk);
  track(r, 'Previous worker', radio(field('candidateIsPreviousWorker'), [p.previousWorker]));
  track(r, 'Country', await dropdown(field('country'), [p.country]));
  track(r, 'Given name', textIn(field('legalName--firstName'), p.firstName));
  track(r, 'Family name', textIn(field('legalName--lastName'), p.lastName));
  track(r, 'Address', textIn(field('addressLine1'), p.address));
  track(r, 'Address line 2', textIn(field('addressLine2'), p.address2));
  // State / region: a dropdown (countryRegion) or a text box depending on the tenant.
  const region = field('countryRegion');
  if (region && p.state) track(r, 'State', region.querySelector('button[aria-haspopup="listbox"]') ? await dropdown(region, [p.state]) : textIn(region, p.state));
  track(r, 'City', textIn(field('city'), p.city));
  track(r, 'Postal code', textIn(field('postalCode'), p.postalCode));
  track(r, 'Phone device', await dropdown(field('phoneType'), p.phoneDevice));
  const code = field('countryPhoneCode');
  if (code && !norm(code.innerText).includes(norm(p.phoneCountry))) track(r, 'Phone country code', await search(code, p.phoneCountry, [`${p.phoneCountry} (+91)`, p.phoneCountry]));
  // The phone wrapper can also hold the country-code search box (Allstate wd5, 2026-11-06): target the number box
  // itself, or the number went into the code search and Workday said "Phone Number is required".
  const phoneBox = document.querySelector<HTMLInputElement>('input[name="phoneNumber"], input[id$="--phoneNumber"], [data-automation-id="phone-number"] input');
  track(r, 'Phone number', phoneBox ? (phoneBox.value === p.phone ? true : setText(phoneBox, p.phone)) : textIn(field('phoneNumber'), p.phone));
}

async function fillMyExperience(p: WorkdayPlan, r: Result): Promise<void> {
  if (p.jobs.length) {
    const n = await ensureBlocks(/^work experience$/i, 'jobTitle', p.jobs.length);
    const titles = fields('jobTitle');
    // Keep blocks already holding one of your jobs; fill the rest in order.
    const done = new Set(titles.map((f) => norm((f.querySelector('input') as HTMLInputElement | null)?.value ?? '')));
    let slot = 0;
    for (const job of p.jobs) {
      const companies = fields('companyName').map((f) => norm((f.querySelector('input') as HTMLInputElement | null)?.value ?? ''));
      const at = companies.indexOf(norm(job.company));
      let i = at;
      if (i < 0) {
        while (slot < n && companies[slot]) slot += 1;
        i = slot;
        slot += 1;
      }
      if (i >= n) { r.failed.push(`Work experience: ${job.company} (no block)`); continue; }
      void done;
      track(r, `${job.company}: title`, textIn(fields('jobTitle')[i] ?? null, job.title));
      track(r, `${job.company}: company`, textIn(fields('companyName')[i] ?? null, job.company));
      // A job's location only when the form requires it (user, 2026-11-06: BestSpaceFinder's was filled needlessly).
      const locationField = fields('location')[i] ?? null;
      if (locationField && isRequiredWd(locationField)) track(r, `${job.company}: location`, textIn(locationField, job.location));
      if (job.current) track(r, `${job.company}: current`, checkbox(fields('currentlyWorkHere')[i] ?? null, true));
      track(r, `${job.company}: from`, await date(fields('startDate')[i] ?? null, job.from));
      if (!job.current) track(r, `${job.company}: to`, await date(fields('endDate')[i] ?? null, job.to));
      track(r, `${job.company}: description`, textIn(fields('roleDescription')[i] ?? null, job.description));
    }
  }
  if (p.education.length) {
    const n = await ensureBlocks(/^education$/i, 'school', p.education.length);
    for (let i = 0; i < Math.min(n, p.education.length); i += 1) {
      const e = p.education[i]!;
      // School is a search list on most tenants, a plain text box on some: there it gets your own wording, IIT Guwahati.
      const schoolField = fields('school')[i] ?? null;
      const schoolNames = [e.school, ...(e.schoolText && e.schoolText !== e.school ? [e.schoolText] : [])];
      track(r, 'School', schoolField && !schoolField.querySelector('[data-automation-id*="prompt" i], [data-automation-id="multiselectInputContainer"]')
        ? textIn(schoolField, e.schoolText ?? e.school)
        : await search(schoolField, e.schoolQuery, schoolNames));
      track(r, 'Degree', await dropdown(fields('degree')[i] ?? null, e.degree));
      if (e.field) track(r, 'Field of study', await search(fields('fieldOfStudy')[i] ?? null, e.fieldQuery ?? e.field, [e.field]));
      track(r, 'Education from', await date(fields('firstYearAttended')[i] ?? null, { year: e.fromYear }));
      track(r, 'Education to', await date(fields('lastYearAttended')[i] ?? null, { year: e.toYear }));
    }
  }
  if (p.languages.length && section(/^languages$/i)) {
    const n = await ensureBlocks(/^languages$/i, 'language', p.languages.length);
    for (let i = 0; i < Math.min(n, p.languages.length); i += 1) {
      const l = p.languages[i]!;
      track(r, `Language ${l.name}`, await dropdown(fields('language')[i] ?? null, [l.name]));
      if (l.fluent) track(r, `${l.name}: fluent`, checkbox(fields('native')[i] ?? null, true));
      // Overall, and on some tenants Reading / Speaking / Writing too (GSK): each block has one of each.
      for (const skill of ['overall', 'reading', 'speaking', 'writing']) {
        const levels = [...document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"]')]
          .filter((f) => shownField(f) && new RegExp(`^${skill}`, 'i').test((f.querySelector('label')?.textContent ?? '').trim()));
        if (levels[i]) track(r, `${l.name}: ${skill}`, await dropdown(levels[i]!, l.level));
      }
    }
  }
  for (const s of p.skills) {
    const words = s.split(/\s+/);
    // Workday's skill search is a one-word catalogue search: query the most specific word, pick the exact skill.
    const query = words.length > 1 ? words.slice(0, 2).join(' ') : s;
    track(r, `Skill ${s}`, await search(field('skills'), query, [s]));
  }
  track(r, 'Resume', await uploadResume(p.resume));
  if (p.websites.length && section(/^websites$/i)) {
    const urls = () => fields('url').map((f) => (f.querySelector('input') as HTMLInputElement | null)?.value ?? '');
    for (const w of p.websites) {
      if (urls().some((u) => norm(u) === norm(w))) { r.filled.push(`Website ${w}`); continue; }
      const n = await ensureBlocks(/^websites$/i, 'url', urls().filter(Boolean).length + 1);
      const empty = fields('url').slice(0, n).find((f) => !(f.querySelector('input') as HTMLInputElement | null)?.value);
      track(r, `Website ${w}`, textIn(empty ?? null, w));
    }
  }
}

/** Known questions on any step (Application Questions, Voluntary Disclosures…), by label. */
async function fillKnownQuestions(p: WorkdayPlan, r: Result): Promise<void> {
  const roots = [...document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"], fieldset')].filter(shownField);
  for (const root of roots) {
    const label = (root.querySelector('label, legend')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    if (/gender/i.test(label) && !/identity|pronoun/i.test(label)) { track(r, 'Gender', await dropdown(root, p.gender)); continue; }
    if (/date of birth|birth ?date/i.test(label)) { if (p.dateOfBirth) track(r, 'Date of birth', await date(root, p.dateOfBirth, 'Date of birth')); continue; }
    if (p.privacyConsent && /privacy notice|privacy policy|read and agree|terms and conditions/i.test(label) && root.querySelector('input[type="checkbox"]')) {
      track(r, 'Privacy notice', checkbox(root, true));
      continue;
    }
    const q = p.questions.find((x) => new RegExp(x.pattern, 'i').test(label));
    if (!q) continue;
    let ok: boolean | null;
    if (root.querySelector('button[aria-haspopup="listbox"]')) ok = await dropdown(root, q.answers);
    else if (root.querySelector('input[type="radio"]')) ok = radio(root, q.answers);
    else ok = textIn(root, q.answers[0]);
    track(r, label.slice(0, 60), ok);
  }
}

/** The step title shows before its form renders (GSK wd3, 2026-11-05: filling right away found no fields). */
async function waitForForm(ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  let last = -1;
  while (Date.now() < until) {
    const n = document.querySelectorAll('[data-automation-id^="formField-"]').length;
    if (n > 0 && n === last) return; // rendered and stable for one beat
    last = n;
    await sleep(500);
  }
}

/**
 * Any field still empty after the step's own fill, matched by what its label means (not its Workday name or
 * place): tenants differ in which address/phone parts they require and how they name them (Allstate: Address Line 2
 * and State required; GSK: neither). Uses whatever control the field has. Runs on every step and again after
 * Workday reports errors, so a new tenant's extra fields are handled without code changes.
 */
async function fillBySemantics(p: WorkdayPlan, r: Result): Promise<void> {
  const rules: Array<[RegExp, (root: HTMLElement) => Promise<boolean | null> | boolean | null]> = [
    [/address line 2|address 2|street 2|locality|area/i, (x) => textIn(x, p.address2 ?? p.city)],
    [/address( line 1)?$|street( address)?$|address line 1/i, (x) => textIn(x, p.address)],
    [/^(city|town)/i, (x) => textIn(x, p.city)],
    [/postal|zip|pin ?code|post code/i, (x) => textIn(x, p.postalCode)],
    [/state|region|province|county/i, async (x) => (x.querySelector('button[aria-haspopup="listbox"]') ? dropdown(x, [p.state ?? '']) : x.querySelector('input:not([type="hidden"])') && x.querySelector('[data-automation-id*="prompt" i], [data-automation-id="multiselectInputContainer"]') ? search(x, p.state ?? '', [p.state ?? '']) : textIn(x, p.state))],
    [/phone device|phone type|device type/i, (x) => dropdown(x, p.phoneDevice)],
    [/country phone code|phone country|dial(ing)? code/i, (x) => search(x, p.phoneCountry, [`${p.phoneCountry} (+91)`, p.phoneCountry])],
    [/(phone|mobile|contact) ?(number|no\.?)?$/i, (x) => {
      const box = x.querySelector<HTMLInputElement>('input[name="phoneNumber"], input[id$="--phoneNumber"]') ?? x.querySelector<HTMLInputElement>('input[type="tel"], input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])');
      return box ? (box.value === p.phone ? true : setText(box, p.phone)) : null;
    }],
    [/given name|first name/i, (x) => textIn(x, p.firstName)],
    [/family name|last name|surname/i, (x) => textIn(x, p.lastName)],
    [/how did you hear|source/i, async (x) => (await dropdown(x, p.source)) || search(x, p.source[0] ?? 'LinkedIn', p.source)],
    [/^country/i, (x) => dropdown(x, [p.country])],
    [/degree|qualification/i, async (x) => {
      const e = p.education[0];
      if (!e) return null;
      return x.querySelector('button[aria-haspopup="listbox"]') ? dropdown(x, e.degree) : search(x, e.degree[0]!.split(' ')[0]!, e.degree);
    }],
    [/school|university|college|institut/i, async (x) => {
      const e = p.education[0];
      if (!e) return null;
      if (!x.querySelector('[data-automation-id*="prompt" i], [data-automation-id="multiselectInputContainer"]')) return textIn(x, e.schoolText ?? e.school);
      return search(x, e.schoolQuery, [e.school, ...(e.schoolText ? [e.schoolText] : [])]);
    }],
    [/field of study|major|discipline|specialization/i, async (x) => {
      const e = p.education[0];
      if (!e?.field) return null;
      return x.querySelector('button[aria-haspopup="listbox"]') ? dropdown(x, [e.field, 'Engineering']) : search(x, e.fieldQuery ?? e.field, [e.field, 'Engineering']);
    }],
  ];
  const empty = new Set(emptyRequired().map((l) => l.toLowerCase()));
  for (const root of [...document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"]')].filter(shownField)) {
    const label = (root.querySelector('label, legend')?.textContent ?? '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
    if (!label || !empty.has(label.toLowerCase())) continue;
    const rule = rules.find(([re]) => re.test(label));
    if (!rule) continue;
    track(r, `${label} (by meaning)`, await rule[1](root));
  }
}

async function fillStep(p: WorkdayPlan): Promise<Result & { step: string; typing: typeof typingQueue }> {
  await waitForForm();
  typingQueue = [];
  const r: Result = { filled: [], failed: [] };
  const { step } = wdState();
  if (/my information/i.test(step)) await fillMyInformation(p, r);
  else if (/my experience/i.test(step)) await fillMyExperience(p, r);
  await fillKnownQuestions(p, r);
  await fillBySemantics(p, r);
  return { ...r, step, typing: typingQueue };
}

/** Press Save and Continue (or Submit on Review) and wait for the next step, a confirmation or errors. */
async function next(): Promise<WdState & { moved: boolean; empty?: string[] }> {
  const before = wdState();
  const btn = auto('pageFooterNextButton') ?? [...document.querySelectorAll<HTMLElement>('button')].filter(visible).find((b) => /^(save and continue|next|submit)$/i.test(b.innerText.trim())) ?? null;
  if (!btn) return { ...before, moved: false };
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    const s = wdState();
    if (s.page === 'submitted' || s.step !== before.step || s.page !== before.page || (s.fingerprint && s.fingerprint !== before.fingerprint)) return { ...s, moved: true };
    if (s.errors.length && i > 4) return { ...s, moved: false, empty: emptyRequired() };
  }
  return { ...wdState(), moved: false, empty: emptyRequired() };
}

async function start(): Promise<WdState> {
  const job = auto('adventureButton');
  if (job && visible(job)) { job.click(); await sleep(2000); }
  const manual = auto('applyManually');
  if (manual && visible(manual)) {
    for (const t of ['mousedown', 'mouseup', 'click']) manual.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    await sleep(3000);
  }
  return wdState();
}

export interface WdQuestion { id: string; label: string; type: 'select' | 'radio' | 'text' | 'textarea' | 'checkbox'; options: string[] }
let questionSeq = 0;

/** Read a dropdown's options (opening it, scrolling the list) and close it again. */
async function dropdownOptions(btn: HTMLElement): Promise<string[]> {
  if (![...document.querySelectorAll('[role="listbox"]')].some(visible)) {
    btn.click();
    await sleep(400);
  }
  const seen = new Set<string>();
  const list = [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(visible).pop();
  for (let i = 0; i < 40; i += 1) {
    for (const o of openOptions()) { const t = o.innerText.trim(); if (t && !/^select one$/i.test(t)) seen.add(t); }
    if (!list) break;
    const before = list.scrollTop;
    list.scrollTop += Math.max(40, list.clientHeight - 20);
    await sleep(80);
    if (list.scrollTop === before) break;
  }
  await closeList(btn);
  return [...seen].slice(0, 80);
}

/**
 * Required questions still empty after the rules: with their real options, for the agent to answer (your profile,
 * remembered answers, then the AI). Workday shows "Select One" in an empty dropdown, which the general engine took
 * for an answer (Allstate: notice period, "skills match the job?", "open to…" were never asked).
 */
async function unanswered(): Promise<WdQuestion[]> {
  const empty = new Set(emptyRequired().map((l) => l.toLowerCase()));
  const out: WdQuestion[] = [];
  for (const root of [...document.querySelectorAll<HTMLElement>('[data-automation-id^="formField-"]')].filter(shownField)) {
    const label = (root.querySelector('label, legend')?.textContent ?? '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
    if (!label || !empty.has(label.toLowerCase())) continue;
    const id = root.getAttribute('data-wd-q') ?? `wd-q-${++questionSeq}`;
    root.setAttribute('data-wd-q', id);
    const btn = root.querySelector<HTMLElement>('button[aria-haspopup="listbox"]');
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    if (btn) out.push({ id, label, type: 'select', options: await dropdownOptions(btn) });
    else if (radios.length) {
      out.push({ id, label, type: 'radio', options: radios.map((o) => ((o.id && root.querySelector<HTMLElement>(`label[for="${CSS.escape(o.id)}"]`)) || o.parentElement)?.innerText.trim() ?? o.value) });
    } else if (root.querySelector('textarea')) out.push({ id, label, type: 'textarea', options: [] });
    else if (root.querySelector('input[type="checkbox"]')) out.push({ id, label, type: 'checkbox', options: [] });
    else out.push({ id, label, type: 'text', options: [] });
  }
  return out;
}

async function setAnswer(id: string, answer: string): Promise<boolean> {
  const root = document.querySelector<HTMLElement>(`[data-wd-q="${id}"]`);
  if (!root || !answer) return false;
  if (root.querySelector('button[aria-haspopup="listbox"]')) return !!(await dropdown(root, [answer]));
  if (root.querySelector('input[type="radio"]')) return !!radio(root, [answer]);
  if (root.querySelector('input[type="checkbox"]')) return !!checkbox(root, /^(yes|true|checked|agree)/i.test(answer));
  if (root.querySelector('[data-automation-id*="prompt" i], [data-automation-id="multiselectInputContainer"]')) return !!(await search(root, answer.split(/\s+/).slice(0, 2).join(' '), [answer]));
  return !!textIn(root, answer);
}

/** The form engine's message hook: returns true when it handled (and will answer) the message. */
export function handleWorkdayMessage(message: { type?: string; plan?: WorkdayPlan }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => { p.then((v) => sendResponse({ ok: true, ...(v as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e) })); return true; };
  switch (message?.type) {
    case 'WD_STATE': return reply(Promise.resolve({ ...wdState(), empty: emptyRequired() }));
    case 'WD_START': return reply(start());
    case 'WD_FILL_STEP': return message.plan ? reply(fillStep(message.plan)) : (sendResponse({ ok: false, error: 'no plan' }), true);
    case 'WD_NEXT': return reply(next());
    case 'WD_UNANSWERED': return reply(unanswered().then((questions) => ({ questions })));
    case 'WD_SET': return reply(setAnswer(String((message as { id?: string }).id ?? ''), String((message as { answer?: string }).answer ?? '')).then((set) => ({ set })));
    case 'WD_FOCUS': return reply(Promise.resolve({ focused: focusTyping(String((message as { id?: string }).id ?? '')) }));
    case 'WD_SUBMIT': return reply(next());
    default: return false;
  }
}
