/**
 * QA harness: the real AI apply flow (src/shared/ai-apply/flow.ts) running inside a test page, driving the real form
 * engine loaded in that page, for live checks in Chrome without reloading the extension. Built by
 * `npx esbuild scripts/qa-harness.ts --bundle --format=iife --outfile=qa/harness.js` and served by
 * scripts/qa-serve.cjs at /harness.js.
 *
 *   await window.__qaRun({ backend: 'http://127.0.0.1:8000' })   // with the real AI backend
 *   await window.__qaRun({ backend: 'http://127.0.0.1:8799/fake-limit' })   // an AI that is out of quota
 *   await window.__qaRun({ backend: '…', firstAnswers: { 'Why this role': 'Keen.' } })   // a bad first answer to repair
 *
 * Needs the engine loaded first (window.__send, as in .claude/agents/qa.md).
 */
import { runAiApply, type FlowDeps } from '../src/shared/ai-apply/flow';
import { backendClient } from '../src/shared/ai-apply/llm';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import { buildWorkdayPlan } from '../src/shared/ats/workday-plan';

type Send = (msg: Record<string, unknown>) => Promise<unknown>;

(window as unknown as { __qaRun: unknown }).__qaRun = async (opts: { backend: string; mode?: 'fill' | 'submit'; firstAnswers?: Record<string, string>; account?: { email: string; password: string } }) => {
  const send = (window as unknown as { __send: Send }).__send;
  const log: string[] = [];
  const aiFields: string[][] = [];
  const generate = backendClient({ url: opts.backend, accessKey: '' }, { onWait: (ms, why) => log.push(`waiting ${Math.round(ms / 1000)} s: ${why}`) });
  const resumeFile = { name: 'resume.pdf', type: 'application/pdf', data: btoa('%PDF-1.4 QA test resume'), text: '' };
  const deps: FlowDeps = {
    frames: async () => [0],
    send: (_frame, msg) => send(msg),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    // Your links (as in the golden tests' profile), so the pre-submit check has links to compare.
    profile: {
      ...DEFAULT_PROFILE, phone: '+91 62642 52896', location: 'Bangalore, India',
      linkedin: 'https://www.linkedin.com/in/mahendra-yadav/', portfolio: 'https://www.mahendrayadavpm.in/',
      custom_fields: [{ id: '1', name: 'Github', value: 'https://github.com/ymahee363' }],
    },
    resume: resumeFile,
    // The platform appliers (Workday, Zoho Recruit) take the page address and the plan built from the profile.
    currentUrl: async () => location.href,
    memory: {}, bank: [], saveMemory: async () => {}, mayClick: async () => null,
    // Test credentials for the local account test site only (tests/fixtures/forms/account-form.html).
    account: opts.account ?? null,
    // A real click is asked for: post where, and wait for a genuine (isTrusted) click there, made by the QA tool.
    clickTrusted: (x, y) => new Promise<boolean>((resolve) => {
      (window as unknown as { __needClick: unknown }).__needClick = { x, y };
      const done = (e: MouseEvent) => {
        if (!e.isTrusted) return;
        document.removeEventListener('click', done, true);
        (window as unknown as { __needClick: unknown }).__needClick = null;
        resolve(true);
      };
      document.addEventListener('click', done, true);
      setTimeout(() => { document.removeEventListener('click', done, true); resolve(false); }, 60_000);
    }),
    status: (t) => log.push(t),
    generate: async (req) => {
      aiFields.push(req.fields.map((f) => f.label));
      // Forced bad first answers (by label start), to see the error-fix agent and the real AI repair them.
      if (opts.firstAnswers && aiFields.length === 1) {
        const real = await generate(req);
        return real.map((a) => {
          const label = req.fields.find((f) => f.id === a.field_id)?.label ?? '';
          const key = Object.keys(opts.firstAnswers!).find((k) => label.startsWith(k));
          return key ? { ...a, answer: opts.firstAnswers![key]!, needs_user_input: false, confidence: 0.9 } : a;
        });
      }
      return generate(req);
    },
  };
  deps.workdayPlan = buildWorkdayPlan(deps.profile, { name: resumeFile.name, type: resumeFile.type, data: resumeFile.data });
  (window as unknown as { __log: string[] }).__log = log;
  const started = Date.now();
  const report = await runAiApply(deps, { mode: opts.mode ?? 'submit', job: { title: 'Product Manager', company: 'QA', url: location.href }, settleMs: 1_000, pageWaitMs: 5_000 });
  return { ms: Date.now() - started, report, log, aiFields };
};
