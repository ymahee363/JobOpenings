import { useEffect, useRef, useState } from 'react';
import { getDb } from '../db/db';
import { exportBackup, importBackup, purge, recentLog } from '../db/repo';
import { appliedCsv, cleanHideWord, DEFAULT_HIDDEN_TITLE_WORDS, type BoardRow, type Stats } from '../shared/board';
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
        <div><dt>Naukri / Indeed / Instahyre / Wellfound</dt>
          <dd>{stats.bySite.naukri} / {stats.bySite.indeed} / {stats.bySite.instahyre} / {stats.bySite.wellfound}</dd></div>
      </dl>
      <p className="hint">Targets: 2x your baseline applications per week, and a median under 24 hours.</p>
      <h3 className="hint">Jobs per feed ("search" is the saved Naukri product manager search, "indeed-*" come from Indeed, "instahyre-search" from Instahyre saved searches, "wellfound-search" from Wellfound; the rest match the tabs on Naukri's recommended jobs page)</h3>
      <dl className="stats">
        {Object.entries(stats.byFeed).sort(([a], [b]) => a.localeCompare(b)).map(([feed, n]) => (
          <div key={feed}><dt>{feed}</dt><dd>{n}</dd></div>
        ))}
      </dl>
    </section>
  );
}

interface SettingsProps {
  settings: Settings;
  hiddenTitleWords: string[];
  /** Open jobs the words hide right now. */
  hiddenCount: number;
}

export function SettingsPanel({ settings, hiddenTitleWords, hiddenCount }: SettingsProps) {
  const [word, setWord] = useState('');
  const [wordMsg, setWordMsg] = useState('');
  const saveWords = (next: string[]) => save('hiddenTitleWords', next).catch(() => undefined);
  const addWord = () => {
    const w = cleanHideWord(word);
    if (!w) return;
    if (hiddenTitleWords.some((x) => x.toLowerCase() === w.toLowerCase())) {
      setWordMsg(`"${w}" is already in the list.`);
      return;
    }
    saveWords([...hiddenTitleWords, w]);
    setWord('');
    setWordMsg('');
  };

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
        Naukri every (minutes, minimum 15), plus a random 30 s to 15 min each time
        <input type="number" min={15} max={1440} value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={() => apply({ ...settings, refreshMinutes: Number(minutes) })} />
      </label>
      <p className="hint">
        Automatic refreshes run only between 9:00 and 22:00. Naukri picks up again at a random time between 9:00 and
        9:30 each morning; Indeed, Instahyre and Wellfound refresh once a day at a random time in that window. Refresh still works any time.
      </p>
      <label className="check">
        <input type="checkbox" checked={settings.indeedOnBoardOpen}
          onChange={(e) => apply({ ...settings, indeedOnBoardOpen: e.target.checked })} />
        Also refresh Indeed, Instahyre and Wellfound when I open the board (each at most once an hour)
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.notifyNewJobs}
          onChange={(e) => apply({ ...settings, notifyNewJobs: e.target.checked })} />
        Desktop notification for new jobs
      </label>
      <p className="hint">
        Each page the app opens stays open for 2 to 3.5 minutes, with a random 5 to 20 second gap before the next.
        A captcha on any of the job sites stops all refreshes until you press Resume.
      </p>

      <h3 className="hint">Hide jobs whose title has these words</h3>
      <p className="hint">
        Whole words, any case, plurals included: "Engineer" hides "Software Engineer" but not "Engineering Manager"
        (add "Engineering" for that). Hidden jobs stay saved and come back if you remove the word; the Applied tab
        always shows everything. {hiddenCount > 0 && `Hiding ${hiddenCount} job${hiddenCount === 1 ? '' : 's'} now.`}
      </p>
      <ul className="word-chips" aria-label="Hidden title words">
        {hiddenTitleWords.length === 0 && <li className="hint">No words; nothing is hidden.</li>}
        {hiddenTitleWords.map((w) => (
          <li key={w} className="chip">
            {w}
            <button type="button" className="chip-x" aria-label={`Stop hiding "${w}"`}
              onClick={() => saveWords(hiddenTitleWords.filter((x) => x !== w))}>×</button>
          </li>
        ))}
      </ul>
      <form className="word-add" onSubmit={(e) => { e.preventDefault(); addWord(); }}>
        <input type="text" placeholder="e.g. Intern, Sales" value={word} aria-label="Word to hide"
          onChange={(e) => { setWord(e.target.value); setWordMsg(''); }} />
        <button type="submit" className="btn">Hide titles with this word</button>
        {(hiddenTitleWords.length !== DEFAULT_HIDDEN_TITLE_WORDS.length
          || hiddenTitleWords.some((w, i) => w !== DEFAULT_HIDDEN_TITLE_WORDS[i])) && (
          <button type="button" className="btn ghost" onClick={() => saveWords(DEFAULT_HIDDEN_TITLE_WORDS)}>
            Reset to Designer, Engineer
          </button>
        )}
      </form>
      {wordMsg && <p role="status" className="hint">{wordMsg}</p>}
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
