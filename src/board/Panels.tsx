import { useEffect, useRef, useState } from 'react';
import { getDb } from '../db/db';
import { exportBackup, importBackup, purge, recentLog } from '../db/repo';
import {
  appliedCsv, cleanHideWord, DEFAULT_HIDDEN_TITLE_WORDS, agentStats, siteStats, SITE_LABEL, SITES, type BoardRow,
} from '../shared/board';
import { clampRefreshMinutes } from '../shared/safety';
import { save } from '../shared/store';
import type { LogEntry, Settings } from '../shared/types';
import type { Attempt } from '../shared/auto-apply/config';

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

const DAY_MS = 86_400_000;
const isoDay = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

type ColKey = 'added' | 'applied' | 'byAgent' | 'byYou' | 'tried' | 'stuck' | 'skipped' | 'success';

/** Per platform (or all of them): relevant jobs added and applications (by the agent / by you) for a period. */
function PlatformStats({ rows, attempts }: { rows: BoardRow[]; attempts: Attempt[] }) {
  const [period, setPeriod] = useState<'today' | '7' | '14' | '30' | 'all' | 'range'>('today');
  const now = Date.now();
  const [fromDay, setFromDay] = useState(isoDay(now - 7 * DAY_MS));
  const [toDay, setToDay] = useState(isoDay(now));
  const from = period === 'range' ? new Date(`${fromDay}T00:00:00`).getTime() : period === 'all' ? 0 : period === 'today' ? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() : now - Number(period) * DAY_MS;
  const to = period === 'range' ? new Date(`${toDay}T23:59:59`).getTime() : now;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  // Rows sorted by the column you click (biggest first, click again for smallest); Total stays last.
  const [sortBy, setSortBy] = useState<{ key: ColKey; desc: boolean }>({ key: 'added', desc: true });
  const table = SITES.map((p) => {
    const s = siteStats(rows, p, from, to);
    const a = agentStats(attempts, p, from, to);
    return { p, s, a, v: { added: s.added, applied: s.applied, byAgent: s.byAgent, byYou: s.byYou, tried: a.tried, stuck: a.stuck, skipped: a.skipped, success: a.tried ? s.byAgent / a.tried : -1 } };
  }).sort((x, y) => (sortBy.desc ? y.v[sortBy.key] - x.v[sortBy.key] : x.v[sortBy.key] - y.v[sortBy.key]) || SITE_LABEL[x.p].localeCompare(SITE_LABEL[y.p]));
  const total = { s: siteStats(rows, 'all', from, to), a: agentStats(attempts, 'all', from, to) };
  const head = (key: ColKey, label: string) => (
    <th scope="col" aria-sort={sortBy.key === key ? (sortBy.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="link" onClick={() => setSortBy({ key, desc: sortBy.key === key ? !sortBy.desc : true })}>
        {label}{sortBy.key === key ? (sortBy.desc ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  );
  return (
    <>
      <h3>By platform</h3>
      <div className="ats-chips" role="group" aria-label="Period">
        {([['today', 'Today'], ['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last month'], ['all', 'All time'], ['range', 'Dates']] as const).map(([p, label]) => (
          <button key={p} type="button" className={`chip ${period === p ? 'on' : ''}`} aria-pressed={period === p} onClick={() => setPeriod(p)}>{label}</button>
        ))}
        {period === 'range' && (
          <>
            <label className="hint">From <input type="date" value={fromDay} max={toDay} onChange={(e) => setFromDay(e.target.value)} /></label>
            <label className="hint">To <input type="date" value={toDay} min={fromDay} onChange={(e) => setToDay(e.target.value)} /></label>
          </>
        )}
      </div>
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">Platform</th>{head('added', 'Jobs added')}{head('applied', 'Applied')}
            {head('byAgent', 'By agent')}{head('byYou', 'By you')}{head('tried', 'Agent tried')}
            {head('stuck', 'Agent stuck')}{head('skipped', 'Agent skipped')}{head('success', 'Agent success')}
          </tr>
        </thead>
        <tbody>
          {[...table, { p: 'all' as const, ...total }].map(({ p, s, a }) => {
            return (
              <tr key={p} className={p === 'all' ? 'total' : ''}>
                <th scope="row">{p === 'all' ? 'Total' : SITE_LABEL[p]}</th>
                <td>{s.added}</td><td>{s.applied}</td><td>{s.byAgent}</td><td>{s.byYou}</td>
                <td>{a.tried}</td><td className={a.stuck ? 'warn-text' : ''}>{a.stuck}</td><td>{a.skipped}</td>
                <td title="Applied by the agent ÷ jobs it tried">{pct(s.byAgent, a.tried)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** Stats: the per-platform table only (user, 2026-11-10: "keep what we implemented today, remove the other data"). */
export function StatsPanel({ rows, attempts }: { rows: BoardRow[]; attempts: Attempt[] }) {
  return (
    <section className="panel" aria-labelledby="stats-h">
      <h2 id="stats-h">Stats</h2>
      <PlatformStats rows={rows} attempts={attempts} />
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
        9:30 each morning; the other sites refresh once a day at a random time in that window. Refresh still works any time.
      </p>
      <label className="check">
        <input type="checkbox" checked={settings.indeedOnBoardOpen}
          onChange={(e) => apply({ ...settings, indeedOnBoardOpen: e.target.checked })} />
        Also refresh the other sites when I open the board (each at most once an hour)
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.notifyNewJobs}
          onChange={(e) => apply({ ...settings, notifyNewJobs: e.target.checked })} />
        Desktop notification for new jobs
      </label>
      <p className="hint">
        Each page the app opens stays open for 2 to 3.5 minutes, with a random 5 to 20 second gap before the next.
        A captcha on any of the job sites stops all refreshes until you press Resume. LinkedIn is never refreshed: its
        jobs are saved only when you open LinkedIn job pages yourself.
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
