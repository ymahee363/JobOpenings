/**
 * Reads the extension's auto-apply attempts straight from Chrome's IndexedDB files (LevelDB), with no native modules:
 * table files (.ldb, snappy-compressed blocks) and the write-ahead log (.log), each value decoded with v8.deserialize.
 * Replaces the auto fixer's old `tr` scan of the raw files, which could not read compressed blocks and counted stale
 * copies of a record (2026-11-11).
 *
 * Correctness (backend review, 2026-11-11):
 *  - reads a snapshot copy, so Chrome compacting or deleting a file mid-read cannot drop data;
 *  - one record per LevelDB key, the highest sequence number wins, and a delete removes the record;
 *  - log records are checked with their CRC32C; a torn or corrupt record is skipped, not the whole file;
 *  - every value that looks like an attempt but cannot be decoded is counted in `stats`, never silently lost;
 *  - the database is found by the extension's own folder (Chrome's preferences), so no other extension's data is read.
 *
 *   node scripts/auto-fixer/read-attempts.mjs [--dir <leveldb dir>] [--since <ms>] > attempts.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_NAME = 'naukri-fast-apply';

// ---------- bytes ----------

function varint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('varint past end');
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [result, pos];
    shift += 7;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32C (Castagnoli), as LevelDB uses. */
export function crc32c(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** LevelDB stores CRCs masked. */
export function maskCrc(crc) {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

/** Raw snappy (the format LevelDB uses for blocks). */
export function snappyDecompress(bytes) {
  const src = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let [len, pos] = varint(src, 0);
  const out = Buffer.alloc(len);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = src.readUIntLE(pos, bytes);
        pos += bytes;
      }
      n += 1;
      src.copy(out, o, pos, pos + n);
      pos += n;
      o += n;
      continue;
    }
    let length;
    let offset;
    if (type === 1) {
      length = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[pos++];
    } else if (type === 2) {
      length = (tag >> 2) + 1;
      offset = src.readUInt16LE(pos);
      pos += 2;
    } else {
      length = (tag >> 2) + 1;
      offset = src.readUInt32LE(pos);
      pos += 4;
    }
    if (offset === 0 || offset > o) throw new RangeError('snappy copy before start');
    for (let i = 0; i < length; i += 1) out[o + i] = out[o - offset + i];
    o += length;
  }
  return out;
}

// ---------- LevelDB table (.ldb) ----------

function readBlock(file, offset, size) {
  const data = file.subarray(offset, offset + size);
  return file[offset + size] === 1 ? snappyDecompress(data) : data;
}

function* blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 * (restarts + 1);
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < end) {
    let shared;
    let unshared;
    let valueLen;
    [shared, pos] = varint(block, pos);
    [unshared, pos] = varint(block, pos);
    [valueLen, pos] = varint(block, pos);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + unshared)]);
    pos += unshared;
    yield [key, block.subarray(pos, pos + valueLen)];
    pos += valueLen;
  }
}

/** Every entry of a table file: { key, seq, put, value }. A bad block is counted and skipped. */
export function* tableEntries(file, stats = {}) {
  const footer = file.subarray(file.length - 48);
  let pos = 0;
  [, pos] = varint(footer, pos);
  [, pos] = varint(footer, pos);
  let indexOffset;
  let indexSize;
  [indexOffset, pos] = varint(footer, pos);
  [indexSize, pos] = varint(footer, pos);
  for (const [, handle] of blockEntries(readBlock(file, indexOffset, indexSize))) {
    let entries;
    try {
      const [offset, p] = varint(handle, 0);
      const [size] = varint(handle, p);
      entries = [...blockEntries(readBlock(file, offset, size))];
    } catch {
      stats.badBlocks = (stats.badBlocks ?? 0) + 1;
      continue;
    }
    for (const [ikey, value] of entries) {
      const trailer = ikey.readBigUInt64LE(ikey.length - 8);
      yield { key: ikey.subarray(0, ikey.length - 8).toString('latin1'), seq: Number(trailer >> 8n), put: (trailer & 0xffn) === 1n, value };
    }
  }
}

// ---------- LevelDB write-ahead log (.log) ----------

/** Every entry written in a log file: { key, seq, put, value }. Records failing their CRC are counted and skipped. */
export function* logEntries(file, stats = {}) {
  const BLOCK = 32768;
  let record = null;
  for (let blockStart = 0; blockStart < file.length; blockStart += BLOCK) {
    let pos = blockStart;
    const blockEnd = Math.min(blockStart + BLOCK, file.length);
    while (pos + 7 <= blockEnd) {
      const crc = file.readUInt32LE(pos);
      const len = file.readUInt16LE(pos + 4);
      const type = file[pos + 6];
      if (type === 0 && len === 0) break; // zero padding
      if (pos + 7 + len > blockEnd) { // torn tail (Chrome still writing)
        stats.tornRecords = (stats.tornRecords ?? 0) + 1;
        break;
      }
      const chunk = file.subarray(pos + 7, pos + 7 + len);
      pos += 7 + len;
      if (maskCrc(crc32c(Buffer.concat([Buffer.from([type]), chunk]))) !== crc) {
        stats.badCrc = (stats.badCrc ?? 0) + 1;
        record = null;
        continue;
      }
      if (type === 1 || type === 2) record = [chunk];
      else if ((type === 3 || type === 4) && record) record.push(chunk);
      if ((type === 1 || type === 4) && record) {
        try {
          yield* batchEntries(Buffer.concat(record));
        } catch {
          stats.badBatches = (stats.badBatches ?? 0) + 1;
        }
        record = null;
      }
    }
  }
}

function* batchEntries(batch) {
  if (batch.length < 12) return;
  let seq = Number(batch.readBigUInt64LE(0));
  const count = batch.readUInt32LE(8);
  let pos = 12;
  const out = [];
  for (let i = 0; i < count; i += 1, seq += 1) {
    const tag = batch[pos++];
    let keyLen;
    [keyLen, pos] = varint(batch, pos);
    const key = batch.subarray(pos, pos + keyLen).toString('latin1');
    pos += keyLen;
    if (tag === 1) {
      let valueLen;
      [valueLen, pos] = varint(batch, pos);
      out.push({ key, seq, put: true, value: batch.subarray(pos, pos + valueLen) });
      pos += valueLen;
    } else {
      out.push({ key, seq, put: false, value: null });
    }
  }
  yield* out; // a batch is applied whole or not at all
}

// ---------- IndexedDB values → attempts ----------

/** The V8-serialized object inside a Blink IndexedDB value; `null` when there is none, throws when it cannot decode. */
export function decodeValue(value) {
  let lastError = null;
  for (let i = value.indexOf(0xff); i >= 0 && i < value.length - 2 && i < 64; i = value.indexOf(0xff, i + 1)) {
    if (value[i + 2] !== 0x6f && value[i + 2] !== 0x3f) continue;
    const payload = Buffer.from(value.subarray(i));
    // Chrome writes V8 format 16 (2026); Node 24 reads up to 15, and plain objects are the same in both. A newer
    // format is not guessed at: it is reported as a decode failure.
    if (payload[1] === 16) payload[1] = 15;
    try {
      const v = v8.deserialize(payload);
      if (v && typeof v === 'object') return v;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return null;
}

const isAttempt = (v) => v && typeof v.jobId === 'string' && typeof v.startedAt === 'number' && typeof v.outcome === 'string' && 'reason' in v;

function chromeRoot() {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
}

/** Extension ids in a profile whose unpacked folder is this repo's dist/, or whose packed manifest has our name. */
function ourExtensionIds(profileDir) {
  const ids = new Set();
  const dist = path.join(ROOT, 'dist').toLowerCase();
  for (const f of ['Secure Preferences', 'Preferences']) {
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(profileDir, f), 'utf8').replace(/^﻿/, ''));
      for (const [id, v] of Object.entries(prefs?.extensions?.settings ?? {})) {
        if (typeof v?.path === 'string' && path.resolve(v.path).toLowerCase() === dist) ids.add(id);
      }
    } catch { /* unreadable: skip, never print its content */ }
  }
  const exts = path.join(profileDir, 'Extensions');
  for (const id of fs.existsSync(exts) ? fs.readdirSync(exts) : []) {
    for (const ver of fs.readdirSync(path.join(exts, id))) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(exts, id, ver, 'manifest.json'), 'utf8')).name === EXTENSION_NAME) ids.add(id);
      } catch { /* not ours */ }
    }
  }
  return ids;
}

/** The extension's IndexedDB folder: in any Chrome profile, the most recently written one. */
export function findDbDir() {
  const root = chromeRoot();
  const found = [];
  for (const profile of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const profileDir = path.join(root, profile);
    if (!fs.existsSync(path.join(profileDir, 'IndexedDB'))) continue;
    for (const id of ourExtensionIds(profileDir)) {
      const dir = path.join(profileDir, 'IndexedDB', `chrome-extension_${id}_0.indexeddb.leveldb`);
      if (fs.existsSync(dir)) found.push({ dir, mtime: fs.statSync(dir).mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.dir ?? null;
}

/** Copy the database's files to a temp folder, retrying when Chrome removes a file mid-copy (compaction). */
export function snapshot(dir) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-idb-'));
    try {
      for (const f of fs.readdirSync(dir)) if (/\.(ldb|log)$/.test(f)) fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
      return tmp;
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (e?.code !== 'ENOENT' || attempt === 2) throw e;
    }
  }
  return dir;
}

/** Attempts (the newest version of each record, deletes applied) and read statistics. */
export function readAttemptsWithStats(dir, since = 0) {
  const stats = { files: 0, entries: 0, attempts: 0, decodeFailures: 0, badBlocks: 0, tornRecords: 0, badCrc: 0, badBatches: 0, badFiles: 0 };
  const latest = new Map(); // LevelDB key → { seq, put, value }
  const snap = snapshot(dir);
  try {
    for (const f of fs.readdirSync(snap).filter((x) => /\.(ldb|log)$/.test(x))) {
      stats.files += 1;
      const buf = fs.readFileSync(path.join(snap, f));
      try {
        for (const e of f.endsWith('.ldb') ? tableEntries(buf, stats) : logEntries(buf, stats)) {
          stats.entries += 1;
          const prev = latest.get(e.key);
          if (!prev || e.seq > prev.seq) latest.set(e.key, e);
        }
      } catch {
        stats.badFiles += 1;
      }
    }
  } finally {
    if (snap !== dir) fs.rmSync(snap, { recursive: true, force: true });
  }
  const attempts = [];
  for (const e of latest.values()) {
    if (!e.put || e.value.length < 20 || !e.value.includes('jobId') || !e.value.includes('outcome')) continue;
    let v;
    try {
      v = decodeValue(e.value);
    } catch {
      stats.decodeFailures += 1;
      continue;
    }
    if (isAttempt(v) && v.startedAt >= since) attempts.push(v);
  }
  attempts.sort((a, b) => b.startedAt - a.startedAt);
  stats.attempts = attempts.length;
  return { attempts, stats };
}

export function readAttempts(dir, since = 0) {
  return readAttemptsWithStats(dir, since).attempts;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const dir = arg('--dir') ?? findDbDir();
  if (!dir) {
    console.error('No IndexedDB folder of the extension found in any Chrome profile.');
    process.exit(1);
  }
  const { attempts, stats } = readAttemptsWithStats(dir, Number(arg('--since') ?? 0));
  const slim = attempts.map(({ jobId, title, company, startedAt, finishedAt, mode, outcome, reason, questions, clicked, build }) =>
    ({ jobId, title, company, startedAt, finishedAt, mode, outcome, reason, questions, clicked, ...(build ? { build } : {}) }));
  process.stdout.write(JSON.stringify({ dir, stats, count: slim.length, attempts: slim }, null, 1));
}
