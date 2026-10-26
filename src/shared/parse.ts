import { z } from 'zod';
import { resolvePostedAt } from './dates';
import type { ApplyType, ParsedJob } from './types';
import { naukriJobUrl, safeExternalUrl } from './url';

/**
 * Shape of one job in Naukri's recom-jobs data (confirmed against the live page on 2026-10-21).
 * Only the fields we use are listed; everything else passes through untouched.
 */
const RawJob = z.object({
  jobId: z.union([z.string().min(1), z.number()]).transform(String),
  title: z.string().min(1),
  companyName: z.string().optional().default(''),
  createdDate: z.number().optional(),
  footerPlaceholderLabel: z.string().optional().default(''),
  placeholders: z.array(z.object({ type: z.string(), label: z.string() }).passthrough()).optional().default([]),
  tagsAndSkills: z.string().optional().default(''),
  jdURL: z.string().optional(),
  companyApplyJob: z.boolean().optional(),
  companyApplyUrl: z.string().nullable().optional(),
  applyRedirectUrl: z.string().nullable().optional(),
  minimumExperience: z.union([z.string(), z.number()]).optional(),
  maximumExperience: z.union([z.string(), z.number()]).optional(),
  salaryDetail: z.object({
    hideSalary: z.boolean().optional(),
    minimumSalary: z.number().optional(),
    maximumSalary: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

type RawJob = z.infer<typeof RawJob>;

export interface CaptureResult {
  jobs: ParsedJob[];
  /** Job-like objects that failed validation: a non-zero count with no jobs means the parser needs an update. */
  rejected: number;
  /** First validation problem, for the error log. */
  firstError: string | null;
}

const MAX_DEPTH = 6;

function looksLikeJob(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'jobId' in v;
}

/** Find every array of job-like objects in a response, with the key it sat under (used as the feed name). */
export function findJobArrays(data: unknown, key = 'root', depth = 0): Array<{ key: string; items: unknown[] }> {
  if (depth > MAX_DEPTH || data === null || typeof data !== 'object') return [];
  if (Array.isArray(data)) {
    if (data.some(looksLikeJob)) return [{ key, items: data }];
    return data.flatMap((v) => findJobArrays(v, key, depth + 1));
  }
  return Object.entries(data).flatMap(([k, v]) => findJobArrays(v, k, depth + 1));
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function placeholder(raw: RawJob, type: string): string {
  return raw.placeholders.find((p) => p.type === type)?.label.trim() ?? '';
}

function applyTypeOf(raw: RawJob, externalUrl: string | null): ApplyType {
  if (raw.companyApplyJob === true) return 'company_site';
  if (raw.companyApplyJob === false) return 'easy_apply';
  return externalUrl ? 'company_site' : 'unknown';
}

function salaryLpa(raw: RawJob): [number | null, number | null] {
  const d = raw.salaryDetail;
  if (!d || d.hideSalary) return [null, null];
  const toLpa = (v: number | undefined) => (v && v > 0 ? Math.round((v / 100_000) * 10) / 10 : null);
  return [toLpa(d.minimumSalary), toLpa(d.maximumSalary)];
}

export function normalizeJob(raw: RawJob, feed: string, now: number): ParsedJob {
  const externalUrl = safeExternalUrl(raw.applyRedirectUrl) ?? safeExternalUrl(raw.companyApplyUrl);
  const posted = resolvePostedAt(raw.createdDate, raw.footerPlaceholderLabel, now);
  const [salaryMinLpa, salaryMaxLpa] = salaryLpa(raw);
  const title = raw.title.trim();
  const company = raw.companyName.trim();
  return {
    jobId: raw.jobId,
    site: 'naukri',
    title,
    company,
    location: placeholder(raw, 'location'),
    experience: placeholder(raw, 'experience'),
    expMin: toNumber(raw.minimumExperience),
    expMax: toNumber(raw.maximumExperience),
    salary: placeholder(raw, 'salary') || 'Not disclosed',
    salaryMinLpa,
    salaryMaxLpa,
    skills: raw.tagsAndSkills.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12),
    postedAt: posted.postedAt,
    postedLabel: raw.footerPlaceholderLabel,
    postedApprox: posted.approx,
    sourceFeeds: [feed],
    applyType: applyTypeOf(raw, externalUrl),
    naukriUrl: naukriJobUrl(raw.jdURL),
    externalUrl,
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

/** Parse any captured payload (a cached feed array or a network response) into jobs. */
export function parseCapture(payload: unknown, feedHint: string | null, now: number): CaptureResult {
  const result: CaptureResult = { jobs: [], rejected: 0, firstError: null };
  const seen = new Set<string>();
  for (const { key, items } of findJobArrays(payload)) {
    const feed = feedHint ?? key;
    for (const item of items) {
      if (!looksLikeJob(item)) continue;
      const parsed = RawJob.safeParse(item);
      if (!parsed.success) {
        result.rejected += 1;
        result.firstError ??= parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        continue;
      }
      if (seen.has(parsed.data.jobId)) continue;
      seen.add(parsed.data.jobId);
      result.jobs.push(normalizeJob(parsed.data, feed, now));
    }
  }
  return result;
}
