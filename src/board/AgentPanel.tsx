import { useEffect, useMemo, useState } from 'react';
import { getDb } from '../db/db';
import { listAttempts } from '../db/repo';
import { attemptsCsv, SITE_LABEL, SITES } from '../shared/board';
import {
  AUTO_SITES, clampDailyCap, clampGapSeconds, clampHours, MAX_DAILY_CAP, MAX_GAP_SECONDS, MIN_ANY_GAP_SECONDS, MIN_GAP_SECONDS, type AgentConfig, type AgentState, type AnswerEntry, type Attempt } from '../shared/auto-apply/config';
import { buildQueue, explainEmptyQueue } from '../shared/auto-apply/match';
import { AGENT_SITES, siteOfJobId } from '../shared/auto-apply/job-page';
import { hoursLabel, startOfDay, summarize } from '../shared/auto-apply/pacing';
import { DB_CHANGED } from '../shared/messages';
import { save } from '../shared/store';
import type { Job, JobStatus } from '../shared/types';

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const list = (csv: string) => csv.split(',').map((s) => s.trim()).filter(Boolean);
const numOrNull = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

const OUTCOME_LABEL: Record<Attempt['outcome'], string> = {
  pending: 'In progress', applied: 'Applied', would_apply: 'Would apply', already_applied: 'Already applied',
  skipped: 'Skipped', needs_me: 'Asked for details, not applied', filled: 'Filled by AI, waiting for your Submit', failed: 'Failed', halted: 'Stopped',
};

interface Props {
  config: AgentConfig;
  state: AgentState;
  jobs: Job[];
  statuses: JobStatus[];
  hiddenTitleWords: string[];
  now: number;
}

/** The auto-apply agent: switches, rules, answer bank, queue, "Needs you" and the audit log (PRD-auto-apply 9). */
export function AgentPanel({ config, state, jobs, statuses, hiddenTitleWords, now }: Props) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  useEffect(() => {
    const reload = () => { listAttempts(getDb()).then(setAttempts).catch(() => undefined); };
    reload();
    const onMessage = (msg: unknown) => {
      if ((msg as { type?: unknown } | null)?.type === DB_CHANGED) reload();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const apply = async (next: AgentConfig) => {
    await save('agent', { ...next, dailyCap: clampDailyCap(next.dailyCap) });
    await chrome.runtime.sendMessage({ type: 'reschedule' }).catch(() => undefined);
  };
  const setRules = (patch: Partial<AgentConfig['rules']>) => apply({ ...config, rules: { ...config.rules, ...patch } });
  const setAnswers = (answers: AnswerEntry[]) => apply({ ...config, answers });

  const queue = useMemo(() => buildQueue(jobs, statuses, attempts, config, hiddenTitleWords, now), [jobs, statuses, attempts, config, hiddenTitleWords, now]);
  const today = summarize(attempts, startOfDay(now));
  const triedDryRun = attempts.some((a) => a.outcome === 'would_apply');
  const platformsQueued = new Set(queue.map((q) => q.job.site)).size;

  // Rule fields are edited as text and saved on blur.
  const [draft, setDraft] = useState(() => toDraft(config));
  useEffect(() => setDraft(toDraft(config)), [config]);
  const [newQ, setNewQ] = useState('');
  const [newA, setNewA] = useState('');
  const [running, setRunning] = useState(false);
  const [hasAllSites, setHasAllSites] = useState<boolean | null>(null);
  useEffect(() => {
    chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] }).then(setHasAllSites).catch(() => setHasAllSites(false));
  }, []);

  return (
    <section className="panel agent" aria-labelledby="agent-h">
      <h2 id="agent-h">Auto-apply (one-click on iimjobs, Instahyre, Naukri, Wellfound; AI apply anywhere)</h2>
      <p className="hint">
        Applies to jobs on the sites ticked below that apply on the site itself (Easy Apply) and pass every rule below,
        in your own Chrome, one at a time, platforms taking turns, {hoursLabel(config)}, at most {config.dailyCap} pages a day on each platform
        across all sites. A captcha, a logout or a page it does not recognise stops it. By default it applies only where
        one click is enough: if the site asks for any details, it submits nothing and leaves the job for you under "Asked
        for details".
      </p>

      <div className="agent-switches">
        <label className="check">
          <input type="checkbox" checked={config.autoApply} onChange={(e) => apply({ ...config, autoApply: e.target.checked })} />
          Auto-apply on
        </label>
        <fieldset className="agent-sites">
          <legend>Apply on</legend>
          <label className="check">
            <input type="checkbox" checked={AUTO_SITES.every((s) => config.sites.includes(s))}
              ref={(el) => { if (el) el.indeterminate = config.sites.length > 0 && config.sites.length < AUTO_SITES.length; }}
              onChange={(e) => apply({ ...config, sites: e.target.checked ? [...AUTO_SITES] : [] })} />
            <strong>All platforms</strong>
          </label>
          {AUTO_SITES.map((s) => {
            const aiOnly = !(AGENT_SITES as string[]).includes(s);
            return (
              <label key={s} className="check" title={aiOnly ? 'No one-click applier here: its jobs go through AI apply, so they need AI apply on' : ''}>
                <input type="checkbox" checked={config.sites.includes(s)}
                  onChange={(e) => apply({ ...config, sites: AUTO_SITES.filter((x) => (x === s ? e.target.checked : config.sites.includes(x))) })} />
                {SITE_LABEL[s]}{aiOnly && <span className="hint"> (AI apply)</span>}
              </label>
            );
          })}
          {SITES.filter((s) => !AUTO_SITES.includes(s)).map((s) => (
            <label key={s} className="check muted" title="LinkedIn is never automated, by your choice; use Apply with AI on a LinkedIn job yourself">
              <input type="checkbox" checked={false} disabled />
              {SITE_LABEL[s]} <span className="hint">(never on its own)</span>
            </label>
          ))}
        </fieldset>
        {config.autoApply && config.sites.length === 0 && <p className="hint warn-text">No platform is ticked, so nothing will be applied to.</p>}
        <div className="agent-hours">
          <label>
            Start at
            <select value={config.activeStartHour} onChange={(e) => apply({ ...config, ...clampHours(Number(e.target.value), config.activeEndHour) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h} disabled={h === config.activeEndHour}>{h}:00</option>)}
            </select>
          </label>
          <label>
            Stop at
            <select value={config.activeEndHour} onChange={(e) => apply({ ...config, ...clampHours(config.activeStartHour, Number(e.target.value)) })}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h} disabled={h === config.activeStartHour}>
                  {h === 24 ? 'Midnight' : `${h}:00`}{h < config.activeStartHour ? ' (next day)' : ''}
                </option>
              ))}
            </select>
          </label>
          <span className="hint">Working hours for auto-apply (refreshes keep their own 9:00 to 22:00).</span>
        </div>
        <label className="check" title={triedDryRun ? '' : 'Let a dry run check at least one job first'}>
          <input type="checkbox" checked={!config.dryRun} disabled={config.dryRun && !triedDryRun}
            onChange={(e) => apply({ ...config, dryRun: !e.target.checked })} />
          Live applying (off = dry run: checks pages and logs "Would apply", clicks nothing)
        </label>
        {config.dryRun && !triedDryRun && <p className="hint">Live applying unlocks after the dry run has checked at least one job.</p>}
        <label>
          Seconds between two applications on the same platform ({MIN_GAP_SECONDS} to {MAX_GAP_SECONDS})
          <input type="number" min={MIN_GAP_SECONDS} max={MAX_GAP_SECONDS} value={draft.gapSeconds}
            onChange={(e) => setDraft({ ...draft, gapSeconds: e.target.value })}
            onBlur={() => apply({ ...config, gapSeconds: clampGapSeconds(Number(draft.gapSeconds)) })} />
        </label>
        <p className="hint">
          The queue takes one job from each platform in turn, so different platforms follow each other faster: with{' '}
          {Math.max(1, platformsQueued)} platform{platformsQueued === 1 ? '' : 's'} queued, about every{' '}
          {Math.max(MIN_ANY_GAP_SECONDS, Math.round(config.gapSeconds / Math.max(1, platformsQueued)))} s, while each
          platform still waits {config.gapSeconds} s between its own applications (plus up to 15% random).
          {config.gapSeconds < 60 && ' Under a minute per platform is fast; sites may notice.'}
        </p>
        <label>
          Pages a day per platform (1 to {MAX_DAILY_CAP}, dry run included)
          <input type="number" min={1} max={MAX_DAILY_CAP} value={draft.dailyCap}
            onChange={(e) => setDraft({ ...draft, dailyCap: e.target.value })}
            onBlur={() => apply({ ...config, dailyCap: Number(draft.dailyCap) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={config.fillForms} onChange={(e) => apply({ ...config, fillForms: e.target.checked })} />
          Also fill in forms from the answer bank (off: one-click applies only; jobs that ask for details are left for you)
        </label>
        <label className="check">
          <input type="checkbox" checked={config.dailySummary} onChange={(e) => apply({ ...config, dailySummary: e.target.checked })} />
          Desktop summary at 21:00
        </label>
      </div>

      <h3>AI apply (any site, company career pages included)</h3>
      <p className="hint">
        Fills application forms anywhere (Greenhouse, Lever, Workday, company sites, job-board pop-ups) from your Profile,
        the answer bank, remembered answers and the AI backend, page by page. It takes the jobs that apply on a company
        site, the sites without a one-click applier, and one-click jobs whose site asks for details. A login wall,
        captcha, or required question it cannot answer truthfully leaves the job for you.
      </p>
      <div className="agent-switches">
        <div className="btn-row">
          <button type="button" className="btn" disabled={hasAllSites === true}
            onClick={async () => setHasAllSites(await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false))}>
            {hasAllSites ? 'AI apply can reach all sites' : 'Allow AI apply on all sites'}
          </button>
          {hasAllSites === false && <span className="hint warn-text">Needed before AI apply can read any form.</span>}
        </div>
        <label className="check">
          <input type="checkbox" checked={config.aiApply} onChange={(e) => apply({ ...config, aiApply: e.target.checked })} />
          Use AI apply in auto-apply (dry run still only checks and clicks nothing)
        </label>
        <label className="check">
          <input type="checkbox" checked={config.aiSubmit} onChange={(e) => apply({ ...config, aiSubmit: e.target.checked })} />
          AI apply presses the final Submit (off: it fills every page and leaves the tab open for you to check and submit)
        </label>
      </div>
      <p className="hint">Apply with AI on any link: use the "Apply by link" box at the top of the board.</p>

      <div className="btn-row">
        <button type="button" className="btn" disabled={!config.autoApply || running}
          title={config.autoApply ? 'Try the next job now; hours, limits and stops still apply' : 'Turn auto-apply on first'}
          onClick={async () => {
            setRunning(true);
            await chrome.runtime.sendMessage({ type: 'agent-run-now' }).catch(() => undefined);
            setTimeout(() => setRunning(false), 5_000);
          }}>
          {running ? 'Running…' : config.dryRun ? 'Run now (dry run)' : 'Run now'}
        </button>
        {state.nextRunAt !== null && config.autoApply && <span className="hint">Next run {new Date(state.nextRunAt).toLocaleTimeString()}</span>}
      </div>
      {state.lastCheck && (
        <p className="agent-today" role="status">
          Last check{state.lastCheckAt ? ` ${new Date(state.lastCheckAt).toLocaleTimeString()}` : ''}: {state.lastCheck}
        </p>
      )}
      {queue.length === 0 && <p className="hint warn-text">{explainEmptyQueue(jobs, statuses, attempts, config, hiddenTitleWords, now)}</p>}

      <p className="agent-today" role="status">
        Today: {today.applied} applied · {today.wouldApply} would apply · {today.needsMe} asked for details · {today.failed} failed · {today.skipped} skipped
        {state.haltedAt !== null && <> · <strong>Stopped: {state.haltReason}</strong> (press Resume in the banner)</>}
      </p>

      <h3>Rules (a job must pass all of them)</h3>
      <div className="agent-rules">
        <label>Title contains one of (comma separated)
          <input value={draft.titleIncludes} onChange={(e) => setDraft({ ...draft, titleIncludes: e.target.value })}
            onBlur={() => setRules({ titleIncludes: list(draft.titleIncludes) })} />
        </label>
        <label>Title has none of these words (the hidden title words in Settings also count)
          <input value={draft.titleExcludes} onChange={(e) => setDraft({ ...draft, titleExcludes: e.target.value })}
            onBlur={() => setRules({ titleExcludes: list(draft.titleExcludes) })} />
        </label>
        <label>My years of experience (required; applies to jobs needing up to this many)
          <input type="number" min={0} max={50} value={draft.myYears} aria-invalid={config.rules.myYears === null}
            onChange={(e) => setDraft({ ...draft, myYears: e.target.value })}
            onBlur={() => setRules({ myYears: numOrNull(draft.myYears) })} />
        </label>
        <label>Locations (comma separated; empty allows any)
          <input value={draft.locations} onChange={(e) => setDraft({ ...draft, locations: e.target.value })}
            onBlur={() => setRules({ locations: list(draft.locations) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={config.rules.allowRemote} onChange={(e) => setRules({ allowRemote: e.target.checked })} />
          Remote / work from home also passes
        </label>
        <label>Salary floor, LPA (undisclosed passes)
          <input type="number" min={0} value={draft.salaryFloorLpa} onChange={(e) => setDraft({ ...draft, salaryFloorLpa: e.target.value })}
            onBlur={() => setRules({ salaryFloorLpa: numOrNull(draft.salaryFloorLpa) })} />
        </label>
        <label>Never apply to (company names, comma separated)
          <input value={draft.companyBlocklist} onChange={(e) => setDraft({ ...draft, companyBlocklist: e.target.value })}
            onBlur={() => setRules({ companyBlocklist: list(draft.companyBlocklist) })} />
        </label>
        <label>Posted within (days)
          <input type="number" min={1} max={30} value={draft.maxPostedDays} onChange={(e) => setDraft({ ...draft, maxPostedDays: e.target.value })}
            onBlur={() => setRules({ maxPostedDays: Math.min(30, Math.max(1, numOrNull(draft.maxPostedDays) ?? 7)) })} />
        </label>
      </div>
      {config.rules.myYears === null && <p className="hint warn-text">Set your years of experience: until then no job matches.</p>}

      <h3>Answer bank {config.fillForms || config.aiApply ? '' : '(used only when form filling or AI apply is on)'}</h3>
      <p className="hint">
        Words that must all appear in a question, and your answer. "expected ctc / expected salary" means either. For
        choice questions the answer must match an option's text.
      </p>
      {config.answers.length === 0 ? <p className="hint">No answers yet.</p> : (
        <ul className="agent-answers">
          {config.answers.map((a, i) => (
            <li key={`${a.question}-${i}`}>
              <span><strong>{a.question}</strong>: {a.answer}</span>
              <button type="button" className="chip-x" aria-label={`Remove the answer for "${a.question}"`}
                onClick={() => setAnswers(config.answers.filter((_, j) => j !== i))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <form className="word-add" onSubmit={(e) => {
        e.preventDefault();
        if (!newQ.trim() || !newA.trim()) return;
        setAnswers([...config.answers, { question: newQ.trim(), answer: newA.trim() }]);
        setNewQ('');
        setNewA('');
      }}>
        <input placeholder="e.g. notice period" aria-label="Question words" value={newQ} onChange={(e) => setNewQ(e.target.value)} />
        <input placeholder="e.g. 30 days" aria-label="Answer" value={newA} onChange={(e) => setNewA(e.target.value)} />
        <button type="submit" className="btn">Add answer</button>
      </form>

      <h3>Queue ({queue.length})</h3>
      <p className="hint">
        By platform: {config.sites.map((site) => `${SITE_LABEL[site]} ${queue.filter((q) => q.job.site === site).length} queued, `
          + `${attempts.filter((a) => a.startedAt >= startOfDay(now) && siteOfJobId(a.jobId) === site).length} of ${config.dailyCap} pages today`).join(' · ') || 'no platform ticked'}.
        {' '}Daily limit: {config.dailyCap} pages per platform; a platform that reaches it sits out until tomorrow.
      </p>
      {queue.length === 0 ? <p className="hint">No matching jobs right now.</p> : (
        <ol className="agent-list">
          {queue.slice(0, 30).map(({ job, reasons }) => (
            <li key={job.jobId}><span className={`tag tag-site tag-${job.site}`}>{SITE_LABEL[job.site]}</span> <strong>{job.title}</strong> at {job.company} <span className="hint">{reasons.join(' · ')}</span></li>
          ))}
        </ol>
      )}

      <h3>Log</h3>
      <div className="btn-row">
        <button type="button" className="btn" disabled={!attempts.length}
          onClick={() => download(`auto-apply-log-${new Date().toISOString().slice(0, 10)}.csv`, attemptsCsv(attempts))}>
          Export log (CSV)
        </button>
      </div>
      {attempts.length === 0 ? <p className="hint">No attempts yet.</p> : (
        <ol className="log">
          {attempts.slice(0, 50).map((a) => (
            <li key={a.id} className={a.outcome === 'failed' || a.outcome === 'halted' ? 'log-warn' : 'log-info'}>
              <time>{new Date(a.startedAt).toLocaleString()}</time> {OUTCOME_LABEL[a.outcome]}{a.mode === 'dry_run' ? ' (dry run)' : ''}:
              {' '}{a.title} at {a.company}{a.reason ? ` (${a.reason})` : ''}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function toDraft(c: AgentConfig) {
  return {
    dailyCap: String(c.dailyCap),
    gapSeconds: String(c.gapSeconds),
    titleIncludes: c.rules.titleIncludes.join(', '),
    titleExcludes: c.rules.titleExcludes.join(', '),
    myYears: c.rules.myYears === null ? '' : String(c.rules.myYears),
    locations: c.rules.locations.join(', '),
    salaryFloorLpa: c.rules.salaryFloorLpa === null ? '' : String(c.rules.salaryFloorLpa),
    companyBlocklist: c.rules.companyBlocklist.join(', '),
    maxPostedDays: String(c.rules.maxPostedDays),
  };
}
