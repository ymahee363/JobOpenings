import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDb } from '../db/db';
import { restoreStatus, setStatus } from '../db/repo';
import { buildRows, computeStats, rowsForTab, type BoardRow, type BoardTab, type Filters } from '../shared/board';
import { formatAge } from '../shared/dates';
import type { RefreshResponse } from '../shared/messages';
import { save } from '../shared/store';
import type { JobStatus, Status } from '../shared/types';
import { NAUKRI_LOGIN_URL, RECOMMENDED_JOBS_URL } from '../shared/url';
import { FilterBar } from './FilterBar';
import { JobRow } from './JobRow';
import { DataPanel, LogPanel, SettingsPanel, StatsPanel } from './Panels';
import { useBoardData } from './useBoardData';

const TABS: Array<{ id: BoardTab; label: string }> = [
  { id: 'easy_apply', label: 'Easy Apply' },
  { id: 'company_site', label: 'Company Site' },
  { id: 'unknown', label: 'Unknown' },
  { id: 'applied', label: 'Applied' },
];

type Panel = 'none' | 'stats' | 'settings' | 'data' | 'log';
interface Toast { text: string; undo?: { jobId: string; prev: JobStatus | null } }

const UNDO_MS = 5_000;
const TAB_KEY = 'board.tab';

function readTab(): BoardTab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t && TABS.some((x) => x.id === t)) return t as BoardTab;
  } catch {
    // Storage unavailable; use the default.
  }
  return 'easy_apply';
}

function openTab(url: string): void {
  // chrome.tabs.create gives the new page no reference back to this one.
  chrome.tabs.create({ url, active: true }).catch(() => undefined);
}

export function App() {
  const db = getDb();
  const { data, reloadDb, markAllSeen } = useBoardData();
  const { jobs, statuses, health, safety, settings, pendingApply, lastVisitAt, now } = data;

  // Filters are edited locally (instant typing) and persisted in the background.
  const [filters, setFiltersState] = useState<Filters>(data.filters);
  const filtersLoaded = useRef(false);
  useEffect(() => {
    if (!filtersLoaded.current && data.loaded) {
      filtersLoaded.current = true;
      setFiltersState(data.filters);
    }
  }, [data.loaded, data.filters]);

  const [tab, setTabState] = useState<BoardTab>(readTab);
  const [selected, setSelected] = useState(0);
  const [panel, setPanel] = useState<Panel>('none');
  const [toast, setToast] = useState<Toast | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [askApplied, setAskApplied] = useState<BoardRow | null>(null);
  const keywordRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const setTab = (t: BoardTab) => {
    setTabState(t);
    setSelected(0);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* ignore */ }
  };

  const rows = useMemo(() => buildRows(jobs, statuses, lastVisitAt, now), [jobs, statuses, lastVisitAt, now]);
  const visible = useMemo(() => rowsForTab(rows, tab, filters, now), [rows, tab, filters, now]);
  const counts = useMemo(() => {
    const out = {} as Record<BoardTab, { total: number; fresh: number }>;
    for (const t of TABS) {
      const r = rowsForTab(rows, t.id, filters, now);
      out[t.id] = { total: r.length, fresh: r.filter((x) => x.isNew).length };
    }
    return out;
  }, [rows, filters, now]);
  const stats = useMemo(() => computeStats(rows, now), [rows, now]);

  useEffect(() => {
    if (selected >= visible.length && visible.length > 0) setSelected(visible.length - 1);
  }, [visible.length, selected]);

  const showToast = useCallback((t: Toast) => {
    clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  }, []);

  const changeStatus = useCallback(async (row: BoardRow, status: Status, text: string) => {
    const prev = await setStatus(db, row.jobId, status, Date.now());
    await reloadDb();
    showToast({ text, undo: { jobId: row.jobId, prev } });
  }, [db, reloadDb, showToast]);

  const undo = useCallback(async () => {
    if (!toast?.undo) return;
    await restoreStatus(db, toast.undo.jobId, toast.undo.prev);
    setToast(null);
    await reloadDb();
  }, [db, toast, reloadDb]);

  const markSeen = useCallback(async (row: BoardRow) => {
    if (row.status === 'new') {
      await setStatus(db, row.jobId, 'seen', Date.now());
      await reloadDb();
    }
  }, [db, reloadDb]);

  const primary = useCallback(async (row: BoardRow) => {
    const url = row.applyType === 'company_site' ? row.externalUrl ?? row.naukriUrl : row.naukriUrl;
    await save('pendingApply', { jobId: row.jobId, at: Date.now() });
    openTab(url);
    await markSeen(row);
  }, [markSeen]);

  // FR-7 fallback: when I come back from an apply, ask whether it went through.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible' || !pendingApply) return;
      const row = rows.find((r) => r.jobId === pendingApply.jobId);
      if (!row || row.status === 'applied') {
        save('pendingApply', null).catch(() => undefined);
        setAskApplied(null);
        return;
      }
      setAskApplied(row);
    };
    // Short delay lets an auto-detected apply land first.
    const t = setTimeout(check, 1_500);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, [pendingApply, rows]);

  const answerApplied = async (yes: boolean) => {
    const row = askApplied;
    setAskApplied(null);
    await save('pendingApply', null);
    if (row && yes) await changeStatus(row, 'applied', `Marked "${row.title}" as applied`);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'refresh' })) as RefreshResponse;
      if (res.ok) showToast({ text: res.added ? `${res.added} new job${res.added === 1 ? '' : 's'}` : 'Up to date' });
      else showToast({ text: res.retryAt ? `${res.reason}. Next at ${new Date(res.retryAt).toLocaleTimeString()}` : res.reason });
    } catch (e) {
      showToast({ text: `Refresh failed: ${String(e)}` });
    } finally {
      setRefreshing(false);
    }
  };

  const setFilters = (f: Filters) => {
    setFiltersState(f);
    setSelected(0);
    save('filters', f).catch(() => undefined);
  };

  // FR-14 keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      const row = visible[selected];
      const key = e.key;
      if (key === 'j' || key === 'ArrowDown') setSelected((s) => Math.min(s + 1, Math.max(visible.length - 1, 0)));
      else if (key === 'k' || key === 'ArrowUp') setSelected((s) => Math.max(s - 1, 0));
      else if (key === 'Enter' && row && el.tagName !== 'BUTTON') primary(row);
      else if (key === 'd' && row && tab !== 'applied') changeStatus(row, 'dismissed', `Dismissed "${row.title}"`);
      else if (key === 'm' && row && tab !== 'applied') changeStatus(row, 'applied', `Marked "${row.title}" as applied`);
      else if (key === 'u') undo();
      else if (key === '/') keywordRef.current?.focus();
      else if (key >= '1' && key <= '4') setTab(TABS[Number(key) - 1]!.id);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    const row = visible[selected];
    if (row) document.getElementById(`job-${row.jobId}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, visible]);

  const paused = safety.pausedUntil !== null && safety.pausedUntil > now;
  const nextRefreshAt = safety.lastAppLoadAt ? safety.lastAppLoadAt + 15 * 60_000 : null;
  const statusText = health.pageState === 'logged_out' ? 'Logged out'
    : health.parser === 'needs_update' ? 'Parser needs update'
      : paused ? 'Paused' : refreshing ? 'Refreshing…' : 'OK';

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>Job Board</h1>
          <span className={`status status-${statusText === 'OK' || statusText === 'Refreshing…' ? 'ok' : 'warn'}`}>{statusText}</span>
        </div>
        <div className="header-meta">
          <span>Last refreshed {health.lastCaptureAt ? formatAge(health.lastCaptureAt, now) : 'never'}</span>
          <button type="button" className="btn primary" onClick={refresh}
            disabled={refreshing || paused || (nextRefreshAt !== null && nextRefreshAt > now)}
            title={nextRefreshAt && nextRefreshAt > now ? `Next refresh available at ${new Date(nextRefreshAt).toLocaleTimeString()}` : 'Refresh from Naukri'}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {(['stats', 'settings', 'data', 'log'] as const).map((p) => (
            <button key={p} type="button" className={`btn ghost ${panel === p ? 'on' : ''}`} aria-expanded={panel === p}
              onClick={() => setPanel(panel === p ? 'none' : p)}>
              {p[0]!.toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {health.pageState === 'logged_out' && (
        <div className="banner warn" role="alert">
          Logged out of Naukri. <button type="button" className="link" onClick={() => openTab(NAUKRI_LOGIN_URL)}>Log in</button>, then refresh.
        </div>
      )}
      {health.parser === 'needs_update' && (
        <div className="banner warn" role="alert">
          Naukri changed its data format and the parser needs an update. Your saved jobs are kept. See the activity log.
        </div>
      )}
      {paused && (
        <div className="banner" role="status">
          App refresh paused until {new Date(safety.pausedUntil!).toLocaleTimeString()} ({safety.pauseReason}).
          Jobs still arrive whenever you open Naukri yourself.
          {safety.pauseReason !== 'Naukri showed a captcha' && (
            <> <button type="button" className="link" onClick={() => chrome.runtime.sendMessage({ type: 'resume' })}>Resume now</button></>
          )}
        </div>
      )}

      {panel === 'stats' && <StatsPanel stats={stats} />}
      {panel === 'settings' && <SettingsPanel settings={settings} />}
      {panel === 'data' && <DataPanel rows={rows} onChanged={reloadDb} />}
      {panel === 'log' && <LogPanel />}

      {tab !== 'applied' && <FilterBar ref={keywordRef} filters={filters} onChange={setFilters} />}

      <nav className="tabs" role="tablist" aria-label="Apply type">
        {TABS.filter((t) => t.id !== 'unknown' || counts.unknown.total > 0).map((t, i) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} title={`Shortcut: ${i + 1}`}>
            {t.label} ({counts[t.id].total})
            {counts[t.id].fresh > 0 && t.id !== 'applied' && <span className="badge">{counts[t.id].fresh} new</span>}
          </button>
        ))}
        <span className="spacer" />
        <button type="button" className="btn ghost small" onClick={markAllSeen}>Mark all as seen</button>
      </nav>

      <main role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {!data.loaded ? <p className="empty">Loading…</p>
          : jobs.length === 0 ? (
            <div className="empty">
              <h2>No jobs yet</h2>
              <p>Open your Naukri recommended jobs or the saved search once while logged in, or press Refresh.</p>
              <button type="button" className="btn primary" onClick={() => openTab(RECOMMENDED_JOBS_URL)}>Open Naukri</button>
            </div>
          ) : visible.length === 0 ? (
            <p className="empty">Nothing here with these filters.</p>
          ) : (
            <div className="list">
              {visible.map((row, i) => (
                <JobRow key={row.jobId} row={row} now={now} selected={i === selected}
                  onSelect={() => setSelected(i)}
                  onPrimary={() => primary(row)}
                  onOpenNaukri={() => { openTab(row.naukriUrl); markSeen(row); }}
                  onMarkApplied={() => changeStatus(row, 'applied', `Marked "${row.title}" as applied`)}
                  onDismiss={() => changeStatus(row, 'dismissed', `Dismissed "${row.title}"`)} />
              ))}
            </div>
          )}
      </main>

      <footer className="keys" aria-label="Keyboard shortcuts">
        j/k move · Enter apply/open · m mark applied · d dismiss · u undo · / search · 1–4 tabs
      </footer>

      {askApplied && (
        <div className="prompt" role="dialog" aria-label="Confirm application">
          <span>Did you apply to <strong>{askApplied.title}</strong> at {askApplied.company}?</span>
          <button type="button" className="btn primary" onClick={() => answerApplied(true)}>Yes</button>
          <button type="button" className="btn" onClick={() => answerApplied(false)}>No</button>
        </div>
      )}
      <div className="toast-area" aria-live="polite">
        {toast && (
          <div className="toast">
            {toast.text}
            {toast.undo && <button type="button" className="link" onClick={undo}>Undo</button>}
          </div>
        )}
      </div>
    </div>
  );
}
