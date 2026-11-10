import { BUILT_AT } from '../build-info';
import { isForeignOnsite } from '../foreign';
/** Which iimjobs jobs the agent applies to, and in what order (PRD-auto-apply AR-1, AR-2, AR-3, AR-14, AR-16). */
import { SITE_LABEL, titleHasHiddenWord } from '../board';
import type { Job, JobStatus } from '../types';
import { allAnswered } from './answers';
import type { AgentConfig, ApplyRules, Attempt } from './config';
import { AGENT_SITES, siteOfJobId } from './job-page';
import { cappedSites } from './pacing';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A failed attempt is retried once, at least this long after it (AR-14). */
export const RETRY_AFTER_MS = HOUR;
export const MAX_FAILURES = 2;
/** At most this many applies to one company in `COMPANY_WINDOW_MS` (AR-16). */
export const COMPANY_CAP = 2;
export const COMPANY_WINDOW_MS = 7 * DAY;

export type Verdict = { ok: true; reasons: string[] } | { ok: false; reason: string };

const companyKey = (c: string) => c.trim().toLowerCase();

/** AR-1: may the agent consider this job at all? */
export function eligibility(
  job: Job, status: JobStatus | undefined, appliedBefore: boolean, rules: ApplyRules, now: number, sites: string[] = ['iimjobs'], aiApply = false,
): string | null {
  if (!sites.includes(job.site)) return 'site not turned on for auto-apply';
  if (!aiApply && !(AGENT_SITES as string[]).includes(job.site)) return 'needs AI apply (no one-click applier on this site)';
  if (!aiApply && job.applyType !== 'easy_apply') return 'applies on a company site';
  const s = status?.status ?? 'new';
  if (s === 'applied') return 'already applied';
  if (s === 'dismissed') return 'dismissed';
  if (isForeignOnsite(job.location)) return 'outside India and not remote';
  if (appliedBefore) return 'applied before (repost)';
  if (now - job.postedAt > rules.maxPostedDays * DAY) return `posted more than ${rules.maxPostedDays} days ago`;
  return null;
}

/** AR-2: does the job pass every one of your rules? Reasons say why it matched, for the audit log. */
export function matchRules(job: Job, rules: ApplyRules, hideWords: string[]): Verdict {
  const title = job.title.toLowerCase();
  const include = rules.titleIncludes.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const hit = include.find((t) => title.includes(t));
  if (!hit) return { ok: false, reason: 'title has none of your phrases' };
  const excluded = [...rules.titleExcludes, ...hideWords].find((w) => titleHasHiddenWord(job.title, [w]));
  if (excluded) return { ok: false, reason: `title has "${excluded}"` };
  const reasons = [`title: ${hit}`];

  if (rules.myYears === null) return { ok: false, reason: 'set your years of experience in the agent rules' };
  // Only iimjobs and Naukri always show an experience range; elsewhere a job without one passes this rule.
  if (job.expMin === null && job.expMax === null && job.site !== 'iimjobs' && job.site !== 'naukri') {
    reasons.push(`experience not shown on ${SITE_LABEL[job.site]}`);
  } else if (job.expMin === null && job.expMax === null) {
    return { ok: false, reason: 'no experience range shown' };
  } else {
    // Your years are enough when the job asks for at most that many: with 7, a 1-3 years job passes and a 10-15 one
    // does not. The top of the range does not matter. A range shown only as a maximum counts as "from 0".
    const needs = job.expMin ?? 0;
    if (needs > rules.myYears) return { ok: false, reason: `experience ${job.experience} needs ${needs}+, you have ${rules.myYears}` };
    reasons.push(`experience ${job.experience}: needs ${needs}, you have ${rules.myYears}`);
  }

  const loc = job.location.toLowerCase();
  const remote = /remote|work from home|wfh/.test(loc);
  const places = rules.locations.map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (places.length) {
    const place = places.find((p) => loc.includes(p));
    if (place) reasons.push(`location: ${place}`);
    else if (rules.allowRemote && remote) reasons.push('location: remote');
    else return { ok: false, reason: `location ${job.location || 'not shown'}` };
  }

  if (rules.salaryFloorLpa !== null) {
    const top = job.salaryMaxLpa ?? job.salaryMinLpa;
    if (top !== null && top < rules.salaryFloorLpa) return { ok: false, reason: `salary ${job.salary} below ${rules.salaryFloorLpa} LPA` };
    reasons.push(top === null ? 'salary not shown' : `salary ${job.salary}`);
  }

  const company = companyKey(job.company);
  const blocked = rules.companyBlocklist.map(companyKey).filter(Boolean).find((b) => company.includes(b));
  if (blocked) return { ok: false, reason: `company blocked (${blocked})` };
  return { ok: true, reasons };
}

/**
 * Has this job's attempt history ruled it out for now? Applied, already applied and skipped jobs are done;
 * "Needs me" jobs wait until every question has a stored answer; failures are retried once after an hour;
 * dry-run results come back when dry run is turned off.
 */
/**
 * The site an attempt stopped at for a sign-in ("sabre.wd1.myworkdayjobs.com wants you to sign in or create an
 * account first…"), or null. Older attempts said only "the site wants you to log in…": '' (site unknown).
 */
export function signInHostOf(reason: string): string | null {
  const m = /^(\S+) wants you to sign in or create an account/.exec(reason);
  if (m) return m[1]!;
  return /wants you to log in or create an account/.test(reason) ? '' : null;
}

export function blockedByHistory(history: Attempt[], config: AgentConfig, now: number, builtAt = BUILT_AT): string | null {
  if (!history.length) return null;
  const last = history.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  if (history.some((a) => a.outcome === 'applied' || a.outcome === 'already_applied')) return 'applied';
  // Zero human intervention (2026-11-10): a job that stopped for you or failed under an older build is tried once
  // more with the fixed code (the auto fixer ships fixes as new builds). Never when Apply was already pressed
  // without confirmation, a site needs your sign-in, or the job was skipped on purpose.
  if (builtAt && last.startedAt < builtAt && (last.outcome === 'needs_me' || last.outcome === 'failed')
    && !last.clicked && signInHostOf(last.reason) === null
    // Not when it asked for something only you can make (a Loom/video walkthrough): CLANX was retried 5 times on
    // 2026-11-10, once per build.
    && !last.questions.some((q) => /\bloom\b|video|record(ed|ing)? (a|an|your)|walk(ing)? us through/i.test(q))
    // Once per failure: the same reason twice means the new build did not fix it (Wing Assistant, 7 retries).
    && history.filter((a) => a.reason === last.reason).length < 2) return null;
  switch (last.outcome) {
    case 'pending': return 'in progress';
    case 'skipped': return last.reason || 'skipped';
    // AI apply filled the form and left the tab for you: never filled twice.
    case 'filled': return 'filled, waiting for your Submit';
    // One-click only: a job that asked for details is left for you. With form filling on, it returns once answered.
    // Instahyre jobs outside your matches were briefly left for you, on the wrong belief that they ask to confirm;
    // they are one click, so they go back in the queue.
    case 'needs_me': if (last.questions.some((q) => /outside your Instahyre matches/.test(q))) return null;
      {
        // Stopped at a company site's sign-in: back in the queue once you mark that site signed in.
        const host = signInHostOf(last.reason);
        if (host !== null) return host && (config.signedIn?.[host] ?? 0) > last.startedAt ? null : 'needs a sign-in on the company site';
      }
      return (config.fillForms || config.aiApply) && allAnswered(last.questions, config.answers) ? null : 'needs your details';
    case 'would_apply': return config.dryRun ? 'dry run done' : null;
    case 'failed': {
      // Apply was pressed but not confirmed (even after a reload): never press it again; it is listed for you.
      // On Instahyre the job page reliably shows "Application sent!" once applied, so an unconfirmed click is tried once
      // more after an hour: if it went through, the page says so and nothing is clicked.
      // Before 2026-11-04 every Naukri, Instahyre and Wellfound report was dropped ("no report from the job page"),
      // so those clicks say nothing about the job: try again. The applier reads the page first, so a job the site
      // already shows as applied is never pressed twice.
      const lostReport = /no report from the job page/.test(last.reason);
      if (last.clicked && !lostReport && siteOfJobId(last.jobId) !== 'instahyre') return 'pressed Apply, not confirmed';
      const failures = history.filter((a) => a.outcome === 'failed').length;
      if (failures >= MAX_FAILURES && !lostReport) return 'failed twice';
      return now - (last.finishedAt ?? last.startedAt) < RETRY_AFTER_MS ? 'retry later' : null;
    }
    default: return null;
  }
}

export interface QueueItem {
  job: Job;
  reasons: string[];
}

/** AR-3: matching jobs, newest posted first, within the per-company cap. */
export function buildQueue(
  jobs: Job[], statuses: JobStatus[], attempts: Attempt[], config: AgentConfig, hideWords: string[], now: number,
): QueueItem[] {
  const statusOf = new Map(statuses.map((s) => [s.jobId, s]));
  const appliedKeys = new Set(jobs.filter((j) => statusOf.get(j.jobId)?.status === 'applied').map((j) => j.titleCompanyKey));
  const historyOf = new Map<string, Attempt[]>();
  for (const a of attempts) historyOf.set(a.jobId, [...(historyOf.get(a.jobId) ?? []), a]);

  const perCompany = new Map<string, number>();
  for (const a of attempts) {
    if (a.outcome === 'applied' && now - a.startedAt < COMPANY_WINDOW_MS) {
      perCompany.set(companyKey(a.company), (perCompany.get(companyKey(a.company)) ?? 0) + 1);
    }
  }

  const capped = new Set(cappedSites(config.sites, config.dailyCap, attempts, now));
  const out: QueueItem[] = [];
  const candidates = [...jobs].sort((a, b) => b.postedAt - a.postedAt || b.firstSeenAt - a.firstSeenAt);
  for (const job of candidates) {
    const status = statusOf.get(job.jobId);
    const repost = status?.status !== 'applied' && appliedKeys.has(job.titleCompanyKey);
    if (eligibility(job, status, repost, config.rules, now, config.sites, config.aiApply)) continue;
    // A platform that has used today's page limit sits out until tomorrow; the others carry on.
    if (capped.has(job.site)) continue;
    if (blockedByHistory(historyOf.get(job.jobId) ?? [], config, now)) continue;
    const verdict = matchRules(job, config.rules, hideWords);
    if (!verdict.ok) continue;
    const key = companyKey(job.company);
    // Confidential employers are many different companies, so the cap does not group them.
    if (key && key !== 'confidential') {
      const n = perCompany.get(key) ?? 0;
      if (n >= COMPANY_CAP) continue;
      perCompany.set(key, n + 1);
    }
    out.push({ job, reasons: verdict.reasons });
  }
  // The platform applied to least recently goes first, so turns carry on from run to run.
  const lastBySite: Record<string, number> = {};
  for (const a of attempts) {
    const site = siteOfJobId(a.jobId);
    if (site) lastBySite[site] = Math.max(lastBySite[site] ?? 0, a.startedAt);
  }
  return interleaveBySite(out, lastBySite);
}

/**
 * Why the queue is empty, in words: how many iimjobs jobs were looked at and the most common reason they did not
 * match. Without this a quiet agent looks broken.
 */
export function explainEmptyQueue(
  jobs: Job[], statuses: JobStatus[], attempts: Attempt[], config: AgentConfig, hideWords: string[], now: number,
): string {
  if (!config.sites.length) return 'No site is ticked under "Apply on" in the Agent panel';
  const names = config.sites.map((x) => SITE_LABEL[x]).join(' or ');
  const onSites = jobs.filter((j) => (config.sites as string[]).includes(j.site));
  if (!onSites.length) return `No ${names} jobs on the board yet: press Refresh, or open your ${names} search once`;
  if (config.rules.myYears === null) return 'Set "My years of experience" in the Agent panel: no job can match until you do';
  const statusOf = new Map(statuses.map((s) => [s.jobId, s]));
  const appliedKeys = new Set(jobs.filter((j) => statusOf.get(j.jobId)?.status === 'applied').map((j) => j.titleCompanyKey));
  const historyOf = new Map<string, Attempt[]>();
  for (const a of attempts) historyOf.set(a.jobId, [...(historyOf.get(a.jobId) ?? []), a]);
  const reasons = new Map<string, number>();
  const bySite = new Map<string, Map<string, number>>();
  const capped = new Set(cappedSites(config.sites, config.dailyCap, attempts, now));
  for (const job of onSites) {
    const status = statusOf.get(job.jobId);
    const repost = status?.status !== 'applied' && appliedKeys.has(job.titleCompanyKey);
    const reason = eligibility(job, status, repost, config.rules, now, config.sites, config.aiApply)
      ?? (capped.has(job.site) ? `daily page limit reached on ${SITE_LABEL[job.site]}` : null)
      ?? blockedByHistory(historyOf.get(job.jobId) ?? [], config, now)
      ?? (() => { const v = matchRules(job, config.rules, hideWords); return v.ok ? 'company limit (2 a week)' : v.reason; })();
    // Group "experience 10-15 yrs needs 10+, you have 7" and the like under one heading.
    const key = reason.replace(/^experience .*/, 'needs more experience than yours').replace(/^location .*/, 'location not in your list')
      .replace(/^salary .*/, 'salary below your floor').replace(/^company blocked .*/, 'company on your blocklist').replace(/^title has ".*"/, 'title has an excluded word');
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    // Per platform, the jobs found in the last 2 days: why the new ones did not go in (2026-11-10).
    if (now - (job.firstSeenAt ?? job.postedAt) < 2 * DAY) {
      const m = bySite.get(job.site) ?? new Map<string, number>();
      m.set(key, (m.get(key) ?? 0) + 1);
      bySite.set(job.site, m);
    }
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join(', ');
  const fresh = [...bySite.entries()].map(([site, m]) => `${SITE_LABEL[site as Job['site']]}: ${[...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r, n]) => `${r} (${n})`).join(', ')}`).join(' · ');
  return `No matching job among ${onSites.length} ${names} jobs. Most common reasons: ${top}${fresh ? `. New jobs (last 2 days): ${fresh}` : ''}`;
}

/**
 * Platforms take turns: one job from each platform in round-robin order until every list runs out. Within a
 * platform jobs stay newest first. Platforms go in order of their last attempt (`lastBySite`, oldest or never
 * first), then by their newest job. So with nothing applied yet, 2 Naukri, 1 Instahyre and 3 iimjobs jobs become
 * Naukri, iimjobs, Instahyre, Naukri, iimjobs, iimjobs (when Naukri has the newest job); after a Naukri attempt,
 * iimjobs comes first. The queue is rebuilt before every run, so this is what keeps the turns going.
 */
export function interleaveBySite<T extends { job: { site: string } }>(items: T[], lastBySite: Record<string, number> = {}): T[] {
  const bySite = new Map<string, T[]>();
  for (const item of items) bySite.set(item.job.site, [...(bySite.get(item.job.site) ?? []), item]);
  // A stable sort keeps the newest-job order between platforms with the same last attempt.
  const lists = [...bySite.entries()].sort(([a], [b]) => (lastBySite[a] ?? 0) - (lastBySite[b] ?? 0)).map(([, list]) => list);
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round += 1) {
    for (const list of lists) if (round < list.length) out.push(list[round]!);
  }
  return out;
}
