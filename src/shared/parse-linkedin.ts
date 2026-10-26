import { z } from 'zod';
import { parseRelativeLabel } from './dates';
import type { CaptureResult } from './parse';
import type { ApplyType, ParsedJob } from './types';
import { linkedInJobUrl } from './url';

/**
 * LinkedIn jobs are read from the job cards on the page you have open (confirmed on www.linkedin.com on
 * 2026-10-26): each card is `div[componentkey="job-card-component-ref-<jobId>"]`, and its visible text is, line
 * by line, the title (screen-reader copy may add " (Verified job)", then the plain title repeats), company,
 * location, optional insights, a hidden "Posted 4 hours ago", and footer items such as "Applied", "Viewed",
 * "Promoted" or "Easy Apply". The content script sends `{ cards: [{ jobId, lines }] }`.
 */
const RawCard = z.object({
  jobId: z.string().regex(/^\d{5,20}$/),
  lines: z.array(z.string().max(500)).min(3).max(60),
});
type RawCard = z.infer<typeof RawCard>;

const Payload = z.object({ cards: z.array(z.unknown()).max(500) });

export interface LinkedInCaptureResult extends CaptureResult {
  /** Job IDs whose card says "Applied". */
  appliedJobIds: string[];
}

const TIME_AGO = /\b(\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s+ago|just now)\b/i;

/** Drop the screen-reader extras: "Selected, " on the open card and " (Verified job)". */
function cleanTitle(s: string): string {
  return s.replace(/^selected,\s*/i, '').replace(/\s*\((?:verified job|verified)\)\s*$/i, '').trim();
}

export function normalizeLinkedInCard(card: RawCard, feed: string, now: number): ParsedJob | null {
  const lines = card.lines.map((s) => s.trim()).filter((s) => s && s !== '·');
  const title = cleanTitle(lines[0] ?? '');
  let i = 1;
  if (cleanTitle(lines[i] ?? '') === title) i += 1;
  const company = lines[i] ?? '';
  const location = lines[i + 1] ?? '';
  if (!title || !company) return null;

  const posted = lines.map((s) => /^(?:re)?posted\s+(.+)$/i.exec(s)?.[1]).find(Boolean)
    ?? lines.map((s) => TIME_AGO.exec(s)?.[1]).find(Boolean)
    ?? '';
  const when = parseRelativeLabel(posted, now);
  const applyType: ApplyType = lines.some((s) => /^easy apply$/i.test(s)) ? 'easy_apply' : 'unknown';
  return {
    jobId: `linkedin-${card.jobId}`,
    site: 'linkedin',
    title,
    company,
    location,
    experience: '',
    expMin: null,
    expMax: null,
    salary: 'Not disclosed',
    salaryMinLpa: null,
    salaryMaxLpa: null,
    skills: [],
    postedAt: when.postedAt,
    postedLabel: posted,
    // "4 hours ago" is rounded, and a card without a time is dated by when it was first seen.
    postedApprox: posted === '' || when.approx,
    sourceFeeds: [feed],
    applyType,
    naukriUrl: linkedInJobUrl(card.jobId),
    externalUrl: null,
    titleCompanyKey: `${title}|${company}`.toLowerCase(),
  };
}

/** Parse the job cards the LinkedIn content script read from the page. */
export function parseLinkedInCapture(payload: unknown, feed: string, now: number): LinkedInCaptureResult {
  const result: LinkedInCaptureResult = { jobs: [], rejected: 0, firstError: null, appliedJobIds: [] };
  const parsedPayload = Payload.safeParse(payload);
  if (!parsedPayload.success) return result;
  const seen = new Set<string>();
  for (const item of parsedPayload.data.cards) {
    const card = RawCard.safeParse(item);
    const job = card.success ? normalizeLinkedInCard(card.data, feed, now) : null;
    if (!card.success || !job) {
      result.rejected += 1;
      result.firstError ??= card.success
        ? `card ${card.data.jobId}: no title or company in "${card.data.lines.slice(0, 4).join(' | ')}"`
        : card.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
      continue;
    }
    if (seen.has(job.jobId)) continue;
    seen.add(job.jobId);
    result.jobs.push(job);
    if (card.data.lines.some((s) => /^applied$/i.test(s.trim()))) result.appliedJobIds.push(job.jobId);
  }
  return result;
}
