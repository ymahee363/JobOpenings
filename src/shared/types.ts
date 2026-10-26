export type ApplyType = 'easy_apply' | 'company_site' | 'unknown';
export type Site = 'naukri' | 'indeed' | 'instahyre' | 'wellfound' | 'linkedin' | 'cutshort' | 'foundit' | 'iimjobs';
/** Sites the app may open by itself on refresh. LinkedIn is read only from pages you open. */
export type AppSite = Exclude<Site, 'linkedin'>;
export type Status = 'new' | 'seen' | 'applied' | 'dismissed';

/** A job as stored in the `jobs` table. Refreshes update it; they never touch status. */
export interface Job {
  /** Naukri's numeric job ID, `indeed-<jobkey>` for Indeed, `instahyre-<id>` for Instahyre, `wellfound-<id>` for Wellfound, `cutshort-<id>` for Cutshort, `foundit-<id>` for foundit, `iimjobs-<id>` for iimjobs, or `linkedin-<id>` for LinkedIn. */
  jobId: string;
  site: Site;
  title: string;
  company: string;
  location: string;
  experience: string;
  expMin: number | null;
  expMax: number | null;
  salary: string;
  /** Annual salary in lakhs (LPA); null when not disclosed. */
  salaryMinLpa: number | null;
  salaryMaxLpa: number | null;
  skills: string[];
  postedAt: number;
  postedLabel: string;
  postedApprox: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  sourceFeeds: string[];
  applyType: ApplyType;
  /** The job's page on its own site. The name predates the other sites. */
  naukriUrl: string;
  externalUrl: string | null;
  /** Lowercased "title|company", used to spot reposts of jobs already applied to. */
  titleCompanyKey: string;
}

/** A job freshly parsed from a capture, before it is merged with what is stored. */
export type ParsedJob = Omit<Job, 'firstSeenAt' | 'lastSeenAt'>;

export interface JobStatus {
  jobId: string;
  status: Status;
  statusAt: number;
}

export interface LogEntry {
  id?: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type PageState = 'ok' | 'logged_out' | 'captcha';

export interface Health {
  lastRefreshAt: number | null;
  lastCaptureAt: number | null;
  /** When the next automatic Naukri refresh is due (interval plus random delay); null when none is scheduled. */
  nextAutoRefreshAt: number | null;
  /** When the once-a-day refresh of Indeed, Instahyre and Wellfound is due; null when none is scheduled. */
  nextIndeedRefreshAt: number | null;
  pageState: PageState;
  parser: 'ok' | 'needs_update';
  lastError: string | null;
}

export interface Settings {
  /** Automatic refresh: Naukri every `refreshMinutes` plus jitter, Indeed, Instahyre and Wellfound once a day at a random time. */
  autoRefresh: boolean;
  refreshMinutes: number;
  /** Refresh Indeed, Instahyre and Wellfound when you open the board (each at most once an hour). */
  indeedOnBoardOpen: boolean;
  notifyNewJobs: boolean;
}

export const DEFAULT_SETTINGS: Settings = { autoRefresh: true, refreshMinutes: 30, indeedOnBoardOpen: true, notifyNewJobs: false };

export const DEFAULT_HEALTH: Health = {
  lastRefreshAt: null,
  lastCaptureAt: null,
  nextAutoRefreshAt: null,
  nextIndeedRefreshAt: null,
  pageState: 'ok',
  parser: 'ok',
  lastError: null,
};
