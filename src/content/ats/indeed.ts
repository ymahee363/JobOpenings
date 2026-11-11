/**
 * Indeed's own applier, in the page (Indeed Apply, the native "Apply now" flow).
 *
 * Seen on in.indeed.com/viewjob?jk=cd52f44a98c04b21 (2026-11-06, signed in, nothing submitted):
 *  - the job page's "Apply now" is `a[data-testid="viewjob-indeed-apply"]`, a link to smartapply.indeed.com; jobs
 *    without it apply on the company site (the general flow follows that link);
 *  - SmartApply is one step per page under /beta/indeedapply/form/<module>/…: resume-selection-module (radios
 *    `input[name="resume-selection"]`, your Indeed resume already ticked), questions-module/questions/<n> (employer
 *    questions, `q_<hash>` boxes and radios), then contact, experience or cover letter steps on some jobs, a review
 *    step with "Submit your application", and /post-apply once sent;
 *  - every step has "Continue" (its data-testid is "continue-button" or a hash, so it is found by its text) and
 *    "Save and close".
 *
 * Messages (from src/shared/ats/indeed-flow.ts): IN_STATE, IN_START, IN_RESUME, IN_CONTINUE, IN_SUBMIT.
 */

export interface InState {
  page: 'job' | 'external' | 'closed' | 'step' | 'review' | 'submitted' | 'unknown';
  /** The SmartApply step, e.g. "questions-module/questions/1"; "" off SmartApply. */
  step: string;
  errors: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const visible = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const SUBMITTED = /your application has been submitted|application (was )?sent|you('ve| have) applied|application submitted/i;

const button = (re: RegExp) => [...document.querySelectorAll<HTMLElement>('button, a[role="button"]')].find((b) => visible(b) && re.test(text(b) || b.getAttribute('aria-label') || ''));
const continueButton = () => button(/^continue$/i);
const submitButton = () => button(/^submit( your)? application$/i);
const applyNow = () => document.querySelector<HTMLElement>('[data-testid="viewjob-indeed-apply"], #indeedApplyButton');
const stepOf = () => /\/form\/(.+)$/.exec(location.pathname)?.[1] ?? '';

export function inState(): InState {
  const errors = [...new Set([...document.querySelectorAll<HTMLElement>('[role="alert"], [id$="-error"], [class*="ErrorMessage"], [data-testid*="error" i]')]
    .filter(visible).map(text).filter((t) => t && t.length < 200))].slice(0, 10);
  const base = { step: stepOf(), errors };
  if (/smartapply\.indeed\.com$/i.test(location.hostname)) {
    if (/post-apply/i.test(location.pathname) || (SUBMITTED.test(document.body?.innerText.slice(0, 4000) ?? '') && !continueButton() && !submitButton())) return { ...base, page: 'submitted' };
    if (submitButton()) return { ...base, page: 'review' };
    if (continueButton()) return { ...base, page: 'step' };
    return { ...base, page: 'unknown' };
  }
  if (visible(applyNow())) return { ...base, page: 'job' };
  // An expired job: no Apply button, an alert "This job has expired on Indeed" (2026-11-11, jk=fddbd84641b96aed and
  // jk=53949a43a0d8b6a3 were reported as "no application step found (unknown)").
  if ([...document.querySelectorAll<HTMLElement>('[data-testid="alert"], [role="alert"], main, body')].some((e) => visible(e) && /this job has expired on indeed|this job is no longer available/i.test(text(e).slice(0, 3000)))) return { ...base, page: 'closed' };
  if (button(/apply on company site/i) || [...document.querySelectorAll('a')].some((a) => visible(a) && /apply on company site/i.test(text(a)))) return { ...base, page: 'external' };
  return { ...base, page: 'unknown' };
}

/** Wait for the step to change (SmartApply moves without a page load), up to `ms`. */
async function moved(from: string, ms = 12_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 300) {
    await sleep(300);
    const s = inState();
    if (s.step !== from || s.page === 'submitted') return true;
    if (s.errors.length && t > 1500) return false;
  }
  return false;
}

export async function inStart(): Promise<InState> {
  applyNow()?.click();
  await sleep(1500);
  return inState();
}

/** On the resume step: keep the ticked resume, else tick the one named like yours, else the first. */
export function inResume(name: string): { ok: boolean; picked: string } {
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="resume-selection"], input[type="radio"]')].filter((r) => r.getClientRects().length > 0 || visible(r.closest('label')));
  const label = (r: HTMLInputElement) => text(r.labels?.[0] ?? r.closest('label'));
  const ticked = radios.find((r) => r.checked);
  if (ticked) return { ok: true, picked: label(ticked) };
  const want = name.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const pick = radios.find((r) => want && label(r).toLowerCase().includes(want)) ?? radios[0];
  if (!pick) return { ok: false, picked: '' };
  (pick.labels?.[0] ?? pick).click();
  return { ok: pick.checked, picked: label(pick) };
}

/**
 * Supporting documents: the Cover letter section's "Add" button (its text is just "Add"; user, 2026-11-06). Clicking
 * it brings in your saved cover letter text. Does nothing when a cover letter box is already open or filled.
 */
export async function inCoverLetter(): Promise<{ clicked: boolean; why: string }> {
  const isCover = (el: Element | null) => /cover ?letter/i.test(text(el) || el?.getAttribute('aria-label') || '');
  const open = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((t) => visible(t) && (isCover(t.labels?.[0] ?? null) || /cover/i.test(t.name + t.id)));
  if (open) return { clicked: false, why: open.value.trim() ? 'cover letter already filled' : 'cover letter box already open' };
  const adds = [...document.querySelectorAll<HTMLElement>('button, a, [role="button"]')].filter((b) => visible(b));
  // "Add cover letter" by its own words or label, else an "Add" inside the section headed "Cover letter".
  let btn = adds.find((b) => /^\+?\s*(add|write)( a| your)? cover ?letter$/i.test(text(b) || b.getAttribute('aria-label') || ''))
    ?? adds.find((b) => /add/i.test(b.getAttribute('aria-label') ?? '') && /cover/i.test(b.getAttribute('aria-label') ?? ''));
  if (!btn) {
    btn = adds.find((b) => {
      if (!/^\+?\s*add$/i.test(text(b))) return false;
      // Walk up a few levels: the section holding this "Add" must name the cover letter, and not also a resume slot.
      let el: HTMLElement | null = b.parentElement;
      for (let i = 0; i < 5 && el; i += 1, el = el.parentElement) {
        const t = text(el);
        if (/cover ?letter/i.test(t)) return !/\bresume\b|\bcv\b/i.test(t) || t.length < 120;
      }
      return false;
    });
  }
  if (!btn) return { clicked: false, why: 'no cover letter Add button' };
  btn.scrollIntoView({ block: 'center' });
  btn.click();
  await sleep(1200);
  return { clicked: true, why: text(btn) || btn.getAttribute('aria-label') || 'Add' };
}

export async function inContinue(): Promise<InState & { moved: boolean }> {
  const from = stepOf();
  const b = continueButton();
  if (!b) return { ...inState(), moved: false };
  b.scrollIntoView({ block: 'center' });
  b.click();
  const ok = await moved(from);
  return { ...inState(), moved: ok };
}

export async function inSubmit(): Promise<InState & { moved: boolean }> {
  const from = stepOf();
  const b = submitButton();
  if (!b) return { ...inState(), moved: false };
  b.scrollIntoView({ block: 'center' });
  b.click();
  const ok = await moved(from, 20_000);
  return { ...inState(), moved: ok };
}

export function handleIndeedMessage(message: { type: string; name?: string }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => {
    p.then((r) => sendResponse({ ok: true, ...(r as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e).slice(0, 200) }));
    return true;
  };
  switch (message.type) {
    case 'IN_STATE': return reply(Promise.resolve(inState()));
    case 'IN_START': return reply(inStart());
    case 'IN_RESUME': return reply(Promise.resolve(inResume(String(message.name ?? ''))));
    case 'IN_CONTINUE': return reply(inContinue());
    case 'IN_COVER': return reply(inCoverLetter());
    case 'IN_SUBMIT': return reply(inSubmit());
    default: return false;
  }
}
