import { memo, type DragEvent } from 'react';
import { SITE_LABEL, type BoardRow } from '../shared/board';
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
  /** AI apply: fill this job's application form with your profile, in a tab you can watch. */
  onAiApply: () => void;
  /** Drag the row onto a tab to move the job there. */
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

const DAY = 86_400_000;

function JobRowImpl({ row, selected, now, onSelect, onPrimary, onOpenNaukri, onMarkApplied, onDismiss, onAiApply, onDragStart, onDragEnd }: Props) {
  const fresh = now - row.postedAt < DAY;
  const applied = row.status === 'applied';
  const cls = ['row', selected && 'selected', fresh && 'fresh', row.maybeClosed && 'closed'].filter(Boolean).join(' ');
  const primaryLabel = row.applyType === 'company_site' ? 'Open site' : row.applyType === 'easy_apply' ? 'Apply' : 'Open';

  return (
    <article id={`job-${row.jobId}`} className={cls} aria-selected={selected} onMouseDown={onSelect}
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd} title="Drag onto a tab to move this job there">
      <div className="row-main">
        <h3 className="row-title">
          <button type="button" className="link" onClick={onOpenNaukri} title={`Open on ${SITE_LABEL[row.site]}`}>{row.title}</button>
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
          <span className={`tag tag-site tag-${row.site}`}>{SITE_LABEL[row.site]}</span>
          {row.ats && <span className="tag tag-muted" title="Applicant tracking system of the career page">ATS: {row.ats}</span>}
          {row.isNew && <span className="tag tag-new">New</span>}
          {row.appliedBefore && <span className="tag tag-warn">Applied before</span>}
          {row.extraDetails && !applied && <span className="tag tag-warn" title={row.extraDetails}>Not applied: {row.extraDetails.slice(0, 80)}</span>}
          {applied && row.appliedBy === 'agent' && <span className="tag tag-agent">Applied by agent</span>}
          {row.maybeClosed && <span className="tag tag-muted">May be closed</span>}
          {row.skills.slice(0, 4).map((s) => <span key={s} className="chip">{s}</span>)}
        </div>
      </div>
      {!applied && (
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={onPrimary}>{primaryLabel}</button>
          <button type="button" className="btn" onClick={onAiApply}
            title="Fill the application with AI from your profile (Profile panel); stops at Submit unless AI apply presses Submit">Apply with AI</button>
          <button type="button" className="btn" onClick={onMarkApplied}>Mark applied</button>
          <button type="button" className="btn ghost" onClick={onDismiss} aria-label={`Dismiss ${row.title}`}>Dismiss</button>
        </div>
      )}
    </article>
  );
}

export const JobRow = memo(JobRowImpl);
