import { z } from 'zod';

const SiteSchema = z.enum(['naukri', 'indeed', 'instahyre', 'wellfound', 'linkedin', 'cutshort', 'foundit', 'iimjobs']);

const Answer = z.object({ question: z.string().max(300), answer: z.string().max(500) });
const Dialog = z.object({
  title: z.string().max(300),
  fields: z.array(z.object({
    label: z.string().max(300),
    kind: z.enum(['text', 'number', 'textarea', 'select', 'radio', 'checkbox', 'file', 'other']),
    required: z.boolean(),
    options: z.array(z.string().max(200)).max(50),
  })).max(30),
  buttons: z.array(z.string().max(100)).max(20),
});

/** The auto-apply agent's request to the applier in a job page tab it opened. */
export const ApplyRunMessage = z.object({
  type: z.literal('apply-run'),
  /** Ties the report to this run; a report with another token is ignored. */
  token: z.string().regex(/^[a-z0-9]{8,64}$/),
  dryRun: z.boolean(),
  fillForms: z.boolean(),
  answers: z.array(Answer).max(200),
});
export type ApplyRunMessage = z.infer<typeof ApplyRunMessage>;

/** Messages from the content scripts on the job sites to the service worker. Validated on arrival. */
export const CollectorMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('capture'),
    site: SiteSchema,
    source: z.enum(['network', 'storage', 'page']),
    feed: z.string().max(64).nullable(),
    url: z.string().max(2048),
    payload: z.unknown(),
  }),
  z.object({ type: z.literal('capture-done'), url: z.string().max(2048) }),
  z.object({ type: z.literal('page-state'), site: SiteSchema, state: z.enum(['ok', 'logged_out', 'captcha']), url: z.string().max(2048) }),
  z.object({ type: z.literal('applied-detected'), jobId: z.string().regex(/^\d{6,20}$/) }),
  /** An Instahyre page the app opened could not find the saved search it was asked to run. */
  z.object({ type: z.literal('saved-search-missing'), name: z.string().max(200) }),
  /** An answer you gave yourself on an application form (the form engine saw you type or pick it): remembered. */
  z.object({ type: z.literal('user-answer'), label: z.string().min(1).max(300), answer: z.string().min(1).max(2000), host: z.string().max(200) }),
  /** The applier is about to press a button in a job page tab the agent opened. */
  z.object({ type: z.literal('apply-progress'), token: z.string().max(64) }),
  /** The applier's result in a job page tab the auto-apply agent opened. */
  z.object({
    type: z.literal('apply-report'),
    token: z.string().max(64),
    result: z.enum(['can_apply', 'applied', 'already_applied', 'closed', 'external', 'captcha', 'logged_out', 'not_found', 'needs_me', 'no_confirmation', 'stopped', 'ready', 'limit', 'error']),
    clicked: z.boolean(),
    reason: z.string().max(500),
    questions: z.array(z.string().max(300)).max(30),
    answers: z.array(Answer).max(30),
    dialogs: z.array(Dialog).max(5),
  }),
]);
export type CollectorMessage = z.infer<typeof CollectorMessage>;

/** Messages from the board page to the service worker. */
export const BoardMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('board-opened') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('reschedule') }),
  /** Agent panel: try the next job now (the switches, halts, hours and daily limit still apply). */
  z.object({ type: z.literal('agent-run-now') }),
  /** "Apply with AI" on a board job, or on any http(s) page you give it (a company career page). */
  z.object({
    type: z.literal('ai-apply'),
    url: z.string().max(2048).refine((u) => {
      try {
        return /^https?:$/.test(new URL(u).protocol);
      } catch {
        return false;
      }
    }),
    jobId: z.string().max(200).nullable(),
  }),
  /** Refuse the running AI apply's next click. */
  z.object({ type: z.literal('ai-apply-stop') }),
]);
export type BoardMessage = z.infer<typeof BoardMessage>;

export type RefreshResponse =
  | { ok: true; added: number; note?: string }
  | { ok: false; reason: string; retryAt?: number };

export { DB_CHANGED } from './constants';
