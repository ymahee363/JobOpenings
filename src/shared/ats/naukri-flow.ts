/**
 * Naukri's applier (the page side is src/content/ats/naukri.ts): press Apply, then answer the recruiter's chatbot
 * questions one by one (deterministic answers first, then the AI) and press Save after each, until Naukri shows its
 * "Applied to …" confirmation. A company-site job is left to the general flow ('external').
 *
 * Naukri has no review page: pressing Apply (or Save on the last question) sends the application. So 'fill' mode
 * answers the first question and stops before Save; only 'submit' mode presses Apply on a job with no questions.
 */
import type { NkState } from '../../content/ats/naukri';
import { buildAnswers, fillPageAnswers, waitBeforeSubmit, type FlowDeps, type FlowMode } from '../ai-apply/flow';
import type { FrameFormData } from '../ai-apply/types';
import type { ApplyReport } from '../auto-apply/runner';
import { naukriApplyResult } from '../auto-apply/job-page';

const MAX_QUESTIONS = 30;
/** Naukri's chatbot answers: at most 99 characters (user, 2026-11-10; Naukri only). */
export const NAUKRI_MAX_CHARS = 99;
/** The wait before each Save on Naukri, to look the answer over: 10 s (user, 2026-11-10; other sites keep 30 s). */
export const NAUKRI_SAVE_WAIT_MS = 10_000;

/** An answer cut to `max` characters at the last whole word (a single long word is cut hard). */
export function capAnswer(answer: string, max = NAUKRI_MAX_CHARS): string {
  const a = answer.replace(/\s+/g, ' ').trim();
  if (a.length <= max) return a;
  const cut = a.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : a.slice(0, max)).replace(/[\s,;:–—-]+$/, '');
}

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

export function isNaukriJobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)naukri\.com$/i.test(u.hostname) && (/^\/job-listings-/.test(u.pathname) || u.pathname.startsWith('/myapply/saveApply') || isNaukriExpired(u.href));
  } catch {
    return false;
  }
}

/** Naukri sends an expired job's page to a search page with `expJD=true` (e.g. /product-manager-jobs-in-bengaluru?expJD=true). */
export function isNaukriExpired(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)naukri\.com$/i.test(u.hostname) && u.searchParams.get('expJD') === 'true';
  } catch {
    return false;
  }
}

export async function runNaukriApply(deps: FlowDeps, mode: FlowMode, _job: { title: string; company: string }): Promise<ApplyReport> {
  const say = (t: string) => deps.status?.(`Naukri: ${t}`);
  let clicked = false;
  const filledAll: ApplyReport['answers'] = [];
  const base = () => ({ clicked, answers: filledAll.slice(0, 30) });
  const frame = async () => (await deps.frames())[0] ?? 0;
  const unknown: NkState = { page: 'unknown', question: '', errors: [] };
  const where = async () => deps.currentUrl?.().catch(() => '') ?? '';
  // This job's id, from its page address: Naukri's confirmation lists a response code per job id.
  const jobId = /-(\d{6,})\/?(?:[?#]|$)/.exec(await where())?.[1];
  // After the last answer Naukri loads its confirmation page, which ends the old page's reply: read the new page.
  const call = async (type: string): Promise<NkState & { moved?: boolean }> => {
    const r = await deps.send(await frame(), { type }).catch(() => null) as (NkState & { ok?: boolean; moved?: boolean }) | null;
    if (r?.ok) return r;
    for (let i = 0; i < 8; i += 1) {
      await deps.sleep(1_500);
      if (naukriApplyResult(await where()).status !== 'none') return { page: 'applied', question: '', errors: [] };
      const s = await deps.send(await frame(), { type: 'NK_STATE' }).catch(() => null) as (NkState & { ok?: boolean }) | null;
      if (s?.ok) return s;
    }
    return unknown;
  };
  // "Applied" is only Naukri's own word for it: on its confirmation page, a 200 for this job; the same page with
  // another code is a failure (user, 2026-11-10). The success message is kept in the report.
  const applied = async (why: string): Promise<ApplyReport> => {
    const r = naukriApplyResult(await where(), jobId);
    if (r.status === 'failed') return report('error', { ...base(), reason: r.message });
    return report('applied', { ...base(), reason: r.status === 'applied' ? `${r.message}; ${why}` : `Naukri shows "Applied" on the job page; ${why}` });
  };

  // An expired job: 'closed', which takes it off the board (user, 2026-11-10).
  if (isNaukriExpired(await where())) return report('closed', { reason: 'Naukri: this job has expired (its page redirects to a search with expJD=true)' });
  let s = await call('NK_STATE');
  if (s.page === 'applied') return report('applied', { reason: 'Naukri shows this job as applied' });
  if (s.page === 'external') return report('external', { reason: 'Naukri: this job applies on the company site' });
  if (s.page === 'job') {
    if (mode !== 'submit') return report('can_apply', { reason: `${mode === 'preview' ? 'dry run' : 'fill'}: Naukri Easy Apply job; pressing Apply may send the application at once, so only submit mode presses it` });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { reason: stop });
    clicked = true;
    say('pressing Apply');
    s = await call('NK_START');
    if (s.page === 'applied') return await applied('applied with one click (no questions)');
  }
  // A slow page: give it a little longer before giving up.
  for (let i = 0; i < 8 && s.page === 'unknown'; i += 1) {
    await deps.sleep(1_000);
    s = await call('NK_STATE');
  }
  if (s.page === 'applied') return await applied('applied after a slow page load');
  if (s.page !== 'chat') {
    const pressed = (s as { presses?: number }).presses;
    return report('needs_me', { ...base(), reason: `Naukri: after Apply${pressed ? ` (pressed ${pressed}x)` : ''} no questions or confirmation (${s.page}${s.errors.length ? `: ${s.errors.join('; ')}` : ''})`.slice(0, 300), questions: ['Apply on the page yourself'] });
  }

  let last = '';
  for (let n = 0; n < MAX_QUESTIONS; n += 1) {
    // The bot may still be typing: wait for its question.
    for (let i = 0; i < 10 && s.page === 'chat' && !s.question; i += 1) {
      await deps.sleep(800);
      s = await call('NK_STATE');
    }
    if (s.page === 'applied') return await applied(`applied after ${n} question(s)`);
    if (s.page !== 'chat' || !s.question) return report('needs_me', { ...base(), reason: `Naukri: the questions stopped without a confirmation (${s.page})`, questions: ['Check the application on Naukri'] });
    if (s.question === last) {
      return report('needs_me', { ...base(), reason: `Naukri did not take the answer to "${s.question}"${s.errors.length ? `: ${s.errors.join('; ')}` : ''}`.slice(0, 300), questions: [s.question] });
    }
    last = s.question;
    say(`question ${n + 1}: ${s.question.slice(0, 80)}`);

    const fid = await frame();
    const extracted = await deps.send(fid, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
    const data = extracted?.ok && extracted.data ? { ...extracted.data, frameId: fid } as FrameFormData : null;
    const field = data?.fields[0];
    if (!data || !field) return report('needs_me', { ...base(), reason: `Naukri: could not read the question "${s.question}"`, questions: [s.question] });
    let built: Awaited<ReturnType<typeof buildAnswers>>;
    try {
      // Free text: tell the AI the limit (choices are Naukri's own words).
      const free = !field.options.length;
      built = await buildAnswers({ ...data, fields: [free ? { ...field, max_length: String(NAUKRI_MAX_CHARS) } : field] }, deps,
        free ? `Naukri accepts at most ${NAUKRI_MAX_CHARS} characters per answer: answer in under ${NAUKRI_MAX_CHARS} characters, short and complete.` : '', true);
    } catch (e) {
      return report('needs_me', { ...base(), reason: `Naukri: the AI could not answer (${String(e).slice(0, 150)})`, questions: [field.label] });
    }
    await deps.saveMemory(built.memory);
    const found = built.answers.find((a) => a.field_id === field.id && a.answer && a.answer !== 'NEEDS_USER_INPUT');
    const answer = found && !field.options.length ? { ...found, answer: capAnswer(found.answer) } : found;
    if (!answer) return report('needs_me', { ...base(), reason: `Naukri: no answer for "${field.label}"`.slice(0, 300), questions: [field.label] });
    await fillPageAnswers(deps, { ...data, fields: [field] }, [answer]);
    filledAll.push({ question: field.label, answer: answer.answer });
    if (mode !== 'submit') return report('ready', { ...base(), reason: `Naukri: answered "${field.label.slice(0, 80)}"; press Save yourself (the last Save sends the application)` });

    // 10 s to read (and change) the answer before Save sends it; a change restarts the wait (user, 2026-11-10).
    const wait = await waitBeforeSubmit(deps, say, NAUKRI_SAVE_WAIT_MS);
    if (wait === 'submitted') return await applied('applied during the wait');
    if (wait) return report('stopped', { ...base(), reason: wait });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { ...base(), reason: stop });
    s = await call('NK_SEND');
    if (s.page === 'applied') return await applied(`applied after ${n + 1} question(s)`);
  }
  return report('needs_me', { ...base(), reason: `Naukri: more than ${MAX_QUESTIONS} questions`, questions: ['Finish the application on Naukri'] });
}
