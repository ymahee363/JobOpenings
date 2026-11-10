import { siteOfJobId } from './auto-apply/job-page';
import { isForeignOnsite } from './foreign';
/** Pure board logic: building rows, filtering, sorting and stats. */
import type { ApplyType, Job, JobStatus, Site, Status } from './types';
import type { Attempt } from './auto-apply/config';
import { detectAts, type Ats } from './ats/detect';

const DAY = 86_400_000;

export const SITE_LABEL: Record<Site, string> = {
  naukri: 'Naukri', indeed: 'Indeed', instahyre: 'Instahyre', wellfound: 'Wellfound', linkedin: 'LinkedIn', cutshort: 'Cutshort', foundit: 'foundit',
  iimjobs: 'iimjobs',
};
/** Every site, in the order the site filter lists them. */
export const SITES = Object.keys(SITE_LABEL) as Site[];
export const MAYBE_CLOSED_AFTER_MS = 7 * DAY;

export interface BoardRow extends Job {
  status: Status;
  statusAt: number | null;
  isNew: boolean;
  maybeClosed: boolean;
  appliedBefore: boolean;
  /** Set on applied jobs the auto-apply agent applied to. */
  appliedBy: JobStatus['appliedBy'];
  /** Why the site wanted more than one click (a form or a confirmation), from the agent; null otherwise. */
  extraDetails: string | null;
  /** The tab you dragged this job to; null keeps the tab its apply type gives it. */
  tabOverride: MovableTab | null;
  /** The ATS of the company career page (company-site jobs with a known link); null otherwise. */
  ats: Ats | null;
}

/** Tabs a job can be dragged to besides Applied (which marks it applied instead). */
export type MovableTab = Exclude<BoardTab, 'applied'>;
/** Where you dragged jobs, by job ID. */
export type TabOverrides = Record<string, MovableTab>;

export interface Filters {
  /** Sites to show; empty shows every site. */
  sites: Site[];
  /**
   * Platforms to show: a company-site job's ATS ("workday", "lever"), else its native site ("linkedin", "naukri");
   * empty shows every job. Missing in filters saved before ATS chips.
   */
  ats?: string[];
  /** Order of a section (user, 2026-11-10: "apply fast on the latest jobs"): newest posted (default), newest found, oldest posted. */
  sort?: 'posted' | 'found' | 'oldest';
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
  sites: [],
  ats: [],
  postedWithinDays: 7,
  expYears: null,
  location: '',
  salaryFloorLpa: null,
  includeUndisclosedSalary: true,
  keywordsInclude: '',
  keywordsExclude: '',
  companyBlocklist: '',
};

/**
 * `extraDetails` maps job IDs to why the site asked for more than one click; those jobs move from Easy Apply to the
 * Extra Details tab.
 */
export function buildRows(
  jobs: Job[], statuses: JobStatus[], lastVisitAt: number | null, now: number, extraDetails: Map<string, string> = new Map(),
  overrides: TabOverrides = {},
): BoardRow[] {
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
      appliedBy: s?.appliedBy,
      extraDetails: extraDetails.get(j.jobId) ?? null,
      tabOverride: overrides[j.jobId] ?? null,
      ats: atsOf(j),
    };
  });
}

/** ATS of a job's company page; null when there is no company link or it is not a known ATS. */
export function atsOf(j: Pick<Job, 'externalUrl'>): Ats | null {
  const a = detectAts(j.externalUrl);
  return a === 'generic' ? null : a;
}

/** Newest posting first; ties go to the job seen most recently for the first time. */
export function compareNewestFirst(a: Job, b: Job): number {
  return b.postedAt - a.postedAt || b.firstSeenAt - a.firstSeenAt || a.jobId.localeCompare(b.jobId);
}

function terms(csv: string): string[] {
  return csv.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

export function matchesFilters(row: BoardRow, f: Filters, now: number): boolean {
  // Foreign jobs only when remote (user, 2026-11-10).
  if (isForeignOnsite(row.location)) return false;
  if (f.sites.length && !f.sites.includes(row.site)) return false;
  if (f.ats?.length && !f.ats.includes(platformOf(row))) return false;
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
  const haystack = `${row.title} ${row.company} ${row.skills.join(' ')} ${row.ats ?? ''}`.toLowerCase();
  const include = terms(f.keywordsInclude);
  if (include.length && !include.some((t) => haystack.includes(t))) return false;
  if (terms(f.keywordsExclude).some((t) => haystack.includes(t))) return false;
  const company = row.company.toLowerCase();
  if (terms(f.companyBlocklist).some((t) => company.includes(t))) return false;
  return true;
}

/** `extra_details`: jobs where the site asked for more than one click; finish them yourself. */
export type BoardTab = ApplyType | 'extra_details' | 'applied';

/** Words that hide a job when its title contains them; editable in Settings. */
export const DEFAULT_HIDDEN_TITLE_WORDS = ['Designer', 'Engineer'];

/** Tidy a typed word: trimmed, inner spaces collapsed, at most 60 characters. */
export function cleanHideWord(word: string): string {
  return word.trim().replace(/\s+/g, ' ').slice(0, 60);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the title contain one of the words? Whole words, any case, plurals too: "Engineer" hides
 * "Software Engineer" and "Engineers" but not "Engineering Manager" (add "Engineering" for that).
 */
export function titleHasHiddenWord(title: string, words: string[]): boolean {
  return words.some((raw) => {
    const w = cleanHideWord(raw);
    if (!w) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(w)}(s|es)?($|[^\\p{L}\\p{N}])`, 'iu').test(title);
  });
}

/** Only product roles are kept: a title must contain "product" (Product Manager, Product Owner, Head of Product…). */
export function isProductTitle(title: string): boolean {
  return /product/i.test(title);
}

/**
 * Is an open job in this tab? A job you dragged somewhere is only there; a job auto-apply could not apply to is
 * only in Extra Details; otherwise its apply type decides.
 */
function inTab(r: BoardRow, tab: MovableTab): boolean {
  if (r.tabOverride) return r.tabOverride === tab;
  if (r.extraDetails !== null) return tab === 'extra_details';
  return tab !== 'extra_details' && r.applyType === tab;
}

/**
 * Rows for one tab: applied jobs live in their own tab, dismissed jobs are hidden everywhere, and jobs
 * whose title has a hidden word are left out of every tab except Applied.
 */
export function rowsForTab(rows: BoardRow[], tab: BoardTab, f: Filters, now: number, hideWords: string[] = []): BoardRow[] {
  if (tab === 'applied') {
    return rows.filter((r) => r.status === 'applied')
      .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0));
  }
  return rows
    .filter((r) => r.status !== 'applied' && r.status !== 'dismissed')
    .filter((r) => isProductTitle(r.title))
    .filter((r) => inTab(r, tab))
    .filter((r) => !titleHasHiddenWord(r.title, hideWords))
    .filter((r) => matchesFilters(r, f, now))
    .sort(f.sort === 'found' ? (a, b) => b.firstSeenAt - a.firstSeenAt || compareNewestFirst(a, b)
      : f.sort === 'oldest' ? (a, b) => -compareNewestFirst(a, b)
        : compareNewestFirst);
}

/**
 * Where a job is applied to: its ATS when it applies on a company site that runs one ("workday"), else the native
 * platform it was found on ("linkedin", "naukri") (user, 2026-11-10: platform tags on every section).
 */
export function platformOf(row: Pick<BoardRow, 'ats' | 'site'>): string {
  return row.ats ?? row.site;
}

/** The chip text for a platform: the site's own name for native platforms, the ATS name otherwise. */
export function platformLabel(p: string): string {
  return (SITE_LABEL as Record<string, string>)[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/** Platforms among a tab's jobs (every filter but the platform one), most openings first. */
export function atsCounts(rows: BoardRow[], tab: BoardTab, f: Filters, now: number, hideWords: string[] = []): Array<{ ats: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rowsForTab(rows, tab, { ...f, ats: [] }, now, hideWords)) counts.set(platformOf(r), (counts.get(platformOf(r)) ?? 0) + 1);
  return [...counts].map(([ats, count]) => ({ ats, count })).sort((a, b) => b.count - a.count || a.ats.localeCompare(b.ats));
}

/** How many open jobs the hidden words currently hide. */
export function countHiddenByTitle(rows: BoardRow[], hideWords: string[]): number {
  return rows.filter((r) => r.status !== 'applied' && r.status !== 'dismissed' && titleHasHiddenWord(r.title, hideWords)).length;
}

export interface Stats {
  appliedLast7Days: number;
  appliedTotal: number;
  medianHoursPostedToApplied: number | null;
  jobsTracked: number;
  byType: Record<ApplyType, number>;
  bySite: Record<Site, number>;
  /** Jobs per feed; compare the Naukri ones with the tab counts on Naukri's recommended-jobs page. */
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
  const bySite: Record<Site, number> = { naukri: 0, indeed: 0, instahyre: 0, wellfound: 0, linkedin: 0, cutshort: 0, foundit: 0, iimjobs: 0 };
  const byFeed: Record<string, number> = {};
  for (const r of rows) {
    byType[r.applyType] += 1;
    bySite[r.site] += 1;
    for (const f of r.sourceFeeds) byFeed[f] = (byFeed[f] ?? 0) + 1;
  }
  return {
    appliedLast7Days: applied.filter((r) => now - (r.statusAt as number) <= 7 * DAY).length,
    appliedTotal: applied.length,
    medianHoursPostedToApplied: median,
    jobsTracked: rows.length,
    byType,
    bySite,
    byFeed,
  };
}

function csvCell(v: string): string {
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function appliedCsv(rows: BoardRow[]): string {
  const header = ['Site', 'Title', 'Company', 'Location', 'Apply type', 'Posted', 'Applied', 'Link'];
  const lines = rows
    .filter((r) => r.status === 'applied')
    .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0))
    .map((r) => [
      SITE_LABEL[r.site], r.title, r.company, r.location, r.applyType === 'company_site' ? 'Company site' : 'Easy apply',
      new Date(r.postedAt).toISOString(), r.statusAt ? new Date(r.statusAt).toISOString() : '',
      r.externalUrl ?? r.naukriUrl,
    ].map(csvCell).join(','));
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}

/**
 * Saved filters from older versions kept one `site` ('all' or a site); turn it into `sites`. Unknown sites are
 * dropped, and choosing every site is the same as choosing none.
 */
export function normalizeFilters(saved: Filters & { site?: unknown }): Filters {
  const { site, ...rest } = saved;
  const sites = Array.isArray(rest.sites) ? rest.sites : typeof site === 'string' && site !== 'all' ? [site] : [];
  const known = SITES.filter((s) => (sites as unknown[]).includes(s));
  return { ...rest, sites: known.length === SITES.length ? [] : known };
}

/** Tick or untick one site in the filter. */
export function toggleSite(sites: Site[], site: Site, on: boolean): Site[] {
  const next = SITES.filter((s) => (s === site ? on : sites.includes(s)));
  return next.length === SITES.length ? [] : next;
}

/** The agent's audit trail as CSV (PRD-auto-apply AR-11). */
export function attemptsCsv(attempts: Attempt[]): string {
  const header = ['Started', 'Finished', 'Mode', 'Outcome', 'Title', 'Company', 'Job ID', 'Matched', 'Answers', 'Questions', 'Reason'];
  const lines = [...attempts].sort((a, b) => b.startedAt - a.startedAt).map((a) => [
    new Date(a.startedAt).toISOString(), a.finishedAt ? new Date(a.finishedAt).toISOString() : '', a.mode, a.outcome,
    a.title, a.company, a.jobId, a.matched.join('; '), a.answers.map((x) => `${x.question}: ${x.answer}`).join('; '),
    a.questions.join('; '), a.reason,
  ].map(csvCell).join(','));
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}

/**
 * Jobs auto-apply tried and could not apply to, with the reason: each job's latest attempt, when the site asked for
 * details ("needs me") or the attempt failed before Apply was pressed. Jobs where Apply was pressed but not confirmed,
 * or AI apply filled the form for you to submit, stay in their own tab. A later attempt (applied, say) takes the job out.
 */
export function extraDetailsFrom(attempts: Attempt[]): Map<string, string> {
  const latest = new Map<string, Attempt>();
  for (const a of attempts) {
    const prev = latest.get(a.jobId);
    if (!prev || a.startedAt > prev.startedAt) latest.set(a.jobId, a);
  }
  const out = new Map<string, string>();
  for (const [jobId, a] of latest) {
    if (a.outcome === 'failed' && !a.clicked) {
      out.set(jobId, a.reason || 'auto-apply could not apply');
      continue;
    }
    if (a.outcome !== 'needs_me' || a.questions.some((q) => /outside your Instahyre matches/.test(q))) continue;
    out.set(jobId, a.reason || 'the site asked for details');
  }
  return out;
}

export interface SiteStats {
  /** Relevant jobs (product titles) first seen in the period. */
  added: number;
  applied: number;
  byAgent: number;
  byYou: number;
}

/**
 * One platform's numbers for a period (user, 2026-11-10: LinkedIn stats, last 7 / 14 days / month or a date range).
 * `from`/`to` are epoch ms; jobs added count by when the board first saw them, applications by when they were applied.
 */
export function siteStats(rows: BoardRow[], site: Site | 'all', from: number, to: number): SiteStats {
  const mine = site === 'all' ? rows : rows.filter((r) => r.site === site);
  const inRange = (t: number | null | undefined) => t !== null && t !== undefined && t >= from && t <= to;
  const added = mine.filter((r) => isProductTitle(r.title) && inRange(r.firstSeenAt)).length;
  const applied = mine.filter((r) => r.status === 'applied' && inRange(r.statusAt));
  const byAgent = applied.filter((r) => r.appliedBy === 'agent').length;
  return { added, applied: applied.length, byAgent, byYou: applied.length - byAgent };
}

export interface AgentStats {
  /** Jobs the agent (or Apply with AI) opened in the period, live runs only. */
  tried: number;
  /** Runs that stopped for you or failed (needs_me, failed, no confirmation). */
  stuck: number;
  /** Runs left alone on purpose (closed, company site, not appliable). */
  skipped: number;
}

/** What the agent did on one platform (or all) in a period: to see where it fails (user, 2026-11-10). */
export function agentStats(attempts: Attempt[], site: Site | 'all', from: number, to: number): AgentStats {
  const mine = attempts.filter((a) => a.mode !== 'dry_run' && a.startedAt >= from && a.startedAt <= to
    && (site === 'all' || siteOfJobId(a.jobId) === site));
  return {
    tried: mine.filter((a) => a.outcome !== 'pending').length,
    stuck: mine.filter((a) => a.outcome === 'needs_me' || a.outcome === 'failed' || (a.outcome as string) === 'no_confirmation').length,
    skipped: mine.filter((a) => a.outcome === 'skipped').length,
  };
}
