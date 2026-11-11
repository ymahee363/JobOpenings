/**
 * LinkedIn Easy Apply's applier (the page side is src/content/ats/linkedin.ts): press Easy Apply, pick your resume by
 * name, answer each step with the general engine and the AI (deterministic answers first), press Next / Review, then
 * on the step with "Submit application" run the pre-submit check, wait 30 s and submit ('submit' mode) or stop for you
 * ('fill' mode). Company-site jobs are not applied to here: LinkedIn native only (user, 2026-11-10).
 */
import type { LiState } from '../../content/ats/linkedin';
import { buildAnswers, fillPageAnswers, findingLabels, fixPageErrors, preSubmitCheck, waitBeforeSubmit, type AnswerHistory, type FlowDeps, type FlowMode } from '../ai-apply/flow';
import type { FrameFormData } from '../ai-apply/types';
import type { ApplyReport } from '../auto-apply/runner';

const MAX_STEPS = 12;
/** Not questions: the Premium "top choice" box and "Follow <company>" stay as they are; the resume list is picked by name. */
const SKIP = /top choice|^follow\b|follow .* to stay up to date/i;

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

/**
 * Which resume to pick (user, 2026-11-10): Indian jobs get Mahendra_IIT_Guwahati_Resume, jobs in any other country
 * get Mahendra_IIT_Resume. An unknown or bare "Remote" location counts as India.
 */
export const INDIA_RESUME = 'Mahendra_IIT_Guwahati_Resume.pdf';
export const ABROAD_RESUME = 'Mahendra_IIT_Resume.pdf';
const INDIA = /\bindia\b|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|gurugram|gurgaon|noida|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore|coimbatore|karnataka|maharashtra|telangana|tamil nadu|haryana|uttar pradesh/i;
export function resumeForLocation(location: string): string {
  const where = location.trim();
  if (!where || /^(remote|hybrid|on-?site)$/i.test(where) || INDIA.test(where)) return INDIA_RESUME;
  return ABROAD_RESUME;
}

export function isLinkedinJobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(u.hostname) && /^\/jobs\/(view|collections|search)/.test(u.pathname);
  } catch {
    return false;
  }
}

export async function runLinkedinApply(deps: FlowDeps, mode: FlowMode, job: { title: string; company: string }, url: string): Promise<ApplyReport> {
  const say = (t: string) => deps.status?.(`LinkedIn: ${t}`);
  let clicked = false;
  const filledAll: ApplyReport['answers'] = [];
  const base = () => ({ clicked, answers: filledAll.slice(0, 30) });
  const frame = async () => (await deps.frames())[0] ?? 0;
  const call = async <T>(msg: Record<string, unknown>): Promise<T & { ok?: boolean }> => (await deps.send(await frame(), msg)) as T & { ok?: boolean };
  const state = () => call<LiState>({ type: 'LI_STATE' }).catch(() => ({ page: 'unknown', step: '', errors: [] }) as LiState);
  let s = await state();
  const where = (await call<{ location: string }>({ type: 'LI_LOCATION' }).catch(() => ({ location: '' })))?.location ?? '';
  const resumeName = resumeForLocation(where);
  say(`job location "${where || 'unknown'}": resume ${resumeName}`);
  if (s.page === 'submitted') return report('applied', { reason: 'LinkedIn shows this job as applied' });
  if (s.page === 'closed') return report('closed', { reason: `LinkedIn: ${s.message || 'No longer accepting applications'} (removed from the listing)` });
  if (s.page === 'external') {
    const target = s.externalUrl ? new URL(s.externalUrl).hostname : '';
    if (mode === 'preview' || !s.externalUrl) {
      return report('external', { reason: `LinkedIn: this job applies on the company site${target ? ` (${target})` : ''}` });
    }
    // Open the company's own apply page in this tab, unwrapped from LinkedIn's redirect (2026-11-11), then let the
    // general flow (or that site's own applier) apply there.
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { reason: stop });
    say(`company-site job: opening ${target}`);
    await call({ type: 'LI_GO_EXTERNAL' }).catch(() => null);
    for (let i = 0; i < 20; i += 1) {
      await deps.sleep(1_000);
      const now = await deps.currentUrl?.().catch(() => '') ?? '';
      if (now && !/^https?:\/\/([^/]+\.)?linkedin\.com\//i.test(now)) {
        // Let the company page load and the cached frame list expire, so the form engine is injected there.
        await deps.sleep(3_000);
        break;
      }
    }
    return report('external', { reason: `LinkedIn: company-site job; opened ${target}` });
  }
  if (s.page === 'job') {
    if (mode === 'preview') return report('can_apply', { reason: 'dry run: LinkedIn Easy Apply job; would open Easy Apply and fill it from your profile' });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { reason: stop });
    say('pressing Easy Apply');
    s = await call<LiState>({ type: 'LI_START' }).catch(() => s);
  }
  if (s.page !== 'step' && s.page !== 'review') return report('needs_me', { reason: `LinkedIn: the Easy Apply form did not open (${s.page})`, questions: ['Apply on LinkedIn yourself'] });
  if (mode === 'preview') return report('can_apply', { reason: 'dry run: LinkedIn Easy Apply form open; would fill it from your profile' });

  const history: AnswerHistory = new Map();
  let lastStep = '';
  let lastMoved = true;
  let stepData: FrameFormData | null = null;
  let stepAnswers: Awaited<ReturnType<typeof buildAnswers>>['answers'] = [];
  /** The error-fix agent on this step: re-read the form, fix each rejected field, then say what is left. */
  const fixErrors = async (): Promise<string[]> => {
    const fid = await frame();
    const again = await deps.send(fid, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
    const data = again?.ok && again.data ? { ...again.data, frameId: fid } as FrameFormData : stepData;
    if (!data) return [];
    say('fixing the answers LinkedIn rejected');
    const left = await fixPageErrors(deps, data, stepAnswers).catch(() => []);
    return left.map((e) => e.message);
  };
  for (let n = 0; n < MAX_STEPS; n += 1) {
    s = await state();
    stepData = null;
    stepAnswers = [];
    if (s.page === 'submitted') return report('applied', { ...base(), reason: 'LinkedIn confirmed: your application was sent' });
    // The dialog is gone (back on the job page): pressing on would only count steps to "more than 12 steps"
    // (2026-11-10, Time Hack Consulting: "step: job" after the contact step). Say where it closed.
    if (n > 0 && (s.page === 'job' || s.page === 'closed' || s.page === 'external')) {
      return report('needs_me', { ...base(), reason: `LinkedIn: the Easy Apply form closed after "${lastStep.slice(0, 80)}"`, questions: ['Finish the application on LinkedIn'] });
    }
    if (n > 0 && !lastMoved && s.step === lastStep && s.page === 'step') {
      return report('needs_me', { ...base(), reason: `LinkedIn: stuck on "${s.step.slice(0, 80)}"${s.errors.length ? `: ${s.errors.join('; ')}` : ''}`.slice(0, 300), questions: s.errors.length ? s.errors : ['Finish this step on LinkedIn'] });
    }
    lastStep = s.step;
    say(`step: ${s.step.slice(0, 80) || s.page}`);

    // Your resume, by name (the newest one named like yours).
    const picked = await call<{ ok: boolean; picked: string; why: string }>({ type: 'LI_RESUME', name: resumeName }).catch(() => null);
    if (picked?.picked) say(`resume: ${picked.picked}`);
    if (picked && !picked.ok && picked.why !== 'no dialog') {
      return report('needs_me', { ...base(), reason: `LinkedIn: ${picked.why}; pick your resume yourself`, questions: ['Pick your resume on LinkedIn'] });
    }

    // The step's questions: deterministic answers first, then the AI.
    const fid = await frame();
    const extracted = await deps.send(fid, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
    if (extracted?.ok && extracted.data) {
      const data = { ...extracted.data, frameId: fid } as FrameFormData;
      const open = data.fields.filter((f) => !f.current_value.trim() && f.type !== 'file' && !SKIP.test(f.label));
      if (open.length) {
        let built: Awaited<ReturnType<typeof buildAnswers>>;
        try {
          built = await buildAnswers({ ...data, fields: open }, { ...deps, abroad: resumeName === ABROAD_RESUME, jobLocation: where }, '', true);
        } catch (e) {
          return report('needs_me', { ...base(), reason: `LinkedIn: the AI could not answer (${String(e).slice(0, 150)})`, questions: open.filter((f) => f.required).map((f) => f.label) });
        }
        await deps.saveMemory(built.memory);
        const answers = built.answers.filter((a) => a.answer && a.answer !== 'NEEDS_USER_INPUT');
        await fillPageAnswers(deps, { ...data, fields: open }, answers);
        stepData = data;
        stepAnswers = answers;
        // LinkedIn checks a box as soon as it is filled ("Enter a decimal number…"): fix those before moving on.
        await fixErrors();
        filledAll.push(...answers.map((a) => ({ question: open.find((f) => f.id === a.field_id)?.label ?? '', answer: a.answer })));
        const missing = open.filter((f) => f.required && !answers.some((a) => a.field_id === f.id)).map((f) => f.label);
        if (missing.length) return report('needs_me', { ...base(), reason: `LinkedIn: no answer for ${missing.join('; ')}`.slice(0, 300), questions: missing });
      }
      for (const f of data.fields) history.set(f.id, { field: f, answer: filledAll.find((a) => a.question === f.label)?.answer ?? f.current_value });
    }

    if (s.page === 'review') {
      const check = await preSubmitCheck(deps, history, { ...job, url }, '');
      if (check.passed.length) say(`pre-submit check passed: ${check.passed.join('; ').slice(0, 200)}`);
      if (check.blocking.length) {
        const labels = findingLabels(check.blocking);
        return report('needs_me', { ...base(), reason: `LinkedIn pre-submit check: ${labels.join('; ')}`.slice(0, 300), questions: labels });
      }
      if (mode === 'fill') return report('ready', { ...base(), reason: 'LinkedIn: form filled and checked; press "Submit application" yourself' });
      const wait = await waitBeforeSubmit(deps, say);
      if (wait === 'submitted') return report('applied', { ...base(), reason: 'LinkedIn confirmed the application (submitted during the wait)' });
      if (wait) return report('stopped', { ...base(), reason: wait });
      const stop = await deps.mayClick();
      if (stop) return report('stopped', { ...base(), reason: stop });
      clicked = true;
      say('pressing "Submit application"');
      let after = await call<LiState & { moved: boolean }>({ type: 'LI_SUBMIT' }).catch(() => null);
      if (after && after.page !== 'submitted' && after.errors.length) {
        await fixErrors();
        after = await call<LiState & { moved: boolean }>({ type: 'LI_SUBMIT' }).catch(() => null);
      }
      const end = after ?? await state();
      if (end.page === 'submitted') return report('applied', { ...base(), reason: `LinkedIn confirmed: "${end.message || 'your application was sent'}"` });
      return report(end.errors.length ? 'needs_me' : 'no_confirmation', { ...base(), reason: end.errors.length ? `LinkedIn rejected Submit: ${end.errors.join('; ')}`.slice(0, 300) : 'LinkedIn: pressed Submit; no confirmation seen', questions: end.errors });
    }

    const stop = await deps.mayClick();
    if (stop) return report('stopped', { ...base(), reason: stop });
    let next = await call<LiState & { moved: boolean }>({ type: 'LI_NEXT' }).catch(() => null);
    if (next && !next.moved && next.errors.length) {
      await fixErrors();
      next = await call<LiState & { moved: boolean }>({ type: 'LI_NEXT' }).catch(() => null);
    }
    lastMoved = next?.moved ?? true;
    if (next && !next.moved && next.errors.length) {
      return report('needs_me', { ...base(), reason: `LinkedIn: ${next.errors.join('; ')}`.slice(0, 300), questions: next.errors });
    }
  }
  return report('needs_me', { ...base(), reason: `LinkedIn: more than ${MAX_STEPS} steps`, questions: ['Finish the application on LinkedIn'] });
}
