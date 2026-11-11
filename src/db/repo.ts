import { z } from 'zod';
import type { Attempt } from '../shared/auto-apply/config';
import { BUILT_AT } from '../shared/build-info';
import type { Job, JobStatus, LogEntry, ParsedJob, Status } from '../shared/types';
import { safeExternalUrl, safeJobPageUrl } from '../shared/url';
import type { BoardDB } from './db';

const DAY = 86_400_000;
export const RETENTION_MS = 60 * DAY;
const LOG_RETENTION_MS = 30 * DAY;
/** The agent's audit trail is kept longer than the log (PRD-auto-apply AR-11). */
export const ATTEMPT_RETENTION_MS = 180 * DAY;

export interface UpsertResult {
  added: string[];
  updated: number;
}

/** Merge parsed jobs into the store. Keeps firstSeenAt and the earliest exact posted date. */
export async function upsertJobs(db: BoardDB, parsed: ParsedJob[], now: number): Promise<UpsertResult> {
  const result: UpsertResult = { added: [], updated: 0 };
  if (!parsed.length) return result;
  await db.transaction('rw', db.jobs, async () => {
    const existing = await db.jobs.bulkGet(parsed.map((p) => p.jobId));
    const rows: Job[] = parsed.map((p, i) => {
      const old = existing[i];
      if (!old) {
        result.added.push(p.jobId);
        return { ...p, firstSeenAt: now, lastSeenAt: now };
      }
      result.updated += 1;
      // An exact date beats an approximate one; otherwise keep the earliest so the sort never jumps.
      const keepOld = old.postedApprox === p.postedApprox ? old.postedAt <= p.postedAt : !old.postedApprox;
      return {
        ...p,
        postedAt: keepOld ? old.postedAt : p.postedAt,
        postedApprox: keepOld ? old.postedApprox : p.postedApprox,
        postedLabel: keepOld ? old.postedLabel : p.postedLabel,
        sourceFeeds: [...new Set([...old.sourceFeeds, ...p.sourceFeeds])],
        firstSeenAt: old.firstSeenAt,
        lastSeenAt: now,
      };
    });
    await db.jobs.bulkPut(rows);
  });
  return result;
}

/** Set a status and return the previous one, so the caller can undo. `appliedBy` marks who applied. */
export async function setStatus(
  db: BoardDB, jobId: string, status: Status, now: number, appliedBy?: JobStatus['appliedBy'],
): Promise<JobStatus | null> {
  return db.transaction('rw', db.statuses, async () => {
    const prev = (await db.statuses.get(jobId)) ?? null;
    await db.statuses.put(status === 'applied' && appliedBy ? { jobId, status, statusAt: now, appliedBy } : { jobId, status, statusAt: now });
    return prev;
  });
}

/**
 * Mark jobs the site says you already applied to. Only jobs still new or seen change: a status you set
 * yourself (applied or dismissed) wins. Returns how many changed.
 */
export async function markAppliedFromSite(db: BoardDB, jobIds: string[], now: number): Promise<number> {
  return db.transaction('rw', db.statuses, async () => {
    const existing = await db.statuses.bulkGet(jobIds);
    const rows: JobStatus[] = jobIds
      .filter((_, i) => !existing[i] || existing[i]!.status === 'new' || existing[i]!.status === 'seen')
      .map((jobId) => ({ jobId, status: 'applied', statusAt: now }));
    await db.statuses.bulkPut(rows);
    return rows.length;
  });
}

export async function restoreStatus(db: BoardDB, jobId: string, prev: JobStatus | null): Promise<void> {
  if (prev) await db.statuses.put(prev);
  else await db.statuses.delete(jobId);
}

/** Drop jobs older than 60 days that were never applied to, and old log lines. Applied history is kept. */
export async function purge(db: BoardDB, now: number): Promise<number> {
  return db.transaction('rw', db.jobs, db.statuses, db.log, db.attempts, async () => {
    await db.attempts.where('startedAt').below(now - ATTEMPT_RETENTION_MS).delete();
    const old = await db.jobs.where('postedAt').below(now - RETENTION_MS).primaryKeys();
    const statuses = await db.statuses.bulkGet(old);
    const doomed = old.filter((_, i) => statuses[i]?.status !== 'applied');
    await db.jobs.bulkDelete(doomed);
    await db.statuses.bulkDelete(doomed);
    await db.log.where('ts').below(now - LOG_RETENTION_MS).delete();
    return doomed.length;
  });
}

export async function log(db: BoardDB, level: LogEntry['level'], message: string, now = Date.now()): Promise<void> {
  await db.log.add({ ts: now, level, message: message.slice(0, 500) });
}

// ---------- auto-apply attempts ----------

/** Record an attempt before anything is clicked, so a cut-off run can be found later. Returns its ID. */
export async function addAttempt(db: BoardDB, a: Omit<Attempt, 'id'>): Promise<number> {
  // Copy: Dexie writes the new key onto the object it is given, which would break reusing it.
  const { id: _id, ...row } = a as Attempt;
  // The build that made the attempt, so the auto fixer can tell a failure after a fix from one before it (2026-11-11).
  return db.attempts.add({ ...row, build: row.build ?? (BUILT_AT || undefined) });
}

export async function finishAttempt(db: BoardDB, id: number, patch: Partial<Omit<Attempt, 'id' | 'jobId'>>): Promise<void> {
  await db.attempts.update(id, patch);
}

/** Every attempt still marked pending, of any age (uses the `outcome` index; 2026-11-11). */
export async function pendingAttempts(db: BoardDB): Promise<Attempt[]> {
  return db.attempts.where('outcome').equals('pending').toArray();
}

/** Attempts newest first, optionally only those started since `from`. */
export async function listAttempts(db: BoardDB, from = 0): Promise<Attempt[]> {
  return (await db.attempts.where('startedAt').aboveOrEqual(from).toArray()).sort((a, b) => b.startedAt - a.startedAt);
}

export async function recentLog(db: BoardDB, limit = 30): Promise<LogEntry[]> {
  return db.log.orderBy('ts').reverse().limit(limit).toArray();
}

const BackupSchema = z.object({
  app: z.literal('naukri-fast-apply'),
  version: z.literal(1),
  exportedAt: z.number(),
  jobs: z.array(z.object({
    jobId: z.string().min(1),
    // Backups made before Indeed support have no site; they are all Naukri jobs.
    site: z.enum(['naukri', 'indeed', 'instahyre', 'wellfound', 'linkedin', 'cutshort', 'foundit', 'iimjobs']).default('naukri'),
    title: z.string(),
    company: z.string(),
    location: z.string(),
    experience: z.string(),
    expMin: z.number().nullable(),
    expMax: z.number().nullable(),
    salary: z.string(),
    salaryMinLpa: z.number().nullable(),
    salaryMaxLpa: z.number().nullable(),
    skills: z.array(z.string()),
    postedAt: z.number(),
    postedLabel: z.string(),
    postedApprox: z.boolean(),
    firstSeenAt: z.number(),
    lastSeenAt: z.number(),
    sourceFeeds: z.array(z.string()),
    applyType: z.enum(['easy_apply', 'company_site', 'unknown']),
    naukriUrl: z.string().refine((u) => safeJobPageUrl(u) === u, 'naukriUrl must be an https link on a supported job site'),
    externalUrl: z.string().nullable().refine((u) => u === null || safeExternalUrl(u) === u, 'externalUrl must be https'),
    titleCompanyKey: z.string(),
  })),
  statuses: z.array(z.object({
    jobId: z.string(),
    status: z.enum(['new', 'seen', 'applied', 'dismissed']),
    statusAt: z.number(),
    appliedBy: z.enum(['me', 'agent']).optional(),
  })),
});

export async function exportBackup(db: BoardDB, now: number): Promise<string> {
  const [jobs, statuses] = await Promise.all([db.jobs.toArray(), db.statuses.toArray()]);
  return JSON.stringify({ app: 'naukri-fast-apply', version: 1, exportedAt: now, jobs, statuses });
}

/** Restore a backup. Merges: existing jobs are overwritten by the backup's copy. */
export async function importBackup(db: BoardDB, text: string): Promise<{ jobs: number; statuses: number }> {
  const data = BackupSchema.parse(JSON.parse(text));
  await db.transaction('rw', db.jobs, db.statuses, async () => {
    await db.jobs.bulkPut(data.jobs);
    await db.statuses.bulkPut(data.statuses);
  });
  return { jobs: data.jobs.length, statuses: data.statuses.length };
}
