/**
 * Lever's applier (the page side is src/content/ats/lever.ts): open the form ("Apply for this job"), attach your
 * resume and fill your details from your profile, answer the employer's questions with the general engine and the AI
 * (deterministic answers first), run the pre-submit check, then wait 30 s and press "Submit application" ('submit'
 * mode), or stop there for you ('fill' mode). An hCaptcha challenge after Submit is yours to solve; the flow waits.
 */
import type { LvFillResult, LvState } from '../../content/ats/lever';
import type { WorkdayPlan } from '../../content/ats/workday';
import { buildAnswers, fillPageAnswers, findingLabels, preSubmitCheck, waitBeforeSubmit, type AnswerHistory, type FlowDeps, type FlowMode } from '../ai-apply/flow';
import type { FrameFormData } from '../ai-apply/types';
import type { ApplyReport } from '../auto-apply/runner';

/** How long to wait for you to solve an hCaptcha challenge. */
export const CHALLENGE_WAIT_MS = 10 * 60_000;

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

export async function runLeverApply(deps: FlowDeps, mode: FlowMode, plan: WorkdayPlan, url: string, job: { title: string; company: string }): Promise<ApplyReport> {
  const say = (t: string) => deps.status?.(`Lever: ${t}`);
  let clicked = false;
  const filledAll: ApplyReport['answers'] = [];
  const base = () => ({ clicked, answers: filledAll.slice(0, 30) });
  const frame = async () => (await deps.frames())[0] ?? 0;
  const call = async <T>(msg: Record<string, unknown>): Promise<T & { ok?: boolean; error?: string }> =>
    (await deps.send(await frame(), msg)) as unknown as T & { ok?: boolean; error?: string };
  const state = () => call<LvState>({ type: 'LV_STATE' }).catch(() => ({ page: 'unknown', challenge: false, errors: [] }) as LvState);

  let s = await state();
  if (s.page === 'submitted') return report('applied', { reason: 'Lever shows the application as submitted' });
  if (s.page === 'job') {
    if (mode === 'preview') return report('can_apply', { reason: 'dry run: Lever job; would press "Apply for this job" and fill the form from your profile' });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { reason: stop });
    clicked = true;
    say('pressing "Apply for this job"');
    await call({ type: 'LV_START' }).catch(() => null);
    for (let i = 0; i < 15 && s.page !== 'form'; i += 1) {
      await deps.sleep(1_000);
      s = await state();
    }
  }
  if (s.page !== 'form') return report('needs_me', { ...base(), reason: `Lever: no application form found (${s.page})`, questions: ['Apply on the page yourself'] });
  if (mode === 'preview') return report('can_apply', { reason: 'dry run: Lever form; would fill it from your profile' });

  // 1. Resume and your details.
  say('attaching your resume and filling your details');
  const p = deps.profile;
  const current = plan.jobs.find((j) => j.current) ?? plan.jobs[0];
  const filled = await call<LvFillResult>({
    type: 'LV_FILL',
    input: {
      name: p.name, email: p.email, phone: p.phone || plan.phone, location: p.location || plan.city || '',
      company: current?.company ?? '', linkedin: p.linkedin, portfolio: p.portfolio, websites: plan.websites, resume: plan.resume ?? null,
    },
  });
  say(`filled ${filled.filled?.length ?? 0} item(s)${filled.failed?.length ? `; could not: ${filled.failed.join('; ').slice(0, 160)}` : ''}`);

  // 2. The employer's questions: deterministic answers first, then the AI.
  const history: AnswerHistory = new Map();
  const fid = await frame();
  const extracted = await deps.send(fid, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
  if (extracted?.ok && extracted.data) {
    const data = { ...extracted.data, frameId: fid } as FrameFormData;
    const open = data.fields.filter((f) => !f.current_value.trim() && f.type !== 'file');
    if (open.length) {
      say(`answering ${open.length} question(s)`);
      // The job description lives on the posting page, not /apply: the AI needs it for "why us" questions.
      const posting = await call<{ text: string }>({ type: 'LV_POSTING' }).catch(() => ({ text: '' }));
      const pageText = [posting.text ? `JOB DESCRIPTION:\n${posting.text}` : '', data.page_text ?? ''].filter(Boolean).join('\n\n');
      let built: Awaited<ReturnType<typeof buildAnswers>>;
      try {
        built = await buildAnswers({ ...data, page_text: pageText, fields: open }, deps, '', true);
      } catch (e) {
        return report('needs_me', { ...base(), reason: `Lever: the AI could not answer (${String(e).slice(0, 150)})`, questions: open.filter((f) => f.required).map((f) => f.label) });
      }
      await deps.saveMemory(built.memory);
      const answers = built.answers.filter((a) => a.answer && a.answer !== 'NEEDS_USER_INPUT');
      await fillPageAnswers(deps, { ...data, fields: open }, answers);
      filledAll.push(...answers.map((a) => ({ question: open.find((f) => f.id === a.field_id)?.label ?? '', answer: a.answer })));
      const missing = open.filter((f) => f.required && !answers.some((a) => a.field_id === f.id)).map((f) => f.label);
      if (missing.length) return report('needs_me', { ...base(), reason: `Lever: no answer for ${missing.join('; ')}`.slice(0, 300), questions: missing });
    }
    for (const f of data.fields) history.set(f.id, { field: f, answer: filledAll.find((a) => a.question === f.label)?.answer ?? f.current_value });
  }

  // 3. The pre-submit check.
  const check = await preSubmitCheck(deps, history, { ...job, url }, '');
  if (check.passed.length) say(`pre-submit check passed: ${check.passed.join('; ').slice(0, 200)}`);
  if (check.blocking.length) {
    const labels = findingLabels(check.blocking);
    return report('needs_me', { ...base(), reason: `Lever pre-submit check: ${labels.join('; ')}`.slice(0, 300), questions: labels });
  }
  if (mode === 'fill') return report('ready', { ...base(), reason: 'Lever: form filled and checked; press "Submit application" yourself' });

  // 4. The wait, Submit, and any hCaptcha challenge (yours to solve).
  const wait = await waitBeforeSubmit(deps, say);
  if (wait === 'submitted') return report('applied', { ...base(), reason: 'Lever confirmed the application (submitted during the wait)' });
  if (wait) return report('stopped', { ...base(), reason: wait });
  const stop = await deps.mayClick();
  if (stop) return report('stopped', { ...base(), reason: stop });
  clicked = true;
  say('pressing "Submit application"');
  // A sent application loads …/thanks, which ends the page's answer to LV_SUBMIT: then read the new page instead.
  let after = await call<LvState & { moved: boolean }>({ type: 'LV_SUBMIT' }).catch(() => null)
    ?? { page: 'unknown', challenge: false, errors: [], moved: false } as LvState & { moved: boolean };
  for (let i = 0; i < 10 && after.page === 'unknown'; i += 1) {
    await deps.sleep(1_500);
    const where = await deps.currentUrl?.().catch(() => '') ?? '';
    if (/\/thanks\/?(\?|#|$)/.test(where)) return report('applied', { ...base(), reason: 'Lever confirmed: application submitted (thanks page)' });
    after = { ...(await state()), moved: false };
  }
  if (after.page === 'submitted') return report('applied', { ...base(), reason: 'Lever confirmed: application submitted' });
  if (after.challenge) {
    say('solve the hCaptcha challenge in the tab; Lever sends the application when it is solved');
    const until = deps.now() + CHALLENGE_WAIT_MS;
    let st: LvState = after;
    while (deps.now() < until && st.page !== 'submitted' && (st.challenge || !st.errors.length)) {
      await deps.sleep(2_000);
      st = await state();
    }
    if (st.page === 'submitted') return report('applied', { ...base(), reason: 'Lever confirmed: application submitted' });
    after = { ...st, moved: false };
    if (!st.errors.length) return report('needs_me', { ...base(), reason: 'Lever: the form is filled; solve the hCaptcha and press "Submit application"', questions: ['Solve the hCaptcha on Lever and submit'] });
  }
  return report(after.errors.length ? 'needs_me' : 'no_confirmation', {
    ...base(),
    reason: after.errors.length ? `Lever rejected Submit: ${after.errors.join('; ')}`.slice(0, 300) : 'Lever: pressed Submit; no confirmation seen',
    questions: after.errors,
  });
}
