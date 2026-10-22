import { useEffect, useRef, useState } from 'react';
import { getDb } from '../db/db';
import { exportBackup, importBackup, purge, recentLog } from '../db/repo';
import { appliedCsv, type BoardRow, type Stats } from '../shared/board';
import { clampRefreshMinutes } from '../shared/safety';
import { save } from '../shared/store';
import type { LogEntry, Settings } from '../shared/types';

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

export function StatsPanel({ stats }: { stats: Stats }) {
  return (
    <section className="panel" aria-labelledby="stats-h">
      <h2 id="stats-h">Stats</h2>
      <dl className="stats">
        <div><dt>Applied, last 7 days</dt><dd>{stats.appliedLast7Days}</dd></div>
        <div><dt>Applied, all time</dt><dd>{stats.appliedTotal}</dd></div>
        <div>
          <dt>Median posting to apply</dt>
          <dd>{stats.medianHoursPostedToApplied === null ? '—' : `${stats.medianHoursPostedToApplied} h`}</dd>
        </div>
        <div><dt>Jobs tracked</dt><dd>{stats.jobsTracked}</dd></div>
        <div><dt>Easy Apply / Company Site / Unknown</dt>
          <dd>{stats.byType.easy_apply} / {stats.byType.company_site} / {stats.byType.unknown}</dd></div>
      </dl>
      <p className="hint">Targets: 2x your baseline applications per week, and a median under 24 hours.</p>
      <h3 className="hint">Jobs per Naukri feed ("search" is the saved product manager search; the rest match the tabs on Naukri's recommended jobs page)</h3>
      <dl className="stats">
        {Object.entries(stats.byFeed).sort(([a], [b]) => a.localeCompare(b)).map(([feed, n]) => (
          <div key={feed}><dt>{feed}</dt><dd>{n}</dd></div>
        ))}
      </dl>
    </section>
  );
}

export function SettingsPanel({ settings }: { settings: Settings }) {
  const [minutes, setMinutes] = useState(String(settings.refreshMinutes));
  useEffect(() => setMinutes(String(settings.refreshMinutes)), [settings.refreshMinutes]);

  const apply = async (next: Settings) => {
    await save('settings', { ...next, refreshMinutes: clampRefreshMinutes(next.refreshMinutes) });
    await chrome.runtime.sendMessage({ type: 'reschedule' });
  };

  return (
    <section className="panel" aria-labelledby="settings-h">
      <h2 id="settings-h">Settings</h2>
      <label className="check">
        <input type="checkbox" checked={settings.autoRefresh}
          onChange={(e) => apply({ ...settings, autoRefresh: e.target.checked })} />
        Refresh automatically while Chrome is open
      </label>
      <label>
        Every (minutes, minimum 15)
        <input type="number" min={15} max={1440} value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={() => apply({ ...settings, refreshMinutes: Number(minutes) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.notifyNewJobs}
          onChange={(e) => apply({ ...settings, notifyNewJobs: e.target.checked })} />
        Desktop notification for new jobs
      </label>
    </section>
  );
}

export function DataPanel({ rows, onChanged }: { rows: BoardRow[]; onChanged: () => void }) {
  const db = getDb();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');

  const doImport = async (file: File) => {
    try {
      const r = await importBackup(db, await file.text());
      setMsg(`Imported ${r.jobs} jobs and ${r.statuses} statuses.`);
      onChanged();
    } catch (e) {
      setMsg(`Import failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  };

  return (
    <section className="panel" aria-labelledby="data-h">
      <h2 id="data-h">Your data</h2>
      <p className="hint">Everything is stored only in this browser. Export a backup before reinstalling.</p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={async () =>
          download(`job-board-backup-${stamp()}.json`, await exportBackup(db, Date.now()), 'application/json')}>
          Export backup
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Import backup</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ''; }} />
        <button type="button" className="btn" onClick={() =>
          download(`applied-jobs-${stamp()}.csv`, appliedCsv(rows), 'text/csv')}>
          Export applied (CSV)
        </button>
        <button type="button" className="btn ghost" onClick={async () => {
          const n = await purge(db, Date.now());
          setMsg(`Removed ${n} jobs older than 60 days.`);
          onChanged();
        }}>Clean up old jobs</button>
      </div>
      {msg && <p role="status" className="hint">{msg}</p>}
    </section>
  );
}

export function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  useEffect(() => {
    recentLog(getDb()).then(setEntries).catch(() => undefined);
  }, []);
  return (
    <section className="panel" aria-labelledby="log-h">
      <h2 id="log-h">Activity log</h2>
      {entries.length === 0 ? <p className="hint">Nothing yet.</p> : (
        <ol className="log">
          {entries.map((e) => (
            <li key={e.id} className={`log-${e.level}`}>
              <time>{new Date(e.ts).toLocaleString()}</time> {e.message}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
