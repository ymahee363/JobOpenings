import { z } from 'zod';
import { resolvePostedAt } from './dates';
import type { CaptureResult } from './parse';
import type { ParsedJob } from './types';
import { wellfoundJobUrl } from './url';

/**
 * Shape of one Wellfound job listing (confirmed against wellfound.com on 2026-10-26). The jobs page loads its
 * results with the `JobSearchResultsX` GraphQL query: `data.talent.jobSearchResults.startups.edges[].node` is a
 * company (`StartupSearchResult`) or a promoted one (`PromotedResult.promotedStartup`), and each company lists
 * its jobs in `highlightedJobListings`. Only the fields we use are listed.
 */
const RawWellfoundJob = z.object({
  id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String),
  title: z.string().min(1),
  slug: z.string().nullable().optional(),
  liveStartAt: z.number().nullable().optional(),
  locationNames: z.array(z.string()).nullable().optional(),
  remote: z.boolean().nullable().optional(),
  compensation: z.string().nullable().optional(),
  currentUserApplied: z.boolean().nullable().optional(),
}).passthrough();

type RawWellfoundJob = z.infer<typeof RawWellfoundJob>;

export interface WellfoundCaptureResult extends CaptureResult {
  /** Job IDs Wellfound reports you have already applied to. */
  appliedJobIds: string[];
}

/** "₹20L – ₹35L • 0.05% – 0.1%" → [20, 35]. Other currencies and formats give nulls. */
export function wellfoundSalaryLpa(compensation: string): [number | null, number | null] {
  const pay = compensation.split('•')[0] ?? '';
  const amounts = [...pay.matchAll(/₹\s*(\d+(?:\.\d+)?)\s*L\b/g)].map((m) => Number(m[1]));
  if (!amounts.length) return [null, null];
  return [amounts[0]!, amounts[1] ?? amounts[0]!];
}

export function normalizeWellfoundJob(raw: RawWellfoundJob, company: string, feed: string, now: number): ParsedJob {
  const posted = resolvePostedAt(raw.liveStartAt ? raw.liveStartAt * 1_000 : undefined, '', now);
  const title = raw.title.trim();
  const places = (raw.locationNames ?? []).map((s) => s.trim()).filter(Boolean);
  if (raw.remote && !places.some((p) => /remote/i.test(p))) places.push('Remote');
  const compensation = raw.compensation?.trim() ?? '';
  const [salaryMinLpa, salaryMaxLpa] = wellfoundSalaryLpa(compensation);
  return {
    jobId: `wellfound-${raw.id}`,
    site: 'wellfound',
    title,
    company,
    location: places.join(', '),
    experience: '',
    expMin: null,
    expMax: null,
    salary: compensation || 'Not disclosed',
    salaryMinLpa,
    salaryMaxLpa,
    skills: [],
    postedAt: posted.postedAt,
    postedLabel: '',
    postedApprox: posted.approx,
    sourceFeeds: [feed],
    // The listings show "Apply on Wellfound", ATS-synced ones included.
    applyType: 'easy_apply',
    naukriUrl: wellfoundJobUrl(raw.id, raw.slug),
    externalUrl: null,
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

const MAX_DEPTH = 12;

/** Every company in the response with its job listings, wherever the query nests them. */
function findCompanies(data: unknown, out: Array<{ name: string; jobs: unknown[] }>, depth = 0): void {
  if (depth > MAX_DEPTH || data === null || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const v of data) findCompanies(v, out, depth + 1);
    return;
  }
  const o = data as { name?: unknown; highlightedJobListings?: unknown };
  if (Array.isArray(o.highlightedJobListings)) {
    out.push({ name: typeof o.name === 'string' ? o.name.trim() : '', jobs: o.highlightedJobListings });
    return;
  }
  for (const v of Object.values(data)) findCompanies(v, out, depth + 1);
}

/** Parse a Wellfound job-search GraphQL response into jobs. */
export function parseWellfoundCapture(payload: unknown, feed: string, now: number): WellfoundCaptureResult {
  const result: WellfoundCaptureResult = { jobs: [], rejected: 0, firstError: null, appliedJobIds: [] };
  const companies: Array<{ name: string; jobs: unknown[] }> = [];
  findCompanies(payload, companies);
  const seen = new Set<string>();
  for (const { name, jobs } of companies) {
    for (const item of jobs) {
      const parsed = RawWellfoundJob.safeParse(item);
      if (!parsed.success) {
        result.rejected += 1;
        result.firstError ??= parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        continue;
      }
      const job = normalizeWellfoundJob(parsed.data, name, feed, now);
      if (seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      result.jobs.push(job);
      if (parsed.data.currentUserApplied) result.appliedJobIds.push(job.jobId);
    }
  }
  return result;
}
