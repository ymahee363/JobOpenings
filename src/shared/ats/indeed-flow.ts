/**
 * Indeed Apply's applier (the page side is src/content/ats/indeed.ts): press "Apply now", keep your Indeed resume,
 * answer each step's questions with the general engine and the AI (deterministic answers first), press Continue,
 * then on the review step run the pre-submit check, wait 30 s and press "Submit your application" ('submit' mode),
 * or stop there for you ('fill' mode).
 */
import type { InState } from '../../content/ats/indeed';
import { buildAnswers, fillPageAnswers, findingLabels, preSubmitCheck, waitBeforeSubmit, type AnswerHistory, type FlowDeps, type FlowMode } from '../ai-apply/flow';
import type { FrameFormData } from '../ai-apply/types';
import type { ApplyReport } from '../auto-apply/runner';

const MAX_STEPS = 15;

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

export function isIndeedUrl(url: string): boolean {
  try {
    return /(^|\.)indeed\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function runIndeedApply(deps: FlowDeps, mode: FlowMode, job: { title: string; company: string }, url: string): Promise<ApplyReport> {
  const say = (t: string) => deps.status?.(`Indeed: ${t}`);
  let clicked = false;
  const filledAll: ApplyReport['answers'] = [];
  const base = () => ({ clicked, answers: filledAll.slice(0, 30) });
  const frame = async () => (await deps.frames())[0] ?? 0;
  const call = async <T>(msg: Record<string, unknown>): Promise<T & { ok?: boolean; error?: string }> =>
    (await deps.send(await frame(), msg)) as unknown as T & { ok?: boolean; error?: string };
  const state = () => call<InState>({ type: 'IN_STATE' }).catch(() => ({ page: 'unknown', step: '', errors: [] }) as InState);

  let s = await state();
  if (s.page === 'submitted') return report('applied', { reason: 'Indeed shows the application as sent' });
  if (s.page === 'external') return report('external', { reason: 'Indeed: this job applies on the company site' });
  if (s.page === 'job') {
    if (mode === 'preview') return report('can_apply', { reason: 'dry run: Indeed Apply job; would press "Apply now" and answer each step from your profile' });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { reason: stop });
    say('pressing "Apply now"');
    await call({ type: 'IN_START' }).catch(() => null);
    for (let i = 0; i < 20 && !['step', 'review', 'submitted'].includes(s.page); i += 1) {
      await deps.sleep(1_000);
      s = await state();
    }
  }
  if (s.page === 'submitted') return report('applied', { reason: 'Indeed shows the application as sent' });
  if (s.page !== 'step' && s.page !== 'review') return report('needs_me', { reason: `Indeed: no application step found (${s.page})`, questions: ['Apply on the page yourself'] });
  if (mode === 'preview') return report('can_apply', { reason: `dry run: Indeed Apply step ${s.step}; would answer it from your profile` });

  const history: AnswerHistory = new Map();
  let lastStep = '';
  for (let n = 0; n < MAX_STEPS; n += 1) {
    s = await state();
    if (s.page === 'submitted') return report('applied', { ...base(), reason: 'Indeed confirmed: application submitted' });
    if (s.step === lastStep && s.page === 'step') {
      return report('needs_me', { ...base(), reason: `Indeed: stuck on ${s.step}${s.errors.length ? `: ${s.errors.join('; ')}` : ''}`.slice(0, 300), questions: s.errors.length ? s.errors : [`Finish the "${s.step}" step on Indeed`] });
    }
    lastStep = s.step;
    say(`step ${s.step || s.page}`);

    // Supporting documents, on any step: press the Cover letter "Add"; Indeed brings in your cover letter text.
    const cover = await call<{ clicked: boolean; why: string }>({ type: 'IN_COVER' }).catch(() => null);
    if (cover?.clicked) {
      say(`cover letter: pressed "${cover.why}"`);
      await deps.sleep(800);
    }
    // Your resume: keep the one on your Indeed account (it is your profile's resume).
    if (/resume-selection/i.test(s.step)) {
      await call({ type: 'IN_RESUME', name: deps.resume?.name ?? '' }).catch(() => null);
    } else {
      // Questions, contact details, experience, cover letter: deterministic answers first, then the AI.
      let fid = await frame();
      // Supporting documents: open "Write / Add cover letter" so your cover letter text goes in (user, 2026-11-06).
      if (deps.coverLetter?.text?.trim()) {
        const opened = await deps.send(fid, { type: 'OPEN_COVER_LETTER' }).catch(() => null);
        if (opened?.opened) {
          say('opened the cover letter box');
          await deps.sleep(800);
          fid = await frame();
        }
      }
      const extracted = await deps.send(fid, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
      if (extracted?.ok && extracted.data) {
        const data = { ...extracted.data, frameId: fid } as FrameFormData;
        const open = data.fields.filter((f) => !f.current_value.trim());
        if (open.length) {
          const built = await buildAnswers({ ...data, fields: open }, deps, '', true);
          await deps.saveMemory(built.memory);
          const answers = built.answers.filter((a) => a.answer && a.answer !== 'NEEDS_USER_INPUT');
          await fillPageAnswers(deps, { ...data, fields: open }, answers);
          filledAll.push(...answers.map((a) => ({ question: open.find((f) => f.id === a.field_id)?.label ?? '', answer: a.answer })));
          const missing = open.filter((f) => f.required && f.type !== 'file' && !answers.some((a) => a.field_id === f.id)).map((f) => f.label);
          if (missing.length) return report('needs_me', { ...base(), reason: `Indeed: no answer for ${missing.join('; ')}`.slice(0, 300), questions: missing });
        }
        for (const f of data.fields) history.set(f.id, { field: f, answer: filledAll.find((a) => a.question === f.label)?.answer ?? f.current_value });
      }
    }

    if (s.page === 'review') {
      const check = await preSubmitCheck(deps, history, { ...job, url }, '');
      if (check.passed.length) say(`pre-submit check passed: ${check.passed.join('; ').slice(0, 200)}`);
      if (check.blocking.length) {
        const labels = findingLabels(check.blocking);
        return report('needs_me', { ...base(), reason: `Indeed pre-submit check: ${labels.join('; ')}`.slice(0, 300), questions: labels });
      }
      if (mode === 'fill') return report('ready', { ...base(), reason: 'Indeed: every step answered and checked; press "Submit your application" yourself' });
      const wait = await waitBeforeSubmit(deps, say);
      if (wait === 'submitted') return report('applied', { ...base(), reason: 'Indeed confirmed the application (submitted during the wait)' });
      if (wait) return report('stopped', { ...base(), reason: wait });
      const stop = await deps.mayClick();
      if (stop) return report('stopped', { ...base(), reason: stop });
      clicked = true;
      say('pressing "Submit your application"');
      const after = await call<InState & { moved: boolean }>({ type: 'IN_SUBMIT' });
      if (after.page === 'submitted') return report('applied', { ...base(), reason: 'Indeed confirmed: application submitted' });
      return report(after.errors.length ? 'needs_me' : 'no_confirmation', { ...base(), reason: after.errors.length ? `Indeed rejected Submit: ${after.errors.join('; ')}`.slice(0, 300) : 'Indeed: pressed Submit; no confirmation seen', questions: after.errors });
    }

    const stop = await deps.mayClick();
    if (stop) return report('stopped', { ...base(), reason: stop });
    const next = await call<InState & { moved: boolean }>({ type: 'IN_CONTINUE' }).catch(() => null);
    if (next && !next.moved && next.errors.length) {
      return report('needs_me', { ...base(), reason: `Indeed: ${next.errors.join('; ')}`.slice(0, 300), questions: next.errors });
    }
    await deps.sleep(800);
  }
  return report('needs_me', { ...base(), reason: `Indeed: more than ${MAX_STEPS} steps`, questions: ['Finish the application on Indeed'] });
}
