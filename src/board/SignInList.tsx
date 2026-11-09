import { useMemo } from 'react';
import type { BoardRow } from '../shared/board';
import type { Attempt } from '../shared/auto-apply/config';
import { signInHostOf } from '../shared/auto-apply/match';
import { applyUrlOf } from '../shared/auto-apply/runner';

interface Props {
  attempts: Attempt[];
  rows: BoardRow[];
  signedIn: Record<string, number>;
  /** Opens a page in a new tab. */
  onOpen: (url: string) => void;
  /** You signed in on this site: its jobs go back in the agent's queue. */
  onSignedIn: (host: string) => void;
}

interface Site {
  host: string;
  jobs: Array<{ jobId: string; title: string; company: string; url: string }>;
}

/**
 * "Sign in once": company sites (Workday, Darwinbox, iCIMS…) where the agent stopped at a sign-in page, grouped by
 * site. Sign in there once in this Chrome, press "I've signed in", and the agent retries those jobs on its own.
 */
export function SignInList({ attempts, rows, signedIn, onOpen, onSignedIn }: Props) {
  const sites = useMemo(() => {
    const latest = new Map<string, Attempt>();
    for (const a of attempts) {
      const prev = latest.get(a.jobId);
      if (!prev || a.startedAt > prev.startedAt) latest.set(a.jobId, a);
    }
    const byId = new Map(rows.map((r) => [r.jobId, r]));
    const out = new Map<string, Site>();
    for (const a of latest.values()) {
      if (a.outcome !== 'needs_me') continue;
      const row = byId.get(a.jobId);
      if (row && (row.status === 'applied' || row.status === 'dismissed')) continue;
      let host = signInHostOf(a.reason);
      if (host === null) continue;
      const url = row ? applyUrlOf(row) : '';
      if (!host && url) {
        try { host = new URL(url).hostname; } catch { /* keep '' */ }
      }
      if (!host || (signedIn[host] ?? 0) > a.startedAt) continue;
      const site = out.get(host) ?? { host, jobs: [] };
      site.jobs.push({ jobId: a.jobId, title: a.title, company: a.company, url: url || `https://${host}` });
      out.set(host, site);
    }
    return [...out.values()].sort((a, b) => b.jobs.length - a.jobs.length);
  }, [attempts, rows, signedIn]);

  if (!sites.length) return null;
  const jobs = sites.reduce((n, s) => n + s.jobs.length, 0);
  return (
    <details className="panel signin">
      <summary>
        <strong>Sign in once:</strong> {sites.length} site{sites.length === 1 ? '' : 's'} wait for a sign-in ({jobs} job{jobs === 1 ? '' : 's'})
      </summary>
      <p className="hint">
        These company sites need an account. Open each, sign in or create the account once (Chrome can save the
        password), then press "I've signed in": the agent applies to those jobs on its own and later jobs there too.
      </p>
      <ul className="signin-list">
        {sites.map((s) => (
          <li key={s.host}>
            <div className="signin-site">
              <strong>{s.host}</strong>
              <span className="hint">{s.jobs.map((j) => `${j.title} (${j.company})`).join(' · ')}</span>
            </div>
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => onOpen(s.jobs[0]!.url)}>Open</button>
              <button type="button" className="btn primary" onClick={() => onSignedIn(s.host)}>I've signed in</button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
