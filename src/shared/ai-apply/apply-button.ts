/**
 * Finding the control that opens a job's application form, by meaning rather than one exact label.
 *
 * Career sites name it differently: "Apply", "Apply now", "Apply on company site", "Start your application",
 * "Submit resume", "I'm interested". Every visible button or link is scored on its text, aria-label/title, its
 * id/class/test ids, and where a link goes (an ATS host such as *.myworkdayjobs.com, or an /apply path). Look-alikes
 * score nothing: "Apply filters", "Applied", "Job alerts", "Sign in", "Share this job".
 *
 * When nothing scores high enough and the page has no form either, the flow (src/shared/ai-apply/flow.ts) shows the
 * page's clickables to the AI as a choice (`applyChoiceField`) and presses the one it picks.
 *
 * Also here: the "side form" check. A job page can carry a form that is not the application (Target's job-alert
 * sign-up: first name, last name, email, location; seen 2026-11-06). Counted as the form, it made the flow skip the
 * Apply button and fill the alert sign-up instead, so the form engine leaves such fields out.
 *
 * Pure functions over plain descriptors, so the scoring is unit tested without a DOM.
 */
import type { Answer, FormField } from './types';

export interface ApplyCandidate {
  /** Visible text (innerText, or an input's value). */
  text: string;
  /** aria-label and title. */
  label?: string;
  /** id, class, name, data-automation-id, data-testid, joined. */
  attrs?: string;
  /** A link's href, resolved. */
  href?: string;
}

/** A candidate at or above this score is the Apply control without asking the AI. */
export const APPLY_THRESHOLD = 7;

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Never the way in to an application, whatever else the control says. */
const NEGATIVE =
  /\bapplied\b|already applied|application (sent|submitted|received)|apply (the )?(filters?|changes|coupon|promo|code|discount|selection)|\bfilters?\b|job alerts?|get alerts|create (an )?alert|newsletter|subscribe|talent (community|network|pool)|\bshare\b|save (this )?job|saved jobs|similar jobs|refer (a )?friend|\brefer\b|referral|\bsign ?in\b|\blog ?in\b|\bsign ?up\b|create (an )?account|forgot|search|cookie|privacy|terms|how to apply|application status|withdraw|with linkedin|with indeed|with google|with facebook/;

/** Wordings that open the application. Matched on the whole text, or at its start/end. */
const STRONG = [
  'apply', 'apply now', 'apply here', 'apply today', 'apply online', 'easy apply', 'quick apply', '1-click apply',
  'one click apply', 'apply for this job', 'apply for this position', 'apply for this role', 'apply to this job',
  'apply for job', 'apply to job', 'apply for the job', 'apply on company site', 'apply on company website',
  'apply on employer site', 'apply externally', 'continue to apply', 'start application', 'start applying',
  'start your application', 'begin application', 'begin your application', 'continue application',
  'continue your application', 'submit application', 'submit your application', 'submit resume', 'submit your resume',
  'submit cv', 'submit your cv', 'send application', 'send your application', 'send resume', 'send cv',
  "i'm interested", 'i am interested', 'express interest', 'apply for position', 'apply to position',
];

/** Career-site and ATS hosts: a link there from a job page is the way in. */
const ATS_HOST =
  /myworkdayjobs\.com|myworkdaysite\.com|greenhouse\.io|lever\.co|smartrecruiters\.com|icims\.com|taleo\.net|successfactors\.(com|eu)|ashbyhq\.com|workable\.com|jobvite\.com|oraclecloud\.com|bamboohr\.com|recruitee\.com|breezy\.hr|jazzhr\.com|applytojob\.com|keka\.com|darwinbox\.in|zohorecruit\.|freshteam\.com|personio\.(de|com)|teamtailor\.com|avature\.net|eightfold\.ai|phenompeople\.com/i;

/** How much a control looks like the one that opens the application. Below 0: never. */
export function scoreApplyCandidate(c: ApplyCandidate): number {
  const text = norm(c.text);
  const label = norm(c.label);
  const attrs = norm(c.attrs);
  const href = c.href ?? '';
  const shown = text || label;
  if (!shown && !attrs) return -1;
  if (NEGATIVE.test(shown)) return -1;
  // "applied" in an id/class marks the after-state; "apply-filter" and the like are list controls.
  if (/applied|apply-?filter|filter-?apply/.test(attrs)) return -1;
  if (/^(mailto|tel|javascript:void)/i.test(href) && !/apply/.test(shown)) return -1;
  // A referral link ("Refer" next to Apply on iCIMS career sites, N-able 2026-11-06) never applies.
  if (/referral|\/refer\b/i.test(href)) return -1;

  let score = 0;
  const words = shown.split(' ').filter(Boolean).length;
  const strongMatch = (t: string) => STRONG.some((p) => t === p || t.startsWith(`${p} `) || t.startsWith(`${p}:`) || t.endsWith(` ${p}`));
  if (strongMatch(text) || (!text && strongMatch(label))) score += 10;
  else if (strongMatch(label)) score += 8;
  else if (/\bapply\b/.test(shown) && words <= 6) score += 7;
  else if (/\b(start|begin|continue)\b.*\bapplication\b/.test(shown) && words <= 6) score += 7;
  // "Begin Your N-able Journey Here" (N-able's Apply, 2026-11-06): starting your journey or applying there.
  else if (/\b(start|begin|launch)\b.*\b(journey|applying)\b/.test(shown) && words <= 8) score += 7;

  // An id/class naming the apply action ("link-apply", "apply-btn", "btn-apply"): the site's own word for it.
  if (/(^|[\s_-])apply([\s_-]|$)|apply-?(btn|button|link|now)|btn-?apply/.test(attrs)) score += 5;
  else if (/apply|application/.test(attrs)) score += 3;
  try {
    const u = new URL(href);
    if (ATS_HOST.test(u.hostname)) score += 3;
    if (/\/apply\b|[?&]apply\b|\/application\b/i.test(u.pathname + u.search)) score += 3;
  } catch {
    // no link, or not an absolute one
  }
  // Prose that mentions applying ("Read how to apply for jobs at …"): a link in a paragraph, not the button.
  if (words > 8) score -= 6;
  return score;
}

/** Index of the best candidate scoring at least APPLY_THRESHOLD, or -1. Ties keep the earlier (page order). */
export function pickApplyCandidate(cands: ApplyCandidate[]): number {
  let best = -1;
  let bestScore = APPLY_THRESHOLD - 1;
  cands.forEach((c, i) => {
    const s = scoreApplyCandidate(c);
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  });
  return best;
}

/**
 * The Apply control only when it is a clear winner: -1 when nothing reaches APPLY_THRESHOLD, or when a second,
 * different control (other text and other link) scores within 3 of the best, so the AI decides between them from the
 * full list instead of the scorer guessing.
 */
export function pickClearApplyCandidate(cands: ApplyCandidate[]): number {
  const scored = cands.map((c, i) => ({ i, s: scoreApplyCandidate(c) })).filter((x) => x.s >= APPLY_THRESHOLD).sort((a, b) => b.s - a.s || a.i - b.i);
  if (!scored.length) return -1;
  const best = scored[0]!;
  const same = (a: ApplyCandidate, b: ApplyCandidate) => norm(a.text || a.label) === norm(b.text || b.label) || (!!a.href && a.href === b.href);
  const rival = scored.slice(1).find((x) => best.s - x.s < 3 && !same(cands[x.i]!, cands[best.i]!));
  return rival ? -1 : best.i;
}

/**
 * Names of a field's surroundings (its own id/name, its ancestors' ids/classes/aria-labels, a heading) that mark a
 * form other than the application: job alerts, newsletters, a talent community, "email this job to a friend".
 */
const SIDE_FORM =
  /job[-_ ]?alerts?|alert[-_ ]?sign[-_ ]?up|create[-_ ]?alert|newsletter|subscri(be|ption)|talent[-_ ]?(community|network|pool)|join[-_ ]?our[-_ ]?(talent|community|network)|e?mail[-_ ]?(this|a)[-_ ]?job|share[-_ ]?(this[-_ ]?)?job|send[-_ ]?to[-_ ]?(a[-_ ]?)?friend|refer[-_ ]?a[-_ ]?friend|get[-_ ]?notified|notify[-_ ]?me|stay[-_ ]?(connected|in[-_ ]?touch)|feedback[-_ ]?form|chat[-_ ]?widget/i;

export function isSideFormContext(context: string): boolean {
  return SIDE_FORM.test(context);
}

/** The AI's choice of control: a dropdown question over the page's clickables, the last option "None of these". */
export const APPLY_CHOICE_ID = '__apply_control';
export const APPLY_CHOICE_NONE = 'None of these';

export function applyChoiceLabel(c: ApplyCandidate, i: number): string {
  const shown = (c.text || c.label || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(no text)';
  let where = '';
  try {
    const u = new URL(c.href ?? '');
    where = ` -> ${u.hostname}${u.pathname.length > 1 ? u.pathname.slice(0, 50) : ''}`;
  } catch {
    // a button, not a link
  }
  return `${i + 1}. ${shown}${where}`;
}

export function applyChoiceField(cands: ApplyCandidate[]): FormField {
  return {
    id: APPLY_CHOICE_ID,
    label:
      'This is a job posting page. Which of these buttons or links opens the application form for this job (the one a candidate presses to apply)? ' +
      `Pick "${APPLY_CHOICE_NONE}" if none of them starts an application (sign-in, search, sharing, alerts and navigation do not).`,
    type: 'select',
    required: true,
    options: [...cands.map(applyChoiceLabel), APPLY_CHOICE_NONE],
    current_value: '',
  };
}

/** The candidate index the AI chose, or -1 for none or an answer that is not one of the options. */
export function parseApplyChoice(answers: Answer[], count: number): number {
  const a = answers.find((x) => x.field_id === APPLY_CHOICE_ID);
  const raw = (a?.answer ?? '').trim();
  if (!raw || a?.needs_user_input || raw.toLowerCase().startsWith('none')) return -1;
  const m = /^(\d+)\./.exec(raw) ?? /^(\d+)$/.exec(raw);
  if (!m) return -1;
  const i = Number(m[1]) - 1;
  return i >= 0 && i < count ? i : -1;
}

/**
 * Do these fields look like a job application, or like some other form on a posting (a job search, a location
 * picker)? An application asks who you are or about your work: name, email, phone, resume, experience, salary.
 * Used only when the page also has an Apply control: then fields that are not an application do not stop the flow
 * from pressing it.
 */
const APPLICATION_FIELD =
  /resume|\bcv\b|cover ?letter|first ?name|last ?name|full ?name|surname|given name|^name\b|\bemail|e-mail|phone|mobile|linkedin|portfolio|experience|employer|notice|salary|ctc|compensation|authori[sz]|sponsor|visa|education|degree|university|college|gender|date of birth|nationality|why (do )?you|cover|current (company|title|role)/i;

export function looksLikeApplicationForm(fields: Array<Pick<FormField, 'label' | 'type'>>): boolean {
  return fields.some((f) => f.type === 'file' || APPLICATION_FIELD.test(f.label ?? ''));
}
