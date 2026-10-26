import { z } from 'zod';
import { resolvePostedAt } from './dates';
import type { CaptureResult } from './parse';
import type { ParsedJob } from './types';
import { cutshortJobUrl } from './url';

/**
 * Shape of one Cutshort job in a `/findjobs/q?page=N&matchesfor=...` response (confirmed against cutshort.io on
 * 2026-10-26): `{ page, totalPages, total_count, page_size: 5, results: [...] }`. The jobs page loads page 1 and
 * the next pages as you scroll. Only the fields we use are listed.
 */
const RawCutshortJob = z.object({
  _id: z.string().regex(/^[0-9a-f]{24}$/i),
  headline: z.string().min(1),
  company: z.string().nullable().optional(),
  companyDetails: z.object({ name: z.string().optional() }).passthrough().nullable().optional(),
  locations: z.array(z.string()).nullable().optional(),
  remoteType: z.string().nullable().optional(),
  expRange: z.object({
    minVanity: z.number().nullable().optional(),
    maxVanity: z.number().nullable().optional(),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
  }).passthrough().nullable().optional(),
  /** What the card shows: "₹25L - ₹42L / yr", or "Best in industry" when the range is hidden. */
  salaryRangeText: z.string().nullable().optional(),
  allSkills: z.array(z.string()).nullable().optional(),
  /** When the job was opened for applications; creationDate is when the recruiter first drafted it. */
  hiringIntentShownOn: z.string().nullable().optional(),
  creationDate: z.string().nullable().optional(),
  publicUrl: z.string().nullable().optional(),
  short_id: z.string().nullable().optional(),
  isExpired: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  isMarkedDeleted: z.boolean().optional(),
}).passthrough();

type RawCutshortJob = z.infer<typeof RawCutshortJob>;

/** "₹25L - ₹42L / yr" → [25, 42]; "Best in industry" and other text → nulls. */
export function cutshortSalaryLpa(text: string): [number | null, number | null] {
  const amounts = [...text.matchAll(/₹\s*(\d+(?:\.\d+)?)\s*L\b/g)].map((m) => Number(m[1]));
  if (!amounts.length) return [null, null];
  return [amounts[0]!, amounts[1] ?? amounts[0]!];
}

function dateMs(iso: string | null | undefined): number | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

export function normalizeCutshortJob(raw: RawCutshortJob, feed: string, now: number): ParsedJob {
  const posted = resolvePostedAt(dateMs(raw.hiringIntentShownOn) ?? dateMs(raw.creationDate), '', now);
  const title = raw.headline.trim();
  const company = (raw.company || raw.companyDetails?.name || '').trim();
  const places = (raw.locations ?? []).map((s) => s.trim()).filter(Boolean);
  if (raw.remoteType === 'remote_only' && !places.some((p) => /remote/i.test(p))) places.push('Remote only');
  const expMin = raw.expRange?.minVanity ?? raw.expRange?.min ?? null;
  const expMax = raw.expRange?.maxVanity ?? raw.expRange?.max ?? null;
  const salaryText = raw.salaryRangeText?.trim() ?? '';
  const [salaryMinLpa, salaryMaxLpa] = cutshortSalaryLpa(salaryText);
  return {
    jobId: `cutshort-${raw._id.toLowerCase()}`,
    site: 'cutshort',
    title,
    company,
    location: places.join(', '),
    experience: expMin !== null && expMax !== null ? `${expMin}-${expMax} yrs` : '',
    expMin,
    expMax,
    salary: salaryMinLpa !== null ? salaryText : 'Not disclosed',
    salaryMinLpa,
    salaryMaxLpa,
    skills: raw.allSkills ?? [],
    postedAt: posted.postedAt,
    postedLabel: '',
    postedApprox: posted.approx,
    sourceFeeds: [feed],
    // Cutshort jobs are applied to on Cutshort ("Apply now").
    applyType: 'easy_apply',
    naukriUrl: cutshortJobUrl(raw.publicUrl, raw.short_id),
    externalUrl: null,
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

/** Parse a Cutshort job-search response into jobs. */
export function parseCutshortCapture(payload: unknown, feed: string, now: number): CaptureResult {
  const result: CaptureResult = { jobs: [], rejected: 0, firstError: null };
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return result;
  const seen = new Set<string>();
  for (const item of results) {
    const parsed = RawCutshortJob.safeParse(item);
    if (!parsed.success) {
      result.rejected += 1;
      result.firstError ??= parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      continue;
    }
    const raw = parsed.data;
    if (raw.isExpired || raw.isHidden || raw.isMarkedDeleted) continue;
    const job = normalizeCutshortJob(raw, feed, now);
    if (seen.has(job.jobId)) continue;
    seen.add(job.jobId);
    result.jobs.push(job);
  }
  return result;
}
