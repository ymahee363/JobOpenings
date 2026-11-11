/**
 * One auto fixer cycle at a time (2026-11-11): an atomic lock file (exclusive create), taken over only when stale.
 *
 *   node scripts/auto-fixer/lock.mjs acquire   # exit 0 = yours; exit 3 = another cycle holds it (stop)
 *   node scripts/auto-fixer/lock.mjs release
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCK = path.join(ROOT, 'qa', 'auto-fixer', '.lock');
export const STALE_MS = 2 * 60 * 60_000;

/** true when taken; false when a fresh lock belongs to another cycle. */
export function acquire(file = LOCK, now = Date.now()) {
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = fs.openSync(file, 'wx'); // fails if it exists: no check-then-write race
      fs.writeSync(fd, JSON.stringify({ startedAt: now, pid: process.pid }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let startedAt = 0;
      try { startedAt = JSON.parse(fs.readFileSync(file, 'utf8')).startedAt ?? 0; } catch { /* unreadable: stale */ }
      if (now - startedAt < STALE_MS) return false;
      fs.rmSync(file, { force: true }); // stale (a crashed cycle): take it over
    }
  }
  return false;
}

export function release(file = LOCK) {
  fs.rmSync(file, { force: true });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'acquire') {
    if (acquire()) console.log('lock: acquired');
    else { console.log('lock: another auto fixer cycle is running; stop'); process.exit(3); }
  } else if (cmd === 'release') {
    release();
    console.log('lock: released');
  } else {
    console.error('usage: lock.mjs acquire|release');
    process.exit(1);
  }
}
