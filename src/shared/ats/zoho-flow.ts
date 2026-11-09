/**
 * Zoho Recruit's applier (the page side is src/content/ats/zoho.ts): press "I'm interested", fill your details,
 * education and every job with their month/year dropdowns, attach your resume, answer what is left with the general
 * engine (and the AI), run the pre-submit check, then wait for you to type the CAPTCHA (only you do), wait 30 s
 * after your last change and press Submit Application. In 'fill' mode it stops before Submit for you.
 */
import type { WorkdayPlan } from '../../content/ats/workday';
import type { ZhFillResult, ZhState } from '../../content/ats/zoho';
import { buildAnswers, findingLabels, preSubmitCheck, waitBeforeSubmit, type AnswerHistory, type FlowDeps, type FlowMode } from '../ai-apply/flow';
import type { ApplyReport } from '../auto-apply/runner';
import type { FrameFormData } from '../ai-apply/types';

/** How long to wait for you to type the CAPTCHA before leaving the application for you. */
export const CAPTCHA_WAIT_MS = 10 * 60_000;
const CAPTCHA_FIELD = /captcha|below image|image text|security (check|code)/i;

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});
const hostOf = (url: string) => {
  try { return new URL(url).hostname; } catch { return 'the site'; }
};

export function runZohoApply(deps: FlowDeps, mode: FlowMode, plan: WorkdayPlan, url: string, job: { title: string; company: string }): Promise<ApplyReport> {
  return runCaptchaFormApply(deps, mode, plan, url, job, { name: 'Zoho Recruit', prefix: 'ZH', startLabel: '"I\'m interested"', submitLabel: 'Submit Application' });
}

/** Keka Hire (src/content/ats/keka.ts): the same steps; its form has an image CAPTCHA and "Apply Now". */
export function runKekaApply(deps: FlowDeps, mode: FlowMode, plan: WorkdayPlan, url: string, job: { title: string; company: string }): Promise<ApplyReport> {
  return runCaptchaFormApply(deps, mode, plan, url, job, { name: 'Keka', prefix: 'KK', startLabel: 'Apply', submitLabel: 'Apply Now' });
}

interface CaptchaFormSite { name: string; prefix: 'ZH' | 'KK'; startLabel: string; submitLabel: string }

/** A one-page form with an image CAPTCHA you type: open it, fill it, check it, wait for the CAPTCHA, submit. */
async function runCaptchaFormApply(deps: FlowDeps, mode: FlowMode, plan: WorkdayPlan, url: string, job: { title: string; company: string }, site: CaptchaFormSite): Promise<ApplyReport> {
  const N = site.name;
  const say = (t: string) => deps.status?.(`${N}: ${t}`);
  let clicked = false;
  const filledAll: ApplyReport['answers'] = [];
  const base = () => ({ clicked, answers: filledAll.slice(0, 30) });
  const frame = async () => (await deps.frames())[0] ?? 0;
  const call = async <T>(msg: Record<string, unknown>): Promise<T & { ok?: boolean; error?: string }> =>
    (await deps.send(await frame(), msg)) as unknown as T & { ok?: boolean; error?: string };
  const host = hostOf(url);

  let state = await call<ZhState>({ type: `${site.prefix}_STATE` });
  if (state.page === 'submitted') return report('applied', { reason: `${host} shows the application as submitted` });
  if (state.page === 'job') {
    if (mode === 'preview') return report('can_apply', { reason: `dry run: ${N} job; would press ${site.startLabel} and fill the form from your profile` });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { reason: stop });
    clicked = true;
    say(`pressing ${site.startLabel}`);
    state = await call<ZhState>({ type: `${site.prefix}_START` }).catch(() => state);
    // Pressing it may load another page: ask again until the form is there.
    for (let i = 0; i < 15 && state.page !== 'form'; i += 1) {
      await deps.sleep(1_000);
      state = await call<ZhState>({ type: `${site.prefix}_STATE` }).catch(() => state);
    }
  }
  if (state.page !== 'form') return report('needs_me', { ...base(), reason: `${N}: no application form found (${state.page})`, questions: ['Apply on the page yourself'] });
  if (mode === 'preview') return report('can_apply', { reason: `dry run: ${N} form; would fill it from your profile` });

  // 1. Your details, education, jobs and resume.
  say('filling your details, education and work experience');
  const filled = await call<ZhFillResult>({ type: `${site.prefix}_FILL`, plan, email: deps.profile.email });
  say(`filled ${filled.filled?.length ?? 0} item(s)${filled.failed?.length ? `; could not: ${filled.failed.join('; ').slice(0, 160)}` : ''}`);

  // 2. Whatever else the form asks: the general engine and the AI (the CAPTCHA and files aside).
  const history: AnswerHistory = new Map();
  const extracted = await deps.send(await frame(), { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
  if (extracted?.ok && extracted.data) {
    const data = { ...extracted.data, frameId: await frame() } as FrameFormData;
    const open = data.fields.filter((f) => !f.current_value.trim() && f.type !== 'file' && !CAPTCHA_FIELD.test(f.label));
    if (open.length) {
      const built = await buildAnswers({ ...data, fields: open }, deps, '', true);
      await deps.saveMemory(built.memory);
      const answers = built.answers.filter((a) => a.answer && a.answer !== 'NEEDS_USER_INPUT');
      if (answers.length) {
        await deps.send(data.frameId, { type: 'FILL_FIELDS', answers: answers.map((a) => ({ ...a, label: open.find((f) => f.id === a.field_id)?.label })) }).catch(() => null);
        filledAll.push(...answers.map((a) => ({ question: open.find((f) => f.id === a.field_id)?.label ?? '', answer: a.answer })));
      }
      const missing = open.filter((f) => f.required && !answers.some((a) => a.field_id === f.id)).map((f) => f.label);
      if (missing.length) return report('needs_me', { ...base(), reason: `${N}: no answer for ${missing.join('; ')}`.slice(0, 300), questions: missing });
    }
    for (const f of data.fields) history.set(f.id, { field: f, answer: f.current_value });
  }

  // 3. The pre-submit check: experience, education, links, messages.
  const check = await preSubmitCheck(deps, history, { ...job, url }, '');
  // The CAPTCHA is yours to type: never a finding.
  const blocking = check.blocking.filter((f) => !CAPTCHA_FIELD.test(f.label));
  if (check.passed.length) say(`pre-submit check passed: ${check.passed.join('; ').slice(0, 200)}`);
  if (blocking.length) {
    const labels = findingLabels(blocking);
    return report('needs_me', { ...base(), reason: `${N} pre-submit check: ${labels.join('; ')}`.slice(0, 300), questions: labels });
  }
  if (mode === 'fill') {
    return report('ready', { ...base(), reason: `${N}: form filled and checked; type the CAPTCHA and press "${site.submitLabel}" yourself` });
  }

  // 4. The CAPTCHA (yours to type), then the wait, then Submit. A wrong CAPTCHA: Zoho shows a new one; type again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    state = await call<ZhState>({ type: `${site.prefix}_STATE` });
    if (state.page === 'submitted') return report('applied', { ...base(), reason: `${host} confirmed the application` });
    if (state.captcha && !state.captchaFilled) {
      say('type the CAPTCHA in the tab; I submit 30 s after your last change');
      const until = deps.now() + CAPTCHA_WAIT_MS;
      while (deps.now() < until && !state.captchaFilled && state.page === 'form') {
        await deps.sleep(2_000);
        state = await call<ZhState>({ type: `${site.prefix}_STATE` });
      }
      if (state.page === 'submitted') return report('applied', { ...base(), reason: `${host} confirmed the application` });
      if (!state.captchaFilled) {
        return report('needs_me', { ...base(), reason: `${N}: the form is filled; type the CAPTCHA and press "${site.submitLabel}"`, questions: [`Type the CAPTCHA on ${host} and submit`] });
      }
    }
    const wait = await waitBeforeSubmit(deps, say);
    if (wait === 'submitted') return report('applied', { ...base(), reason: `${host} confirmed the application (submitted during the wait)` });
    if (wait) return report('stopped', { ...base(), reason: wait });
    const stop = await deps.mayClick();
    if (stop) return report('stopped', { ...base(), reason: stop });
    clicked = true;
    say('pressing ${site.submitLabel}');
    const after = await call<ZhState & { moved: boolean }>({ type: `${site.prefix}_SUBMIT` });
    if (after.page === 'submitted') return report('applied', { ...base(), reason: `${host} confirmed the application` });
    const captchaWrong = after.errors.some((e) => /captcha|image text|security/i.test(e)) || (after.captcha && !after.captchaFilled);
    if (!captchaWrong) {
      return report(after.errors.length ? 'needs_me' : 'no_confirmation', { ...base(), reason: after.errors.length ? `${N} rejected Submit: ${after.errors.join('; ')}`.slice(0, 300) : `${N}: pressed ${site.submitLabel}; no confirmation seen`, questions: after.errors });
    }
    say('the CAPTCHA was not accepted; type the new one');
  }
  return report('needs_me', { ...base(), reason: `${N}: the CAPTCHA was not accepted three times`, questions: [`Type the CAPTCHA on ${host} and submit`] });
}
