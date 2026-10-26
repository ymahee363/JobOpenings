import { z } from 'zod';
import { resolvePostedAt } from './dates';
import type { CaptureResult } from './parse';
import type { ApplyType, ParsedJob } from './types';
import { founditJobUrl, safeExternalUrl } from './url';

/**
 * Shape of one foundit job in a `/home/api/searchResultsPage?...` response (confirmed against www.foundit.in on
 * 2026-10-26): `{ data: [...], meta: { paging: { total, limit } }, filter, ... }`, 20 jobs a page. Only the fields
 * we use are listed.
 */
const Years = z.object({ years: z.number().nullable().optional() }).passthrough().nullable().optional();
const Money = z.object({ absoluteValue: z.number().nullable().optional() }).passthrough().nullable().optional();

const RawFounditJob = z.object({
  jobId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String),
  title: z.string().min(1),
  companyName: z.string().nullable().optional(),
  company: z.object({ name: z.string().optional() }).passthrough().nullable().optional(),
  hideCompanyName: z.number().nullable().optional(),
  locations: z.array(z.object({ city: z.string().optional() }).passthrough()).nullable().optional(),
  minimumExperience: Years,
  maximumExperience: Years,
  minimumSalary: Money,
  maximumSalary: Money,
  hideSalary: z.number().nullable().optional(),
  jobSalaryConfidential: z.boolean().nullable().optional(),
  skills: z.array(z.object({ text: z.string() }).passthrough()).nullable().optional(),
  postedAt: z.number().nullable().optional(),
  createdAt: z.number().nullable().optional(),
  /** Set when applying happens on another site (often LinkedIn or a company's Workday). */
  applyUrl: z.string().nullable().optional(),
  jdUrl: z.string().nullable().optional(),
  isApplied: z.boolean().nullable().optional(),
  activeJob: z.boolean().nullable().optional(),
}).passthrough();

type RawFounditJob = z.infer<typeof RawFounditJob>;

export interface FounditCaptureResult extends CaptureResult {
  /** Job IDs foundit reports you have already applied to. */
  appliedJobIds: string[];
}

const LAKH = 100_000;

function salaryLpa(raw: RawFounditJob): [number | null, number | null] {
  if (raw.hideSalary || raw.jobSalaryConfidential) return [null, null];
  const toLpa = (v: number | null | undefined) => (v && v > 0 ? Math.round((v / LAKH) * 10) / 10 : null);
  return [toLpa(raw.minimumSalary?.absoluteValue), toLpa(raw.maximumSalary?.absoluteValue)];
}

function applyOf(raw: RawFounditJob): { applyType: ApplyType; externalUrl: string | null } {
  const external = safeExternalUrl(raw.applyUrl);
  if (external && !/(^|\.)foundit\.in$/i.test(new URL(external).hostname)) return { applyType: 'company_site', externalUrl: external };
  return { applyType: 'easy_apply', externalUrl: null };
}

export function normalizeFounditJob(raw: RawFounditJob, feed: string, now: number): ParsedJob {
  const posted = resolvePostedAt(raw.postedAt ?? raw.createdAt ?? undefined, '', now);
  const title = raw.title.trim();
  const company = raw.hideCompanyName ? 'Confidential' : (raw.companyName || raw.company?.name || '').trim();
  const cities = (raw.locations ?? []).map((l) => l.city?.trim() ?? '').filter(Boolean);
  const expMin = raw.minimumExperience?.years ?? null;
  const expMax = raw.maximumExperience?.years ?? null;
  const [salaryMinLpa, salaryMaxLpa] = salaryLpa(raw);
  const salary = salaryMinLpa !== null || salaryMaxLpa !== null
    ? `${salaryMinLpa ?? '?'}-${salaryMaxLpa ?? '?'} Lacs PA`
    : 'Not disclosed';
  return {
    jobId: `foundit-${raw.jobId}`,
    site: 'foundit',
    title,
    company,
    location: [...new Set(cities)].join(', '),
    experience: expMin !== null && expMax !== null ? `${expMin}-${expMax} Yrs` : '',
    expMin,
    expMax,
    salary,
    salaryMinLpa,
    salaryMaxLpa,
    skills: (raw.skills ?? []).map((s) => s.text.trim()).filter(Boolean),
    postedAt: posted.postedAt,
    postedLabel: '',
    postedApprox: posted.approx,
    sourceFeeds: [feed],
    ...applyOf(raw),
    naukriUrl: founditJobUrl(raw.jobId, raw.jdUrl),
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

/** Parse a foundit search response into jobs. */
export function parseFounditCapture(payload: unknown, feed: string, now: number): FounditCaptureResult {
  const result: FounditCaptureResult = { jobs: [], rejected: 0, firstError: null, appliedJobIds: [] };
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return result;
  const seen = new Set<string>();
  for (const item of data) {
    const parsed = RawFounditJob.safeParse(item);
    if (!parsed.success) {
      result.rejected += 1;
      result.firstError ??= parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      continue;
    }
    if (parsed.data.activeJob === false) continue;
    const job = normalizeFounditJob(parsed.data, feed, now);
    if (seen.has(job.jobId)) continue;
    seen.add(job.jobId);
    result.jobs.push(job);
    if (parsed.data.isApplied) result.appliedJobIds.push(job.jobId);
  }
  return result;
}
