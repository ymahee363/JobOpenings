export type ApplyType = 'easy_apply' | 'company_site' | 'unknown';
export type Status = 'new' | 'seen' | 'applied' | 'dismissed';

/** A job as stored in the `jobs` table. Refreshes update it; they never touch status. */
export interface Job {
  jobId: string;
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
  pageState: PageState;
  parser: 'ok' | 'needs_update';
  lastError: string | null;
}

export interface Settings {
  autoRefresh: boolean;
  refreshMinutes: number;
  notifyNewJobs: boolean;
}

export const DEFAULT_SETTINGS: Settings = { autoRefresh: true, refreshMinutes: 30, notifyNewJobs: false };

export const DEFAULT_HEALTH: Health = {
  lastRefreshAt: null,
  lastCaptureAt: null,
  pageState: 'ok',
  parser: 'ok',
  lastError: null,
};
