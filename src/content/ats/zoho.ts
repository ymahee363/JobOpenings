/**
 * Zoho Recruit's applier, in the page (career sites on *.zohorecruit.com and company domains running Zoho Recruit).
 *
 * Zoho builds its application form with its own "Lyte" components (seen 2026-11-06 on raveinfosys.zohorecruit.com):
 *  - every question is a `.crc-form-row` whose label is `.crc-label-text`, not tied to its box by for/id;
 *  - text boxes are plain <input>s inside <lyte-input>; a value set through the native setter plus input/change is
 *    kept (checked live: the component's own value follows);
 *  - dropdowns are <lyte-dropdown>: its [role=combobox] opens a <lyte-drop-box> (moved to the end of the page) whose
 *    <lyte-drop-item>s are clicked; Mobile has one for the country code;
 *  - "Educational Details" and "Experience Details" are empty until their "Add" button adds a block
 *    (`.tabular-main-div`) with Institute / School, Major / Department, Degree, Duration (4 dropdowns: from month,
 *    from year, to month, to year), Currently pursuing; Occupation / Title, Company, Summary, Work Duration,
 *    I currently work here;
 *  - files go into hidden <input type=file> inside <lyte-fileupload>: "Autofill Application" at the top (parses the
 *    resume and overwrites the form: never used), and "Photo" / "Resume" under Attachment Information;
 *  - a required image CAPTCHA, which only you type, and "Submit Application".
 *
 * Messages (from src/shared/ats/zoho-flow.ts): ZH_STATE, ZH_START, ZH_FILL, ZH_SUBMIT.
 */
import type { WdDate, WorkdayPlan } from './workday';

export interface ZhState {
  /** A Zoho Recruit page at all. */
  zoho: boolean;
  page: 'job' | 'form' | 'submitted' | 'unknown';
  captcha: boolean;
  captchaFilled: boolean;
  errors: string[];
}

export interface ZhFillResult {
  filled: string[];
  failed: string[];
  /** Required questions still empty (the CAPTCHA aside), for the general form engine and the AI. */
  empty: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const visible = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CAPTCHA_LABEL = /captcha|below image|image text|security (check|code)/i;
const CONFIRMED = /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received|sent)|successfully (applied|submitted)|we('ve| have) received your application/i;

const rows = () => [...document.querySelectorAll<HTMLElement>('.crc-form-row')];
const labelOf = (row: Element) => text(row.querySelector('.crc-label-text') ?? row.querySelector(':scope > label')).replace(/\s*\*\s*$/, '');
const rowByLabel = (re: RegExp) => rows().find((r) => re.test(labelOf(r)));
const sectionRow = (name: RegExp) => rows().find((r) => name.test(text(r.querySelector('.cw-section-title, h2')) || r.getAttribute('aria-label') || ''));

function captchaInput(): HTMLInputElement | null {
  const row = rowByLabel(CAPTCHA_LABEL);
  return (row?.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null)
    ?? [...document.querySelectorAll<HTMLInputElement>('input')].find((i) => CAPTCHA_LABEL.test(i.placeholder || '')) ?? null;
}

// The real <button>, never its <lyte-button> wrapper: a click on the wrapper does not reach the button's handler
// (replica test, 2026-11-06: Submit "pressed", nothing happened).
const realButton = (re: RegExp) => [...document.querySelectorAll<HTMLElement>('button, a')].find((b) => visible(b) && re.test(text(b)))
  ?? (() => {
    const wrap = [...document.querySelectorAll<HTMLElement>('lyte-button')].find((b) => visible(b) && re.test(text(b)));
    return wrap?.querySelector<HTMLElement>('button') ?? wrap ?? null;
  })();
const submitButton = () => realButton(/^submit application$/i) ?? [...document.querySelectorAll<HTMLElement>('button[type="submit"]')].find(visible) ?? null;
const interestedButton = () => realButton(/^(i'?m interested|apply( now)?)$/i);

export function zhState(): ZhState {
  const body = document.body?.innerText ?? '';
  const zoho = !!document.querySelector('.crc-form-row, rec-tabular-component, crux-text-component')
    || /zohorecruit\./i.test(location.hostname)
    || [...document.querySelectorAll('a')].some((a) => /zoho recruit|recruit\.zoho/i.test(`${text(a)} ${a.getAttribute('href') ?? ''}`) && /powered/i.test(text(a.parentElement)));
  const errors = [...new Set([...document.querySelectorAll<HTMLElement>('.lyteErrorMessage, .cxErrorMsg, [class*="errorMsg"], [class*="error-msg"], [role="alert"], .crc-error')]
    .filter(visible).map(text).filter((t) => t && t.length < 200))].slice(0, 10);
  const cap = captchaInput();
  const base = { zoho, captcha: !!cap && visible(cap), captchaFilled: !!cap?.value.trim(), errors };
  if (CONFIRMED.test(body.slice(0, 6000)) && !visible(submitButton())) return { ...base, page: 'submitted' };
  if (visible(submitButton()) && rows().length) return { ...base, page: 'form' };
  if (interestedButton()) return { ...base, page: 'job' };
  return { ...base, page: 'unknown' };
}

export async function zhStart(): Promise<ZhState> {
  const b = interestedButton();
  if (b) b.click();
  for (let i = 0; i < 30 && zhState().page !== 'form'; i += 1) await sleep(400);
  return zhState();
}

/** Type a value into a Zoho text box the way the component listens (native setter, input, change, blur). */
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

/** Open a <lyte-dropdown> and click the item that `want` picks; checks the dropdown shows it. */
async function pick(dd: Element | null, want: (item: string) => boolean): Promise<boolean> {
  if (!dd) return false;
  const opener = dd.querySelector<HTMLElement>('[role="combobox"]') ?? dd.querySelector<HTMLElement>('lyte-drop-button');
  if (!opener) return false;
  opener.scrollIntoView({ block: 'center' });
  opener.click();
  let box: Element | undefined;
  for (let i = 0; i < 10 && !box; i += 1) {
    await sleep(150);
    box = [...document.querySelectorAll('lyte-drop-box')].find((b) => visible(b) && !b.classList.contains('lyteDropdownHidden'));
  }
  const item = box && [...box.querySelectorAll<HTMLElement>('lyte-drop-item')].find((i) => want(text(i)));
  if (!item) {
    opener.click();
    await sleep(150);
    return false;
  }
  item.click();
  await sleep(250);
  return want(text(dd.querySelector('lyte-drop-button')));
}

const monthIs = (m: string | undefined) => (item: string) => !!m && MONTHS[Number(m) - 1] === item.slice(0, 3).toLowerCase();
const yearIs = (y: string | undefined) => (item: string) => !!y && item.trim() === y;

/** Set a checkbox (Lyte or native) to `on`. */
function check(row: Element | null | undefined, on: boolean): boolean {
  const box = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) return false;
  if (box.checked !== on) (box.closest('label') as HTMLElement | null ?? box).click();
  if (box.checked !== on) box.click();
  return box.checked === on;
}

/** The blocks of a repeatable section, adding blocks with its "Add" button until there are `n`. */
async function blocks(section: RegExp, n: number): Promise<HTMLElement[]> {
  const row = sectionRow(section);
  if (!row || !n) return [];
  const list = () => [...row.querySelectorAll<HTMLElement>('.tabular-main-div')];
  for (let i = 0; i < n + 2 && list().length < n; i += 1) {
    const add = [...row.querySelectorAll<HTMLElement>('button')].find((b) => /^\+?\s*add( more| row)?$/i.test(text(b)));
    if (!add) break;
    add.click();
    await sleep(500);
  }
  return list().slice(0, n);
}

const fieldIn = (block: Element, label: RegExp) => [...block.querySelectorAll('.crc-form-tabularrow')].find((r) => label.test(text(r.querySelector('label'))));
const inputIn = (row: Element | undefined) => (row?.querySelector('textarea, input[type="text"], input:not([type])') as HTMLInputElement | null) ?? null;

async function duration(row: Element | undefined, from: WdDate, to: WdDate | null): Promise<boolean> {
  const dds = row ? [...row.querySelectorAll('lyte-dropdown')] : [];
  if (dds.length < 4) return false;
  const ok: boolean[] = [];
  if (from.month) ok.push(await pick(dds[0]!, monthIs(from.month)));
  if (from.year) ok.push(await pick(dds[1]!, yearIs(from.year)));
  if (to?.month) ok.push(await pick(dds[2]!, monthIs(to.month)));
  if (to?.year) ok.push(await pick(dds[3]!, yearIs(to.year)));
  return ok.every(Boolean);
}

function attach(input: HTMLInputElement | null | undefined, file: { name: string; type: string; data: string } | null | undefined): boolean {
  if (!input || !file?.data) return false;
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], file.name, { type: file.type || 'application/pdf' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Fill the form from your profile (the Workday plan, which carries the same facts) and your email. */
export async function zhFill(plan: WorkdayPlan, email: string): Promise<ZhFillResult> {
  const r: ZhFillResult = { filled: [], failed: [], empty: [] };
  const track = (what: string, ok: boolean) => (ok ? r.filled : r.failed).push(what);
  const box = (re: RegExp) => inputIn(rowByLabel(re) ?? undefined);
  const linkedin = plan.websites.find((w) => /linkedin/i.test(w));

  // Your details, by label. A box already holding a value is left as it is.
  const basics: Array<[RegExp, string | undefined]> = [
    [/^first name$/i, plan.firstName], [/^last name$/i, plan.lastName], [/^e-?mail( address)?$/i, email],
    [/^(street|address)( line 1)?$/i, plan.address], [/^city$/i, plan.city], [/^(zip|postal|pin)/i, plan.postalCode],
    [/^state|province/i, plan.state], [/^country$/i, plan.country], [/^linked ?in/i, linkedin],
  ];
  for (const [re, value] of basics) {
    const input = box(re);
    if (input && value && !input.value.trim()) track(re.source, setText(input, value));
  }
  // Mobile: India (+91) in its country-code list, then the number.
  const mobile = rowByLabel(/^(mobile|phone)/i);
  if (mobile && plan.phone) {
    const code = mobile.querySelector('lyte-dropdown');
    if (code && !/\+91|india/i.test(text(code.querySelector('lyte-drop-button')))) {
      track('phone country code', await pick(code, (t) => /\+\s?91\b|^india\b/i.test(t)));
    }
    const input = inputIn(mobile);
    if (input && !input.value.trim()) track('mobile', setText(input, plan.phone));
  }

  // Education: one block per degree.
  const edu = await blocks(/educational details|education/i, plan.education.length);
  for (const [i, e] of plan.education.entries()) {
    const b = edu[i];
    if (!b) { r.failed.push(`education ${i + 1}: no block`); continue; }
    track(`${e.school}: institute`, setText(inputIn(fieldIn(b, /institute|school|college|university/i)), e.school));
    if (e.field) track(`${e.school}: major`, setText(inputIn(fieldIn(b, /major|department|field|specialization/i)), e.field));
    // A text box: B.Tech (your degree's first choice), not Workday's generic list wording.
    track(`${e.school}: degree`, setText(inputIn(fieldIn(b, /^degree/i)), e.degree[0]));
    if (e.fromYear || e.toYear) track(`${e.school}: duration`, await duration(fieldIn(b, /duration|year|period/i), { year: e.fromYear }, { year: e.toYear }));
  }

  // Experience: one block per job, most recent first.
  const exp = await blocks(/experience details|work experience|experience/i, plan.jobs.length);
  for (const [i, j] of plan.jobs.entries()) {
    const b = exp[i];
    if (!b) { r.failed.push(`${j.company}: no block`); continue; }
    track(`${j.company}: title`, setText(inputIn(fieldIn(b, /occupation|title|designation|role/i)), j.title));
    track(`${j.company}: company`, setText(inputIn(fieldIn(b, /^company|employer|organi[sz]ation/i)), j.company));
    if (j.description) track(`${j.company}: summary`, setText(inputIn(fieldIn(b, /summary|description|responsibilit/i)), j.description));
    if (j.current) track(`${j.company}: current`, check(fieldIn(b, /currently work|current/i), true));
    track(`${j.company}: dates`, await duration(fieldIn(b, /duration|period|dates/i), j.from, j.current ? null : j.to));
  }

  // Your resume, in the Attachment Information "Resume" slot (never "Autofill Application", which overwrites the form).
  const resumeRow = rows().find((row) => /^resume\b/i.test(labelOf(row) || text(row)) && !/autofill/i.test(text(row)));
  const resumeInput = resumeRow?.querySelector<HTMLInputElement>('input[type="file"]')
    ?? [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter((f) => !/image/i.test(f.accept) && !/autofill/i.test(text(f.closest('.crc-form-row')))).at(-1);
  if (plan.resume && resumeInput && !resumeInput.files?.length) {
    track('resume', attach(resumeInput, plan.resume));
    await sleep(800);
  }

  // Required questions still empty, the CAPTCHA aside.
  for (const row of rows()) {
    const label = labelOf(row);
    if (!/\*/.test(text(row.querySelector('.crc-label-text'))) || CAPTCHA_LABEL.test(label)) continue;
    const input = inputIn(row);
    if (input && !input.value.trim()) r.empty.push(label);
  }
  return r;
}

export async function zhSubmit(): Promise<ZhState & { moved: boolean }> {
  const btn = submitButton();
  if (!btn) return { ...zhState(), moved: false };
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  for (let i = 0; i < 50; i += 1) {
    await sleep(400);
    const s = zhState();
    if (s.page === 'submitted') return { ...s, moved: true };
    if (s.errors.length && i > 4) return { ...s, moved: false };
  }
  return { ...zhState(), moved: false };
}

export function handleZohoMessage(message: { type: string; plan?: WorkdayPlan; email?: string }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => {
    p.then((r) => sendResponse({ ok: true, ...(r as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e).slice(0, 200) }));
    return true;
  };
  switch (message.type) {
    case 'ZH_STATE': return reply(Promise.resolve(zhState()));
    case 'ZH_START': return reply(zhStart());
    case 'ZH_FILL': return message.plan ? reply(zhFill(message.plan, String(message.email ?? ''))) : (sendResponse({ ok: false, error: 'no plan' }), true);
    case 'ZH_SUBMIT': return reply(zhSubmit());
    default: return false;
  }
}
