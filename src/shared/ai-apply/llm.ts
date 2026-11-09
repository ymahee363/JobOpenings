/**
 * The LLM backend client (backend/app/main.py, `POST /answer`): Gemini with a Groq fallback, behind an optional
 * X-App-Key. The API keys stay in backend/.env; the extension only knows the backend's address.
 *
 * AI usage limits: when every provider is out of quota the backend answers 429, or 502 with the providers' "429 /
 * RESOURCE_EXHAUSTED / quota / rate limit" text. A short limit (per minute) is waited out here; a longer one throws
 * `AiLimitError` with when to try again, so the apply flow stops without failing the job and the agent pauses until
 * then (src/shared/auto-apply/runner.ts, `limitUntil`), resuming by itself — also after the laptop wakes from sleep.
 */
import type { AiBackend } from './profile';
import type { Answer, CandidateProfile, FormField } from './types';

export interface AnswerRequest {
  instruction: string;
  candidate: CandidateProfile;
  job: Record<string, unknown>;
  fields: FormField[];
  /** Fields already answered, as context so dependent answers stay coherent. */
  filled_summary: Array<{ label: string; value: string }>;
  resume_text: string;
}

export const DEFAULT_INSTRUCTION = 'Apply for this job using my profile. Answer truthfully and do not invent experience.';

/** Fields per request: a long form goes in several calls so one slow or rate-limited call fails less. */
const BATCH = 25;
/** Waits before the 2nd and 3rd try of a failed AI call. */
const RETRY_DELAYS_MS = [3_000, 8_000];
/** A usage limit that clears within this is waited out in place; a longer one pauses the agent. */
export const LIMIT_WAIT_IN_PLACE_MS = 90_000;
/** How long to wait in place in total, over several limited replies, before handing the pause to the agent. */
const LIMIT_IN_PLACE_BUDGET_MS = 3 * 60_000;

export type GenerateAnswers = (req: AnswerRequest) => Promise<Answer[]>;

/** The AI is out of its usage limit; try again at `retryAt` (ms since epoch). */
export class AiLimitError extends Error {
  readonly retryAt: number;
  readonly daily: boolean;
  constructor(message: string, retryAt: number, daily: boolean) {
    super(message);
    this.name = 'AiLimitError';
    this.retryAt = retryAt;
    this.daily = daily;
  }
}

export function isAiLimitError(e: unknown): e is AiLimitError {
  return e instanceof AiLimitError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AiLimitError');
}

/** A reply that means "usage limit reached" rather than a broken request. */
export function isLimitReply(status: number, body: string): boolean {
  if (status === 429) return true;
  return status >= 500 && /\b429\b|resource[_ ]exhausted|rate[ -]?limit|quota|too many requests|tokens per (minute|day)|requests per (minute|day)/i.test(body);
}

/** A per-day quota (Gemini "PerDay", Groq "tokens per day (TPD)"), which resets once a day, not in a minute. */
export function isDailyLimit(body: string): boolean {
  return /per ?day|perday|daily|\bTPD\b|\bRPD\b/i.test(body);
}

/**
 * How long the reply says to wait: "retry in 4.46s", "'retryDelay': '37s'", Groq's "try again in 7m12.5s" or
 * "1h2m3s", a Retry-After header in seconds. Null when it does not say.
 */
export function limitWaitMs(body: string, retryAfterHeader?: string | null): number | null {
  if (retryAfterHeader && /^\d+(\.\d+)?$/.test(retryAfterHeader.trim())) return Math.ceil(Number(retryAfterHeader) * 1000);
  const m = /(?:try again|retry)\D{0,20}((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(body);
  if (m) {
    const unit = (u: string) => {
      const x = new RegExp(String.raw`(\d+(?:\.\d+)?)` + u).exec(m[1]!);
      return x ? Number(x[1]) : 0;
    };
    const total = unit('h') * 3600_000 + unit('m(?!s)') * 60_000 + unit('(?<!m)s') * 1000 + unit('ms');
    if (total > 0) return Math.ceil(total);
  }
  const delay = /retryDelay['"]?\s*[:=]\s*['"]?(\d+(?:\.\d+)?)s/i.exec(body);
  if (delay) return Math.ceil(Number(delay[1]) * 1000);
  return null;
}

/**
 * When a limit that did not say how long is likely over: a per-day quota at the next reset (Gemini's daily quotas
 * reset at midnight Pacific time; 08:00 UTC is a safe stand-in), anything else after a growing wait.
 */
export function guessLimitReset(now: number, daily: boolean, streak: number): number {
  if (daily) {
    const d = new Date(now);
    const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 5);
    return reset > now ? reset : reset + 24 * 3600_000;
  }
  const steps = [5, 15, 30, 60, 120];
  return now + steps[Math.min(streak, steps.length - 1)]! * 60_000;
}

export interface ClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Told when the client waits out a short limit, so the run can show "AI limit: waiting 40 s". */
  onWait?: (ms: number, why: string) => void;
}

export function backendClient(backend: AiBackend, fetchOrOpts: typeof fetch | ClientOptions = fetch): GenerateAnswers {
  const opts: ClientOptions = typeof fetchOrOpts === 'function' ? { fetchFn: fetchOrOpts } : fetchOrOpts;
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  return async (req) => {
    const out: Answer[] = [];
    let waitedForLimit = 0;
    for (let i = 0; i < req.fields.length; i += BATCH) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (backend.accessKey) headers['X-App-Key'] = backend.accessKey;
      const call = () => fetchFn(`${backend.url.replace(/\/+$/, '')}/answer`, {
        method: 'POST', headers, body: JSON.stringify({ ...req, fields: req.fields.slice(i, i + BATCH) }),
      });
      // The providers are sometimes briefly overloaded (Gemini 503 "high demand" became a backend 502 on 2026-11-05,
      // while the same call worked seconds later): retry a server error or a network failure before giving up, so
      // one busy moment does not fail a whole application. A usage limit is handled apart, below.
      let res: Response | null = null;
      let lastError = '';
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
        try {
          res = await call();
        } catch (e) {
          res = null;
          lastError = String(e).slice(0, 200);
          continue;
        }
        if (res.ok) break;
        const text = await res.text();
        if (isLimitReply(res.status, text)) {
          const daily = isDailyLimit(text);
          const wait = limitWaitMs(text, res.headers?.get?.('retry-after'));
          // A short limit: wait it out here and ask again (the same batch, a fresh retry count).
          if (!daily && wait !== null && wait <= LIMIT_WAIT_IN_PLACE_MS && waitedForLimit + wait <= LIMIT_IN_PLACE_BUDGET_MS) {
            opts.onWait?.(wait, 'AI usage limit');
            await sleep(wait + 500);
            waitedForLimit += wait + 500;
            attempt = -1;
            res = null;
            continue;
          }
          const retryAt = wait !== null ? now() + wait + 5_000 : guessLimitReset(now(), daily, 0);
          throw new AiLimitError(`AI usage limit reached${daily ? ' (daily quota)' : ''}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`, retryAt, daily);
        }
        if (res.status < 500) {
          lastError = `AI backend ${res.status}: ${text.slice(0, 200)}`;
          throw new Error(lastError);
        }
        lastError = `AI backend ${res.status}: ${text.slice(0, 200)}`;
        res = null;
      }
      if (!res) throw new Error(lastError || 'AI backend did not answer');
      const body = (await res.json()) as { answers?: unknown };
      if (Array.isArray(body.answers)) out.push(...(body.answers as Answer[]));
    }
    return out;
  };
}

/** Is the backend up? `GET /health`. */
export async function backendHealth(backend: AiBackend, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`${backend.url.replace(/\/+$/, '')}/health`);
    return res.ok ? null : `backend answered ${res.status}`;
  } catch (e) {
    return `backend not reachable at ${backend.url} (${String(e).slice(0, 100)})`;
  }
}
