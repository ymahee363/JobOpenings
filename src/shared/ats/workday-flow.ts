/**
 * The Workday applier, agent side: drives Workday's wizard step by step with the page-side handlers in
 * src/content/ats/workday.ts. Chosen by runAiApply when the tab is on *.myworkdayjobs.com (src/shared/ats/detect.ts).
 *
 * Per step: fill what your profile knows (no AI), let the general engine answer any required field still empty
 * (the AI only for those), then Save and Continue. Workday's own error messages stop the run and are reported.
 * The final Submit is pressed only in 'submit' mode; 'fill' stops on Review for you; 'preview' only looks.
 */
import type { ApplyReport } from '../auto-apply/runner';
import type { FlowDeps, FlowMode } from '../ai-apply/flow';
import { buildAnswers, fillPageAnswers, findingLabels, preSubmitCheck, waitBeforeSubmit } from '../ai-apply/flow';
import { findPendingQuestions } from '../ai-apply/answer-rules';
import type { FrameFormData } from '../ai-apply/types';
import type { WorkdayPlan, WdState } from '../../content/ats/workday';

const MAX_STEPS = 12;
/** How long a run waits for you to fix a field Workday rejected before listing the job under "Needs me". */
const FIX_WAIT_MS = 5 * 60_000;

const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return 'the Workday site'; }
}

export async function runWorkdayApply(deps: FlowDeps, mode: FlowMode, plan: WorkdayPlan, url: string): Promise<ApplyReport> {
  const say = (t: string) => deps.status?.(`Workday: ${t}`);
  let clicked = false;
  let accountSteps = 0;
  const filledAll: ApplyReport['answers'] = [];
  const base = () => ({ clicked, answers: filledAll.slice(0, 30) });
  const frame = async () => (await deps.frames())[0] ?? 0;
  const callOnce = async <T>(msg: Record<string, unknown>): Promise<T & { ok?: boolean; error?: string }> =>
    (await deps.send(await frame(), msg)) as unknown as T & { ok?: boolean; error?: string };
  /**
   * A press that reloads the page (Apply → Apply Manually → the account page on Cisco, 2026-11-06) closes the
   * message channel before the answer: "A listener indicated an asynchronous response… channel closed". The run
   * failed there. Now: wait for the new page and read where the wizard is instead.
   */
  const call = async <T>(msg: Record<string, unknown>): Promise<T & { ok?: boolean; error?: string }> => {
    try {
      return await callOnce<T>(msg);
    } catch (e) {
      if (!/channel closed|Receiving end does not exist|message port closed|frame .*(removed|not found)|No tab with id|back\/forward cache/i.test(String(e))) throw e;
      for (let i = 0; i < 6; i += 1) {
        await deps.sleep(2_000);
        try {
          return (await callOnce<WdState>({ type: 'WD_STATE' })) as unknown as T & { ok?: boolean; error?: string };
        } catch {
          // still loading
        }
      }
      throw e;
    }
  };
  const press = async (_action: string): Promise<string | null> => {
    const stop = await deps.mayClick();
    if (stop) return stop;
    await deps.beforeClick?.();
    clicked = true;
    return null;
  };

  // A Workday page renders in stages: right after the Apply click it is briefly neither job, chooser, sign-in nor
  // step (Target wd5, 2026-11-05: "unexpected page (unknown)"). Wait for it to settle.
  /**
   * After a step the agent could not finish: watch the tab for up to FIX_WAIT_MS while you correct it. Returns the
   * new state once you moved to the next step yourself, or once nothing required is empty (then it presses Save
   * and Continue itself); null if nothing changed in time.
   */
  const waitForYourFix = async (step: string, why: string[]): Promise<WdState | null> => {
    say(`step "${step}" needs you: ${why.join('; ').slice(0, 160)}. Fix it in the tab and I will continue`);
    const until = deps.now() + FIX_WAIT_MS;
    while (deps.now() < until) {
      await deps.sleep(3_000);
      const s = await call<WdState & { empty?: string[] }>({ type: 'WD_STATE' }).catch(() => null);
      if (!s) continue;
      if (s.page !== 'step' || s.step !== step) return s; // you moved on (or submitted) yourself
      if (s.empty && s.empty.length === 0) {
        const stop = await press('WD_NEXT');
        if (stop) return null;
        const next = await call<WdState & { moved: boolean }>({ type: 'WD_NEXT' });
        if (next.moved || next.page === 'submitted') { say(`step "${step}" fixed; continuing`); return next; }
      }
    }
    return null;
  };

  /**
   * Required questions still empty: read them with their real options and answer each one (profile, remembered
   * answers, then the AI, which must pick from the options). Returns the questions nobody could answer.
   */
  const answerOpenQuestions = async (step: string): Promise<string[]> => {
    const got = await call<{ questions?: Array<{ id: string; label: string; type: string; options: string[] }> }>({ type: 'WD_UNANSWERED' }).catch(() => ({ questions: [] }));
    const qs = got.questions ?? [];
    if (!qs.length) return [];
    say(`step "${step}": answering ${qs.length} question(s): ${qs.map((q) => q.label).join('; ').slice(0, 140)}`);
    const fields = qs.map((q) => ({
      id: q.id, label: q.label, required: true, current_value: '',
      type: q.type === 'select' ? 'select' : q.type === 'radio' ? 'radio' : q.type === 'checkbox' ? 'checkbox' : q.type === 'textarea' ? 'textarea' : 'text',
      options: q.options,
    }));
    const data = { url, title: '', page_text: '', fields, frameId: await frame() } as unknown as FrameFormData;
    const built = await buildAnswers(data, deps, '', false);
    await deps.saveMemory(built.memory);
    const missing: string[] = [];
    for (const q of qs) {
      const a = built.answers.find((x) => x.field_id === q.id);
      if (!a || !a.answer || a.answer === 'NEEDS_USER_INPUT') { missing.push(q.label); continue; }
      const set = await call<{ set?: boolean }>({ type: 'WD_SET', id: q.id, answer: a.answer });
      if (set.set) filledAll.push({ question: q.label, answer: a.answer });
      else missing.push(q.label);
    }
    return missing;
  };

  let state = await call<WdState>({ type: 'WD_STATE' });
  for (let i = 0; i < 40 && state.page === 'unknown'; i += 1) {
    await deps.sleep(500);
    state = await call<WdState>({ type: 'WD_STATE' }).catch(() => state);
  }
  if (state.page === 'job' || state.page === 'chooser') {
    if (mode === 'preview') return report('can_apply', { reason: 'dry run: Workday job; would press Apply → Apply Manually and fill each step from your profile' });
    const stop = await press('WD_START');
    if (stop) return report('stopped', { ...base(), reason: stop });
    say('pressing Apply → Apply Manually');
    state = await call<WdState>({ type: 'WD_START' });
  }

  for (let i = 0; i < MAX_STEPS; i += 1) {
    // Any page may still be loading (Apply Manually reloads into the account page; Cisco 2026-11-06 was read blank,
    // "unexpected page (unknown)"): wait up to 20 s for it to show what it is.
    for (let j = 0; j < 40 && state.page === 'unknown'; j += 1) {
      await deps.sleep(500);
      state = await call<WdState>({ type: 'WD_STATE' }).catch(() => state);
    }
    if (state.page === 'submitted') return report('applied', { ...base(), reason: `${hostOf(url)} (Workday) ${state.errors?.includes('already applied') ? 'shows you already applied' : 'confirmed the application'}` });
    if (state.page === 'closed') return report('closed', { ...base(), reason: `${hostOf(url)} (Workday): the job is no longer open` });
    if (state.page === 'signIn' && deps.account?.email && deps.account.password && accountSteps < 3) {
      // The account agent (src/content/account.ts): Workday's Sign In or Create Account, with your .env account.
      accountSteps += 1;
      const stop = await press('ACCOUNT');
      if (stop) return report('stopped', { ...base(), reason: stop });
      say('account page: signing in or creating the account');
      type AccountReply = { outcome?: string; reason?: string; verification?: boolean; captcha?: boolean; page?: string; point?: { x: number; y: number } };
      let r = await call<AccountReply>({ type: 'ACCOUNT_STEP', email: deps.account.email, password: deps.account.password });
      // Workday's Create Account ignored the scripted press (Cisco, 2026-11-06): a real mouse click, then the result.
      if (r.outcome === 'no_effect' && r.point && deps.clickTrusted) {
        say('pressing Create Account / Sign In with a real click');
        if (await deps.clickTrusted(r.point.x, r.point.y)) r = await call<AccountReply>({ type: 'ACCOUNT_AFTER' });
      }
      if (r.outcome === 'no_effect') r = { ...r, outcome: 'stopped' };
      if (r.verification) return report('needs_me', { ...base(), reason: `${hostOf(url)} sent a verification email to ${deps.account.email}: confirm it, then run Apply with AI again`, questions: [`Confirm your ${hostOf(url)} account from your email`] });
      if (r.captcha) return report('needs_me', { ...base(), reason: `${hostOf(url)} shows a captcha on its sign-in page`, questions: [`Solve the captcha and sign in on ${hostOf(url)}`] });
      if (r.outcome !== 'stopped') {
        say(r.outcome === 'switched' ? String(r.reason) : r.page === 'signup' ? 'account created' : 'signed in');
        await deps.sleep(2_000);
        state = await call<WdState>({ type: 'WD_STATE' }).catch(() => state);
        continue;
      }
      say(`account: ${String(r.reason ?? '').slice(0, 160)}`);
    }
    if (state.page === 'signIn') {
      // Same wording as the general flow, so the board's "Sign in once" list picks it up.
      return report('needs_me', { ...base(), reason: `${hostOf(url)} wants you to sign in or create an account first; do that once in this browser, then run Apply with AI again`, questions: [`Sign in or create an account on ${hostOf(url)}`] });
    }
    if (state.page === 'review') {
      if (mode === 'preview') return report('can_apply', { ...base(), reason: 'dry run: every Workday step filled; would submit on Review' });
      // The pre-submit QA agent on Workday's Review page, which lists every section: all your companies with their
      // dates, IIT Guwahati, your links, and no other company named in a message.
      say('pre-submit check of the Review page');
      const check = await preSubmitCheck(deps, new Map(), { company: '', title: '', url }, '', true);
      if (check.passed.length) say(`pre-submit check passed: ${check.passed.join('; ').slice(0, 250)}`);
      if (check.blocking.length) {
        const labels = findingLabels(check.blocking);
        return report('needs_me', { ...base(), reason: `Workday pre-submit check: ${labels.join('; ')}`.slice(0, 300), questions: labels });
      }
      if (mode === 'fill') return report('ready', { ...base(), reason: 'Workday: every step filled, saved and checked on Review; press Submit yourself' });
      const wait = await waitBeforeSubmit(deps, say);
      if (wait === 'submitted') return report('applied', { ...base(), reason: `${hostOf(url)} (Workday) confirmed the application (submitted during the wait)` });
      if (wait) return report('stopped', { ...base(), reason: wait });
      const stop = await press('WD_SUBMIT');
      if (stop) return report('stopped', { ...base(), reason: stop });
      say('pressing Submit');
      const after = await call<WdState & { moved: boolean }>({ type: 'WD_SUBMIT' });
      if (after.page === 'submitted') return report('applied', { ...base(), reason: `${hostOf(url)} (Workday) confirmed the application` });
      if (after.errors?.length) return report('needs_me', { ...base(), reason: `Workday rejected Submit: ${after.errors.join('; ')}`.slice(0, 300), questions: after.errors });
      return report('no_confirmation', { ...base(), reason: 'Workday: pressed Submit; no confirmation seen' });
    }
    if (state.page !== 'step') {
      return report('needs_me', { ...base(), reason: `Workday: unexpected page (${state.page})${state.errors?.length ? `: ${state.errors.join('; ')}` : ''}`.slice(0, 300), questions: ['Finish the application on the page'] });
    }

    say(`step "${state.step}": filling from your profile`);
    const filled = await call<{ filled: string[]; failed: string[]; step: string; typing?: Array<{ id: string; text: string; label: string }> }>({ type: 'WD_FILL_STEP', plan });
    for (const f of filled.filled ?? []) filledAll.push({ question: f, answer: 'from profile' });
    // Dates: typed with real keystrokes (Workday ignores scripted values in its date boxes).
    for (const t of filled.typing ?? []) {
      const focus = await call<{ focused?: boolean }>({ type: 'WD_FOCUS', id: t.id });
      const typed = focus.focused && deps.typeTrusted ? await deps.typeTrusted(t.text) : false;
      if (!typed) (filled.failed ??= []).push(`${t.label} (date needs typing)`);
    }

    // Anything required still empty (custom questions): the general engine, with the AI only for these.
    const frameId = await frame();
    const extracted = await deps.send(frameId, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
    if (extracted?.ok && extracted.data) {
      const data = { ...extracted.data, frameId };
      const empty = data.fields.filter((f) => f.required && !f.current_value && f.type !== 'file');
      if (empty.length) {
        say(`step "${state.step}": ${empty.length} more question(s)`);
        const built = await buildAnswers({ ...data, fields: empty }, deps, '', false);
        await deps.saveMemory(built.memory);
        const pending = findPendingQuestions({ ...data, fields: empty }, built.answers);
        if (pending.length && mode !== 'preview') {
          return report('needs_me', { ...base(), reason: `Workday step "${state.step}": no answer for ${pending.map((p) => p.label).join('; ')}`.slice(0, 300), questions: pending.map((p) => p.label) });
        }
        if (mode !== 'preview') await fillPageAnswers(deps, data, built.answers);
      }
    }
    if (mode !== 'preview') await answerOpenQuestions(state.step);
    if (mode === 'preview') return report('can_apply', { ...base(), reason: `dry run: Workday step "${state.step}" filled (${filled.filled?.length ?? 0} from profile${filled.failed?.length ? `, could not set: ${filled.failed.join(', ')}` : ''})` });

    const stop = await press('WD_NEXT');
    if (stop) return report('stopped', { ...base(), reason: stop });
    const prev = state.step;
    let moved = await call<WdState & { moved: boolean; empty?: string[] }>({ type: 'WD_NEXT' });
    if (!moved.moved && moved.page !== 'submitted' && (moved.errors?.length || moved.empty?.length)) {
      // Tenants differ (Allstate wants Address Line 2 and State, GSK does not): fill again, this time every empty
      // field the general engine can answer, then try once more before asking you.
      say(`step "${prev}": Workday asked for more (${(moved.errors ?? []).join('; ').slice(0, 120)}); filling again`);
      const again = await call<{ filled: string[]; failed: string[]; typing?: Array<{ id: string; text: string; label: string }> }>({ type: 'WD_FILL_STEP', plan });
      for (const t of again.typing ?? []) {
        const focus = await call<{ focused?: boolean }>({ type: 'WD_FOCUS', id: t.id });
        if (focus.focused && deps.typeTrusted) await deps.typeTrusted(t.text);
      }
      const fid = await frame();
      const ex = await deps.send(fid, { type: 'EXTRACT_FORM' }).catch(() => null) as { ok?: boolean; data?: FrameFormData } | null;
      if (ex?.ok && ex.data) {
        const data = { ...ex.data, frameId: fid };
        const empty = data.fields.filter((f) => !f.current_value && f.type !== 'file');
        if (empty.length) {
          const built = await buildAnswers({ ...data, fields: empty }, deps, '', false);
          await deps.saveMemory(built.memory);
          await fillPageAnswers(deps, data, built.answers.filter((x) => x.answer && x.answer !== 'NEEDS_USER_INPUT'));
        }
      }
      await answerOpenQuestions(prev);
      const stop2 = await press('WD_NEXT');
      if (stop2) return report('stopped', { ...base(), reason: stop2 });
      moved = await call<WdState & { moved: boolean; empty?: string[] }>({ type: 'WD_NEXT' });
    }
    if (!moved.moved && moved.page !== 'submitted') {
      // Workday's message if it shows one, else the required fields still empty, else what could not be set.
      const why = moved.errors?.length ? moved.errors
        : moved.empty?.length ? moved.empty.map((e) => `"${e}" is still empty`)
        : [...(filled.failed ?? []).map((f) => `could not set ${f}`), 'Save and Continue did not move on'];
      // Let you fix it in the tab: wait for the field(s) to be filled (or for you to move on yourself), then carry
      // on with the remaining steps instead of giving up.
      const resumed = await waitForYourFix(prev, why);
      if (!resumed) return report('needs_me', { ...base(), reason: `Workday step "${prev}": ${why.join('; ')}`.slice(0, 300), questions: why });
      state = resumed;
      continue;
    }
    state = moved;
  }
  return report('needs_me', { ...base(), reason: `Workday: more than ${MAX_STEPS} steps`, questions: ['Finish the application on the page'] });
}
