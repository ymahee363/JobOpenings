import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDb } from '../db/db';
import { restoreStatus, setStatus } from '../db/repo';
import {
  atsCounts, buildRows, computeStats, countHiddenByTitle, extraDetailsFrom, rowsForTab, type BoardRow, type BoardTab, type Filters,
  type MovableTab, type TabOverrides,
} from '../shared/board';
import { agentHeadline } from '../shared/auto-apply/pacing';
import { applyUrlOf } from '../shared/auto-apply/runner';
import { formatAge } from '../shared/dates';
import type { RefreshResponse } from '../shared/messages';
import { load, save } from '../shared/store';
import type { JobStatus, Status } from '../shared/types';
import { INDEED_HOME_URL, NAUKRI_LOGIN_URL, RECOMMENDED_JOBS_URL } from '../shared/url';
import { FilterBar } from './FilterBar';
import { JobRow } from './JobRow';
import { SignInList } from './SignInList';
import { AgentPanel } from './AgentPanel';
import { ProfilePanel } from './ProfilePanel';
import { DataPanel, LogPanel, SettingsPanel, StatsPanel } from './Panels';
import { SourcesPanel } from './SourcesPanel';
import { useBoardData } from './useBoardData';

const TABS: Array<{ id: BoardTab; label: string }> = [
  { id: 'easy_apply', label: 'Easy Apply' },
  { id: 'company_site', label: 'Company Site' },
  { id: 'extra_details', label: 'Extra Details' },
  { id: 'unknown', label: 'Unknown' },
  { id: 'applied', label: 'Applied' },
];

type Panel = 'none' | 'agent' | 'profile' | 'stats' | 'settings' | 'sources' | 'data' | 'log';
/** Undo restores the job's status, and its dragged-to tab when `overrides` is set. */
interface Toast { text: string; undo?: { jobId: string; prev: JobStatus | null; overrides?: TabOverrides } }

/** The drag payload: a job ID, under our own type so other drags (text, files) are ignored. */
const DRAG_TYPE = 'application/x-board-job';

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

/** "14:05" today, "Thu 14:05" on another day. */
function shortTime(t: number, now: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Start AI apply on a link (runs in parallel with any others); resolves to what to tell you. */
async function startAiApply(url: string, jobId: string | null): Promise<string> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ai-apply', url, jobId }) as { ok?: boolean; running?: number } | undefined;
    if (!res?.ok) return 'Apply with AI could not start: the extension did not accept the link. Reload the extension and try again.';
    return (res.running ?? 1) > 1 ? `Apply with AI started in a new tab (${res.running} running in parallel).` : 'Apply with AI started in a new tab.';
  } catch {
    return 'Apply with AI could not start: the extension is not responding. Reload it from chrome://extensions.';
  }
}

/** Apply with AI on any job or career page link you paste. */
function ApplyByLink({ onResult }: { onResult: (text: string) => void }) {
  const [url, setUrl] = useState('');
  const valid = (() => {
    try {
      return /^https?:$/.test(new URL(url.trim()).protocol);
    } catch {
      return false;
    }
  })();
  return (
    <form className="ai-url" onSubmit={(e) => {
      e.preventDefault();
      if (!valid) return;
      startAiApply(url.trim(), null).then(onResult).catch(() => undefined);
      setUrl('');
    }}>
      <input type="url" placeholder="Apply by link: paste any job or career page URL" aria-label="Job link to apply to"
        value={url} onChange={(e) => setUrl(e.target.value)} />
      <button type="submit" className="btn primary" disabled={!valid}>Apply</button>
      <button type="button" className="btn ghost" onClick={() => { chrome.runtime.sendMessage({ type: 'ai-apply-stop' }).catch(() => undefined); }}>Stop</button>
    </form>
  );
}

function openTab(url: string): void {
  // chrome.tabs.create gives the new page no reference back to this one.
  chrome.tabs.create({ url, active: true }).catch(() => undefined);
}

export function App() {
  const db = getDb();
  const { data, reloadDb, markAllSeen } = useBoardData();
  const { jobs, statuses, health, safety, settings, pendingApply, lastVisitAt, now, hiddenTitleWords, agent, agentState } = data;

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
  const [overrides, setOverrides] = useState<TabOverrides>({});
  const [dropTarget, setDropTarget] = useState<BoardTab | null>(null);
  useEffect(() => {
    load('tabOverrides').then(setOverrides).catch(() => undefined);
  }, []);
  const saveOverrides = useCallback((next: TabOverrides) => {
    setOverrides(next);
    save('tabOverrides', next).catch(() => undefined);
  }, []);

  // Opening the board refreshes Indeed, Instahyre and Wellfound in the background (if enabled, each at most once an hour).
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'board-opened' }).catch(() => undefined);
  }, []);
  const [selected, setSelected] = useState(0);
  /** Set by j/k and the arrow keys: only a keyboard move scrolls the list, never a data refresh or a click. */
  const scrollToSelected = useRef(false);
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

  const extra = useMemo(() => extraDetailsFrom(data.attempts), [data.attempts]);
  const rows = useMemo(() => buildRows(jobs, statuses, lastVisitAt, now, extra, overrides), [jobs, statuses, lastVisitAt, now, extra, overrides]);
  const visible = useMemo(() => rowsForTab(rows, tab, filters, now, hiddenTitleWords), [rows, tab, filters, now, hiddenTitleWords]);
  const atsChips = useMemo(() => atsCounts(rows, tab, filters, now, hiddenTitleWords), [rows, tab, filters, now, hiddenTitleWords]);
  const counts = useMemo(() => {
    const out = {} as Record<BoardTab, { total: number; fresh: number }>;
    for (const t of TABS) {
      const r = rowsForTab(rows, t.id, filters, now, hiddenTitleWords);
      out[t.id] = { total: r.length, fresh: r.filter((x) => x.isNew).length };
    }
    return out;
  }, [rows, filters, now, hiddenTitleWords]);
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

  /**
   * Drag and drop: a job dropped on Applied is marked applied; dropped on another tab, it is filed there (and taken
   * out of Applied if it was in it). Undo puts it back.
   */
  const moveRow = useCallback(async (jobId: string, target: BoardTab) => {
    const row = rows.find((r) => r.jobId === jobId);
    if (!row) return;
    const label = TABS.find((t) => t.id === target)?.label ?? target;
    if (target === 'applied') {
      if (row.status === 'applied') return;
      await changeStatus(row, 'applied', `Marked "${row.title}" as applied`);
      return;
    }
    const before = overrides;
    const { [jobId]: _old, ...rest } = overrides;
    saveOverrides({ ...rest, [jobId]: target as MovableTab });
    const prev = row.status === 'applied' ? await setStatus(db, jobId, 'seen', Date.now()) : (statuses.find((s) => s.jobId === jobId) ?? null);
    if (row.status === 'applied') await reloadDb();
    showToast({ text: `Moved "${row.title}" to ${label}`, undo: { jobId, prev, overrides: before } });
  }, [rows, overrides, saveOverrides, changeStatus, db, statuses, reloadDb, showToast]);

  const undo = useCallback(async () => {
    if (!toast?.undo) return;
    if (toast.undo.overrides) saveOverrides(toast.undo.overrides);
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
      if (res.ok) {
        const text = res.added ? `${res.added} new job${res.added === 1 ? '' : 's'}` : 'Up to date';
        showToast({ text: res.note ? `${text}. Skipped: ${res.note}` : text });
      }
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
      if (key === 'j' || key === 'ArrowDown') { scrollToSelected.current = true; setSelected((s) => Math.min(s + 1, Math.max(visible.length - 1, 0))); }
      else if (key === 'k' || key === 'ArrowUp') { scrollToSelected.current = true; setSelected((s) => Math.max(s - 1, 0)); }
      else if (key === 'Enter' && row && el.tagName !== 'BUTTON') primary(row);
      else if (key === 'd' && row && tab !== 'applied') changeStatus(row, 'dismissed', `Dismissed "${row.title}"`);
      else if (key === 'm' && row && tab !== 'applied') changeStatus(row, 'applied', `Marked "${row.title}" as applied`);
      else if (key === 'u') undo();
      else if (key === '/') keywordRef.current?.focus();
      else if (key >= '1' && key <= '5') setTab(TABS[Number(key) - 1]!.id);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Scroll only after a keyboard move. Before, this ran whenever the list was rebuilt (new captures, the clock),
  // pulling the page back up to the selected job while you scrolled.
  useEffect(() => {
    if (!scrollToSelected.current) return;
    scrollToSelected.current = false;
    const row = visible[selected];
    if (row) document.getElementById(`job-${row.jobId}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, visible]);

  const halted = safety.haltedAt !== null;
  const paused = safety.pausedUntil !== null && safety.pausedUntil > now;
  const statusText = halted ? 'Stopped'
    : health.pageState === 'logged_out' ? 'Logged out'
      : health.parser === 'needs_update' ? 'Parser needs update'
        : paused ? 'Paused' : refreshing ? 'Refreshing…' : 'OK';
  const resumeRefresh = () => chrome.runtime.sendMessage({ type: 'resume' }).catch(() => undefined);
  // Jobs the agent applied to today; the Agent panel has the full breakdown.
  const agentToday = useMemo(() => {
    const from = new Date(now).setHours(0, 0, 0, 0);
    return rows.filter((r) => r.appliedBy === 'agent' && (r.statusAt ?? 0) >= from).length;
  }, [rows, now]);
  const agentLine = agentHeadline(agent, agentState, halted, agentToday, (t) => shortTime(t, now));
  const toggleKeepAwake = async () => {
    await save('agent', { ...agent, keepAwake: !agent.keepAwake });
    await chrome.runtime.sendMessage({ type: 'reschedule' }).catch(() => undefined);
  };
  const toggleAgent = async () => {
    await save('agent', { ...agent, autoApply: !agent.autoApply });
    await chrome.runtime.sendMessage({ type: 'reschedule' }).catch(() => undefined);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>Job Board</h1>
          <span className={`status status-${statusText === 'OK' || statusText === 'Refreshing…' ? 'ok' : 'warn'}`}>{statusText}</span>
        </div>
        <div className="header-meta">
          <span>Last refreshed {health.lastCaptureAt ? formatAge(health.lastCaptureAt, now) : 'never'}</span>
          {settings.autoRefresh && !halted && health.nextAutoRefreshAt !== null && health.nextAutoRefreshAt > now && (
            <span title="Your interval plus a random delay, different every time">
              Naukri next {shortTime(health.nextAutoRefreshAt, now)}
            </span>
          )}
          {settings.autoRefresh && !halted && health.nextIndeedRefreshAt !== null && health.nextIndeedRefreshAt > now && (
            <span title="Indeed, Instahyre and Wellfound: once a day at a random time between 9:00 and 22:00">
              Others next {shortTime(health.nextIndeedRefreshAt, now)}
            </span>
          )}
          <span className={`status status-${agentLine.tone === 'ok' ? 'ok' : agentLine.tone === 'warn' ? 'warn' : 'off'}`}
            title="Auto-apply: applies to every job on the platforms you ticked that passes your rules, one-click and company-site alike (Agent panel)">{agentLine.text}</span>
          <button type="button" className={`btn ${agent.autoApply ? 'ghost' : ''}`} onClick={toggleAgent}
            aria-pressed={agent.autoApply}>
            {agent.autoApply ? 'Stop auto-apply' : 'Start auto-apply'}
          </button>
          <button type="button" className={`btn ghost ${agent.keepAwake ? 'on' : ''}`} onClick={toggleKeepAwake} aria-pressed={!!agent.keepAwake}
            title="Keep the laptop from sleeping when idle, at any hour, so auto-apply keeps running. Closing the lid can still sleep it (Windows power settings).">
            {agent.keepAwake ? 'Keep awake: on' : 'Keep awake: off'}
          </button>
          <button type="button" className="btn primary" onClick={refresh} disabled={refreshing || halted}
            title="Refresh every site now (each site still keeps its own minimum gap)">
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {(['agent', 'profile', 'stats', 'settings', 'sources', 'data', 'log'] as const).map((p) => (
            <button key={p} type="button" className={`btn ghost ${panel === p ? 'on' : ''}`} aria-expanded={panel === p}
              onClick={() => setPanel(panel === p ? 'none' : p)}>
              {p[0]!.toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {agent.autoApply && !halted && agentState.haltedAt === null && agentState.lastCheck && (
        <div className="banner" role="status">
          <strong>Auto-apply</strong>{agentState.lastCheckAt ? ` (${shortTime(agentState.lastCheckAt, now)})` : ''}: {agentState.lastCheck}.
          {' '}<button type="button" className="link" onClick={() => setPanel('agent')}>Open Agent panel</button>
        </div>
      )}
      {agent.autoApply && !halted && agentState.haltedAt !== null && (
        <div className="banner warn" role="alert">
          <strong>Auto-apply stopped:</strong> {agentState.haltReason} ({new Date(agentState.haltedAt).toLocaleString()}).
          Refreshes keep running. {' '}<button type="button" className="link" onClick={resumeRefresh}>Resume</button>
        </div>
      )}
      {halted && (
        <div className="banner warn" role="alert">
          <strong>All refreshes stopped:</strong> {safety.haltReason} ({new Date(safety.haltedAt!).toLocaleString()}).
          Nothing will open any of the job sites until you resume. If the site asks, solve the captcha there first.
          {' '}<button type="button" className="link" onClick={resumeRefresh}>Resume</button>
        </div>
      )}
      {health.pageState === 'logged_out' && (
        <div className="banner warn" role="alert">
          Logged out of Naukri. <button type="button" className="link" onClick={() => openTab(NAUKRI_LOGIN_URL)}>Log in</button>, then refresh.
        </div>
      )}
      {health.parser === 'needs_update' && (
        <div className="banner warn" role="alert">
          A job site changed its data format and the parser needs an update. Your saved jobs are kept. See the activity log.
        </div>
      )}
      {paused && (
        <div className="banner" role="status">
          App refresh paused until {new Date(safety.pausedUntil!).toLocaleTimeString()} ({safety.pauseReason}).
          Jobs still arrive whenever you open the job sites yourself.
          {' '}<button type="button" className="link" onClick={resumeRefresh}>Resume now</button>
        </div>
      )}

      {panel === 'agent' && (
        <AgentPanel config={agent} state={agentState} jobs={jobs} statuses={statuses} hiddenTitleWords={hiddenTitleWords} now={now} />
      )}
      {panel === 'profile' && <ProfilePanel />}
      {panel === 'stats' && <StatsPanel stats={stats} />}
      {panel === 'settings' && (
        <SettingsPanel settings={settings} hiddenTitleWords={hiddenTitleWords}
          hiddenCount={countHiddenByTitle(rows, hiddenTitleWords)} />
      )}
      {panel === 'sources' && <SourcesPanel />}
      {panel === 'data' && <DataPanel rows={rows} onChanged={reloadDb} />}
      {panel === 'log' && <LogPanel />}

      <SignInList attempts={data.attempts} rows={rows} signedIn={agent.signedIn ?? {}} onOpen={openTab}
        onSignedIn={async (host) => {
          await save('agent', { ...agent, signedIn: { ...(agent.signedIn ?? {}), [host]: Date.now() } });
          await chrome.runtime.sendMessage({ type: 'reschedule' }).catch(() => undefined);
          showToast({ text: `${host}: its jobs are back in the agent's queue` });
        }} />

      <ApplyByLink onResult={(text) => showToast({ text })} />

      {tab !== 'applied' && <FilterBar ref={keywordRef} filters={filters} onChange={setFilters} />}
      {tab !== 'applied' && atsChips.length > 0 && (
        <div className="ats-chips" role="group" aria-label="Filter by ATS">
          <span className="hint">ATS:</span>
          {atsChips.map(({ ats, count }) => {
            const on = filters.ats?.includes(ats) ?? false;
            return (
              <button key={ats} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on}
                onClick={() => setFilters({ ...filters, ats: on ? (filters.ats ?? []).filter((a) => a !== ats) : [...(filters.ats ?? []), ats] })}>
                {ats} ({count})
              </button>
            );
          })}
          {!!filters.ats?.length && <button type="button" className="link" onClick={() => setFilters({ ...filters, ats: [] })}>Clear</button>}
        </div>
      )}

      <nav className="tabs" role="tablist" aria-label="Apply type">
        {TABS.filter((t) => t.id !== 'unknown' || counts.unknown.total > 0).map((t, i) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''} ${dropTarget === t.id ? 'drop-target' : ''}`} onClick={() => setTab(t.id)}
            title={`Shortcut: ${i + 1}. Drop a job here to move it to ${t.label}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE) || t.id === tab) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dropTarget !== t.id) setDropTarget(t.id);
            }}
            onDragLeave={() => setDropTarget((d) => (d === t.id ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              const jobId = e.dataTransfer.getData(DRAG_TYPE);
              if (jobId) moveRow(jobId, t.id).catch(() => undefined);
            }}>
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
              <p>Open your Naukri recommended jobs or the Indeed homepage once while logged in, or press Refresh.</p>
              <button type="button" className="btn primary" onClick={() => openTab(RECOMMENDED_JOBS_URL)}>Open Naukri</button>
              {' '}
              <button type="button" className="btn" onClick={() => openTab(INDEED_HOME_URL)}>Open Indeed</button>
            </div>
          ) : visible.length === 0 ? (
            <p className="empty">Nothing here with these filters.</p>
          ) : (
            <div className="list">
              {visible.map((row, i) => (
                <JobRow key={row.jobId} row={row} now={now} selected={i === selected}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, row.jobId);
                    e.dataTransfer.effectAllowed = 'move';
                    setSelected(i);
                  }}
                  onDragEnd={() => setDropTarget(null)}
                  onSelect={() => setSelected(i)}
                  onPrimary={() => primary(row)}
                  onOpenNaukri={() => { openTab(row.naukriUrl); markSeen(row); }}
                  onMarkApplied={() => changeStatus(row, 'applied', `Marked "${row.title}" as applied`)}
                  onDismiss={() => changeStatus(row, 'dismissed', `Dismissed "${row.title}"`)}
                  onAiApply={() => { startAiApply(applyUrlOf(row), row.jobId).then((text) => showToast({ text })).catch(() => undefined); }} />
              ))}
            </div>
          )}
      </main>

      <footer className="keys" aria-label="Keyboard shortcuts">
        j/k move · Enter apply/open · m mark applied · d dismiss · u undo · / search · 1–5 tabs · drag a job onto a tab to move it
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
