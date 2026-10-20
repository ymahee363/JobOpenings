/** Pure board logic: building rows, filtering, sorting and stats. */
import type { ApplyType, Job, JobStatus, Status } from './types';

const DAY = 86_400_000;
export const MAYBE_CLOSED_AFTER_MS = 7 * DAY;

export interface BoardRow extends Job {
  status: Status;
  statusAt: number | null;
  isNew: boolean;
  maybeClosed: boolean;
  appliedBefore: boolean;
}

export interface Filters {
  postedWithinDays: number | null;
  expYears: number | null;
  location: string;
  salaryFloorLpa: number | null;
  includeUndisclosedSalary: boolean;
  keywordsInclude: string;
  keywordsExclude: string;
  companyBlocklist: string;
}

export const DEFAULT_FILTERS: Filters = {
  postedWithinDays: 7,
  expYears: null,
  location: '',
  salaryFloorLpa: null,
  includeUndisclosedSalary: true,
  keywordsInclude: '',
  keywordsExclude: '',
  companyBlocklist: '',
};

export function buildRows(jobs: Job[], statuses: JobStatus[], lastVisitAt: number | null, now: number): BoardRow[] {
  const byId = new Map(statuses.map((s) => [s.jobId, s]));
  const appliedKeys = new Map<string, string>();
  for (const j of jobs) {
    if (byId.get(j.jobId)?.status === 'applied') appliedKeys.set(j.titleCompanyKey, j.jobId);
  }
  return jobs.map((j) => {
    const s = byId.get(j.jobId);
    const appliedId = appliedKeys.get(j.titleCompanyKey);
    return {
      ...j,
      status: s?.status ?? 'new',
      statusAt: s?.statusAt ?? null,
      isNew: lastVisitAt !== null && j.firstSeenAt > lastVisitAt,
      maybeClosed: now - j.lastSeenAt > MAYBE_CLOSED_AFTER_MS,
      appliedBefore: appliedId !== undefined && appliedId !== j.jobId,
    };
  });
}

/** Newest posting first; ties go to the job seen most recently for the first time. */
export function compareNewestFirst(a: Job, b: Job): number {
  return b.postedAt - a.postedAt || b.firstSeenAt - a.firstSeenAt || a.jobId.localeCompare(b.jobId);
}

function terms(csv: string): string[] {
  return csv.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

export function matchesFilters(row: BoardRow, f: Filters, now: number): boolean {
  if (f.postedWithinDays !== null && now - row.postedAt > f.postedWithinDays * DAY) return false;
  if (f.expYears !== null) {
    if (row.expMin !== null && f.expYears < row.expMin) return false;
    if (row.expMax !== null && f.expYears > row.expMax) return false;
  }
  if (f.location.trim()) {
    const wanted = terms(f.location);
    const loc = row.location.toLowerCase();
    if (!wanted.some((w) => loc.includes(w))) return false;
  }
  if (f.salaryFloorLpa !== null) {
    const top = row.salaryMaxLpa ?? row.salaryMinLpa;
    if (top === null ? !f.includeUndisclosedSalary : top < f.salaryFloorLpa) return false;
  }
  const haystack = `${row.title} ${row.company} ${row.skills.join(' ')}`.toLowerCase();
  const include = terms(f.keywordsInclude);
  if (include.length && !include.some((t) => haystack.includes(t))) return false;
  if (terms(f.keywordsExclude).some((t) => haystack.includes(t))) return false;
  const company = row.company.toLowerCase();
  if (terms(f.companyBlocklist).some((t) => company.includes(t))) return false;
  return true;
}

export type BoardTab = ApplyType | 'applied';

/** Rows for one tab: applied jobs live in their own tab, dismissed jobs are hidden everywhere. */
export function rowsForTab(rows: BoardRow[], tab: BoardTab, f: Filters, now: number): BoardRow[] {
  if (tab === 'applied') {
    return rows.filter((r) => r.status === 'applied')
      .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0));
  }
  return rows
    .filter((r) => r.applyType === tab && r.status !== 'applied' && r.status !== 'dismissed')
    .filter((r) => matchesFilters(r, f, now))
    .sort(compareNewestFirst);
}

export interface Stats {
  appliedLast7Days: number;
  appliedTotal: number;
  medianHoursPostedToApplied: number | null;
  jobsTracked: number;
  byType: Record<ApplyType, number>;
  /** Jobs per Naukri feed; compare with the tab counts on Naukri's recommended-jobs page. */
  byFeed: Record<string, number>;
}

export function computeStats(rows: BoardRow[], now: number): Stats {
  const applied = rows.filter((r) => r.status === 'applied' && r.statusAt !== null);
  const hours = applied.map((r) => ((r.statusAt as number) - r.postedAt) / 3_600_000).filter((h) => h >= 0)
    .sort((a, b) => a - b);
  let median: number | null = null;
  if (hours.length) {
    const mid = Math.floor(hours.length / 2);
    median = hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
    median = Math.round(median * 10) / 10;
  }
  const byType: Record<ApplyType, number> = { easy_apply: 0, company_site: 0, unknown: 0 };
  const byFeed: Record<string, number> = {};
  for (const r of rows) {
    byType[r.applyType] += 1;
    for (const f of r.sourceFeeds) byFeed[f] = (byFeed[f] ?? 0) + 1;
  }
  return {
    appliedLast7Days: applied.filter((r) => now - (r.statusAt as number) <= 7 * DAY).length,
    appliedTotal: applied.length,
    medianHoursPostedToApplied: median,
    jobsTracked: rows.length,
    byType,
    byFeed,
  };
}

function csvCell(v: string): string {
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function appliedCsv(rows: BoardRow[]): string {
  const header = ['Title', 'Company', 'Location', 'Apply type', 'Posted', 'Applied', 'Link'];
  const lines = rows
    .filter((r) => r.status === 'applied')
    .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0))
    .map((r) => [
      r.title, r.company, r.location, r.applyType === 'company_site' ? 'Company site' : 'Easy apply',
      new Date(r.postedAt).toISOString(), r.statusAt ? new Date(r.statusAt).toISOString() : '',
      r.externalUrl ?? r.naukriUrl,
    ].map(csvCell).join(','));
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}
