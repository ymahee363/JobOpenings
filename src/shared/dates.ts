const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Earliest createdDate we accept as real (2015-01-01); older or future values fall back to the label. */
const MIN_PLAUSIBLE = Date.UTC(2015, 0, 1);

export interface Posted {
  postedAt: number;
  approx: boolean;
}

/**
 * Prefer Naukri's absolute createdDate (epoch ms). Fall back to the relative label
 * ("Few Hours Ago", "3 Days Ago", "30+ Days Ago") when it is missing or implausible.
 */
export function resolvePostedAt(createdDate: unknown, label: string, now: number): Posted {
  if (typeof createdDate === 'number' && Number.isFinite(createdDate)
    && createdDate >= MIN_PLAUSIBLE && createdDate <= now + DAY) {
    return { postedAt: Math.min(createdDate, now), approx: false };
  }
  return parseRelativeLabel(label, now);
}

export function parseRelativeLabel(label: string, now: number): Posted {
  const s = label.trim().toLowerCase();
  if (!s) return { postedAt: now, approx: true };
  if (/just now|few (hours|minutes)|today/.test(s)) return { postedAt: now, approx: false };
  if (/yesterday/.test(s)) return { postedAt: now - DAY, approx: false };

  const m = /(\d+)\s*(\+)?\s*(minute|min|hour|hr|day|week|month)s?/.exec(s);
  if (!m) return { postedAt: now, approx: true };
  const n = Number(m[1]);
  const plus = Boolean(m[2]);
  const unit = m[3] ?? 'day';
  const ms = unit.startsWith('min') ? 60_000
    : unit.startsWith('h') ? HOUR
      : unit === 'week' ? 7 * DAY
        : unit === 'month' ? 30 * DAY
          : DAY;
  return { postedAt: now - n * ms, approx: plus || unit === 'month' };
}

export function formatAge(postedAt: number, now: number): string {
  const diff = Math.max(0, now - postedAt);
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  return `${Math.round(diff / DAY)}d ago`;
}
