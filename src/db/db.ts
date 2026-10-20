import Dexie, { type Table } from 'dexie';
import type { Job, JobStatus, LogEntry } from '../shared/types';

export class BoardDB extends Dexie {
  jobs!: Table<Job, string>;
  statuses!: Table<JobStatus, string>;
  log!: Table<LogEntry, number>;

  constructor(name = 'naukri-fast-apply') {
    super(name);
    // Bump the version and add an upgrade() when the schema changes; never edit v1 in place.
    this.version(1).stores({
      jobs: 'jobId, postedAt, lastSeenAt, applyType, titleCompanyKey',
      statuses: 'jobId, status, statusAt',
      log: '++id, ts',
    });
  }
}

let instance: BoardDB | null = null;

export function getDb(): BoardDB {
  instance ??= new BoardDB();
  return instance;
}
