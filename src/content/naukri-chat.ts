/**
 * Naukri's apply questions come in a chatbot drawer, not a form (seen live 2026-11-04 on a job-listings page):
 * `.chatbot_Drawer` > `.chatbot_MessageContainer` lists the bot's messages (`.botMsg`), the last one being the
 * current question; the answer goes in a contenteditable `div.textArea` (or radio buttons / checkboxes / chips for
 * choice questions) and is sent with the `div.sendMsg` "Save". One question per step: the form engine treats each
 * as a one-field page and "Save" as its Next button, so the AI apply flow answers them one by one.
 */
import type { FormData, FormField } from '../shared/ai-apply/types';
import { naukriApplyResult } from '../shared/auto-apply/job-page';

const FIELD_ID = 'naukri-chat-answer';
const GREETING = /thank you for showing interest|kindly answer all the recruiter/i;

function shown(el: Element | null): el is HTMLElement {
  return !!el && el instanceof HTMLElement && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

const visibleEl = (el: Element | null): boolean => shown(el);

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The open chatbot drawer on naukri.com, or null. */
export function naukriChatRoot(): HTMLElement | null {
  if (!/(^|\.)naukri\.com$/.test(location.hostname)) return null;
  return [...document.querySelectorAll<HTMLElement>('.chatbot_Drawer')].find(shown) ?? null;
}

function question(root: HTMLElement): string {
  const msgs = [...root.querySelectorAll<HTMLElement>('.botMsg')];
  const last = clean(msgs[msgs.length - 1]?.innerText);
  // The greeting ("thank you for showing interest. Kindly answer all the recruiter's questions") is not a question:
  // wait for the first real one.
  return GREETING.test(last) ? '' : last;
}

function textBox(root: HTMLElement): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('[contenteditable="true"]')].find(shown) ?? null;
}

interface Choice { text: string; el: HTMLElement }

/** Choice controls of the current question: radio buttons, checkboxes, or clickable chips. */
function choices(root: HTMLElement): { kind: 'radio' | 'checkbox'; items: Choice[] } | null {
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')]
    .filter((i) => visibleEl(i) || shown(i.closest('label')) || shown(i.parentElement));
  if (inputs.length) {
    const items = inputs.map((i) => {
      const label: HTMLElement | null = (i.id ? root.querySelector<HTMLElement>(`label[for="${CSS.escape(i.id)}"]`) : null)
        ?? i.closest('label') ?? i.parentElement;
      return { text: clean(label?.innerText) || i.value, el: label ?? i };
    }).filter((c) => c.text);
    return { kind: inputs[0]!.type === 'checkbox' ? 'checkbox' : 'radio', items };
  }
  const chips = [...root.querySelectorAll<HTMLElement>('[class*="chatbot_Chip"], .chipItem, .chip')]
    .filter((c) => shown(c) && !c.closest('.botLogo') && !c.querySelector('img') && clean(c.innerText));
  return chips.length ? { kind: 'radio', items: chips.map((el) => ({ text: clean(el.innerText), el })) } : null;
}

/** The current question as a one-field form, or null when no chatbot is open (or it is waiting on the bot). */
export function naukriChatForm(): FormData | null {
  const root = naukriChatRoot();
  if (!root) return null;
  const label = question(root);
  const choice = choices(root);
  const box = textBox(root);
  if (!label || (!choice && !box)) return { url: location.href, title: document.title, page_text: label, fields: [] };
  const field: FormField = choice
    ? { id: FIELD_ID, label, type: choice.kind, required: true, options: choice.items.map((c) => c.text), current_value: '', group_label: label }
    : { id: FIELD_ID, label, type: 'textarea', required: true, options: [], current_value: clean(box!.innerText) };
  return { url: location.href, title: document.title, page_text: clean(root.innerText).slice(0, 1500), fields: [field] };
}

/** Fill the chatbot's answer. Null when `id` is not the chatbot's field. */
export function naukriChatFill(id: string, value: string): boolean | null {
  if (id !== FIELD_ID) return null;
  const root = naukriChatRoot();
  if (!root || !value || value === 'NEEDS_USER_INPUT') return false;
  const choice = choices(root);
  if (choice) {
    const wanted = choice.kind === 'checkbox' ? value.split(/\s*[,;]\s*/) : [value];
    let hit = false;
    for (const w of wanted) {
      const c = choice.items.find((i) => i.text.toLowerCase() === w.toLowerCase())
        ?? choice.items.find((i) => i.text.toLowerCase().startsWith(w.toLowerCase()) || w.toLowerCase().startsWith(i.text.toLowerCase()));
      if (c) { c.el.click(); hit = true; }
    }
    return hit;
  }
  const box = textBox(root);
  if (!box) return false;
  box.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(box);
  sel?.removeAllRanges();
  sel?.addRange(range);
  // Typing the way a keyboard would, so the chatbot enables "Save"; plain textContent as a fallback.
  if (!document.execCommand('insertText', false, value) || clean(box.innerText) !== clean(value)) box.textContent = value;
  box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  return true;
}

/** The chatbot's "Save" (send) button, which moves to the next question. */
export function naukriChatSave(): HTMLElement | null {
  const root = naukriChatRoot();
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>('.sendMsg, [id^="sendMsg_"] .sendMsg')].find(shown) ?? null;
}

/** Naukri marks a job applied with `#already-applied` ("Applied") or a success line after the chatbot closes. */
export function naukriApplied(): boolean {
  if (!/(^|\.)naukri\.com$/.test(location.hostname)) return false;
  // After the last chatbot answer Naukri opens its "Apply Confirmation" page (/myapply/saveApply, seen live
  // 2026-11-04), reading 'Applied to "<job title>"'.
  // Naukri opens the same page when an apply fails, so only its response code for the job counts (2026-11-10).
  if (location.pathname.startsWith('/myapply/saveApply')) return naukriApplyResult(location.href).status === 'applied';
  // Naukri's own "Applied" in place of the Apply button.
  if (shown(document.querySelector('#already-applied'))) return true;
  // The chatbot's or a toast's own success line; never page-wide text ("Jobs you have applied to" is a menu link).
  const toast = [...document.querySelectorAll<HTMLElement>('.chatbot_Drawer, [class*="toast" i], [role="alert"]')].filter(shown).map((e) => e.innerText).join(' ');
  return /applied successfully|successfully applied/i.test(toast);
}
