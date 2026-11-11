/**
 * The AI apply flow: applies through any application form, on a job board or a company's own career site, using
 * your profile, the answer bank, form memory and the LLM backend. Ported from job-apply-ai-mvp's side-panel agent
 * (extension/src/sidepanel/ApplyView.tsx `runAgent`), made to run unattended from the service worker: where the MVP
 * paused for you, this ends the attempt as "Needs me" and keeps the questions so you can answer them once.
 *
 * Chrome comes in as `FlowDeps` (frames of the agent's tab, messages to the form engine in
 * src/content/form-engine.ts), so the whole flow is tested with a fake page.
 *
 * Modes:
 *  - `preview` (dry run): no click at all. Reads the form if one is visible and works out the answers.
 *  - `fill`: presses Apply, fills every page and presses Next/Continue, and stops at the final Submit, leaving the
 *    tab open for you to check and submit.
 *  - `submit`: as `fill`, then presses Submit and looks for a confirmation.
 * Fails closed: a required question with no answer, a login/signup wall, a captcha, validation errors it cannot fix
 * or a page that does not move all end the run before Submit.
 */
import { detectAts } from '../ats/detect';
import { runWorkdayApply } from '../ats/workday-flow';
import { runKekaApply, runZohoApply } from '../ats/zoho-flow';
import { isIndeedUrl, runIndeedApply } from '../ats/indeed-flow';
import { runLeverApply } from '../ats/lever-flow';
import { isNaukriJobUrl, runNaukriApply } from '../ats/naukri-flow';
import { isLinkedinJobUrl, runLinkedinApply } from '../ats/linkedin-flow';
import { isWellfoundJobUrl, runWellfoundApply } from '../ats/wellfound-flow';
import type { WorkdayPlan } from '../../content/ats/workday';
import { findAnswer } from '../auto-apply/answers';
import type { AnswerEntry } from '../auto-apply/config';
import type { ApplyReport } from '../auto-apply/runner';
import {
  directMapAnswer, educationEntryAnswer, enrichEntryFieldLabel, experienceEntryAnswer, findPendingQuestions, isAlreadyFilled,
  gpaFromProfile, gpaOption, isCoverLetterLabel, isGpaLabel, isJoinWhenQuestion, standingAnswer, isResumeLabel, isValidAgainstOptions, linkFitsLabel, nextDayAnswer, pageFingerprint, verifyAndCorrectAnswers,
} from './answer-rules';
import { applyChoiceField, looksLikeApplicationForm, parseApplyChoice, type ApplyCandidate } from './apply-button';
import { classifyField, directKindAnswer, normalizeForInput, withKindHint, type NormalizeContext } from './input-kinds';
import { planFix } from './error-fix';
import { reviewBeforeSubmit, type Finding, type ReviewedAnswer } from './pre-submit';
import { DEFAULT_INSTRUCTION, isAiLimitError, type GenerateAnswers } from './llm';
import { lookupRememberedAnswer, rememberAnswers, yourAnswer, yourFacts, type MemoryMap } from './memory';
import type { StoredResume } from './profile';
import type { Answer, CandidateProfile, FormData, FormField, FrameFormData } from './types';

export type FlowMode = 'preview' | 'fill' | 'submit';

/** Any reply from the form engine; it answers plain objects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EngineReply = any;

export interface FlowDeps {
  /** Frame IDs of the agent's tab, with the form engine injected in each. */
  frames(): Promise<number[]>;
  /** A message to the form engine in one frame. Rejects when the frame is gone or does not answer. */
  send(frameId: number, msg: Record<string, unknown>): Promise<EngineReply>;
  sleep(ms: number): Promise<void>;
  now(): number;
  profile: CandidateProfile;
  resume: StoredResume | null;
  coverLetter?: StoredResume | null;
  memory: MemoryMap;
  bank: AnswerEntry[];
  generate: GenerateAnswers;
  saveMemory(m: MemoryMap): Promise<void>;
  /** Re-read the kill switch right before a click: a reason to stop, or null. */
  mayClick(): Promise<string | null>;
  beforeClick?(): Promise<void>;
  /** After pressing Apply on a posting: the site may open the form in a new tab; the deps switch to it. */
  afterApplyClick?(): Promise<void>;
  status?(text: string): void;
  /** The tab's current URL, to pick a platform-specific applier (src/shared/ats/detect.ts). */
  currentUrl?(): Promise<string>;
  /** What the Workday applier fills (src/shared/ats/workday-plan.ts); without it Workday goes the general way. */
  workdayPlan?: WorkdayPlan;
  /**
   * Type into the focused field with real keystrokes (chrome.debugger), then Tab. Workday's date boxes accept
   * nothing else. Missing: such fields are reported instead.
   */
  typeTrusted?(text: string): Promise<boolean>;
  /**
   * Your career-site account (ACCOUNT_EMAIL / ACCOUNT_PASSWORD in .env, built into the extension): the account agent
   * (src/content/account.ts) signs in or creates the account on an account wall. Missing: such a page needs you.
   */
  account?: { email: string; password: string } | null;
  /** A real (trusted) mouse click at a viewport point (chrome.debugger), for a button that ignores scripted clicks. */
  clickTrusted?(x: number, y: number): Promise<boolean>;
}

export interface FlowOptions {
  mode: FlowMode;
  job: { title: string; company: string; url: string };
  instruction?: string;
  maxPages?: number;
  /** How long to wait for a heavy page (LinkedIn's work-history step can freeze the tab for 45 s or more). */
  pageWaitMs?: number;
  /** How long to wait at the start for the page to settle (an Apply button or a real form). */
  settleMs?: number;
}

const MAX_PAGES = 15;
const MAX_APPLY_PRESSES = 3;
const MAX_PAGE_ERRORS = 4;
/** Account presses per run (sign in, create, switch between them): more risks locking the account. */
const MAX_ACCOUNT_STEPS = 3;
const MAX_FIX_ROUNDS = 3;
/** Times Next or Submit is pressed again after fixing the errors that stopped it. */
const MAX_RETRY_PRESSES = 2;
/** The wait before the final Submit (user, 2026-11-06), restarted by any change you make on the page meanwhile. */
export const SUBMIT_WAIT_MS = 30_000;

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

async function pollUntil<T>(deps: FlowDeps, check: () => Promise<T>, ready: (v: T) => boolean, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = deps.now() + timeoutMs;
  let v = await check();
  while (!ready(v) && deps.now() < deadline) {
    await deps.sleep(intervalMs);
    v = await check();
  }
  return v;
}

/** The frame with the most form fields (LinkedIn's Easy Apply form is in an iframe; the page behind has none). */
async function extractBest(deps: FlowDeps): Promise<FrameFormData | null> {
  const frames = await deps.frames();
  const found = await Promise.all(frames.map(async (frameId) => {
    try {
      const r = await deps.send(frameId, { type: 'EXTRACT_FORM' });
      return r?.ok && Array.isArray(r.data?.fields) && r.data.fields.length > 0 ? { ...(r.data as FormData), frameId } : null;
    } catch {
      return null;
    }
  }));
  return found.filter((f): f is FrameFormData => f !== null).reduce<FrameFormData | null>((best, f) => (!best || f.fields.length > best.fields.length ? f : best), null);
}

/** First frame whose engine answers `msg` with `found`. */
async function findIn(deps: FlowDeps, msg: Record<string, unknown>): Promise<{ frameId: number; text: string } | null> {
  for (const frameId of await deps.frames()) {
    try {
      const r = await deps.send(frameId, msg);
      if (r?.ok && r.found) return { frameId, text: String(r.text ?? '') };
    } catch {
      // No engine in this frame (closed, chrome:// or blocked): try the next.
    }
  }
  return null;
}

/**
 * No control on the page reads as Apply by its wording: show the AI the page's clickables and let it pick the one that
 * opens the application. The frame with the most candidates (the posting itself, not an embedded widget) is asked.
 */
async function aiFindApply(deps: FlowDeps, opts: FlowOptions, say?: (t: string) => void): Promise<{ frameId: number; index: number; text: string } | null> {
  let best: { frameId: number; cands: ApplyCandidate[] } | null = null;
  for (const frameId of await deps.frames()) {
    try {
      const r = await deps.send(frameId, { type: 'APPLY_CANDIDATES' });
      const cands = Array.isArray(r?.candidates) ? (r.candidates as ApplyCandidate[]) : [];
      if (cands.length > 0 && (!best || cands.length > best.cands.length)) best = { frameId, cands };
    } catch {
      // no engine in this frame
    }
  }
  if (!best) return null;
  say?.(`Buttons on the page (${best.cands.length}): ${best.cands.slice(0, 12).map((c) => `"${(c.text || c.label || '').slice(0, 30)}"`).join(', ')}`);
  let answers: Answer[];
  try {
    answers = await deps.generate({
      instruction: 'Choose the control on this job posting that opens its application form. Answer with one option exactly as written.',
      candidate: deps.profile,
      job: { title: opts.job.title, company: opts.job.company, url: opts.job.url },
      fields: [applyChoiceField(best.cands)],
      filled_summary: [],
      resume_text: '',
    });
  } catch (e) {
    // Out of AI quota: the run pauses (runAiApply); any other failure just means no pick.
    if (isAiLimitError(e)) throw e;
    return null;
  }
  const index = parseApplyChoice(answers, best.cands.length);
  if (index < 0) return null;
  const c = best.cands[index]!;
  say?.(`AI chose "${(c.text || c.label || '').slice(0, 40)}" as the way to apply`);
  return { frameId: best.frameId, index, text: c.text || c.label || 'Apply' };
}

async function signals(deps: FlowDeps): Promise<{ confirmed: boolean; captcha: boolean; closed: boolean }> {
  let confirmed = false;
  let captcha = false;
  let closed = false;
  for (const frameId of await deps.frames()) {
    try {
      const r = await deps.send(frameId, { type: 'PAGE_SIGNALS' });
      confirmed ||= r?.confirmed === true;
      captcha ||= r?.captcha === true;
      closed ||= r?.closed === true;
    } catch {
      // ignore this frame
    }
  }
  return { confirmed, captcha, closed };
}

/**
 * Your answer in the words a dropdown offers (user's rules, 2026-11-05, kept in seed/applicant_profile.py): B.Tech is
 * "Bachelor's Degree" when no B.Tech option exists, Civil Engineering is "Engineering", and "How did you hear about
 * us" is always LinkedIn when LinkedIn is offered. An answer already among the options is kept.
 */
const OPTION_FALLBACKS: Array<{ answer: RegExp; prefer: string[]; always?: boolean }> = [
  // Your degree (user, 2026-11-06): B.Tech / Bachelor of Technology; if the list has neither, Bachelor of
  // Engineering; only then a general bachelor's option. Applied even when the AI picked "Bachelor's Degree" from a
  // list that also offers B.Tech.
  {
    answer: /^b\.?\s?tech|bachelor of tech|^be$|^b\.e\.?$|^bachelor'?s?( degree)?$|^bachelor degree/i,
    prefer: ['B. Tech', 'B.Tech', 'BTech', 'B Tech', 'Bachelor of Technology', 'Bachelor of Engineering', 'B.E.', 'BE', "Bachelor's Degree", 'Bachelor Degree', 'Bachelors', 'Bachelor', 'Undergraduate', 'Graduate'],
    always: true,
  },
  { answer: /civil/i, prefer: ['Civil Engineering', 'Civil', 'Engineering'] },
];
const SOURCE_LABEL = /how did you (hear|find|learn|come across)|^source\b|referral source|where did you (see|find|hear)/i;
const SOURCE_PRIORITY = ['LinkedIn', 'Indeed', 'Naukri', 'Job board', 'Job Board'];

function fitToOptions(field: FormField, answer: string): string | null {
  const options = field.options.map((o) => o.trim()).filter(Boolean);
  if (!options.length || !answer || answer === 'NEEDS_USER_INPUT' || answer === 'RESUME_UPLOAD') return null;
  const n = (t: string) => t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const find = (wanted: string[]) => {
    for (const w of wanted) { const hit = options.find((o) => n(o) === n(w)); if (hit) return hit; }
    for (const w of wanted) { const hit = options.find((o) => n(w) && (n(o).includes(n(w)) || n(w).includes(n(o)))); if (hit) return hit; }
    return null;
  };
  if (SOURCE_LABEL.test(field.label)) return find(SOURCE_PRIORITY) ?? null;
  const rule = OPTION_FALLBACKS.find((r) => r.answer.test(answer.trim()));
  if (rule?.always) {
    const pick = find(rule.prefer);
    return pick && n(pick) !== n(answer) ? pick : null;
  }
  if (options.some((o) => n(o) === n(answer))) return null;
  return rule ? find(rule.prefer) : null;
}

/**
 * A checkbox whose whole label is "I agree" / "I accept" / "I consent" (Ashby's application consent, QA 2026-11-05):
 * ticked, since the form cannot be submitted otherwise. Longer consent texts still go through the normal answering.
 */
function agreeAnswer(field: FormField): string | null {
  if (field.type !== 'checkbox') return null;
  return /^(yes,? )?i (agree|accept|consent)\b[^]{0,40}$/i.test(field.label.replace(/[*✱]\s*$/, '').trim()) ? 'Yes' : null;
}

/** A currency picker (most options are 3-letter codes, INR among them): INR. */
function currencyAnswer(field: FormField): string | null {
  if (!field.options.length || field.current_value === 'INR') return null;
  const codes = field.options.filter((o) => /^[A-Z]{3}$/.test(o.trim())).length;
  return codes >= Math.min(5, field.options.length) && field.options.some((o) => o.trim() === 'INR') ? 'INR' : null;
}

export interface BuiltAnswers {
  answers: Answer[];
  memory: MemoryMap;
  counts: { existing: number; direct: number; bank: number; memory: number; llm: number };
}

/**
 * Answers for every field of a page: what is already filled stays; then your experience/education entries, a direct
 * copy from the profile (name, email, phone...), the answer bank, form memory, and the LLM for the rest. What the LLM
 * answers is remembered for the next form that asks the same question.
 */
export async function buildAnswers(
  data: FormData, deps: Pick<FlowDeps, 'profile' | 'resume' | 'memory' | 'bank' | 'generate' | 'now'> & Partial<Pick<FlowDeps, 'coverLetter'>> & { abroad?: boolean; jobLocation?: string }, instruction: string, includePageText: boolean,
): Promise<BuiltAnswers> {
  const { profile } = deps;
  const kindCtx: NormalizeContext = { profile, today: new Date(deps.now()), abroad: deps.abroad };
  const local: Answer[] = [];
  const forLLM: FormField[] = [];
  const counts = { existing: 0, direct: 0, bank: 0, memory: 0, llm: 0 };
  const known: Array<{ label: string; value: string }> = [];
  const add = (field: FormField, answer: string, source: string, confidence = 1) => {
    local.push({ field_id: field.id, answer, confidence, source, needs_user_input: false });
    known.push({ label: field.label, value: answer });
  };

  for (const field of data.fields) {
    if (field.type === 'file') {
      local.push({ field_id: field.id, answer: 'RESUME_UPLOAD', confidence: 1, source: 'existing', needs_user_input: false });
      continue;
    }
    // Passwords mean an account wall; the flow stops before this matters, and a password never reaches the LLM.
    if (field.type === 'password') continue;
    // A CAPTCHA is yours to type: never answered, never sent to the AI.
    if (/captcha|type (the )?(text|characters) (in|from|below|shown)|below image|image text/i.test(`${field.label} ${field.placeholder ?? ''}`)) continue;
    // A cover letter text box (Indeed): your own cover letter, word for word; the AI never writes one (user,
    // 2026-11-06). Without one saved, an optional box stays empty and a required one is left for you.
    if (field.type !== 'file' && (isCoverLetterLabel(field.label) || /^cover ?letter|write (a |your )?cover letter/i.test(field.label))) {
      const letter = deps.coverLetter?.text?.trim();
      if (letter) {
        add(field, letter, 'your cover letter');
        counts.direct += 1;
      } else if (field.required) {
        local.push({ field_id: field.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'no cover letter text saved', needs_user_input: true });
      }
      continue;
    }
    // A work-experience entry's location only when the form requires it (user, 2026-11-06).
    if (field.entry_type === 'experience' && /\b(location|city|place)\b/i.test(field.label) && !field.required) continue;
    // An answer you gave yourself to this question (typed on an earlier form, or told to the agent) comes first, even
    // before your profile: it is your latest word (user, 2026-11-06).
    {
      const fitYours = (v: string | undefined) => (v ? fitToOptions(field, v) ?? v : v);
      const yours = fitYours(yourAnswer(deps.memory, field.label));
      if (yours && isValidAgainstOptions(field, yours)) {
        add(field, yours, 'you');
        counts.memory += 1;
        continue;
      }
    }
    // Before "keep what is there": a currency picker left on its first option (Keka's "AFN") and an unticked consent
    // box are not answers (Keka QA, 2026-11-05).
    const fixed = currencyAnswer(field) ?? (SOURCE_LABEL.test(field.label) ? fitToOptions(field, 'LinkedIn') : null) ?? agreeAnswer(field);
    if (fixed) {
      add(field, fixed, 'direct');
      counts.direct += 1;
      continue;
    }
    // A phone country-code picker left on the site's default ("+1") is not your answer: set yours.
    const kindDirect = directKindAnswer(field, kindCtx);
    if (kindDirect && classifyField(field) === 'phone_code' && field.current_value.trim() !== kindDirect) {
      add(field, kindDirect, 'direct');
      counts.direct += 1;
      continue;
    }
    if (isAlreadyFilled(field)) {
      add(field, field.current_value, 'existing');
      counts.existing += 1;
      continue;
    }
    const entry = experienceEntryAnswer(field, profile) || educationEntryAnswer(field, profile);
    const direct = entry || directMapAnswer(field, profile) || kindDirect;
    if (direct) {
      add(field, direct, 'direct');
      counts.direct += 1;
      continue;
    }
    // A saved answer in other words than this form's options (B.Tech vs "Bachelor's Degree") is mapped first.
    const fit = (v: string | undefined) => (v ? fitToOptions(field, v) ?? v : v);
    const banked = fit(findAnswer(field.label, deps.bank)?.answer);
    if (banked && isValidAgainstOptions(field, banked)) {
      add(field, banked, 'bank');
      counts.bank += 1;
      continue;
    }
    // The same wording can come with a different option list on another site, so a remembered answer must fit.
    const remembered = fit(lookupRememberedAnswer(deps.memory, field.label) ?? undefined);
    if (remembered && isValidAgainstOptions(field, remembered)) {
      add(field, remembered, 'memory', 0.9);
      counts.memory += 1;
      continue;
    }
    forLLM.push(withKindHint(enrichEntryFieldLabel(field, profile)));
  }

  let llm: Answer[] = [];
  if (forLLM.length) {
    counts.llm = forLLM.length;
    // Your own earlier answers, as facts for questions worded differently on this form.
    const facts = yourFacts(deps.memory);
    const raw = await deps.generate({
      instruction: facts.length ? `${instruction}\n\nFacts the candidate gave on earlier applications (use them where a question asks the same thing):\n${facts.map((x) => `- ${x}`).join('\n')}` : instruction,
      candidate: profile,
      resume_text: deps.resume?.text ?? '',
      // The job description matters on the first page only; later pages repeat form chrome.
      job: { title: data.title, url: data.url, page_text: includePageText ? data.page_text : '' },
      fields: forLLM,
      filled_summary: known,
    });
    // Never trust the model's option pick blindly: check it against the field's own options.
    // Shaped first ("Yes, happy to" → "Yes", "4 out of 5" → "4"), so the option check does not throw out an answer
    // that only needed rewording.
    const shaped = raw.map((a) => {
      const f = forLLM.find((x) => x.id === a.field_id);
      const n = f ? normalizeForInput(f, a.answer, kindCtx) : null;
      return n?.ok && n.value !== a.answer ? { ...a, answer: n.value } : a;
    });
    llm = verifyAndCorrectAnswers(forLLM, shaped, profile, new Date(deps.now()));
  }

  const byId = new Map([...local, ...llm].map((a) => [a.field_id, a]));
  const answers = data.fields.map((f) => {
    // "How soon can you join?": tomorrow's date, over any remembered or AI answer (user, 2026-11-10).
    const joinWhen = isJoinWhenQuestion(f.label) && !f.options.length && ['text', 'textarea', 'date'].includes(f.type);
    // Your standing answers (work authorization India only, never their employee, salary abroad, terms agreed).
    const standing = byId.get(f.id)?.source !== 'existing' ? standingAnswer(f, deps.jobLocation ?? '', profile) : null;
    const a = joinWhen && byId.get(f.id)?.source !== 'existing'
      ? { ...(byId.get(f.id) ?? { field_id: f.id }), answer: nextDayAnswer(f.type, new Date(deps.now())), confidence: 1, source: 'profile', needs_user_input: false } as Answer
      : standing
        ? { ...(byId.get(f.id) ?? { field_id: f.id }), answer: standing, confidence: 1, source: 'profile', needs_user_input: false } as Answer
        : byId.get(f.id);
    // CGPA / GPA: your profile's, and only on a required field; an optional one stays empty (user, 2026-11-11).
    if (isGpaLabel(f.label) && byId.get(f.id)?.source !== 'existing') {
      const gpa = gpaFromProfile(profile);
      if (!f.required) return undefined;
      if (gpa) return { ...(byId.get(f.id) ?? { field_id: f.id }), answer: f.options.length ? gpaOption(f.options, gpa) ?? fitToOptions(f, gpa) ?? gpa : gpa, confidence: 1, source: 'profile', needs_user_input: false } as Answer;
    }
    if (!a) return a;
    // A site's link box ("Naukri URL") with a link to another site (your portfolio): left empty, or yours to fill
    // when required (user, 2026-11-10).
    if (a.source !== 'existing' && a.answer && a.answer !== 'NEEDS_USER_INPUT' && linkFitsLabel(f.label, a.answer) === false) {
      return f.required ? { ...a, answer: 'NEEDS_USER_INPUT', needs_user_input: true, confidence: 0, source: `${a.source}:wrong-site-link` } : undefined;
    }
    const fitted = fitToOptions(f, a.answer);
    const picked = fitted && fitted !== a.answer ? { ...a, answer: fitted } : a;
    // The input-type agent: the answer in the exact shape this control keeps (a time as HH:MM, a number within the
    // slider's range, a URL with https://). One that cannot fit goes to you instead of into the page broken.
    if (picked.source === 'existing') return picked;
    const n = normalizeForInput(f, picked.answer, kindCtx);
    if (!n.ok) return { ...picked, answer: 'NEEDS_USER_INPUT', needs_user_input: true, confidence: 0, source: `${picked.source}:${n.reason}` };
    return n.value !== picked.answer ? { ...picked, answer: n.value } : picked;
  }).filter((a): a is Answer => !!a);
  const learned = llm.filter((a) => !a.needs_user_input && a.answer && a.answer !== 'NEEDS_USER_INPUT')
    .map((a) => ({ label: data.fields.find((f) => f.id === a.field_id)?.label ?? '', answer: a.answer }));
  return { answers, memory: rememberAnswers(deps.memory, learned, deps.now()), counts };
}

/** For a platform with its own applier (Workday), run that one; null when the tab is on any other site. */
async function platformApplier(deps: FlowDeps, opts: FlowOptions): Promise<ApplyReport | null> {
  if (!deps.currentUrl) return null;
  const url = await deps.currentUrl().catch(() => '');
  // Indeed's native "Apply now" (Indeed Apply / SmartApply): its own step-by-step applier.
  if (isIndeedUrl(url)) {
    deps.status?.('Indeed: using the Indeed Apply applier');
    const r = await runIndeedApply(deps, opts.mode, { title: opts.job.title, company: opts.job.company }, url);
    // A company-site job: the general flow follows Indeed's link to the company page.
    if (r.result !== 'external') return r;
  }
  // LinkedIn Easy Apply: its own applier. Company-site jobs are not applied to from LinkedIn (user, 2026-11-10).
  if (isLinkedinJobUrl(url)) {
    deps.status?.('LinkedIn: using the LinkedIn Easy Apply applier');
    return runLinkedinApply(deps, opts.mode, { title: opts.job.title, company: opts.job.company }, url);
  }
  // Naukri's own Apply and its chatbot questions: its own applier. Company-site jobs go the general way.
  if (isNaukriJobUrl(url)) {
    deps.status?.('Naukri: using the Naukri applier');
    const r = await runNaukriApply(deps, opts.mode, { title: opts.job.title, company: opts.job.company });
    if (r.result !== 'external') return r;
  }
  // Wellfound's application form (custom questions, "Send application"): its own applier.
  if (isWellfoundJobUrl(url)) {
    deps.status?.('Wellfound: using the Wellfound applier');
    return runWellfoundApply(deps, opts.mode, { title: opts.job.title, company: opts.job.company }, url);
  }
  if (!deps.workdayPlan) return null;
  const ats = detectAts(url);
  if (ats === 'workday') {
    deps.status?.('Workday site: using the Workday applier');
    return runWorkdayApply(deps, opts.mode, deps.workdayPlan, url);
  }
  // Zoho Recruit: by its address, or by its page on a company domain (the plan carries the same facts).
  let zoho = ats === 'zoho';
  if (!zoho && ats === 'generic') {
    const frames = await deps.frames().catch(() => [] as number[]);
    const s = frames.length ? await deps.send(frames[0]!, { type: 'ZH_STATE' }).catch(() => null) : null;
    zoho = s?.zoho === true && (s.page === 'job' || s.page === 'form');
  }
  if (zoho) {
    deps.status?.('Zoho Recruit site: using the Zoho Recruit applier');
    return runZohoApply(deps, opts.mode, deps.workdayPlan, url, { title: opts.job.title, company: opts.job.company });
  }
  if (ats === 'lever') {
    deps.status?.('Lever site: using the Lever applier');
    return runLeverApply(deps, opts.mode, deps.workdayPlan, url, { title: opts.job.title, company: opts.job.company });
  }
  if (ats === 'keka') {
    deps.status?.('Keka site: using the Keka applier');
    return runKekaApply(deps, opts.mode, deps.workdayPlan, url, { title: opts.job.title, company: opts.job.company });
  }
  return null;
}

/** fillPage for the platform appliers. */
export function fillPageAnswers(deps: FlowDeps, data: FrameFormData, answers: Answer[]): Promise<number> {
  return fillPage(deps, data, answers);
}

/** Fill a page's answers, then attach your cover letter and resume to their upload fields. Returns how many fields took a value. */
async function fillPage(deps: FlowDeps, data: FrameFormData, answers: Answer[]): Promise<number> {
  const withLabels = answers.map((a) => ({ ...a, label: data.fields.find((f) => f.id === a.field_id)?.label }));
  const r = await deps.send(data.frameId, { type: 'FILL_FIELDS', answers: withLabels });
  let filled = Array.isArray(r?.results) ? r.results.filter((x: { filled?: boolean }) => x.filled).length : 0;

  const files = data.fields.filter((f) => f.type === 'file');
  const cover = files.find((f) => isCoverLetterLabel(f.label));
  // A lone unlabelled upload ("Upload file") is almost always the resume slot.
  const resumeField = files.find((f) => f !== cover && isResumeLabel(f.label)) ?? (files.filter((f) => f !== cover).length === 1 ? files.find((f) => f !== cover) : undefined);
  const attach = async (file: StoredResume, field: FormField) => {
    const res = await deps.send(data.frameId, {
      type: 'FILL_RESUME', field_id: field.id, base64: file.data, file_name: file.name, file_type: file.type, label: field.label,
    }).catch(() => null);
    return res?.filled ? 1 : 0;
  };
  if (deps.coverLetter && cover && !cover.current_value) filled += await attach(deps.coverLetter, cover);
  if (deps.resume && resumeField && !resumeField.current_value) filled += await attach(deps.resume, resumeField);
  return filled;
}

type ErrorList = Array<{ field_id: string; message: string; value?: string }>;

/** The page's validation errors: per field (field_id), and page-level banners (field_id ""). */
async function pageErrors(deps: FlowDeps, frameId: number): Promise<ErrorList> {
  const r = await deps.send(frameId, { type: 'DETECT_ERRORS' }).catch(() => null);
  const fields: ErrorList = Array.isArray(r?.errors) ? r.errors : [];
  const page: string[] = Array.isArray(r?.page) ? r.page : [];
  return [...fields, ...page.map((message) => ({ field_id: '', message }))];
}

/** Errors that belong to a field of this page. */
const fieldErrorsOf = (errors: ErrorList, data: FrameFormData) => errors.filter((e) => data.fields.some((f) => f.id === e.field_id));

/**
 * The error-fix agent's loop (src/shared/ai-apply/error-fix.ts): read the page's errors, fix each field (shorten,
 * clamp, reformat a date or phone, set a value that did not stick by interacting, or ask the LLM with the error),
 * fill the fixes and look again. Each field remembers what was tried, so nothing is repeated; it stops when a round
 * has nothing new to try. Returns the errors still on the page.
 */
/**
 * What the error-fix agent knows about one page across its rounds and Next/Submit presses: each field's answer now,
 * the answers tried, and the error message each fix answered (to spot a stale message).
 */
interface FixMemory {
  current: Map<string, string>;
  tried: Map<string, Set<string>>;
  fixedFor: Map<string, string>;
}

function newFixMemory(given: Answer[]): FixMemory {
  return { current: new Map(given.map((a) => [a.field_id, a.answer])), tried: new Map(), fixedFor: new Map() };
}

/**
 * The error-fix agent for a platform applier (LinkedIn): fix what the page rejected on this step ("Enter a decimal
 * number" for "Rs.2700000" → 2700000), mechanically first, else the AI with the error. Returns the errors left.
 */
export async function fixPageErrors(deps: FlowDeps, data: FrameFormData, given: Answer[]): Promise<ErrorList> {
  return autoFixErrors(deps, data, '', newFixMemory(given));
}

async function autoFixErrors(deps: FlowDeps, data: FrameFormData, instruction: string, mem: FixMemory): Promise<ErrorList> {
  const ctx: NormalizeContext = { profile: deps.profile, today: new Date(deps.now()) };
  const { current, tried } = mem;
  const triedOf = (id: string) => {
    if (!tried.has(id)) tried.set(id, new Set(current.has(id) ? [current.get(id)!] : []));
    return tried.get(id)!;
  };
  const labelOf = (id: string) => data.fields.find((f) => f.id === id)?.label;
  /**
   * Many forms check a field only when Submit or Next is pressed, so the old message stays up after a fix. An
   * error on a field that now holds our fix, with the same message the fix answered, is stale: the next press
   * re-checks it.
   */
  const isStale = (e: ErrorList[number]) =>
    mem.fixedFor.get(e.field_id) === e.message && (e.value === undefined || e.value === current.get(e.field_id));
  for (let round = 0; round < MAX_FIX_ROUNDS; round += 1) {
    const errors = await pageErrors(deps, data.frameId);
    const fieldErrors = fieldErrorsOf(errors, data).filter((e) => !isStale(e));
    if (!fieldErrors.length) return errors.filter((e) => !e.field_id || !isStale(e)).filter((e) => !fieldErrorsOf([e], data).length);

    const sets: Answer[] = [];
    const interacts: Array<{ field_id: string; answer: string }> = [];
    const forAi: FormField[] = [];
    const notes: string[] = [];
    const fixedWhy: string[] = [];
    for (const e of fieldErrors) {
      const f = data.fields.find((x) => x.id === e.field_id)!;
      if (f.type === 'password' || f.type === 'file') continue;
      const t = triedOf(f.id);
      // What is really in the box, when the page reports it (a fix may have been changed by the page).
      const inBox = e.value !== undefined && e.value !== '' ? e.value : undefined;
      if (inBox !== undefined) t.add(inBox);
      const plan = planFix(f, e.message, inBox ?? current.get(f.id) ?? f.current_value, t, ctx);
      if (plan.action === 'set') {
        sets.push({ field_id: f.id, answer: plan.answer, confidence: 0.8, source: 'error_fix', needs_user_input: false });
        t.add(plan.answer);
        current.set(f.id, plan.answer);
        mem.fixedFor.set(f.id, e.message);
        fixedWhy.push(`${f.label}: ${plan.why}`);
      } else if (plan.action === 'interact') {
        interacts.push({ field_id: f.id, answer: plan.answer });
        t.add(`interact:${plan.answer}`);
        mem.fixedFor.set(f.id, e.message);
        fixedWhy.push(`${f.label}: ${plan.why}`);
      } else if (plan.action === 'ask_ai') {
        mem.fixedFor.set(f.id, e.message);
        forAi.push(withKindHint(f));
        notes.push(`- "${f.label}" (was "${(current.get(f.id) ?? '').slice(0, 120)}"): ${plan.guidance}`);
      }
    }

    if (forAi.length) {
      deps.status?.(`Fixing ${forAi.length} rejected field(s) with AI`);
      const raw = await deps.generate({
        instruction: `${instruction}\n\nThe form rejected these answers. Fix each one exactly as described; never repeat the rejected value:\n${notes.join('\n')}`,
        candidate: deps.profile, resume_text: deps.resume?.text ?? '', job: { title: data.title, url: data.url, page_text: '' }, fields: forAi, filled_summary: [],
      });
      const shaped = raw.map((a) => {
        const f = forAi.find((x) => x.id === a.field_id);
        const n = f ? normalizeForInput(f, a.answer, ctx) : null;
        return n?.ok ? { ...a, answer: n.value } : a;
      });
      for (const a of verifyAndCorrectAnswers(forAi, shaped, deps.profile, new Date(deps.now()))) {
        const t = triedOf(a.field_id);
        if (!a.answer || a.answer === 'NEEDS_USER_INPUT' || t.has(a.answer)) continue;
        sets.push(a);
        t.add(a.answer);
        current.set(a.field_id, a.answer);
        fixedWhy.push(`${labelOf(a.field_id)}: rewritten by AI`);
      }
    }

    // Nothing new to try: what is left needs you.
    if (!sets.length && !interacts.length) return errors;
    deps.status?.(`Fixing: ${fixedWhy.join('; ').slice(0, 200)}`);
    if (sets.length) {
      await deps.send(data.frameId, { type: 'FILL_FIELDS', answers: sets.map((a) => ({ ...a, label: labelOf(a.field_id) })) }).catch(() => null);
    }
    for (const i of interacts) {
      await deps.send(data.frameId, { type: 'FORCE_INTERACT_FIELD', field_id: i.field_id, value: i.answer, label: labelOf(i.field_id) }).catch(() => null);
    }
    await deps.sleep(400);
    // A value set by script that the page still rejects with a new message: some widgets (date pickers) only take a
    // real interaction. (The same message is stale: the page re-checks on the next press.)
    const still = new Set(fieldErrorsOf(await pageErrors(deps, data.frameId), data).filter((e) => !isStale(e)).map((e) => e.field_id));
    for (const a of sets) {
      const t = triedOf(a.field_id);
      if (still.has(a.field_id) && !t.has(`interact:${a.answer}`)) {
        t.add(`interact:${a.answer}`);
        await deps.send(data.frameId, { type: 'FORCE_INTERACT_FIELD', field_id: a.field_id, value: a.answer, label: labelOf(a.field_id) }).catch(() => null);
      }
    }
    await deps.sleep(400);
  }
  return (await pageErrors(deps, data.frameId)).filter((e) => !e.field_id || !isStale(e));
}

/** Errors in words for the report: "Phone: Please enter a valid number". */
function errorLabels(errors: ErrorList, data: FrameFormData): string[] {
  return errors.map((e) => (e.field_id ? `${data.fields.find((f) => f.id === e.field_id)?.label ?? e.field_id}: ${e.message}` : e.message));
}

const asEntries = (data: FormData, answers: Answer[]) => answers
  .filter((a) => a.source !== 'existing' && a.answer && a.answer !== 'NEEDS_USER_INPUT' && a.answer !== 'RESUME_UPLOAD')
  .map((a) => ({ question: data.fields.find((f) => f.id === a.field_id)?.label ?? a.field_id, answer: a.answer }));

/** Apply to one job in the agent's tab. */
/** Every page's fields and the answers given, for the pre-submit review (earlier pages cannot be changed any more). */
export type AnswerHistory = Map<string, { field: FormField; answer: string }>;

export interface PreSubmitResult {
  /** What still stops the Submit. */
  blocking: Finding[];
  /** Sections checked and fine, for the log. */
  passed: string[];
  /** What the check corrected on the page. */
  fixed: string[];
}

/**
 * The pre-submit QA agent's run (src/shared/ai-apply/pre-submit.ts): review the whole application against your
 * profile, fix what can be fixed on the open page (set a wrong month/year, college or link; have the AI rewrite a
 * message that names another company, keeps a placeholder or a strange link), review again, and return what is left.
 */
export async function preSubmitCheck(
  deps: FlowDeps, history: AnswerHistory, job: { company: string; title: string; url?: string }, instruction: string, reviewPage = false,
): Promise<PreSubmitResult> {
  const fixed: string[] = [];
  const ctx: NormalizeContext = { profile: deps.profile, today: new Date(deps.now()) };
  for (let round = 0; ; round += 1) {
    const now = await extractBest(deps);
    const text = now ? await deps.send(now.frameId, { type: 'PAGE_TEXT' }).catch(() => null) : null;
    const onPage = new Set((now?.fields ?? []).map((f) => f.id));
    const answers: ReviewedAnswer[] = [
      ...[...history.values()].filter((h) => !onPage.has(h.field.id)).map((h) => ({ field: h.field, answer: h.answer, onPage: false })),
      // What the box shows; when a widget reads back blank although it was filled, the answer that was filled.
      ...(now?.fields ?? []).map((f) => ({ field: f, answer: f.current_value || history.get(f.id)?.answer || '', onPage: true })),
    ];
    const review = reviewBeforeSubmit({ profile: deps.profile, job, answers, pageText: String(text?.text ?? ''), reviewPage });
    const sets = review.findings.filter((f) => f.set && f.field_id && onPage.has(f.field_id));
    const yourLetter = deps.coverLetter?.text?.trim();
    const rewrites = review.findings.filter((f) => f.rewrite && f.field_id && onPage.has(f.field_id))
      // Your own cover letter is never rewritten: it is reported instead.
      .filter((f) => !yourLetter || (now?.fields.find((x) => x.id === f.field_id)?.current_value ?? '').trim() !== yourLetter)
      .filter((f, i, all) => all.findIndex((x) => x.field_id === f.field_id) === i);
    if (round >= 1 || !now || (!sets.length && !rewrites.length)) return { blocking: review.findings, passed: review.passed, fixed };

    const labelOf = (id: string) => now.fields.find((f) => f.id === id)?.label;
    if (sets.length) {
      await deps.send(now.frameId, {
        type: 'FILL_FIELDS', answers: sets.map((f) => ({ field_id: f.field_id, answer: f.set, label: labelOf(f.field_id!) })),
      }).catch(() => null);
      fixed.push(...sets.map((f) => `${f.label}: ${f.problem} → set to "${f.set}"`));
    }
    if (rewrites.length) {
      const allowed = [...new Set(rewrites[0]!.rewrite!.allowed)].filter((a) => a.length < 60);
      const links = [deps.profile.portfolio, deps.profile.linkedin, ...deps.profile.custom_fields.filter((c) => /github|portfolio|website/i.test(c.name)).map((c) => c.value)].filter(Boolean);
      const fields = rewrites.map((f) => withKindHint(now.fields.find((x) => x.id === f.field_id)!));
      const note = rewrites.map((f) => {
        const all = review.findings.filter((x) => x.field_id === f.field_id).map((x) => x.problem).join('; ');
        return `- "${labelOf(f.field_id!)}": ${all}. Current text: "${(now.fields.find((x) => x.id === f.field_id)?.current_value ?? '').slice(0, 600)}"`;
      }).join('\n');
      deps.status?.(`Pre-submit check: rewriting ${rewrites.length} message(s)`);
      const raw = await deps.generate({
        instruction: `${instruction}\n\nBEFORE SUBMITTING, rewrite these answers. Keep them truthful and specific. Name no company except these: ${allowed.join(', ')}. ` +
          `No placeholders like [Company]. Links only from: ${links.join(', ') || 'none'}. Problems found:\n${note}`,
        candidate: deps.profile, resume_text: deps.resume?.text ?? '', job: { title: job.title, company: job.company, url: job.url ?? '' }, fields, filled_summary: [],
      });
      const good = raw.filter((a) => {
        if (!a.answer || a.answer === 'NEEDS_USER_INPUT') return false;
        // The rewrite must itself pass: a still-wrong message is left for you, not filled.
        const field = now.fields.find((x) => x.id === a.field_id);
        if (!field) return false;
        const again = reviewBeforeSubmit({ profile: deps.profile, job, answers: [{ field, answer: a.answer, onPage: true }], pageText: '' });
        return !again.findings.some((x) => x.section === 'message' || x.section === 'general');
      }).map((a) => {
        const field = now.fields.find((x) => x.id === a.field_id)!;
        const n = normalizeForInput(field, a.answer, ctx);
        return { ...a, answer: n.ok ? n.value : a.answer, label: field.label };
      });
      if (good.length) {
        await deps.send(now.frameId, { type: 'FILL_FIELDS', answers: good }).catch(() => null);
        fixed.push(...good.map((a) => `${a.label}: message rewritten`));
      }
    }
    await deps.sleep(400);
  }
}

/** The review's verdict in words: "experience: Start month (Xaigi) is "July", your resume says Jun 2024". */
export function findingLabels(findings: Finding[]): string[] {
  return findings.map((f) => `${f.section}: ${f.label} ${f.problem}`);
}

/** Record a page's fields and their answers (after any fixes) for the pre-submit review. */
function remember(history: AnswerHistory, data: FrameFormData, answers: Map<string, string>): void {
  for (const f of data.fields) history.set(f.id, { field: f, answer: answers.get(f.id) ?? f.current_value ?? '' });
}

/** Your real input on the page, summed over its frames (USER_ACTIVITY). */
async function userActivityCount(deps: FlowDeps): Promise<number> {
  let total = 0;
  for (const frameId of await deps.frames().catch(() => [] as number[])) {
    const r = await deps.send(frameId, { type: 'USER_ACTIVITY' }).catch(() => null);
    total += Number(r?.count ?? 0);
  }
  return total;
}

/**
 * Wait SUBMIT_WAIT_MS before the final Submit, so you can look the form over. Anything you change on the page
 * restarts the wait: Submit is pressed 30 s after your last change. Returns a reason to stop (the kill switch, or the
 * site already confirmed because you submitted yourself), or null to go ahead.
 */
export async function waitBeforeSubmit(deps: FlowDeps, say: (t: string) => void, waitMs = SUBMIT_WAIT_MS): Promise<string | null> {
  let seen = await userActivityCount(deps);
  let until = deps.now() + waitMs;
  say(`Submitting in ${Math.round(waitMs / 1000)} s; change anything on the page and I wait ${Math.round(waitMs / 1000)} s after your last change`);
  while (deps.now() < until) {
    await deps.sleep(1_000);
    const count = await userActivityCount(deps);
    if (count !== seen) {
      seen = count;
      until = deps.now() + waitMs;
      say('You changed something: submitting 30 s after your last change');
    }
    if ((await signals(deps)).confirmed) return 'submitted';
  }
  return deps.mayClick();
}

/**
 * Run AI apply. When the AI's usage limit runs out mid-way (every provider out of quota, src/shared/ai-apply/llm.ts),
 * nothing was submitted: the run ends `limit` with when to try again, the job stays in the queue, and the agent
 * pauses until then (src/shared/auto-apply/runner.ts).
 */
export async function runAiApply(deps: FlowDeps, opts: FlowOptions): Promise<ApplyReport> {
  try {
    return await runAiApplyOnce(deps, opts);
  } catch (e) {
    if (!isAiLimitError(e)) throw e;
    const at = new Date(e.retryAt);
    deps.status?.(`AI usage limit reached; continuing after ${at.toLocaleTimeString()}`);
    return report('limit', {
      reason: `AI usage limit reached${e.daily ? ' (daily quota)' : ''}; continues after ${at.toLocaleString()}`,
      retryAt: e.retryAt,
    });
  }
}

async function runAiApplyOnce(deps: FlowDeps, opts: FlowOptions): Promise<ApplyReport> {
  // First check the platform: Workday has its own applier; everything else goes the general way below.
  const dedicated = await platformApplier(deps, opts);
  if (dedicated) return dedicated;
  const instruction = opts.instruction ?? DEFAULT_INSTRUCTION;
  const pageWaitMs = opts.pageWaitMs ?? 60_000;
  const submitted: ApplyReport['answers'] = [];
  const history: AnswerHistory = new Map();
  const jobInfo = { ...opts.job, url: opts.job.url };
  let clicked = false;
  let memory = deps.memory;
  const say = (t: string) => deps.status?.(t);
  const base = () => ({ clicked, answers: submitted.slice(0, 30) });

  const click = async (frameId: number, type: string): Promise<string | null> => {
    const stop = await deps.mayClick();
    if (stop) return stop;
    await deps.beforeClick?.();
    clicked = true;
    const r = await deps.send(frameId, { type });
    return r?.ok === false ? String(r.error ?? `${type} failed`) : null;
  };
  const clickMsg = async (frameId: number, msg: Record<string, unknown>): Promise<string | null> => {
    const stop = await deps.mayClick();
    if (stop) return stop;
    await deps.beforeClick?.();
    clicked = true;
    const r = await deps.send(frameId, msg);
    return r?.ok === false ? String(r.error ?? `${String(msg.type)} failed`) : null;
  };

  // 0. Let the page settle. Right after load a page can show a passing field and no Apply button yet (Naukri shows
  // an "Email ID" sign-in box for a moment, seen live 2026-11-04): acting then filled that box and stopped. Wait
  // until there is an Apply button, a form of 2+ fields, or the same form on two reads in a row.
  let lastPrint: string | null = null;
  const settled = await pollUntil(deps, async () => {
    const [d, apply] = await Promise.all([extractBest(deps), findIn(deps, { type: 'FIND_APPLY' })]);
    const print = pageFingerprint(d ?? undefined);
    const stable = d !== null && d.fields.length > 0 && print === lastPrint;
    lastPrint = print;
    return { d, apply, ready: !!apply || (d?.fields.length ?? 0) >= 2 || stable };
  }, (v) => v.ready, opts.settleMs ?? 10_000);

  // An expired job: nothing to press and the page says it is closed. It leaves the board.
  if (!settled.apply && !(settled.d?.fields.length)) {
    const s = await signals(deps);
    if (s.closed) return report('closed', { reason: 'the job has expired (the page says it is closed)' });
  }

  // 1. A job posting rather than a form: press its Apply button (in preview, only note that it is there).
  let data = settled.d;
  // The checker: is the application form already here, or must Apply be pressed first? Fields that are not an
  // application (a job search, a location picker) do not count when the page also has an Apply control.
  const formHere = (d: FrameFormData | null) => !!d && d.fields.length >= 2 && looksLikeApplicationForm(d.fields);
  const formHereNow = formHere(data) || (!!data && data.fields.length >= 2 && !settled.apply);
  let askedAi = false;
  // Apply can take more than one press: Workday's Apply opens a "Start Your Application" chooser whose "Apply
  // Manually" leads on (seen 2026-11-05). Up to MAX_APPLY_PRESSES in a row while no form has appeared.
  for (let press = 0; press < MAX_APPLY_PRESSES && !(press === 0 ? formHereNow : formHere(data)); press += 1) {
    const found = await findIn(deps, { type: 'FIND_APPLY' });
    // Every button and link on the page was scored by meaning (src/shared/ai-apply/apply-button.ts). No clear winner
    // (nothing reads as Apply, or two close ones): the AI picks from the full list, once per page, and only while
    // there is no form at all (a form with an unknown Next is the form loop's job).
    let apply: { frameId: number; text: string; index?: number } | null = found;
    if (!apply && !askedAi && (data?.fields.length ?? 0) < 2) {
      askedAi = true;
      say('No clear Apply button: listing every button for the AI to choose');
      apply = await aiFindApply(deps, opts, say);
    }
    if (!apply) break;
    if (opts.mode === 'preview') return report('can_apply', { reason: `dry run: would press "${apply.text.trim().slice(0, 40)}" and fill the form with AI` });
    say(`Pressing "${apply.text.trim()}"`);
    const stop = apply.index === undefined
      ? await click(apply.frameId, 'CLICK_APPLY')
      : await clickMsg(apply.frameId, { type: 'CLICK_APPLY', index: apply.index });
    if (stop) return report('stopped', { ...base(), reason: stop });
    await deps.sleep(1_500);
    // Every press may open the next page in a new tab (careers page → Workday), so check after each one.
    await deps.afterApplyClick?.();
    // A form appears, the site applies in one click and shows the job as applied (iimjobs, seen 2026-11-04), or
    // another Apply-type choice appears (Workday's chooser).
    // A field or two that are not an application (a widget, a search box) do not end the presses while the new page
    // still has an Apply control: Indeed's "Apply on company site" opens Target's posting, whose own Apply leads on.
    const after = await pollUntil(deps, async () => {
      const d = await extractBest(deps);
      if (formHere(d)) return { d, confirmed: false, again: false };
      const confirmed = (await signals(deps)).confirmed;
      const again = !confirmed && !!(await findIn(deps, { type: 'FIND_APPLY' }));
      return { d, confirmed, again };
    }, (v) => formHere(v.d) || v.confirmed || v.again, 20_000);
    if (after.confirmed) return report('applied', { ...base(), reason: 'applied in one click: the site shows the job as applied' });
    data = after.d;
    // A new page: the AI may choose on it too (Indeed → N-able's careers page, whose Apply reads "Begin Your N-able
    // Journey Here", 2026-11-06: the run stopped there with "no Apply button found").
    askedAi = false;
    if (after.again) continue;
    if (formHere(data) || (data?.fields.length ?? 0) >= 2) break;
    // Workday has its own applier, which takes it from its job page.
    if (deps.currentUrl && detectAts(await deps.currentUrl().catch(() => '')) === 'workday') break;
  }
  // The Apply button may have led to a Workday site (Indeed "Apply on company site" → *.myworkdayjobs.com).
  {
    const dedicated = await platformApplier(deps, opts);
    if (dedicated) return { ...dedicated, clicked: dedicated.clicked || clicked };
  }
  if (!data) {
    const s = await signals(deps);
    if (s.captcha) return report('needs_me', { ...base(), reason: 'a captcha is showing on the page', questions: ['Solve the captcha, then apply'] });
    // Not `not_found`: that counts toward the "site page changed" halt, which is about the one-click sites.
    return report('needs_me', { ...base(), reason: 'no application form or Apply button found', questions: ['Apply on the page yourself'] });
  }

  let pageErrorsSeen = 0;
  let accountSteps = 0;
  for (let page = 1; page <= (opts.maxPages ?? MAX_PAGES); page += 1) {
    try {
      // A step that applies by itself once answered, then leaves the form (Naukri's chatbot opens its confirmation page).
      if (page > 1 && (await signals(deps)).confirmed) return report('applied', { ...base(), reason: 'the site confirmed the application' });
      if (page > 1 || !data) data = await extractBest(deps);
      // The next page can take a moment to draw its form: Jobvite (Nutanix, 2026-11-10) shows a data-consent step
      // first, and right after it the page had no fields yet ("the form disappeared on page 2"). Wait for it.
      if (!data && page > 1) data = await pollUntil(deps, () => extractBest(deps), (d) => !!d, Math.min(pageWaitMs, 15_000), 1_000);
      // Indeed's "Write a cover letter" / "Add cover letter": opened, so your cover letter goes in.
      if (data && deps.coverLetter?.text?.trim()) {
        const opened = await deps.send(data.frameId, { type: 'OPEN_COVER_LETTER' }).catch(() => null);
        if (opened?.opened) {
          say('Opened the cover letter box');
          await deps.sleep(800);
          data = (await extractBest(deps)) ?? data;
        }
      }
      if (!data) return report('no_confirmation', { ...base(), reason: `the form disappeared on page ${page}` });
      if ((await signals(deps)).captcha) return report('needs_me', { ...base(), reason: 'a captcha is showing on the form', questions: ['Solve the captcha, then apply'] });
      if (data.fields.some((f) => f.type === 'password')) {
        const host = hostOf(data.url);
        const wall = (why: string) => report('needs_me', { ...base(), reason: `${host} wants you to sign in or create an account first (${why}); do that once in this browser, then run Apply with AI again`, questions: [`Sign in or create an account on ${host}`] });
        if (!deps.account?.email || !deps.account.password) return wall('no account email/password set: add ACCOUNT_EMAIL and ACCOUNT_PASSWORD to .env and rebuild');
        // At most MAX_ACCOUNT_STEPS presses per run: a wrong password tried again and again can lock the account.
        if (accountSteps >= MAX_ACCOUNT_STEPS) return wall('signing in did not get past the account page');
        accountSteps += 1;
        // The page's other questions first (a create-account form may also ask your name or country), never the
        // email or password: those are the account's.
        const others = data.fields.filter((f) => f.type !== 'password' && f.type !== 'email' && !/e-?mail|user ?name|login/i.test(f.label));
        if (others.length) {
          const built = await buildAnswers({ ...data, fields: others }, { ...deps, memory }, instruction, false);
          await deps.send(data.frameId, { type: 'FILL_FIELDS', answers: built.answers.map((a) => ({ ...a, label: others.find((f) => f.id === a.field_id)?.label })) }).catch(() => null);
        }
        const stop = await deps.mayClick();
        if (stop) return report('stopped', { ...base(), reason: stop });
        await deps.beforeClick?.();
        clicked = true;
        say(`${host}: account page; signing in or creating the account`);
        let r = await deps.send(data.frameId, { type: 'ACCOUNT_STEP', email: deps.account.email, password: deps.account.password }).catch((e: unknown) => ({ ok: false, outcome: 'stopped', reason: String(e).slice(0, 120) }));
        // The scripted press did nothing: a real mouse click on the button, then read what happened.
        if (r?.outcome === 'no_effect' && r.point && deps.clickTrusted) {
          say(`${host}: pressing the account button with a real click`);
          if (await deps.clickTrusted(r.point.x, r.point.y)) {
            r = await deps.send(data.frameId, { type: 'ACCOUNT_AFTER' }).catch((e: unknown) => ({ ok: false, outcome: 'stopped', reason: String(e).slice(0, 120) }));
          }
        }
        if (r?.outcome === 'no_effect') r = { ...r, outcome: 'stopped' };
        if (r?.verification) return report('needs_me', { ...base(), reason: `${host} sent a verification email or code to ${deps.account.email}: confirm it, then run Apply with AI again`, questions: [`Confirm your ${host} account from your email`] });
        if (r?.captcha) return report('needs_me', { ...base(), reason: `${host} shows a captcha on its account page`, questions: [`Solve the captcha and sign in on ${host}`] });
        if (r?.outcome === 'stopped') return wall(String(r.reason ?? 'the site did not accept it').slice(0, 160));
        say(r?.outcome === 'switched' ? `${host}: ${r.reason}` : `${host}: ${r?.page === 'signup' ? 'account created' : 'signed in'}`);
        // The next page (or the other form) is read afresh.
        await deps.sleep(1_500);
        await deps.afterApplyClick?.();
        data = null;
        page -= 1;
        continue;
      }

      say(`Page ${page}: answering ${data.fields.length} fields`);
      const built = await buildAnswers(data, { ...deps, memory }, instruction, page === 1);
      memory = built.memory;
      await deps.saveMemory(memory);
      const pending = findPendingQuestions(data, built.answers);
      if (opts.mode === 'preview') {
        const entries = asEntries(data, built.answers);
        if (pending.length) return report('needs_me', { reason: `required questions with no answer: ${pending.map((p) => p.label).join('; ')}`.slice(0, 300), questions: pending.map((p) => p.label), answers: entries });
        return report('can_apply', { reason: `dry run: would fill ${entries.length} fields (${describe(built.counts)})`, answers: entries });
      }
      if (pending.length) {
        return report('needs_me', { ...base(), reason: `required questions with no answer: ${pending.map((p) => p.label).join('; ')}`.slice(0, 300), questions: pending.map((p) => p.label) });
      }

      const filled = await fillPage(deps, data, built.answers);
      submitted.push(...asEntries(data, built.answers));
      say(`Page ${page}: filled ${filled} fields (${describe(built.counts)})`);
      await deps.sleep(500);
      const fixMem = newFixMemory(built.answers);
      const left = fieldErrorsOf(await autoFixErrors(deps, data, instruction, fixMem), data);
      if (left.length) {
        const labels = errorLabels(left, data);
        return report('needs_me', { ...base(), reason: `the form rejected: ${labels.join('; ')}`.slice(0, 300), questions: labels });
      }
      remember(history, data, fixMem.current);

      // Next or Submit; a heavy page may not have mounted its buttons yet.
      const frameId = data.frameId;
      const { next, submit } = await pollUntil(deps, async () => {
        const [n, s] = await Promise.all([
          deps.send(frameId, { type: 'FIND_CONTINUE' }).catch(() => null),
          deps.send(frameId, { type: 'FIND_SUBMIT' }).catch(() => null),
        ]);
        return { next: n?.found ? n : null, submit: s?.found ? s : null };
      }, (v) => !!v.next || !!v.submit, pageWaitMs);

      if (!next && submit) {
        // The pre-submit QA agent: the whole application against your profile, before anything is submitted.
        say('Pre-submit check: experience, education, links, messages');
        const check = await preSubmitCheck(deps, history, { ...jobInfo, url: data.url || jobInfo.url }, instruction);
        if (check.fixed.length) say(`Pre-submit check fixed: ${check.fixed.join('; ').slice(0, 250)}`);
        if (check.passed.length) say(`Pre-submit check passed: ${check.passed.join('; ').slice(0, 250)}`);
        if (check.blocking.length) {
          const labels = findingLabels(check.blocking);
          return report('needs_me', { ...base(), reason: `pre-submit check: ${labels.join('; ')}`.slice(0, 300), questions: labels });
        }
        if (opts.mode === 'fill') return report('ready', { ...base(), reason: `filled ${page} page(s) and checked them (${check.passed.length} section checks passed${check.fixed.length ? `, ${check.fixed.length} fixed` : ''}); press "${String(submit.text).trim()}" yourself` });
        // Submit, and when the form rejects it, fix what it names and press again (up to MAX_RETRY_PRESSES times).
        let done: { confirmed: boolean; captcha: boolean; closed: boolean; form: FrameFormData | null } | null = null;
        {
          const wait = await waitBeforeSubmit(deps, say);
          if (wait === 'submitted') return report('applied', { ...base(), reason: `${hostOf(data.url)} confirmed the application (submitted during the wait)` });
          if (wait) return report('stopped', { ...base(), reason: wait });
        }
        for (let press = 0; press <= MAX_RETRY_PRESSES; press += 1) {
          say(press ? `Pressing Submit again (try ${press + 1})` : 'Pressing Submit');
          const stop = await click(frameId, 'CLICK_SUBMIT');
          if (stop) return report('stopped', { ...base(), reason: stop });
          done = await pollUntil(deps, async () => {
            const s = await signals(deps);
            const form = s.confirmed ? null : await extractBest(deps).catch(() => null);
            return { ...s, form };
          }, (v) => v.confirmed || v.captcha, 20_000);
          if (done.confirmed) return report('applied', { ...base(), reason: `${hostOf(data.url)} confirmed the application` });
          if (done.captcha) return report('needs_me', { ...base(), reason: 'a captcha appeared after Submit', questions: ['Solve the captcha and submit'] });
          const errs = await pageErrors(deps, frameId);
          if (!errs.length) break;
          const fixable = fieldErrorsOf(errs, data).length > 0;
          const left = fixable && press < MAX_RETRY_PRESSES ? fieldErrorsOf(await autoFixErrors(deps, data, instruction, fixMem), data) : errs;
          if (!fixable || left.length || press === MAX_RETRY_PRESSES) {
            const labels = errorLabels(left.length ? left : errs, data);
            return report('needs_me', { ...base(), reason: `Submit was rejected: ${labels.join('; ')}`.slice(0, 300), questions: labels });
          }
        }
        if (!done) return report('no_confirmation', { ...base(), reason: 'pressed Submit; nothing happened' });
        // The form is gone with no error: most sites then show a thank-you page in words we do not know.
        if (!done.form || pageFingerprint(done.form) !== pageFingerprint(data)) return report('applied', { ...base(), reason: 'form submitted (no confirmation text recognised)' });
        return report('no_confirmation', { ...base(), reason: 'pressed Submit; the form is still there' });
      }
      if (!next) return report('needs_me', { ...base(), reason: `page ${page}: no Next or Submit button`, questions: ['Finish the application on the page'] });

      const before = pageFingerprint(data);
      const stop = await click(frameId, 'CLICK_CONTINUE');
      if (stop) return report('stopped', { ...base(), reason: stop });
      const after = await pollUntil(deps, () => extractBest(deps), (d) => pageFingerprint(d ?? undefined) !== before, pageWaitMs);
      // A step that applies by itself once answered (Naukri's chatbot after its last question).
      if ((await signals(deps)).confirmed) return report('applied', { ...base(), reason: `${hostOf(data.url)} confirmed the application` });
      // Next did not move on: the page is showing what is wrong. Fix it and press again.
      let moved = after;
      for (let press = 1; press <= MAX_RETRY_PRESSES && pageFingerprint(moved ?? undefined) === before; press += 1) {
        const errs = await pageErrors(deps, frameId);
        if (!fieldErrorsOf(errs, data).length) break;
        say(`Page ${page}: "${String(next.text).trim()}" was refused; fixing ${fieldErrorsOf(errs, data).length} field(s)`);
        const left = fieldErrorsOf(await autoFixErrors(deps, data, instruction, fixMem), data);
        if (left.length) {
          const labels = errorLabels(left, data);
          return report('needs_me', { ...base(), reason: `page ${page}: the form rejected: ${labels.join('; ')}`.slice(0, 300), questions: labels });
        }
        const again = await click(frameId, 'CLICK_CONTINUE');
        if (again) return report('stopped', { ...base(), reason: again });
        moved = await pollUntil(deps, () => extractBest(deps), (d) => pageFingerprint(d ?? undefined) !== before, pageWaitMs);
        if ((await signals(deps)).confirmed) return report('applied', { ...base(), reason: `${hostOf(data.url)} confirmed the application` });
      }
      if (pageFingerprint(moved ?? undefined) === before) {
        const errs = errorLabels(await pageErrors(deps, frameId), data);
        return report('needs_me', { ...base(), reason: `page ${page}: pressing "${String(next.text).trim()}" did not move on${errs.length ? `: ${errs.join('; ')}` : ''}`.slice(0, 300), questions: errs.length ? errs : ['A field on this page needs your attention'] });
      }
      data = moved;
      pageErrorsSeen = 0;
    } catch (e) {
      // Out of AI quota: not a page problem; the run stops and resumes once the limit is back (runAiApply).
      if (isAiLimitError(e)) throw e;
      // A frame torn down by a real navigation: retry the same page from scratch.
      pageErrorsSeen += 1;
      if (pageErrorsSeen > MAX_PAGE_ERRORS) return report('error', { ...base(), reason: `page ${page}: ${String(e).slice(0, 200)}` });
      await deps.sleep(1_200);
      data = null;
      page -= 1;
    }
  }
  return report('needs_me', { ...base(), reason: `more than ${opts.maxPages ?? MAX_PAGES} pages`, questions: ['Finish the application on the page'] });
}

function describe(c: BuiltAnswers['counts']): string {
  return `${c.existing} already filled, ${c.direct} from profile, ${c.bank} from answer bank, ${c.memory} from memory, ${c.llm} by AI`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the site';
  }
}
