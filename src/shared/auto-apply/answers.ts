/** The answer bank: matching dialog questions to your stored answers (PRD-auto-apply section 7). */
import type { AnswerEntry } from './config';
import { submitButtonOf, type DialogField, type DialogSnapshot } from './job-page';

/** Lower case, letters and digits only, single spaces. */
export function normalizeQuestion(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function words(s: string): string[] {
  return normalizeQuestion(s).split(' ').filter(Boolean);
}

/** Does the pattern match? Every word of one of its "/"-separated alternatives appears in the question. */
export function patternMatches(pattern: string, question: string): boolean {
  const have = new Set(words(question));
  return pattern.split('/').some((alt) => {
    const need = words(alt);
    return need.length > 0 && need.every((w) => have.has(w));
  });
}

/** The stored answer for a question, preferring the most specific pattern ("expected ctc" over "ctc"). */
export function findAnswer(question: string, bank: AnswerEntry[]): AnswerEntry | null {
  const specificity = (p: string) => Math.max(...p.split('/').map((a) => words(a).length));
  const sorted = [...bank].filter((e) => e.answer.trim()).sort((a, b) => specificity(b.question) - specificity(a.question));
  return sorted.find((e) => patternMatches(e.question, question)) ?? null;
}

export interface Fill {
  /** Index into the dialog's fields. */
  index: number;
  /** For select and radio fields, the option text to pick; for checkboxes, "true" or "false". */
  value: string;
}

export type DialogPlan =
  | { ok: true; fills: Fill[]; submit: string; answers: AnswerEntry[] }
  | { ok: false; reason: string; questions: string[] };

function valueFor(field: DialogField, answer: string): string | null {
  const a = answer.trim();
  switch (field.kind) {
    case 'select':
    case 'radio': {
      const want = normalizeQuestion(a);
      const exact = field.options.find((o) => normalizeQuestion(o) === want);
      return exact ?? field.options.find((o) => normalizeQuestion(o).startsWith(want) && want.length > 0) ?? null;
    }
    case 'checkbox':
      if (/^(yes|y|true)$/i.test(a)) return 'true';
      if (/^(no|n|false)$/i.test(a)) return 'false';
      return null;
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(a) ? a : null;
    case 'text':
    case 'textarea':
      return a;
    default:
      return null;
  }
}

/**
 * How to fill a dialog, or why not. Fails closed: any required field without a usable stored answer, a file
 * upload, a dialog with nothing to fill, or no single submit button means nothing is submitted.
 */
export function planDialog(d: DialogSnapshot, bank: AnswerEntry[]): DialogPlan {
  const labels = d.fields.map((f) => f.label.trim() || '(unlabelled field)');
  const fills: Fill[] = [];
  const answers: AnswerEntry[] = [];
  const missing: string[] = [];
  d.fields.forEach((field, index) => {
    if (field.kind === 'file' || field.kind === 'other') {
      if (field.required) missing.push(labels[index]!);
      return;
    }
    const entry = findAnswer(field.label, bank);
    const value = entry ? valueFor(field, entry.answer) : null;
    if (value === null) {
      if (field.required) missing.push(labels[index]!);
      return;
    }
    fills.push({ index, value });
    answers.push({ question: labels[index]!, answer: value });
  });
  if (missing.length) return { ok: false, reason: `No stored answer for: ${missing.join('; ')}`.slice(0, 300), questions: missing };
  if (!fills.length) {
    return { ok: false, reason: `Unrecognised dialog "${d.title}" (${d.buttons.join(', ')})`.slice(0, 300), questions: labels.length ? labels : [d.title || '(dialog)'] };
  }
  const submit = submitButtonOf(d);
  if (!submit) return { ok: false, reason: `No single submit button in "${d.title}" (${d.buttons.join(', ')})`.slice(0, 300), questions: labels };
  return { ok: true, fills, submit, answers };
}

/** Have all these questions got a stored answer now? Lets a "Needs me" job back into the queue (AR-13). */
export function allAnswered(questions: string[], bank: AnswerEntry[]): boolean {
  return questions.length > 0 && questions.every((q) => findAnswer(q, bank) !== null);
}
