/**
 * What a job page shows, for the auto-apply agent (PRD-auto-apply section 7), on the sites it applies on: iimjobs,
 * Instahyre, Naukri and Wellfound. Every selector and text pattern the agent relies on lives in this file, so a site change touches one
 * place.
 *
 * iimjobs:
 * Confirmed read-only on www.iimjobs.com on 2026-10-27 (no Apply was pressed):
 *  - Job pages are `/j/<slug>-<id>` (Next.js, page `/j/[jobslug]`). The apply control is
 *    `button[data-track="apply-job"]` (a MUI button, shown twice: header and floating). It reads "Apply" when open
 *    and "Applied" (disabled) once applied.
 *  - `__NEXT_DATA__` → `props.pageProps.initialState.botDetection.captchaShown` flags a captcha, and
 *    `initialState.app.redirectedFromExpiredJD` flags a closed job that redirected.
 * Confirmed from a real apply on 2026-10-27: after a one-click Apply, iimjobs leaves the job page for
 * `/job/applied?ref=jd&jobId=<id>` (title "Job Applied", text "Your application has been submitted successfully!").
 * A form asking for details is treated as "Needs me" and not submitted unless form filling is on.
 *
 * Instahyre, confirmed read-only on www.instahyre.com on 2026-10-27 (no Apply was pressed):
 *  - Job pages are `/job-<id>-<slug>/` (AngularJS). The apply control is `button[ng-click="submitChoice(opp, true)"]`
 *    reading "Apply now"; once applied it is a disabled `button.btn-filled.btn-md` reading "Application sent!",
 *    with "on <date>" beside it. What follows the click is not yet seen: anything but "Application sent!" is
 *    checked by reloading the page.
 *  - Seen on a real one-click apply (2026-10-27, an "outside your matches" job): within 0.3 s the button turns to a
 *    disabled "Application sent!" ("on <date>" beside it) and a toast says "Application sent to <company>!". No
 *    pop-up, no page change.
 *  - From Instahyre's own `submitChoice` code (read 2026-10-27): a successful apply shows a toastr toast "Application
 *    sent to <company>" and may then open an "actively looking?" or "apply to similar jobs" pop-up. The toast is
 *    the success signal; the pop-ups come after it. Jobs outside your matches run `submitChoiceNonMatching()`
 *    instead, which is also one click: it sends the application and shows the same toast, with no confirmation.
 *
 * Naukri, confirmed read-only on www.naukri.com on 2026-10-27 (no Apply was pressed):
 *  - Job pages are `/job-listings-<slug>-<id>`. Easy Apply jobs show `button#apply-button` reading "Apply"; applied
 *    jobs show `span#already-applied` reading "Applied"; company-site jobs show `button#company-site-button`
 *    ("Apply on company site"), which the agent never presses. Naukri's follow-up questions open in a chatbot
 *    drawer, treated as a form asking for details.
 *
 * Wellfound, confirmed read-only on wellfound.com on 2026-10-27 (no Apply was pressed):
 *  - Job pages are `/jobs/<id>-<slug>`; the apply controls are `button[class*="applyButton"]` ("Apply", "Apply now").
 *    The nav link "Applied" (`a[data-test="ItemApplied"]`) is not one of them. The page data does not say whether
 *    you applied to the job shown, and the applied state of the button is not yet seen: anything unclear after a
 *    click is checked by reloading, and a click without a confirmed result is never repeated.
 *
 * The content script turns the live page into a `PageSnapshot`; everything here is pure so tests can use saved
 * snapshots.
 */

import type { Site } from '../types';

/** Sites with a one-click applier (the AI apply flow covers the others). */
export type AgentSite = 'iimjobs' | 'instahyre' | 'naukri' | 'wellfound';
export const AGENT_SITES: AgentSite[] = ['iimjobs', 'instahyre', 'naukri', 'wellfound'];

interface SitePage {
  name: string;
  origin: string;
  /** The apply control, in either state (open or applied). */
  applySelector: string;
  /** A job page path; group 1 is the job's ID on the site. */
  jobPathRe: RegExp;
  /** The page a successful apply moves to, when the site has one. */
  appliedPath: string | null;
  /** Prefix of the board's job IDs for this site (Naukri's are bare numbers). */
  idPrefix: string;
}

export const SITE_PAGES: Record<AgentSite, SitePage> = {
  iimjobs: {
    name: 'iimjobs',
    origin: 'https://www.iimjobs.com',
    applySelector: 'button[data-track="apply-job"]',
    // `/j/<slug>-<id>`, or `/j/<id>` (the link the parser builds when a job has no detail URL).
    jobPathRe: /^\/j\/(?:[^/]*-)?(\d+)\/?$/,
    appliedPath: '/job/applied',
    idPrefix: 'iimjobs-',
  },
  instahyre: {
    name: 'Instahyre',
    origin: 'https://www.instahyre.com',
    applySelector: 'button[ng-click="submitChoice(opp, true)"], button.btn-filled.btn-md',
    jobPathRe: /^\/job-(\d+)(?:-[^/]*)?\/?$/,
    appliedPath: null,
    idPrefix: 'instahyre-',
  },
  naukri: {
    name: 'Naukri',
    origin: 'https://www.naukri.com',
    applySelector: '#apply-button, #already-applied, #company-site-button',
    jobPathRe: /^\/job-listings-[^/]*?-(\d{6,})\/?$/,
    // Where Naukri goes after a successful Easy Apply (see `confirmedJobIds`).
    appliedPath: '/myapply/saveApply',
    idPrefix: '',
  },
  wellfound: {
    name: 'Wellfound',
    origin: 'https://wellfound.com',
    applySelector: 'button[class*="applyButton"]',
    jobPathRe: /^\/jobs\/(\d+)(?:-[^/]*)?\/?$/,
    appliedPath: null,
    idPrefix: 'wellfound-',
  },
};

/** Kept for the iimjobs-only callers and tests. */
export const APPLY_BUTTON_SELECTOR = SITE_PAGES.iimjobs.applySelector;
export const JOB_PATH_RE = SITE_PAGES.iimjobs.jobPathRe;
/**
 * MUI dialogs (iimjobs), Instahyre's own `.application-modal` pop-ups (hidden with `ng-hide` until shown), Bootstrap
 * modals, Naukri's chatbot drawer, plus anything that calls itself a dialog.
 */
export const DIALOG_SELECTOR = '[role="dialog"], .MuiDialog-root, .modal.in, .modal-dialog, [class*="chatbot_Drawer"], [class*="chatbot_drawer"], '
  + '.application-modal:not(.ng-hide)';

/**
 * Toast notifications. Instahyre's own (seen on a real apply, 2026-10-27): `#insta-toastr-container` >
 * `.insta-toastr-success` > `.insta-toastr-message` "Application sent to <company>!", for about 3 seconds.
 */
export const TOAST_SELECTOR = '#insta-toastr-container, [class*="insta-toastr"], #toast-container, .toast, .toast-success, [class*="toast-message"]';

/** The agent site a host belongs to, or null. */
export function agentSiteOfHost(hostname: string): AgentSite | null {
  for (const site of AGENT_SITES) if (new URL(SITE_PAGES[site].origin).hostname === hostname) return site;
  return null;
}

/** The site of a board job ID: `<site>-…` (`iimjobs-…`, `indeed-…`), or a bare Naukri number. */
export function siteOfJobId(jobId: string | undefined): Site | null {
  if (typeof jobId !== 'string') return null;
  for (const site of ['iimjobs', 'instahyre', 'wellfound', 'indeed', 'cutshort', 'foundit', 'linkedin'] as const) {
    if (jobId.startsWith(`${site}-`)) return site;
  }
  return /^\d{6,}$/.test(jobId) ? 'naukri' : null;
}

/** `<site>-<id>` for a job page path on that site, or null. */
export function jobIdFromPath(site: AgentSite, path: string): string | null {
  const m = SITE_PAGES[site].jobPathRe.exec(path);
  return m ? `${SITE_PAGES[site].idPrefix}${m[1]}` : null;
}

/** The site and job ID of a job page URL on an agent site (https only), or null. */
export function jobPageOf(raw: string): { site: AgentSite; jobId: string } | null {
  try {
    const url = new URL(raw);
    const site = url.protocol === 'https:' ? agentSiteOfHost(url.hostname) : null;
    const jobId = site ? jobIdFromPath(site, url.pathname) : null;
    return site && jobId ? { site, jobId } : null;
  } catch {
    return null;
  }
}

export interface PageButton {
  text: string;
  disabled: boolean;
}

export type FieldKind = 'text' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'other';

export interface DialogField {
  /** The question as shown: label, legend or placeholder. */
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Choices for select and radio fields. */
  options: string[];
}

export interface DialogSnapshot {
  title: string;
  fields: DialogField[];
  buttons: string[];
}

export interface PageSnapshot {
  /** Missing means iimjobs (snapshots saved before Instahyre support). */
  site?: AgentSite;
  path: string;
  title: string;
  /** The start of the page's visible text. */
  text: string;
  /** Text of toasts and the open dialog, where sites put "application sent" messages. */
  noticeText?: string;
  applyButtons: PageButton[];
  captchaShown: boolean;
  expiredRedirect: boolean;
  /** The first open dialog, if any. */
  dialog: DialogSnapshot | null;
}

export type PageVerdict = 'can_apply' | 'applied' | 'closed' | 'captcha' | 'logged_out' | 'external' | 'not_found';

const CAPTCHA_TEXT_RE = /verify (that )?you are (a )?human|are you a robot|captcha/i;
const CLOSED_TEXT_RE = /no longer (accepting|available|active)|job (has )?expired|this job (is|has been) closed|position (has been )?filled/i;
/** iimjobs and Naukri "Applied", Instahyre "Application sent!", Wellfound's likely wordings. */
const APPLIED_RE = /^(applied|application sent!?|you applied|application submitted|undo\s*·\s*\d+:\d{2})$/i;
const APPLY_RE = /^apply( now)?$/i;
const LOGIN_RE = /^(log ?in|sign ?in|register)\b.*apply|^login$/i;
const EXTERNAL_RE = /company('s)? (site|website)|apply (on|at) /i;

/** The iimjobs job ID in a job page path, or null. */
export function jobIdFromIimjobsPath(path: string): string | null {
  return jobIdFromPath('iimjobs', path);
}

/** The confirmation page iimjobs opens after a successful apply: `/job/applied?jobId=<id>`. */
export const APPLIED_PATH = SITE_PAGES.iimjobs.appliedPath!;

/** The job a confirmation URL confirms (`iimjobs-<id>`), or null when the URL is not a confirmation page. */
export function appliedConfirmationJobId(raw: string): string | null {
  return confirmedJobIds(raw)[0] ?? null;
}

/** Naukri's confirmation page after a successful Easy Apply (seen on a real apply, 2026-10-27). */
export const NAUKRI_APPLIED_PATH = SITE_PAGES.naukri.appliedPath!;

/**
 * The jobs a site's confirmation page says were applied to, as board job IDs; empty when the URL is not one.
 *  - iimjobs: `/job/applied?ref=jd&jobId=<id>`.
 *  - Naukri: `/myapply/saveApply?strJobsarr=[<id>]&applytype=single&…&multiApplyResp={"<id>":200}` (title "Apply
 *    Confirmation", text `Applied to "<title>"`). Only IDs whose response code is 200 count.
 */
/**
 * Naukri's answer on its "Apply Confirmation" page (/myapply/saveApply?…&multiApplyResp={"<jobId>":<code>}&jobTitle=…):
 * 'applied' only when this job's code is 200 (any 200 when `jobId` is not given); 'failed' when the page lists the job
 * (or any job) with another code; 'none' off that page. Naukri opens the same page when an apply fails, so the page
 * alone is never proof (user, 2026-11-10: failed jobs were moving to Applied). `message` is what the agent records.
 */
export function naukriApplyResult(raw: string, jobId?: string): { status: 'applied' | 'failed' | 'none'; message: string } {
  try {
    const url = new URL(raw);
    if (url.hostname !== 'www.naukri.com' || url.pathname.replace(/\/$/, '') !== NAUKRI_APPLIED_PATH) return { status: 'none', message: '' };
    const resp = JSON.parse(url.searchParams.get('multiApplyResp') ?? '{}') as Record<string, unknown>;
    const codes = Object.entries(resp).filter(([id]) => /^\d{6,}$/.test(id) && (!jobId || id === jobId));
    const title = url.searchParams.get('jobTitle') ?? '';
    const ok = codes.find(([, code]) => Number(code) === 200);
    if (ok) return { status: 'applied', message: `Naukri: Applied to "${title || 'the job'}" (response ${ok[1]} for job ${ok[0]})` };
    const shown = codes.map(([id, code]) => `${id}: ${String(code)}`).join(', ') || 'no response for this job';
    return { status: 'failed', message: `Naukri did not apply (${shown})` };
  } catch {
    return { status: 'none', message: '' };
  }
}

export function confirmedJobIds(raw: string): string[] {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return [];
    const path = url.pathname.replace(/\/$/, '');
    if (url.hostname === 'www.iimjobs.com' && path === APPLIED_PATH) {
      const id = url.searchParams.get('jobId');
      return id && /^\d+$/.test(id) ? [`iimjobs-${id}`] : [];
    }
    if (url.hostname === 'www.naukri.com' && path === NAUKRI_APPLIED_PATH) {
      const resp = JSON.parse(url.searchParams.get('multiApplyResp') ?? '{}') as Record<string, unknown>;
      return Object.entries(resp).filter(([id, code]) => /^\d{6,}$/.test(id) && Number(code) === 200).map(([id]) => id);
    }
    return [];
  } catch {
    return [];
  }
}

/** What the page lets the agent do, before any click. Anything not recognised is `not_found`: no click. */
export function classifyPage(s: PageSnapshot): PageVerdict {
  if (s.captchaShown || CAPTCHA_TEXT_RE.test(s.title)) return 'captcha';
  if (/^\/(login|signup)\b/i.test(s.path)) return 'logged_out';
  if (s.expiredRedirect || !SITE_PAGES[s.site ?? 'iimjobs'].jobPathRe.test(s.path) || CLOSED_TEXT_RE.test(s.text)) return 'closed';
  const texts = s.applyButtons.map((b) => b.text.trim());
  if (texts.some((t) => APPLIED_RE.test(t))) return 'applied';
  if (texts.some((t) => LOGIN_RE.test(t))) return 'logged_out';
  if (texts.some((t) => EXTERNAL_RE.test(t))) return 'external';
  if (s.applyButtons.some((b) => !b.disabled && APPLY_RE.test(b.text.trim()))) return 'can_apply';
  return 'not_found';
}

export type AfterClick = 'applied' | 'captcha' | 'dialog' | 'closed' | 'waiting';

/** What the page shows after pressing Apply (or submitting a dialog). */
export function classifyAfterClick(s: PageSnapshot): AfterClick {
  if (s.captchaShown || CAPTCHA_TEXT_RE.test(s.title) || (s.dialog && CAPTCHA_TEXT_RE.test(s.dialog.title))) return 'captcha';
  const appliedPath = SITE_PAGES[s.site ?? 'iimjobs'].appliedPath;
  if (appliedPath && s.path.replace(/\/$/, '') === appliedPath) return 'applied';
  if (s.applyButtons.some((b) => APPLIED_RE.test(b.text.trim()))) return 'applied';
  if (/successfully applied|applied successfully|application (has been )?(sent|submitted|received)|you have applied/i.test(s.noticeText ?? '')) return 'applied';
  if (s.dialog) return 'dialog';
  if (CLOSED_TEXT_RE.test(s.text)) return 'closed';
  return 'waiting';
}

/** Dialog buttons the agent may press to submit answers it has filled. Never upsells ("Buy", "Upgrade"). */
const SUBMIT_RE = /^(submit|apply|apply now|send|send application|confirm|continue|next|save (and|&) apply)$/i;

/** The one submit button in a dialog, or null when there is none or more than one. */
export function submitButtonOf(d: DialogSnapshot): string | null {
  const hits = d.buttons.map((b) => b.trim()).filter((b) => SUBMIT_RE.test(b));
  return new Set(hits.map((h) => h.toLowerCase())).size === 1 ? hits[0]! : null;
}
