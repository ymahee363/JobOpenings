import { z } from 'zod';

/** Messages from the Naukri content script to the service worker. Validated on arrival. */
export const CollectorMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('capture'),
    source: z.enum(['network', 'storage']),
    feed: z.string().max(64).nullable(),
    url: z.string().max(2048),
    payload: z.unknown(),
  }),
  z.object({ type: z.literal('capture-done'), url: z.string().max(2048) }),
  z.object({ type: z.literal('page-state'), state: z.enum(['ok', 'logged_out', 'captcha']), url: z.string().max(2048) }),
  z.object({ type: z.literal('applied-detected'), jobId: z.string().regex(/^\d{6,20}$/) }),
]);
export type CollectorMessage = z.infer<typeof CollectorMessage>;

/** Messages from the board page to the service worker. */
export const BoardMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('reschedule') }),
]);
export type BoardMessage = z.infer<typeof BoardMessage>;

export type RefreshResponse =
  | { ok: true; added: number }
  | { ok: false; reason: string; retryAt?: number };

export { DB_CHANGED } from './constants';
