/**
 * The account agent, in the page: signs in, or creates the account, on a career site's account wall (Workday, iCIMS,
 * Taleo, SuccessFactors, any "create an account to apply" page), with the email and password from your .env
 * (ACCOUNT_EMAIL / ACCOUNT_PASSWORD, built into the extension by scripts/build.mjs; never in the repo, never sent to
 * the AI or written to the log).
 *
 * One ACCOUNT_STEP does one thing and reports back to the flow (src/shared/ai-apply/flow.ts):
 *  - a sign-in form: email + password, press Sign in;
 *  - a create-account form: email, password and its confirmation, the terms/privacy box, press Create Account;
 *  - after the press: in (the page moved on), "switched" (the site says the account exists → its Sign in; says there
 *    is no account → its Create Account), or stopped: a wrong password, a captcha, an emailed code, another error.
 * It never solves a captcha, never reads email for a code, and fills only on https pages (localhost for tests).
 */

export interface AccountResult {
  ok: boolean;
  /** What the page was. */
  page: 'signin' | 'signup' | 'none';
  /** in: the page moved on; switched: went to the other form; stopped: needs you; none: nothing done. */
  outcome: 'in' | 'switched' | 'stopped' | 'none' | 'no_effect';
  /** no_effect: where the button is on screen (CSS px in the viewport), for a real mouse click. */
  point?: { x: number; y: number };
  /** Why it stopped, in the site's words where it gave any. */
  reason?: string;
  verification?: boolean;
  captcha?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function visible(el: Element | null | undefined): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (!el.getClientRects().length) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

const auto = (id: string) => document.querySelector<HTMLElement>(`[data-automation-id="${id}"]`);
const textOf = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

function labelOf(el: HTMLElement): string {
  const id = el.id;
  const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
  const wrap = el.closest('label');
  const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((x) => textOf(document.getElementById(x))).join(' ');
  return [textOf(byFor), textOf(wrap), labelled, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), id,
    el.getAttribute('autocomplete'), el.getAttribute('data-automation-id')].filter(Boolean).join(' ');
}

/** Set a value as typing would (React and Workday read the native setter plus input/change/blur). */
function setValue(el: HTMLInputElement, value: string): void {
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

function press(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'auto' });
  // Workday puts a transparent click_filter over its buttons; the press must land on it.
  const filter = el.parentElement?.querySelector<HTMLElement>('[data-automation-id="click_filter"]');
  const target = filter && visible(filter) ? filter : el;
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  target.click();
}

const passwordsShown = () => [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(visible);

/** The box (form, dialog or section) holding the password fields. */
function accountBox(pw: HTMLInputElement[]): HTMLElement {
  let box: HTMLElement | null = pw[0]!.closest('form, [role="dialog"], dialog') as HTMLElement | null;
  if (box) return box;
  box = pw[0]!.parentElement;
  while (box && box !== document.body && !(box.querySelectorAll('button, [role="button"], input[type="submit"]').length && pw.every((p) => box!.contains(p)))) box = box.parentElement;
  return box ?? document.body;
}

const SIGNUP_WORDS = /create (an |my |your )?account|sign ?up|register|join now|create profile/i;
const SIGNIN_WORDS = /^(sign ?in|log ?in|login|continue|next|submit)$/i;

function buttonsIn(box: ParentNode): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"], a[role="button"]')].filter(visible);
}

/** Sign-up or sign-in, from the page: two password boxes, Workday's ids, the form's button, its heading. */
function pageKind(pw: HTMLInputElement[], box: HTMLElement): 'signin' | 'signup' {
  if (visible(auto('createAccountSubmitButton')) || visible(auto('verifyPassword'))) return 'signup';
  if (visible(auto('signInSubmitButton'))) return 'signin';
  if (pw.length >= 2) return 'signup';
  if (pw.some((p) => /new-password/i.test(p.getAttribute('autocomplete') || '') || /confirm|verify|re-?enter|repeat/i.test(labelOf(p)))) return 'signup';
  const buttons = buttonsIn(box).map((b) => textOf(b) || (b as HTMLInputElement).value || '');
  if (buttons.some((t) => SIGNUP_WORDS.test(t)) && !buttons.some((t) => /^(sign ?in|log ?in|login)$/i.test(t))) return 'signup';
  return 'signin';
}

function submitButton(kind: 'signin' | 'signup', box: HTMLElement): HTMLElement | null {
  const wd = auto(kind === 'signup' ? 'createAccountSubmitButton' : 'signInSubmitButton');
  if (visible(wd)) return wd;
  const buttons = buttonsIn(box);
  const words = kind === 'signup' ? SIGNUP_WORDS : SIGNIN_WORDS;
  return buttons.find((b) => words.test(textOf(b) || (b as HTMLInputElement).value || ''))
    ?? buttons.find((b) => /^(continue|next|submit|create account|sign ?in|log ?in)$/i.test(textOf(b) || (b as HTMLInputElement).value || ''))
    ?? (box.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]') || null);
}

/** The link or button to the other form: "Already have an account? Sign in" / "Create Account". */
function switchControl(to: 'signin' | 'signup'): HTMLElement | null {
  const wd = auto(to === 'signin' ? 'signInLink' : 'createAccountLink');
  if (visible(wd)) return wd;
  const words = to === 'signin' ? /^(sign ?in|log ?in|login|already have an account\??\s*(sign ?in|log ?in)?)$/i : /^(create (an )?account|sign ?up|register|new user\??.*)$/i;
  return [...document.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"]')].filter(visible).find((b) => words.test(textOf(b))) ?? null;
}

function pageErrors(): string[] {
  return [...new Set([...document.querySelectorAll<HTMLElement>('[role="alert"], [data-automation-id*="error" i], .error, .error-message, .errorMessage, .alert-danger, .invalid-feedback, [class*="error" i]')]
    .filter(visible).map(textOf).filter((t) => t && t.length < 300))].slice(0, 6);
}

const CAPTCHA = () => [...document.querySelectorAll<HTMLElement>("iframe[src*='recaptcha/api2/bframe'], iframe[src*='hcaptcha'], iframe[src*='challenges.cloudflare']")]
  .some((f) => visible(f) && f.getBoundingClientRect().height > 0) || /verify (that )?you are (a )?human|are you a robot/i.test(document.body.innerText.slice(0, 4000));
const VERIFY = () => /verification code|verify your email|check your (email|inbox)|confirm your email|we('ve| have) sent (you )?an? (email|link|code)|enter the code|one[- ]?time (code|password)/i.test(document.body.innerText.slice(0, 5000));

export async function accountStep(email: string, password: string): Promise<AccountResult> {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (location.protocol !== 'https:' && !local) return { ok: false, page: 'none', outcome: 'stopped', reason: 'not a secure (https) page: the password is not entered here' };
  if (!email || !password) return { ok: false, page: 'none', outcome: 'stopped', reason: 'no account email/password in the extension (.env ACCOUNT_EMAIL / ACCOUNT_PASSWORD)' };
  // Workday draws the account form in stages: the step says "Create Account/Sign In" before the boxes exist.
  let pw = passwordsShown();
  for (let i = 0; i < 20 && !pw.length; i += 1) {
    await sleep(500);
    pw = passwordsShown();
  }
  if (!pw.length) return { ok: false, page: 'none', outcome: 'stopped', reason: 'the account page showed no password box' };
  if (CAPTCHA()) return { ok: false, page: 'none', outcome: 'stopped', captcha: true, reason: 'a captcha is showing' };
  const box = accountBox(pw);
  const kind = pageKind(pw, box);

  // Email / username boxes next to the passwords.
  const inputs = [...box.querySelectorAll<HTMLInputElement>('input')].filter((i) => visible(i) && i.type !== 'password' && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio');
  const emailBoxes = inputs.filter((i) => i.type === 'email' || /e-?mail|user ?name|username|login|user id|userid/i.test(labelOf(i)));
  for (const i of emailBoxes) setValue(i, email);
  for (const p of pw) setValue(p, password);
  // The account's terms / privacy / consent box (your standing yes to application privacy notices); marketing
  // opt-ins stay unticked.
  for (const c of [...box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]) {
    const l = labelOf(c);
    if (!c.checked && /agree|accept|terms|privacy|consent|acknowledge|data (protection|processing)/i.test(l) && !/marketing|newsletter|sms|text message|promotional|offers/i.test(l)) {
      const wrap = c.closest('label');
      if (wrap) wrap.click();
      else c.click();
      if (!c.checked) c.click();
    }
  }
  const wdBox = auto('createAccountCheckbox');
  if (wdBox && wdBox instanceof HTMLInputElement && !wdBox.checked) wdBox.click();
  await sleep(300);

  const btn = submitButton(kind, box);
  if (!btn) return { ok: false, page: kind, outcome: 'stopped', reason: `no ${kind === 'signup' ? 'Create Account' : 'Sign In'} button found` };
  pending = { kind, before: location.href, errorsBefore: new Set(pageErrors()), button: btn };
  press(btn);
  const after = await watchAfterPress(6_000);
  if (after.outcome !== 'no_effect') return after;
  // Nothing happened: some sites (Workday's Create Account on Cisco, 2026-11-06) act only on a real mouse press,
  // not a scripted one. Hand back where the button is, for a real click (chrome.debugger), then ACCOUNT_AFTER.
  btn.scrollIntoView({ block: 'center', behavior: 'auto' });
  await sleep(200);
  const target = btn.parentElement?.querySelector<HTMLElement>('[data-automation-id="click_filter"]') ?? btn;
  const r = (visible(target) ? target : btn).getBoundingClientRect();
  return { ...after, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
}

/** The press in progress, so ACCOUNT_AFTER can read its result after a real click. */
let pending: { kind: 'signin' | 'signup'; before: string; errorsBefore: Set<string>; button: HTMLElement } | null = null;

/**
 * What the press did, watched for up to `ms`: in, switched to the other form, stopped (a captcha, an emailed code,
 * the site's error) or no_effect (nothing happened yet).
 */
export async function watchAfterPress(ms = 15_000): Promise<AccountResult> {
  if (!pending) return { ok: false, page: 'none', outcome: 'stopped', reason: 'no account press to check' };
  const { kind, before, errorsBefore } = pending;
  for (let i = 0; i < Math.ceil(ms / 300); i += 1) {
    await sleep(300);
    if (CAPTCHA()) return { ok: false, page: kind, outcome: 'stopped', captcha: true, reason: 'a captcha appeared' };
    if (VERIFY()) return { ok: false, page: kind, outcome: 'stopped', verification: true, reason: 'the site sent a verification email or code' };
    const gone = !passwordsShown().length || location.href !== before;
    if (gone) return { ok: true, page: kind, outcome: 'in' };
    const errors = pageErrors().filter((e) => !errorsBefore.has(e));
    if (errors.length && i >= 3) {
      const text = errors.join(' ');
      // The account exists: sign in instead. No account: create it.
      if (kind === 'signup' && /already (exists|registered|in use|taken|have an account)|account (with this|for this) email|email (is )?(already|in use)/i.test(text)) {
        const to = switchControl('signin');
        if (to) { press(to); await sleep(1500); return { ok: true, page: kind, outcome: 'switched', reason: 'the account exists; signing in' }; }
      }
      if (kind === 'signin' && /no account|not (found|registered)|does ?n.?t exist|doesn't exist|unknown (user|email)|create an account/i.test(text)) {
        const to = switchControl('signup');
        if (to) { press(to); await sleep(1500); return { ok: true, page: kind, outcome: 'switched', reason: 'no account yet; creating it' }; }
      }
      return { ok: false, page: kind, outcome: 'stopped', reason: text.slice(0, 250) };
    }
  }
  return { ok: false, page: kind, outcome: 'no_effect', reason: `pressed ${kind === 'signup' ? 'Create Account' : 'Sign In'}; the page did not move on` };
}
