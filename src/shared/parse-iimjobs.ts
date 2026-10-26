import { z } from 'zod';
import { resolvePostedAt } from './dates';
import type { CaptureResult } from './parse';
import type { ApplyType, ParsedJob } from './types';
import { iimjobsJobUrl, safeExternalUrl } from './url';

/**
 * Shape of one iimjobs job in a `gladiator.iimjobs.com/job/search?...&page=N` response (confirmed against
 * www.iimjobs.com on 2026-10-26): `{ data: [...], page, limit: 50, totalJobs, totalPages, hasMore }`. The search
 * page requests it with your saved experience range. Only the fields we use are listed.
 */
const RawIimjobsJob = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  locations: z.array(z.object({ name: z.string() }).passthrough()).nullable().optional(),
  otherLocation: z.string().nullable().optional(),
  workFromHome: z.number().nullable().optional(),
  companyData: z.object({ companyName: z.string().optional() }).passthrough().nullable().optional(),
  confidential: z.number().nullable().optional(),
  tags: z.array(z.object({ name: z.string() }).passthrough()).nullable().optional(),
  createdTime: z.number().nullable().optional(),
  createdTimeMs: z.number().nullable().optional(),
  minSal: z.number().nullable().optional(),
  maxSal: z.number().nullable().optional(),
  hideSal: z.number().nullable().optional(),
  /** Set when applying happens on another site (Lever, Turbohire, ...). */
  applyUrl: z.string().nullable().optional(),
  jobDetailUrl: z.string().nullable().optional(),
  applied: z.number().nullable().optional(),
  status: z.number().nullable().optional(),
}).passthrough();

type RawIimjobsJob = z.infer<typeof RawIimjobsJob>;

export interface IimjobsCaptureResult extends CaptureResult {
  /** Job IDs iimjobs reports you have already applied to. */
  appliedJobIds: string[];
}

/** Salary in lakhs a year; larger numbers are taken as rupees. */
function toLpa(v: number | null | undefined): number | null {
  if (!v || v <= 0) return null;
  return v > 1_000 ? Math.round((v / 100_000) * 10) / 10 : v;
}

function applyOf(raw: RawIimjobsJob): { applyType: ApplyType; externalUrl: string | null } {
  const external = safeExternalUrl(raw.applyUrl);
  if (external && !/(^|\.)iimjobs\.com$/i.test(new URL(external).hostname)) return { applyType: 'company_site', externalUrl: external };
  return { applyType: 'easy_apply', externalUrl: null };
}

export function normalizeIimjobsJob(raw: RawIimjobsJob, feed: string, now: number): ParsedJob {
  // createdTime is the posting day as shown ("Posted 3 days ago"); createdTimeMs adds the time of day.
  const posted = resolvePostedAt(raw.createdTimeMs ?? raw.createdTime ?? undefined, '', now);
  const title = raw.title.trim();
  const company = raw.confidential ? 'Confidential' : (raw.companyData?.companyName ?? '').trim();
  const places = (raw.locations ?? []).map((l) => l.name.trim()).filter(Boolean);
  if (raw.otherLocation?.trim()) places.push(raw.otherLocation.trim());
  if (raw.workFromHome && !places.some((p) => /remote|home/i.test(p))) places.push('Work from home');
  const expMin = raw.min ?? null;
  const expMax = raw.max ?? null;
  const [salaryMinLpa, salaryMaxLpa] = raw.hideSal ? [null, null] : [toLpa(raw.minSal), toLpa(raw.maxSal)];
  return {
    jobId: `iimjobs-${raw.id}`,
    site: 'iimjobs',
    title,
    company,
    location: [...new Set(places)].join(', '),
    experience: expMin !== null && expMax !== null ? `${expMin}-${expMax} yrs` : '',
    expMin,
    expMax,
    salary: salaryMinLpa !== null || salaryMaxLpa !== null ? `${salaryMinLpa ?? '?'}-${salaryMaxLpa ?? '?'} LPA` : 'Not disclosed',
    salaryMinLpa,
    salaryMaxLpa,
    skills: (raw.tags ?? []).map((t) => t.name.trim()).filter(Boolean),
    postedAt: posted.postedAt,
    postedLabel: '',
    postedApprox: posted.approx,
    sourceFeeds: [feed],
    ...applyOf(raw),
    naukriUrl: iimjobsJobUrl(raw.id, raw.jobDetailUrl),
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

/** Parse an iimjobs job-search response into jobs. */
export function parseIimjobsCapture(payload: unknown, feed: string, now: number): IimjobsCaptureResult {
  const result: IimjobsCaptureResult = { jobs: [], rejected: 0, firstError: null, appliedJobIds: [] };
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return result;
  const seen = new Set<string>();
  for (const item of data) {
    const parsed = RawIimjobsJob.safeParse(item);
    if (!parsed.success) {
      result.rejected += 1;
      result.firstError ??= parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      continue;
    }
    if (parsed.data.status !== undefined && parsed.data.status !== null && parsed.data.status !== 1) continue;
    const job = normalizeIimjobsJob(parsed.data, feed, now);
    if (seen.has(job.jobId)) continue;
    seen.add(job.jobId);
    result.jobs.push(job);
    if (parsed.data.applied) result.appliedJobIds.push(job.jobId);
  }
  return result;
}
