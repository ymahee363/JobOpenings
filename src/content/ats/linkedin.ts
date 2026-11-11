/**
 * LinkedIn Easy Apply's applier, in the page (www.linkedin.com/jobs/view/<id>). Easy Apply only: a job that applies
 * on the company's site is left alone (user, 2026-11-10: "native, not for any company site").
 *
 * Seen on www.linkedin.com/jobs/view/4488137195 (2026-11-10, signed in, nothing submitted):
 *  - class names are generated ("igtlxk …"), so everything is found by text, aria-label and roles;
 *  - the job page's button has aria-label "Easy Apply to this job";
 *  - the form opens in a native <dialog data-testid="dialog"> headed "Apply to <Company>" in the page itself (the
 *    `/preload/` iframe only holds the top bar). It can be one scrolling page (contact info, resume, questions,
 *    "Submit application") or several steps with "Next" / "Review";
 *  - resumes are radios whose aria-label is the file name ("Mahendra_IIT_Guwahati_Resume.pdf"), newest first;
 *  - "Mark job as a top choice" (Premium) is a checkbox that stays unticked.
 *
 * Messages (from src/shared/ats/linkedin-flow.ts): LI_STATE, LI_START, LI_RESUME, LI_NEXT, LI_SUBMIT.
 */

export interface LiState {
  page: 'job' | 'step' | 'review' | 'submitted' | 'closed' | 'external' | 'unknown';
  /** What the dialog shows (its headings), to tell steps apart. */
  step: string;
  errors: string[];
  /** LinkedIn's own success line once applied, e.g. "Application submitted now". */
  message?: string;
  /** A company-site job: where its "Apply" leads (the company's own page, unwrapped from LinkedIn's redirect). */
  externalUrl?: string;
}

/**
 * Where a company-site job's "Apply" leads. Seen 2026-11-11 (Razorpay, jobs/view/4487990883): an
 * `a[aria-label="Apply on company website"][target=_blank]` to `linkedin.com/safety/go/?url=<company page>&urlhash=…`,
 * here job-boards.greenhouse.io. The company page itself is returned, so the run can open it in the same tab (no new
 * tab, no "leaving LinkedIn" page). Only http(s) addresses off linkedin.com.
 */
export function companyApplyUrl(href: string): string | null {
  try {
    let u = new URL(href, location.href);
    if (/(^|\.)linkedin\.com$/i.test(u.hostname)) {
      const inner = u.searchParams.get('url');
      if (!inner) return null;
      u = new URL(inner);
    }
    return /^https?:$/.test(u.protocol) && !/(^|\.)linkedin\.com$/i.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function externalApplyLink(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('button, a')].find((b) => shown(b) && (/^apply( on company website)?$/i.test(text(b)) || /^apply (to .* )?on company website/i.test(b.getAttribute('aria-label') ?? ''))) ?? null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const shown = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const SENT = /your application was sent|application (was )?sent|application submitted/i;

function dialog(): HTMLElement | null {
  const native = [...document.querySelectorAll<HTMLElement>('dialog[data-testid="dialog"], dialog[open]')].find((d) => shown(d) && /apply to |application/i.test(text(d).slice(0, 400)));
  if (native) return native;
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => shown(d) && /apply to |application/i.test(text(d).slice(0, 400))) ?? null;
}

const buttonIn = (root: ParentNode, re: RegExp) => [...root.querySelectorAll<HTMLElement>('button')].find((b) => shown(b) && !(b as HTMLButtonElement).disabled && re.test(text(b) || b.getAttribute('aria-label') || ''));
const easyApply = () => [...document.querySelectorAll<HTMLElement>('button, a')].find((b) => shown(b) && /^easy apply to /i.test(b.getAttribute('aria-label') ?? ''))
  ?? [...document.querySelectorAll<HTMLElement>('button')].find((b) => shown(b) && /^easy apply$/i.test(text(b)));
const submitButton = (d: ParentNode) => buttonIn(d, /^submit application$/i);
const nextButton = (d: ParentNode) => buttonIn(d, /^(next|review|continue( to next step)?|review your application)$/i);

/** The job's location from its top card ("European Union · 4 days ago · Over 100 applicants"), or "". */
export function liLocation(): string {
  const line = [...document.querySelectorAll<HTMLElement>('main p, main span, main div')]
    .map(text).filter((s) => /·\s*(reposted\s+)?\d+\s+\w+\s+ago/i.test(s)).sort((a, b) => a.length - b.length)[0] ?? '';
  return line.split('·')[0]!.trim().slice(0, 100);
}

export function liState(): LiState {
  const d = dialog();
  if (d) {
    // LinkedIn's field errors ("This field is required") are plain leaf text with generated classes (2026-11-10).
    // A numbers-only box rejects "5 years" with "Invalid input" in its helper text (Orbit Verify, 2026-11-11): read
    // it, so the run fixes the answer instead of stopping as "stuck" with no error.
    const leaf = [...d.querySelectorAll<HTMLElement>('p, span, div')].filter((e) => !e.children.length && /^(this field is required|invalid input|please (enter|select|make)|enter a (valid|whole|decimal)|.*must be (a|an|between|less|more|greater))/i.test(text(e)));
    const errors = [...new Set([...d.querySelectorAll<HTMLElement>('[role="alert"], [aria-live="assertive"], [class*="error" i], [id^="error-message"]'), ...leaf].filter(shown).map(text).filter((t) => t && t.length < 200))].slice(0, 8);
    // Every step is headed "Apply to <Company>": the progress and the step's own labels tell steps apart (2026-11-10).
    const progress = d.querySelector('progress, [role="progressbar"]');
    const pct = progress?.getAttribute('aria-valuenow') ?? progress?.getAttribute('value') ?? (text(d).match(/\b\d{1,3}%/) ?? [''])[0];
    const labels = [...d.querySelectorAll('h3, label, legend')].map(text).filter(Boolean).slice(0, 4).join(' | ');
    const step = `${pct ? `${pct} ` : ''}${labels || [...d.querySelectorAll('h2')].map(text).join(' | ')}`.slice(0, 200);
    if (SENT.test(text(d).slice(0, 600)) && !submitButton(d)) return { page: 'submitted', step, errors: [], message: (text(d).match(SENT) ?? [''])[0] };
    if (submitButton(d)) return { page: 'review', step, errors };
    if (nextButton(d)) return { page: 'step', step, errors };
    return { page: 'unknown', step, errors };
  }
  // A closed job: "No longer accepting applications" where Easy Apply was (2026-11-10, jobs/view/4488169223).
  const closed = [...document.querySelectorAll<HTMLElement>('main p, main span, main div')].find((e) => !e.children.length && shown(e) && /^(no longer|not currently) accepting applications$/i.test(text(e)));
  if (closed && !easyApply()) return { page: 'closed', step: '', errors: [], message: text(closed) };
  if (easyApply()) return { page: 'job', step: '', errors: [] };
  // Already applied: LinkedIn shows "Applied … ago" / "Application submitted" where Easy Apply was.
  // After Submit the dialog closes and the job shows "Application status · Application submitted · now" (2026-11-10).
  const done = text(document.querySelector('main')).slice(0, 4000).match(/application submitted(?: (?:now|\d+ \w+ ago))?|\bapplied \d+ \w+ ago\b/i);
  if (done) return { page: 'submitted', step: '', errors: [], message: done[0] };
  // A company-site job: "Apply" that leaves LinkedIn.
  const link = externalApplyLink();
  if (link) {
    const href = link instanceof HTMLAnchorElement ? link.href : '';
    return { page: 'external', step: '', errors: [], externalUrl: (href && companyApplyUrl(href)) || undefined };
  }
  return { page: 'unknown', step: '', errors: [] };
}

export async function liStart(): Promise<LiState> {
  // The page can show Easy Apply before LinkedIn's script listens to it: a press then does nothing (2026-11-10,
  // Jobgether: "the Easy Apply form did not open (job)"). Wait for the button, press, and press again (up to 3
  // times) while no dialog opened. The dialog opens empty and fills in a moment later (17a): wait for its buttons.
  for (let i = 0; i < 25 && !easyApply() && !dialog(); i += 1) await sleep(400);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!dialog()) easyApply()?.click();
    for (let i = 0; i < 25; i += 1) {
      await sleep(400);
      const s = liState();
      if (s.page === 'step' || s.page === 'review' || s.page === 'submitted' || s.page === 'closed') return s;
    }
  }
  return liState();
}

const norm = (s: string) => s.toLowerCase().replace(/\.(pdf|docx?)$/i, '').replace(/[^a-z0-9]+/g, '');

/**
 * Pick your resume: the first (newest) one whose file name matches yours, ignoring case, underscores and the
 * extension (user, 2026-11-10: "Mahendra_IIT_Guwahati_Resume", the 2nd in the list). Leaves the choice alone when
 * no resume list is shown or none matches.
 */
export function liResume(name: string): { ok: boolean; picked: string; why: string } {
  const d = dialog();
  if (!d) return { ok: false, picked: '', why: 'no dialog' };
  const radios = [...d.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) => /\.(pdf|docx?)$/i.test(r.getAttribute('aria-label') ?? ''));
  if (!radios.length) return { ok: true, picked: '', why: 'no resume list on this step' };
  const want = norm(name);
  const pick = want ? radios.find((r) => norm(r.getAttribute('aria-label') ?? '') === want) : undefined;
  if (!pick) return { ok: false, picked: radios.find((r) => r.checked)?.getAttribute('aria-label') ?? '', why: `no resume named like ${name}` };
  if (!pick.checked) (pick.labels?.[0] ?? pick).click();
  if (!pick.checked) pick.click();
  return { ok: pick.checked, picked: `${pick.getAttribute('aria-label')} (#${radios.indexOf(pick) + 1})`, why: '' };
}

/** "Top choice" (Premium) and "Follow <company>" are not questions: never answered. */
export function liSkipLabel(label: string): boolean {
  return /top choice|follow .* to stay up to date|^follow\b/i.test(label);
}

async function moved(from: string, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 300) {
    await sleep(300);
    const s = liState();
    if (s.page === 'submitted' || s.step !== from) return true;
    if (s.errors.length && t > 1500) return false;
  }
  return false;
}

export async function liNext(): Promise<LiState & { moved: boolean }> {
  const d = dialog();
  const b = d && nextButton(d);
  if (!b) return { ...liState(), moved: false };
  const from = liState().step;
  b.scrollIntoView({ block: 'center' });
  b.click();
  const ok = await moved(from, 10_000);
  return { ...liState(), moved: ok };
}

export async function liSubmit(): Promise<LiState & { moved: boolean }> {
  const d = dialog();
  const b = d && submitButton(d);
  if (!b) return { ...liState(), moved: false };
  b.scrollIntoView({ block: 'center' });
  b.click();
  for (let i = 0; i < 50; i += 1) {
    await sleep(400);
    const s = liState();
    if (s.page === 'submitted') return { ...s, moved: true };
    if (s.errors.length && i > 4) return { ...s, moved: false };
  }
  return { ...liState(), moved: false };
}

export function handleLinkedinMessage(message: { type: string; name?: string }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => {
    p.then((r) => sendResponse({ ok: true, ...(r as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e).slice(0, 200) }));
    return true;
  };
  switch (message.type) {
    case 'LI_STATE': return reply(Promise.resolve(liState()));
    case 'LI_LOCATION': return reply(Promise.resolve({ location: liLocation() }));
    case 'LI_START': return reply(liStart());
    case 'LI_RESUME': return reply(Promise.resolve(liResume(String(message.name ?? ''))));
    case 'LI_NEXT': return reply(liNext());
    case 'LI_SUBMIT': return reply(liSubmit());
    // Open the company's apply page in this tab (a company-site job; 2026-11-11).
    case 'LI_GO_EXTERNAL': {
      const url = liState().externalUrl;
      if (url) setTimeout(() => location.assign(url), 50);
      return reply(Promise.resolve({ url: url ?? null }));
    }
    default: return false;
  }
}
