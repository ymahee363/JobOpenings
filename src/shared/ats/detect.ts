/**
 * Which applicant tracking system (ATS) a page belongs to, from its URL. The AI apply flow checks this before it
 * starts: a platform with its own applier (Workday first) is applied to step by step with that platform's known
 * structure; everything else goes through the general form engine.
 *
 * Add a platform: give it a pattern here, then an applier (see src/content/ats/workday.ts and
 * src/shared/ats/workday-flow.ts).
 */
export type Ats =
  | 'workday'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'oracle'
  | 'icims'
  | 'darwinbox'
  | 'keka'
  | 'successfactors'
  | 'zoho'
  | 'generic';

const PATTERNS: Array<[Ats, RegExp]> = [
  // Workday career sites: <tenant>.wd<N>.myworkdayjobs.com (wd1, wd5, wd108, wd502…), some on myworkdaysite.com.
  ['workday', /(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)myworkday\.com$/i],
  ['greenhouse', /(^|\.)greenhouse\.io$/i],
  ['lever', /(^|\.)lever\.co$/i],
  ['ashby', /(^|\.)ashbyhq\.com$/i],
  ['smartrecruiters', /(^|\.)smartrecruiters\.com$/i],
  ['oracle', /\.oraclecloud\.com$/i],
  ['icims', /(^|\.)icims\.com$/i],
  ['darwinbox', /(^|\.)darwinbox\.in$/i],
  ['keka', /(^|\.)keka\.com$/i],
  ['successfactors', /(^|\.)successfactors\.(com|eu)$|(^|\.)sapsf\.(com|eu)$/i],
  // Zoho Recruit career sites: <company>.zohorecruit.com / .in / .eu (company domains are recognised by the page).
  ['zoho', /(^|\.)zohorecruit\.(com|in|eu|com\.au|jp)$/i],
];

/** The ATS of a URL; 'generic' when unknown or unparseable. */
export function detectAts(url: string | undefined | null): Ats {
  if (!url) return 'generic';
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'generic';
  }
  for (const [ats, re] of PATTERNS) if (re.test(host)) return ats;
  return 'generic';
}

/** Platforms with a dedicated applier. Others are applied to with the general flow. */
export const DEDICATED_ATS: Ats[] = ['workday', 'zoho', 'keka', 'lever'];

export function hasDedicatedApplier(ats: Ats): boolean {
  return DEDICATED_ATS.includes(ats);
}
