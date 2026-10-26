import { z } from 'zod';
import { resolvePostedAt } from './dates';
import type { CaptureResult } from './parse';
import type { ParsedJob } from './types';
import { instahyreJobUrl } from './url';

/**
 * Shape of one Instahyre job in a `/api/v1/job_search` response (confirmed against www.instahyre.com on
 * 2026-10-26): `{ meta, objects: [...] }`. Only the fields we use are listed. The response carries no posted
 * date, experience or salary, so jobs are dated by when the board first saw them.
 */
const RawInstahyreJob = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  locations: z.string().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  public_url: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  employer: z.object({ company_name: z.string().optional().default('') }).passthrough(),
}).passthrough();

type RawInstahyreJob = z.infer<typeof RawInstahyreJob>;

export function normalizeInstahyreJob(raw: RawInstahyreJob, feed: string, now: number): ParsedJob {
  const posted = resolvePostedAt(undefined, '', now);
  const title = raw.title.trim();
  const company = raw.employer.company_name.trim();
  return {
    jobId: `instahyre-${raw.id}`,
    site: 'instahyre',
    title,
    company,
    location: (raw.locations ?? '').split(',').map((s) => s.trim()).filter(Boolean).join(', '),
    experience: '',
    expMin: null,
    expMax: null,
    salary: 'Not disclosed',
    salaryMinLpa: null,
    salaryMaxLpa: null,
    skills: raw.keywords ?? [],
    postedAt: posted.postedAt,
    postedLabel: '',
    postedApprox: posted.approx,
    sourceFeeds: [feed],
    // Instahyre jobs are applied to on Instahyre itself ("View job" then "Apply").
    applyType: 'easy_apply',
    naukriUrl: instahyreJobUrl(raw.id, raw.public_url),
    externalUrl: null,
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

/** Parse an Instahyre job-search response into jobs. */
export function parseInstahyreCapture(payload: unknown, feed: string, now: number): CaptureResult {
  const result: CaptureResult = { jobs: [], rejected: 0, firstError: null };
  const objects = (payload as { objects?: unknown } | null)?.objects;
  if (!Array.isArray(objects)) return result;
  const seen = new Set<string>();
  for (const item of objects) {
    const parsed = RawInstahyreJob.safeParse(item);
    if (!parsed.success) {
      result.rejected += 1;
      result.firstError ??= parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      continue;
    }
    if (parsed.data.is_active === false) continue;
    const job = normalizeInstahyreJob(parsed.data, feed, now);
    if (seen.has(job.jobId)) continue;
    seen.add(job.jobId);
    result.jobs.push(job);
  }
  return result;
}
