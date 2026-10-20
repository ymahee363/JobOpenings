export const NAUKRI_ORIGIN = 'https://www.naukri.com';
export const RECOMMENDED_JOBS_URL = `${NAUKRI_ORIGIN}/mnjuser/recommendedjobs`;
export const NAUKRI_LOGIN_URL = `${NAUKRI_ORIGIN}/nlogin/login`;

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

/** Job ID from a Naukri job page path such as /job-listings-pm-acme-bengaluru-2-6-years-100826018354. */
export function jobIdFromJobPath(pathname: string): string | null {
  if (!pathname.startsWith('/job-listings-')) return null;
  const m = /-(\d{6,})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}
