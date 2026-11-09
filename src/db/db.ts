import Dexie, { type Table } from 'dexie';
import type { Attempt } from '../shared/auto-apply/config';
import type { Job, JobStatus, LogEntry } from '../shared/types';

export class BoardDB extends Dexie {
  jobs!: Table<Job, string>;
  statuses!: Table<JobStatus, string>;
  log!: Table<LogEntry, number>;
  /** The auto-apply agent's audit trail (PRD-auto-apply AR-11). */
  attempts!: Table<Attempt, number>;

  constructor(name = 'naukri-fast-apply') {
    super(name);
    // Bump the version and add an upgrade() when the schema changes; never edit v1 in place.
    this.version(1).stores({
      jobs: 'jobId, postedAt, lastSeenAt, applyType, titleCompanyKey',
      statuses: 'jobId, status, statusAt',
      log: '++id, ts',
    });
    // v2: jobs gain `site` when Indeed was added; everything stored before then came from Naukri.
    this.version(2).stores({}).upgrade((tx) =>
      tx.table('jobs').toCollection().modify((job: Partial<Job>) => {
        job.site ??= 'naukri';
      }));
    // v3: the auto-apply agent's attempts. Only adds a table, so older builds still read the database.
    this.version(3).stores({ attempts: '++id, jobId, startedAt, outcome' });
  }
}

let instance: BoardDB | null = null;

export function getDb(): BoardDB {
  instance ??= new BoardDB();
  return instance;
}
