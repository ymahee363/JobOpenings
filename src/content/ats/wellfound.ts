/**
 * Wellfound's applier, in the page (wellfound.com/jobs/<id>-<slug>).
 *
 * Seen live on 2026-11-11 (signed in; the form was opened and cancelled, nothing was sent):
 *  - a job shows two `button[class*="applyButton"]` ("Apply" in the header, "Apply now" lower down); right after
 *    load a click can do nothing (the page is not yet listening), so Apply is pressed again while nothing opened;
 *  - Apply opens a react-modal (`.ReactModal__Content`) with the job's facts, then "YOUR APPLICATION": zero or more
 *    `textarea[name^="customQuestionAnswers["]` (e.g. "What interests you about working for this company?", or
 *    8 required self-rating questions marked "*"), "Cancel", and `button[data-test="JobApplicationModal--SubmitButton"]`
 *    ("Send application", type=submit). Opening the form sends nothing; "Send application" does;
 *  - a job that was taken down is Wellfound's 404 page ("Page not found - 404");
 *  - after "Send application" (a real apply, SciSpace, 2026-11-11) the modal stays open with only the job's facts (its
 *    form and Send are gone), and both apply buttons read "Undo · 4:39": a 5-minute undo window, never pressed here.
 *    That is the confirmation; the form closing without errors also counts as sent.
 *
 * Messages (from src/shared/ats/wellfound-flow.ts): WF_STATE, WF_START, WF_SEND.
 */

export interface WfState {
  page: 'job' | 'form' | 'applied' | 'closed' | 'unknown';
  /** Questions in the open form. */
  questions: number;
  errors: string[];
  /** The open modal's text when it has no Send button (e.g. a location block), or what confirmed the apply. */
  note: string;
}

const SUBMIT = '[data-test="JobApplicationModal--SubmitButton"]';
const APPLY = 'button[class*="applyButton"], a[class*="applyButton"]';
/** Right after Send, Wellfound's apply buttons read "Undo · 4:39" (a 5-minute undo window; seen 2026-11-11). Never pressed. */
const UNDO_RE = /^undo\s*·\s*\d+:\d{2}$/i;
const APPLIED_RE = /^(applied|application sent!?|you applied|application submitted)$/i;
const SENT_RE = /application (was )?(sent|submitted)|you('ve| have) applied/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const shown = (el: Element | null): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function modal(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.ReactModal__Content, [role="dialog"]')].filter(shown).pop() ?? null;
}

function applyButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(APPLY)].filter(shown);
}

/** A toast or the apply control saying the application went in. */
function appliedSignal(): string {
  const control = applyButtons().map((b) => clean(b.textContent)).find((t) => APPLIED_RE.test(t) || UNDO_RE.test(t));
  if (control) return UNDO_RE.test(control) ? `Wellfound sent it (its apply button reads "${control}", the undo window)` : `the job's apply control reads "${control}"`;
  const toast = [...document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"], [class*="toast" i], [class*="Toast"], [class*="notification" i]')]
    .filter(shown).map((e) => clean(e.innerText)).find((t) => SENT_RE.test(t));
  return toast ? `Wellfound says "${toast.slice(0, 120)}"` : '';
}

export function wfState(): WfState {
  if (/page not found|\b404\b/i.test(document.title)) return { page: 'closed', questions: 0, errors: [], note: 'Wellfound shows "Page not found" (the job was taken down)' };
  const m = modal();
  // After Send the modal stays open with its form gone, behind it the apply buttons read "Undo · m:ss".
  if (!m?.querySelector(SUBMIT)) {
    const signal = appliedSignal();
    if (signal) return { page: 'applied', questions: 0, errors: [], note: signal };
  }
  if (m) {
    const errors = [...m.querySelectorAll<HTMLElement>('[class*="error" i], [role="alert"]')].filter(shown).map((e) => clean(e.innerText)).filter((t) => t && t.length < 200).slice(0, 5);
    if (m.querySelector(SUBMIT)) {
      const questions = [...m.querySelectorAll('textarea, input:not([type="hidden"]), select')].filter(shown).length;
      return { page: 'form', questions, errors, note: '' };
    }
    const text = clean(m.innerText);
    if (SENT_RE.test(text)) return { page: 'applied', questions: 0, errors: [], note: `Wellfound says "${text.slice(0, 120)}"` };
    return { page: 'unknown', questions: 0, errors, note: text.slice(0, 200) };
  }
  const signal = appliedSignal();
  if (signal) return { page: 'applied', questions: 0, errors: [], note: signal };
  if (/no longer (accepting|available|active)|job (has )?expired|this job (is|has been) closed/i.test(clean(document.body?.innerText).slice(0, 5000))) {
    return { page: 'closed', questions: 0, errors: [], note: 'Wellfound says the job is closed' };
  }
  if (applyButtons().some((b) => !(b as HTMLButtonElement).disabled && /^apply( now)?$/i.test(clean(b.textContent)))) return { page: 'job', questions: 0, errors: [], note: '' };
  return { page: 'unknown', questions: 0, errors: [], note: `page ${location.pathname.slice(0, 60)}` };
}

/**
 * Press Apply and wait for the application form. Opening the form sends nothing. A click before the page listens does
 * nothing (seen 2026-11-11), so Apply is pressed again, up to 3 times, while nothing opened.
 */
export async function wfStart(): Promise<WfState & { presses: number }> {
  const button = () => applyButtons().find((b) => /^apply( now)?$/i.test(clean(b.textContent)) && !(b as HTMLButtonElement).disabled) ?? null;
  for (let i = 0; i < 25 && !button() && wfState().page === 'unknown'; i += 1) await sleep(400);
  let presses = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (wfState().page !== 'job') break;
    const b = button();
    if (!b) break;
    b.scrollIntoView({ block: 'center' });
    b.click();
    presses += 1;
    // The modal opens a moment before its questions and "Send application" render (seen 2026-11-11: read as
    // 'unknown' right after the click): wait for the form itself.
    for (let i = 0; i < 25; i += 1) {
      await sleep(400);
      const page = wfState().page;
      if (page === 'form' || page === 'applied' || page === 'closed') break;
      if (page === 'job' && i >= 8 && !modal()) break;
    }
    if (modal()) break;
  }
  // Let the form's questions render.
  for (let i = 0; i < 5 && wfState().page === 'form'; i += 1) await sleep(300);
  return { ...wfState(), presses };
}

/** Press "Send application" and wait for the form to close (sent) or show errors. */
export async function wfSend(): Promise<WfState & { sent: boolean }> {
  const m = modal();
  const send = m?.querySelector<HTMLButtonElement>(SUBMIT);
  if (!send || !shown(send)) return { ...wfState(), sent: false };
  if (send.disabled) return { ...wfState(), errors: ['"Send application" is disabled'], sent: false };
  send.click();
  for (let i = 0; i < 50; i += 1) {
    await sleep(400);
    const s = wfState();
    if (s.page === 'applied') return { ...s, sent: true };
    if (s.page === 'form' && s.errors.length && i >= 3) return { ...s, sent: false };
    // The form closed (or its form part went away) with no errors: Wellfound took the application.
    if (!modal() || !modal()?.querySelector(SUBMIT)) {
      for (let j = 0; j < 5 && !appliedSignal(); j += 1) await sleep(400);
      const signal = appliedSignal();
      return { ...wfState(), page: 'applied', errors: [], note: signal || 'the application form closed after "Send application" with no errors', sent: true };
    }
  }
  return { ...wfState(), sent: false };
}

export function handleWellfoundMessage(message: { type: string }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => {
    p.then((r) => sendResponse({ ok: true, ...(r as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e).slice(0, 200) }));
    return true;
  };
  switch (message.type) {
    case 'WF_STATE': return reply(Promise.resolve(wfState()));
    case 'WF_START': return reply(wfStart());
    case 'WF_SEND': return reply(wfSend());
    default: return false;
  }
}
