/**
 * What the applier does on an iimjobs job page (PRD-auto-apply AR-4 to AR-6), kept apart from the message wiring in
 * `applier.ts` so tests can run it against a fake page. Fails closed: a page it does not recognise, a question it
 * cannot answer or a missing confirmation ends the run with no further click. Before every click it re-reads the
 * kill switch, dry run and halt state from storage (AR-9).
 */
import { planDialog } from '../shared/auto-apply/answers';
import {
  agentSiteOfHost, classifyAfterClick, classifyPage, DIALOG_SELECTOR, SITE_PAGES, TOAST_SELECTOR, type DialogField, type DialogSnapshot,
  type FieldKind, type PageSnapshot,
} from '../shared/auto-apply/job-page';
import type { ApplyReport } from '../shared/auto-apply/runner';
import type { ApplyRunMessage } from '../shared/messages';

/** Dialog steps followed at most (questions, then perhaps a second page). */
const MAX_DIALOGS = 3;

export interface Timing {
  /** How long the page may take to show its Apply button. */
  pageWaitMs: number;
  /** How long to wait for "Applied" or a dialog after a click. */
  confirmWaitMs: number;
  pollMs: number;
  /** How long the page must keep showing the same state before the agent acts on it. */
  settleMs: number;
  /** How long to wait for "applied" after a pop-up appears, before treating it as a form. */
  dialogGraceMs: number;
  /** A human-ish pause before each click or batch of typing. */
  beatMs: () => number;
}

export const DEFAULT_TIMING: Timing = {
  pageWaitMs: 20_000, confirmWaitMs: 25_000, pollMs: 500, settleMs: 2_000, dialogGraceMs: 4_000, beatMs: () => 600 + Math.floor(Math.random() * 1_400),
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** This page's site (the content script runs only on iimjobs and Instahyre job pages) and its apply control. */
const siteHere = () => agentSiteOfHost(location.hostname) ?? 'iimjobs';
const applySelector = () => SITE_PAGES[siteHere()].applySelector;

function visible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function nextData(): { captchaShown: boolean; expiredRedirect: boolean } {
  try {
    const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? 'null') as {
      props?: { pageProps?: { initialState?: { botDetection?: { captchaShown?: unknown }; app?: { redirectedFromExpiredJD?: unknown } } } };
    } | null;
    const st = nd?.props?.pageProps?.initialState;
    return { captchaShown: st?.botDetection?.captchaShown === true, expiredRedirect: st?.app?.redirectedFromExpiredJD === true };
  } catch {
    return { captchaShown: false, expiredRedirect: false };
  }
}

// ---------- dialogs ----------

interface LiveField {
  field: DialogField;
  els: HTMLElement[];
}

function labelOf(el: HTMLElement, root: Element): string {
  const input = el as HTMLInputElement;
  const own = input.labels?.[0]?.textContent ?? el.getAttribute('aria-label')
    ?? (el.getAttribute('aria-labelledby') ? root.querySelector(`#${CSS.escape(el.getAttribute('aria-labelledby')!)}`)?.textContent : null);
  if (clean(own)) return clean(own);
  const group = el.closest('fieldset, [role="radiogroup"], .MuiFormControl-root');
  const legend = group?.querySelector('legend, label, .MuiFormLabel-root')?.textContent;
  return clean(legend) || clean(input.placeholder) || clean(input.name);
}

function kindOf(el: HTMLElement): FieldKind {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  if (!(el instanceof HTMLInputElement)) return 'other';
  switch (el.type) {
    case 'text': case 'email': case 'tel': case '': return 'text';
    case 'number': return 'number';
    case 'radio': return 'radio';
    case 'checkbox': return 'checkbox';
    case 'file': return 'file';
    default: return 'other';
  }
}

/** The fields of a dialog, in order, each with the elements to fill. Radios are grouped by name. */
function liveFields(root: Element): LiveField[] {
  const out: LiveField[] = [];
  const radios = new Map<string, LiveField>();
  const els = root.querySelectorAll<HTMLElement>('input, select, textarea, [role="combobox"], [role="listbox"]');
  for (const el of els) {
    if (el instanceof HTMLInputElement && ['hidden', 'submit', 'button', 'reset'].includes(el.type)) continue;
    if (!visible(el) && !(el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox' || el.type === 'file'))) continue;
    const kind = kindOf(el);
    const label = labelOf(el, root);
    const required = (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label);
    if (kind === 'radio') {
      const name = (el as HTMLInputElement).name || label;
      let group = radios.get(name);
      const option = clean((el as HTMLInputElement).labels?.[0]?.textContent) || (el as HTMLInputElement).value;
      if (!group) {
        const groupLabel = clean(el.closest('fieldset, [role="radiogroup"], .MuiFormControl-root')?.querySelector('legend, .MuiFormLabel-root')?.textContent) || name;
        group = { field: { label: groupLabel.replace(/\s*\*$/, ''), kind, required, options: [] }, els: [] };
        radios.set(name, group);
        out.push(group);
      }
      group.field.options.push(option);
      group.field.required ||= required;
      group.els.push(el);
      continue;
    }
    const options = el instanceof HTMLSelectElement ? [...el.options].filter((o) => o.value !== '').map((o) => clean(o.textContent)) : [];
    out.push({ field: { label: label.replace(/\s*\*$/, ''), kind, required, options }, els: [el] });
  }
  return out;
}

function openDialog(): Element | null {
  return [...document.querySelectorAll(DIALOG_SELECTOR)].find(visible) ?? null;
}

function dialogSnapshot(root: Element): DialogSnapshot {
  const title = clean(root.querySelector('h1, h2, h3, h4, h5, h6, .MuiDialogTitle-root, [id*="title" i]')?.textContent).slice(0, 300);
  const buttons = [...root.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]')]
    .filter(visible).map((b) => clean(b.textContent || (b as HTMLInputElement).value || b.getAttribute('aria-label'))).filter(Boolean).slice(0, 20);
  return { title, fields: liveFields(root).map((f) => f.field).slice(0, 30), buttons };
}

/** Text of any toast notifications on screen (toastr and similar). */
function toastText(): string {
  return [...document.querySelectorAll<HTMLElement>(TOAST_SELECTOR)].filter(visible).map((t) => t.innerText).join(' | ').slice(0, 500);
}

export function snapshot(): PageSnapshot {
  const nd = nextData();
  const captchaFrame = [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]')].some(visible);
  const dialog = openDialog();
  return {
    site: siteHere(),
    path: location.pathname,
    title: document.title,
    text: document.body?.innerText.slice(0, 3_000) ?? '',
    // Where success messages appear: toasts (Instahyre's "Application sent to <company>" is appended at the end of
    // the body) and an open dialog. Kept apart from the page text, whose lists of other jobs can say "Applied" too.
    noticeText: [toastText(), dialog ? (dialog as HTMLElement).innerText.slice(0, 1_000) : ''].join(' | '),
    applyButtons: [...document.querySelectorAll<HTMLButtonElement>(applySelector())].map((b) => ({ text: clean(b.textContent), disabled: b.disabled === true })),
    captchaShown: nd.captchaShown || captchaFrame,
    expiredRedirect: nd.expiredRedirect,
    dialog: dialog ? dialogSnapshot(dialog) : null,
  };
}

/** Set a value the way typing would, so React-controlled inputs see it. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fill(f: LiveField, value: string): boolean {
  const [el] = f.els;
  switch (f.field.kind) {
    case 'text': case 'number': case 'textarea':
      setValue(el as HTMLInputElement, value);
      return true;
    case 'select': {
      const sel = el as HTMLSelectElement;
      const opt = [...sel.options].find((o) => clean(o.textContent) === value);
      if (!opt) return false;
      setValue(sel, opt.value);
      return true;
    }
    case 'radio': {
      const i = f.field.options.indexOf(value);
      const radio = f.els[i] as HTMLInputElement | undefined;
      if (!radio) return false;
      if (!radio.checked) radio.click();
      return true;
    }
    case 'checkbox': {
      const box = el as HTMLInputElement;
      if (box.checked !== (value === 'true')) box.click();
      return true;
    }
    default:
      return false;
  }
}

function buttonIn(root: Element, text: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]')]
    .find((b) => visible(b) && clean(b.textContent || (b as HTMLInputElement).value) === text) ?? null;
}

/** Leave a dialog without submitting it. */
function dismissDialog(root: Element): void {
  const close = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((b) => /^(cancel|close|not now|skip|×|x)$/i.test(clean(b.textContent)) || /close/i.test(b.getAttribute('aria-label') ?? ''));
  if (close) close.click();
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

// ---------- the run ----------

/** Re-read the switches right before a click: the kill switch must stop the very next click (AR-9). */
async function mayClick(): Promise<string | null> {
  const got = await chrome.storage.local.get(['agent', 'safety', 'agentState']) as {
    agent?: { autoApply?: boolean; dryRun?: boolean }; safety?: { haltedAt?: number | null }; agentState?: { haltedAt?: number | null };
  };
  if (got.agent?.autoApply !== true) return 'auto-apply was turned off';
  if (got.agent?.dryRun !== false) return 'dry run was turned on';
  if (got.safety?.haltedAt) return 'refreshes are halted';
  if (got.agentState?.haltedAt) return 'auto-apply is halted';
  return null;
}

async function pollUntil<T>(fn: () => T | null, timeoutMs: number, pollMs: number): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null || Date.now() >= until) return v;
    await wait(pollMs);
  }
}

export const report = (result: ApplyReport['result'], over: Partial<ApplyReport> = {}): ApplyReport => ({
  result, clicked: false, reason: '', questions: [], answers: [], dialogs: [], ...over,
});

/** Called right before each click, so the service worker knows Apply was pressed even if the page then reloads. */
export interface Hooks {
  beforeClick?: () => Promise<void>;
}

export async function runApply(msg: ApplyRunMessage, t: Timing = DEFAULT_TIMING, hooks: Hooks = {}): Promise<ApplyReport> {
  const beat = () => wait(t.beatMs());
  // Wait until the page settles on something recognisable, and keeps showing it for a moment: a page that loads in
  // stages (Instahyre) can show an Apply button before it can act on a click.
  let last: ReturnType<typeof classifyPage> | null = null;
  let since = 0;
  const first = await pollUntil(() => {
    const v = classifyPage(snapshot());
    if (v === 'not_found') {
      last = null;
      return null;
    }
    if (v !== last) {
      last = v;
      since = Date.now();
    }
    return Date.now() - since >= t.settleMs ? v : null;
  }, t.pageWaitMs, t.pollMs) ?? last ?? 'not_found';
  switch (first) {
    case 'can_apply': break;
    case 'applied': return report('already_applied');
    case 'not_found': return report('not_found', { reason: `Apply button not found (${applySelector()})` });
    default: return report(first);
  }
  if (msg.dryRun) return report('can_apply');

  const stop = await mayClick();
  if (stop) return report('stopped', { reason: stop });
  const button = [...document.querySelectorAll<HTMLButtonElement>(applySelector())].find((b) => visible(b) && !b.disabled && /^apply( now)?$/i.test(clean(b.textContent)));
  if (!button) return report('not_found', { reason: 'Apply button not visible' });
  await beat();
  await hooks.beforeClick?.();
  button.click();

  const dialogs: DialogSnapshot[] = [];
  const answers: ApplyReport['answers'] = [];
  for (let step = 0; ; step += 1) {
    const after = await pollUntil(() => {
      const s = snapshot();
      const v = classifyAfterClick(s);
      return v === 'waiting' ? null : { v, s };
    }, t.confirmWaitMs, t.pollMs);
    const base = { clicked: true, dialogs, answers };
    if (!after) return report('no_confirmation', { ...base, reason: 'no "Applied" after pressing Apply' });
    if (after.v === 'applied') return report('applied', base);
    if (after.v === 'captcha') return report('captcha', base);
    if (after.v === 'closed') return report('closed', { ...base, reason: 'job closed after pressing Apply' });

    // A pop-up can appear just before the site shows the job as applied (Instahyre): give it a few seconds first.
    const settled = await pollUntil(() => (classifyAfterClick(snapshot()) === 'applied' ? true : null), t.dialogGraceMs, t.pollMs);
    if (settled) return report('applied', { ...base, reason: 'applied (a pop-up showed first)' });

    const root = openDialog();
    const shown = snapshot().dialog ?? after.s.dialog!;
    dialogs.push(shown);
    if (!root) return report('error', { ...base, reason: 'dialog vanished' });
    if (step >= MAX_DIALOGS) {
      dismissDialog(root);
      return report('needs_me', { ...base, reason: `more than ${MAX_DIALOGS} dialog steps`, questions: [shown.title || '(dialog)'] });
    }
    // One-click only (the default): iimjobs wants details, so close the form, submit nothing, leave the job for you.
    if (!msg.fillForms) {
      dismissDialog(root);
      const asked = shown.fields.map((f) => f.label).filter(Boolean);
      return report('needs_me', {
        ...base,
        reason: `iimjobs asked for details${asked.length ? ` (${asked.slice(0, 5).join(', ')})` : ''}; not applied, left for you`,
        questions: asked.length ? asked : [shown.title || '(form)'],
      });
    }
    const plan = planDialog(shown, msg.answers);
    if (!plan.ok) {
      dismissDialog(root);
      return report('needs_me', { ...base, reason: plan.reason, questions: plan.questions });
    }
    const live = liveFields(root);
    await beat();
    for (const f of plan.fills) {
      const target = live[f.index];
      if (!target || !fill(target, f.value)) {
        dismissDialog(root);
        return report('needs_me', { ...base, reason: `could not fill "${shown.fields[f.index]?.label ?? '?'}"`, questions: [shown.fields[f.index]?.label ?? '?'] });
      }
    }
    answers.push(...plan.answers);
    const submit = buttonIn(root, plan.submit);
    if (!submit) {
      dismissDialog(root);
      return report('needs_me', { ...base, reason: `submit button "${plan.submit}" not found`, questions: plan.answers.map((a) => a.question) });
    }
    const stopAgain = await mayClick();
    if (stopAgain) {
      dismissDialog(root);
      return report('stopped', { ...base, reason: stopAgain });
    }
    await beat();
    await hooks.beforeClick?.();
    submit.click();
  }
}
