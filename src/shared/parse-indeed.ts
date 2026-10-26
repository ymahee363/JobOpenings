import { z } from 'zod';
import { resolvePostedAt } from './dates';
import type { CaptureResult } from './parse';
import type { ApplyType, ParsedJob } from './types';
import { indeedJobUrl, safeExternalUrl } from './url';

/**
 * Shape of one Indeed job card (confirmed against in.indeed.com on 2026-10-23). The homepage embeds them in
 * `mosaic-provider-jobcards-*` models; its GraphQL pagination returns the same model as a JSON string
 * (`transitionalJobCardsModelBlob`). Only the fields we use are listed.
 */
const RawIndeedJob = z.object({
  jobkey: z.string().regex(/^[0-9a-f]{16}$/i),
  title: z.string().min(1),
  displayTitle: z.string().optional(),
  company: z.string().optional().default(''),
  formattedLocation: z.string().optional().default(''),
  pubDate: z.number().optional(),
  createDate: z.number().optional(),
  formattedRelativeTime: z.string().optional().default(''),
  indeedApplyable: z.boolean().optional(),
  thirdPartyApplyUrl: z.string().nullable().optional(),
  extractedSalary: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    type: z.string().optional(),
  }).passthrough().nullable().optional(),
  salarySnippet: z.object({ text: z.string().optional() }).passthrough().nullable().optional(),
  expired: z.boolean().optional(),
  appliedOrGreater: z.boolean().optional(),
}).passthrough();

type RawIndeedJob = z.infer<typeof RawIndeedJob>;

export interface IndeedCaptureResult extends CaptureResult {
  /** Job IDs Indeed reports you have already applied to. */
  appliedJobIds: string[];
}

const MAX_DEPTH = 8;

function looksLikeIndeedJob(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'jobkey' in v;
}

/** Find every array of Indeed job cards, unpacking the JSON-string blobs GraphQL wraps them in. */
export function findIndeedJobArrays(data: unknown, depth = 0): unknown[][] {
  if (depth > MAX_DEPTH) return [];
  if (typeof data === 'string') {
    if (!data.startsWith('{') || !data.includes('jobkey')) return [];
    try {
      return findIndeedJobArrays(JSON.parse(data), depth + 1);
    } catch {
      return [];
    }
  }
  if (data === null || typeof data !== 'object') return [];
  if (Array.isArray(data)) {
    if (data.some(looksLikeIndeedJob)) return [data];
    return data.flatMap((v) => findIndeedJobArrays(v, depth + 1));
  }
  return Object.values(data).flatMap((v) => findIndeedJobArrays(v, depth + 1));
}

const LAKH = 100_000;

function salaryLpa(raw: RawIndeedJob): [number | null, number | null] {
  const s = raw.extractedSalary;
  const perYear = s?.type === 'YEARLY' ? 1 : s?.type === 'MONTHLY' ? 12 : null;
  if (!s || perYear === null) return [null, null];
  const toLpa = (v: number | undefined) => (v && v > 0 ? Math.round(((v * perYear) / LAKH) * 10) / 10 : null);
  return [toLpa(s.min), toLpa(s.max)];
}

function applyTypeOf(raw: RawIndeedJob): ApplyType {
  if (raw.indeedApplyable === true) return 'easy_apply';
  if (raw.indeedApplyable === false) return 'company_site';
  return 'unknown';
}

export function normalizeIndeedJob(raw: RawIndeedJob, feed: string, now: number): ParsedJob {
  // pubDate is what Indeed's "N days ago" label counts from; createDate is the original posting.
  const posted = resolvePostedAt(raw.pubDate ?? raw.createDate, raw.formattedRelativeTime, now);
  const [salaryMinLpa, salaryMaxLpa] = salaryLpa(raw);
  const title = (raw.displayTitle || raw.title).trim();
  const company = raw.company.trim();
  const applyType = applyTypeOf(raw);
  return {
    jobId: `indeed-${raw.jobkey.toLowerCase()}`,
    site: 'indeed',
    title,
    company,
    location: raw.formattedLocation.trim(),
    experience: '',
    expMin: null,
    expMax: null,
    salary: raw.salarySnippet?.text?.trim() || 'Not disclosed',
    salaryMinLpa,
    salaryMaxLpa,
    skills: [],
    postedAt: posted.postedAt,
    postedLabel: raw.formattedRelativeTime,
    postedApprox: posted.approx,
    sourceFeeds: [feed],
    applyType,
    naukriUrl: indeedJobUrl(raw.jobkey.toLowerCase()),
    externalUrl: applyType === 'company_site' ? safeExternalUrl(raw.thirdPartyApplyUrl) : null,
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

/** Parse an Indeed capture (an embedded job-cards model or a GraphQL response) into jobs. */
export function parseIndeedCapture(payload: unknown, feed: string, now: number): IndeedCaptureResult {
  const result: IndeedCaptureResult = { jobs: [], rejected: 0, firstError: null, appliedJobIds: [] };
  const seen = new Set<string>();
  for (const items of findIndeedJobArrays(payload)) {
    for (const item of items) {
      if (!looksLikeIndeedJob(item)) continue;
      const parsed = RawIndeedJob.safeParse(item);
      if (!parsed.success) {
        result.rejected += 1;
        result.firstError ??= parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        continue;
      }
      if (parsed.data.expired) continue;
      const job = normalizeIndeedJob(parsed.data, feed, now);
      if (seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      result.jobs.push(job);
      if (parsed.data.appliedOrGreater) result.appliedJobIds.push(job.jobId);
    }
  }
  return result;
}
