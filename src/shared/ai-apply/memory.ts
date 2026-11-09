/**
 * Form memory: answers to application questions, remembered across every site by the question's normalized text, so
 * the same "Are you legally authorized to work in India?" is never sent to the LLM (or to you) twice. Ported from
 * job-apply-ai-mvp (extension/src/storage/formMemory.ts) as pure functions; the store keeps the map under
 * `formMemory`.
 */

export interface RememberedAnswer {
  /** The question as first seen, for display. */
  label: string;
  answer: string;
  category: string;
  updatedAt: number;
  /**
   * "you": an answer you gave yourself (typed or picked on a form, or told to the agent). It wins over the agent's
   * own answers from your profile, and the AI is told it as a fact for differently worded questions.
   */
  by?: 'you';
}

/** Keyed by `normalizeLabel(question)`. */
export type MemoryMap = Record<string, RememberedAnswer>;

export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const CATEGORY_RULES: Array<{ test: RegExp; category: string }> = [
  { test: /authoriz|sponsor|visa|work permit|citizenship|legally (able|eligible)/i, category: 'Work authorization' },
  { test: /salary|compensation|\bctc\b|\bpay\b|\blpa\b|expected pay|remuneration/i, category: 'Compensation' },
  { test: /notice period|start date|available|earliest|joining date|when can you|how soon/i, category: 'Notice period & availability' },
  { test: /relocat|remote|hybrid|onsite|travel|shift|work from/i, category: 'Work preferences' },
  { test: /email|phone|mobile|address|linkedin|portfolio|website|github/i, category: 'Contact info' },
  { test: /experience|years|skill|education|degree|university|college|certif/i, category: 'Experience & background' },
  { test: /disability|veteran|gender|ethnicity|race|sexual orientation|background check|criminal/i, category: 'Legal & self-identification' },
  { test: /hear about|referr|how did you find/i, category: 'How you heard about the role' },
];

export function classifyCategory(label: string): string {
  return CATEGORY_RULES.find((r) => r.test.test(label))?.category ?? 'Other';
}

export function lookupRememberedAnswer(memory: MemoryMap, label: string): string | undefined {
  const key = normalizeLabel(label);
  return key ? memory[key]?.answer : undefined;
}

/**
 * The map with these answers added (or replaced). Blank answers and NEEDS_USER_INPUT are never stored. The agent's
 * own answers (`by` unset) never replace one you gave yourself.
 */
export function rememberAnswers(memory: MemoryMap, entries: Array<{ label: string; answer: string }>, now: number, by?: 'you'): MemoryMap {
  const next = { ...memory };
  for (const e of entries) {
    const key = normalizeLabel(e.label);
    if (!key || !e.answer.trim() || e.answer === 'NEEDS_USER_INPUT') continue;
    if (!by && next[key]?.by === 'you') continue;
    next[key] = { label: e.label.trim(), answer: e.answer, category: classifyCategory(e.label), updatedAt: now, ...(by ? { by } : {}) };
  }
  return next;
}

/** Your own answer to this question, if you gave one. */
export function yourAnswer(memory: MemoryMap, label: string): string | undefined {
  const e = memory[normalizeLabel(label)];
  return e?.by === 'you' ? e.answer : undefined;
}

/** Your own answers, newest first, as facts for the AI ("Will you require visa sponsorship? → No"). */
export function yourFacts(memory: MemoryMap, limit = 40): string[] {
  return Object.values(memory).filter((e) => e.by === 'you').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
    .map((e) => `${e.label.replace(/\s+/g, ' ').slice(0, 160)} → ${e.answer.replace(/\s+/g, ' ').slice(0, 200)}`);
}

export function forgetAnswer(memory: MemoryMap, key: string): MemoryMap {
  const next = { ...memory };
  delete next[key];
  return next;
}

/** Entries by category, most recent first, for the Profile panel. */
export function groupMemory(memory: MemoryMap): Array<{ category: string; entries: Array<RememberedAnswer & { key: string }> }> {
  const groups = new Map<string, Array<RememberedAnswer & { key: string }>>();
  for (const [key, e] of Object.entries(memory)) {
    const category = e.category || classifyCategory(e.label || key);
    groups.set(category, [...(groups.get(category) ?? []), { ...e, key, label: e.label || key, category }]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, entries]) => ({ category, entries: entries.sort((a, b) => b.updatedAt - a.updatedAt) }));
}
