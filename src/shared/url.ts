export const NAUKRI_ORIGIN = 'https://www.naukri.com';
export const RECOMMENDED_JOBS_URL = `${NAUKRI_ORIGIN}/mnjuser/recommendedjobs`;
export const NAUKRI_LOGIN_URL = `${NAUKRI_ORIGIN}/nlogin/login`;

export const INDEED_ORIGIN = 'https://in.indeed.com';
/** Indeed's homepage ("Jobs for you"); the board links to it. Refresh reads its pages from sources.json. */
export const INDEED_HOME_URL = `${INDEED_ORIGIN}/?from=gnav-homepage--homepage-frontend`;

export const INSTAHYRE_ORIGIN = 'https://www.instahyre.com';
/** Instahyre's opportunities page; refresh opens it and runs a saved search from there. */
export const WELLFOUND_ORIGIN = 'https://wellfound.com';
export const CUTSHORT_ORIGIN = 'https://cutshort.io';
export const FOUNDIT_ORIGIN = 'https://www.foundit.in';
export const IIMJOBS_ORIGIN = 'https://www.iimjobs.com';

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

export const INSTAHYRE_OPPORTUNITIES_URL = `${INSTAHYRE_ORIGIN}/candidate/opportunities/?matching=true`;

function parse(raw: string | null | undefined): URL | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return new URL(raw.trim(), NAUKRI_ORIGIN);
  } catch {
    return null;
  }
}

function isNaukriHost(host: string): boolean {
  return host === 'naukri.com' || host.endsWith('.naukri.com');
}

function isIndeedHost(host: string): boolean {
  return host === 'indeed.com' || host.endsWith('.indeed.com');
}

function isInstahyreHost(host: string): boolean {
  return host === 'instahyre.com' || host.endsWith('.instahyre.com');
}

function isWellfoundHost(host: string): boolean {
  return host === 'wellfound.com' || host.endsWith('.wellfound.com');
}

function isCutshortHost(host: string): boolean {
  return host === 'cutshort.io' || host.endsWith('.cutshort.io');
}

function isFounditHost(host: string): boolean {
  return host === 'foundit.in' || host.endsWith('.foundit.in');
}

function isIimjobsHost(host: string): boolean {
  return host === 'iimjobs.com' || host.endsWith('.iimjobs.com');
}

function isLinkedInHost(host: string): boolean {
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

/** An apply link we are willing to open: https only, so javascript:, data: and http: links are dropped. */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  const url = parse(raw);
  if (!url || url.protocol !== 'https:' || !url.hostname) return null;
  return url.href;
}

/** The Naukri job page for a job, or the recommended-jobs page if the link is missing or off-site. */
export function naukriJobUrl(jdUrl: string | null | undefined): string {
  const url = parse(jdUrl);
  if (url && url.protocol === 'https:' && isNaukriHost(url.hostname)) return url.href;
  return RECOMMENDED_JOBS_URL;
}

/** A job page link on one of the supported sites over https, else null. Used to validate backups. */
export function safeJobPageUrl(raw: string | null | undefined): string | null {
  const url = parse(raw);
  if (!url || url.protocol !== 'https:') return null;
  const host = url.hostname;
  const known = isNaukriHost(host) || isIndeedHost(host) || isInstahyreHost(host) || isWellfoundHost(host)
    || isCutshortHost(host) || isFounditHost(host) || isIimjobsHost(host) || isLinkedInHost(host);
  if (!known) return null;
  return url.href;
}

/** The Indeed job page for a jobkey (16 hex characters). */
export function indeedJobUrl(jobkey: string): string {
  return `${INDEED_ORIGIN}/viewjob?jk=${encodeURIComponent(jobkey)}`;
}

/** The Instahyre job page: the job's own public link when it is on instahyre.com, else /job-<id>/. */
export function instahyreJobUrl(id: number, publicUrl: string | null | undefined): string {
  const url = parse(publicUrl);
  if (url && url.protocol === 'https:' && isInstahyreHost(url.hostname)) return url.href;
  return `${INSTAHYRE_ORIGIN}/job-${id}/`;
}

/** The Wellfound job page, /jobs/<id>-<slug> (the slug is optional). */
export function wellfoundJobUrl(id: string, slug: string | null | undefined): string {
  const tail = slug && /^[a-z0-9-]+$/i.test(slug) ? `-${slug}` : '';
  return `${WELLFOUND_ORIGIN}/jobs/${encodeURIComponent(id)}${tail}`;
}

/** The Cutshort job page: its public link when it is on cutshort.io, else /job/<shortId>, else the jobs page. */
export function cutshortJobUrl(publicUrl: string | null | undefined, shortId: string | null | undefined): string {
  const url = parse(publicUrl);
  if (url && url.protocol === 'https:' && isCutshortHost(url.hostname)) return url.href;
  if (shortId && /^[A-Za-z0-9_-]+$/.test(shortId)) return `${CUTSHORT_ORIGIN}/job/${shortId}`;
  return `${CUTSHORT_ORIGIN}/profile/all-jobs`;
}

/** The foundit job page: its /job/... path when given, else /job/<id>. */
export function founditJobUrl(jobId: string, jdUrl: string | null | undefined): string {
  if (jdUrl && /^\/job\/[A-Za-z0-9-]+\/?$/.test(jdUrl)) return `${FOUNDIT_ORIGIN}${jdUrl}`;
  return `${FOUNDIT_ORIGIN}/job/${encodeURIComponent(jobId)}`;
}

/** The iimjobs job page: its own link when it is on iimjobs.com, else /j/<id>. */
export function iimjobsJobUrl(id: number, jobDetailUrl: string | null | undefined): string {
  const url = parse(jobDetailUrl);
  if (url && url.protocol === 'https:' && isIimjobsHost(url.hostname)) return url.href;
  return `${IIMJOBS_ORIGIN}/j/${id}`;
}

/** The LinkedIn job page for a numeric job ID. */
export function linkedInJobUrl(id: string): string {
  return `${LINKEDIN_ORIGIN}/jobs/view/${encodeURIComponent(id)}/`;
}

/** Job ID from a Naukri job page path such as /job-listings-pm-acme-bengaluru-2-6-years-100826018354. */
export function jobIdFromJobPath(pathname: string): string | null {
  if (!pathname.startsWith('/job-listings-')) return null;
  const m = /-(\d{6,})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}
