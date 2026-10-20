import { memo } from 'react';
import type { BoardRow } from '../shared/board';
import { formatAge } from '../shared/dates';

interface Props {
  row: BoardRow;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onPrimary: () => void;
  onOpenNaukri: () => void;
  onMarkApplied: () => void;
  onDismiss: () => void;
}

const DAY = 86_400_000;

function JobRowImpl({ row, selected, now, onSelect, onPrimary, onOpenNaukri, onMarkApplied, onDismiss }: Props) {
  const fresh = now - row.postedAt < DAY;
  const applied = row.status === 'applied';
  const cls = ['row', selected && 'selected', fresh && 'fresh', row.maybeClosed && 'closed'].filter(Boolean).join(' ');
  const primaryLabel = row.applyType === 'company_site' ? 'Open site' : row.applyType === 'easy_apply' ? 'Apply' : 'Open';

  return (
    <article id={`job-${row.jobId}`} className={cls} aria-selected={selected} onMouseDown={onSelect}>
      <div className="row-main">
        <h3 className="row-title">
          <button type="button" className="link" onClick={onOpenNaukri} title="Open on Naukri">{row.title}</button>
        </h3>
        <div className="row-company">{row.company}</div>
        <div className="row-meta">
          {row.location && <span>{row.location}</span>}
          {row.experience && <span>{row.experience}</span>}
          <span>{row.salary}</span>
          <span title={new Date(row.postedAt).toLocaleString()}>
            {row.postedApprox ? `${row.postedLabel || formatAge(row.postedAt, now)} (approx.)` : formatAge(row.postedAt, now)}
          </span>
          {applied && row.statusAt && <span>Applied {new Date(row.statusAt).toLocaleDateString()}</span>}
        </div>
        <div className="row-tags">
          {row.isNew && <span className="tag tag-new">New</span>}
          {row.appliedBefore && <span className="tag tag-warn">Applied before</span>}
          {row.maybeClosed && <span className="tag tag-muted">May be closed</span>}
          {row.skills.slice(0, 6).map((s) => <span key={s} className="chip">{s}</span>)}
        </div>
      </div>
      {!applied && (
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={onPrimary}>{primaryLabel}</button>
          {row.applyType !== 'easy_apply' && (
            <button type="button" className="btn" onClick={onMarkApplied}>Mark applied</button>
          )}
          <button type="button" className="btn ghost" onClick={onDismiss} aria-label={`Dismiss ${row.title}`}>Dismiss</button>
        </div>
      )}
    </article>
  );
}

export const JobRow = memo(JobRowImpl);
