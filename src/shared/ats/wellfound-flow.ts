/**
 * Wellfound's applier (the page side is src/content/ats/wellfound.ts): press Apply to open the application form
 * (opening it sends nothing), answer the employer's questions (deterministic answers first, then the AI), run the
 * pre-submit check, then wait and press "Send application" ('submit' mode), or stop there for you ('fill' mode).
 * 'preview' presses nothing.
 */
import type { WfState } from '../../content/ats/wellfound';
import { buildAnswers, fillPageAnswers, findingLabels, preSubmitCheck, waitBeforeSubmit, type AnswerHistory, type FlowDeps, type FlowMode } from '../ai-apply/flow';
import type { FrameFormData } from '../ai-apply/types';
import type { ApplyReport } from '../auto-apply/runner';

/** For required questions the AI left open the first time. */
export const RETRY_INSTRUCTION = 'Every question here is required: give your best honest answer from the resume and profile for each one, '
  + 'short and specific (a yes/no question gets Yes or No plus one line of how). Never answer NEEDS_USER_INPUT.';

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

export function isWellfoundJobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)wellfound\.com$/i.test(u.hostname) && /^\/jobs\/\d+(?:-[^/]*)?\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export async function runWellfoundApply(deps: FlowDeps, mode: FlowMode, job: { title: string; company: string }, url: string): Promise<ApplyReport> {
  const say = (t: string) => deps.status?.(`Wellfound: ${t}`);
  let clicked = false;
  const filledAll: ApplyReport['answers'] = [];
  const base = () => ({ clicked, answers: filledAll.slice(0, 30) });
  const frame = async () => (await deps.frames())[0] ?? 0;
  const unknown: WfState = { page: 'unknown', questions: 0, errors: [], note: '' };
  const call = async <T = WfState>(type: string): Promise<T & WfState> => {
    const r = await deps.send(await frame(), { type }).catch(() => null) as (T & WfState & { ok?: boolean }) | null;
    return r?.ok ? r : { ...unknown } as T & WfState;
  };

  let s = await call('WF_STATE');
  // A slow page: give it a little longer.
  for (let i = 0; i < 8 && s.page === 'unknown'; i += 1) {
    await deps.sleep(1_000);
    s = await call('WF_STATE');
  }
  if (s.page === 'applied') return report('applied', { reason: `Wellfound shows this job as applied (${s.note})` });
  if (s.page === 'closed') return report('closed', { reason: s.note || 'Wellfound: the job is closed' });
  if (s.page === 'job') {
    if (mode === 'preview') return report('can_apply', { reason: 'dry run: Wellfound job; would press Apply, answer the form and press "Send application"' });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { reason: stop });
    say('pressing Apply (opens the form; nothing is sent yet)');
    s = await call<{ presses?: number }>('WF_START');
  }
  if (s.page === 'applied') return report('applied', { reason: `Wellfound shows this job as applied (${s.note})` });
  if (s.page !== 'form') {
    const pressed = (s as { presses?: number }).presses;
    return report('needs_me', {
      ...base(),
      reason: `Wellfound: no application form after Apply${pressed ? ` (pressed ${pressed}x)` : ''} (${s.page}${s.note ? `: ${s.note}` : ''}${s.errors.length ? `; ${s.errors.join('; ')}` : ''})`.slice(0, 300),
      questions: ['Apply on Wellfound yourself'],
    });
  }

  // 1. The employer's questions.
  const history: AnswerHistory = new Map();
  const fid = await frame();
  const extracted = await deps.send(fid, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
  if (!extracted?.ok || !extracted.data) return report('needs_me', { ...base(), reason: 'Wellfound: could not read the application form', questions: ['Apply on Wellfound yourself'] });
  const data = { ...extracted.data, frameId: fid } as FrameFormData;
  const open = data.fields.filter((f) => !f.current_value.trim() && f.type !== 'file');
  if (open.length) {
    say(`answering ${open.length} question(s)`);
    let built: Awaited<ReturnType<typeof buildAnswers>>;
    try {
      built = await buildAnswers({ ...data, fields: open }, deps, '', true);
    } catch (e) {
      return report('needs_me', { ...base(), reason: `Wellfound: the AI could not answer (${String(e).slice(0, 150)})`, questions: open.filter((f) => f.required).map((f) => f.label) });
    }
    await deps.saveMemory(built.memory);
    const answers = built.answers.filter((a) => a.answer && a.answer !== 'NEEDS_USER_INPUT');
    // A required question the AI left open (seen 2026-11-11: "Have you setup and ran LLM based evals?*"): ask once
    // more for its best answer from the resume, so the run does not stop on it.
    const skipped = open.filter((f) => f.required && !answers.some((a) => a.field_id === f.id));
    if (skipped.length) {
      say(`asking again for ${skipped.length} required question(s)`);
      const retry = await buildAnswers({ ...data, fields: skipped }, { ...deps, memory: built.memory }, RETRY_INSTRUCTION, true).catch(() => null);
      if (retry) {
        await deps.saveMemory(retry.memory);
        answers.push(...retry.answers.filter((a) => a.answer && a.answer !== 'NEEDS_USER_INPUT' && skipped.some((f) => f.id === a.field_id)));
      }
    }
    await fillPageAnswers(deps, { ...data, fields: open }, answers);
    filledAll.push(...answers.map((a) => ({ question: open.find((f) => f.id === a.field_id)?.label ?? '', answer: a.answer })));
    const missing = open.filter((f) => f.required && !answers.some((a) => a.field_id === f.id)).map((f) => f.label);
    if (missing.length) return report('needs_me', { ...base(), reason: `Wellfound: no answer for ${missing.join('; ')}`.slice(0, 300), questions: missing });
  }
  for (const f of data.fields) history.set(f.id, { field: f, answer: filledAll.find((a) => a.question === f.label)?.answer ?? f.current_value });

  // 2. The pre-submit check.
  const check = await preSubmitCheck(deps, history, { ...job, url }, '');
  if (check.passed.length) say(`pre-submit check passed: ${check.passed.join('; ').slice(0, 200)}`);
  if (check.blocking.length) {
    const labels = findingLabels(check.blocking);
    return report('needs_me', { ...base(), reason: `Wellfound pre-submit check: ${labels.join('; ')}`.slice(0, 300), questions: labels });
  }
  if (mode !== 'submit') return report('ready', { ...base(), reason: 'Wellfound: form answered and checked; press "Send application" yourself' });

  // 3. The wait, then "Send application".
  const wait = await waitBeforeSubmit(deps, say);
  if (wait === 'submitted') return report('applied', { ...base(), clicked: true, reason: 'Wellfound confirmed the application (sent during the wait)' });
  if (wait) return report('stopped', { ...base(), reason: wait });
  const stop = await deps.mayClick();
  if (stop) return report('stopped', { ...base(), reason: stop });
  clicked = true;
  say('pressing "Send application"');
  const after = await call<{ sent?: boolean }>('WF_SEND');
  if (after.sent || after.page === 'applied') return report('applied', { ...base(), reason: `Wellfound: application sent (${after.note || 'form closed'})` });
  if (after.errors.length) return report('needs_me', { ...base(), reason: `Wellfound rejected "Send application": ${after.errors.join('; ')}`.slice(0, 300), questions: after.errors });
  return report('no_confirmation', { ...base(), reason: `Wellfound: pressed "Send application"; the form did not close (${after.page})` });
}
