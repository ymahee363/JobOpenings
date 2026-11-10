/**
 * Naukri's applier, in the page (www.naukri.com/job-listings-<slug>-<id>).
 *
 * Seen on a job page on 2026-11-10 (signed in, read only) and from the chatbot code in ../naukri-chat.ts:
 *  - an Easy Apply job shows `button#apply-button` ("Apply"); a job already applied to shows `#already-applied`;
 *    a company-site job shows `#company-site-button` ("Apply on company site"), which this applier never presses;
 *  - pressing Apply either applies at once, or opens the recruiter's questions in a chatbot drawer
 *    (`.chatbot_Drawer`), one question at a time, each sent with "Save" (`.sendMsg`). The questions are read and
 *    answered through the form engine (EXTRACT_FORM / FILL_FIELDS see the drawer's current question as a form);
 *  - once applied, Naukri opens its "Apply Confirmation" page (/myapply/saveApply: 'Applied to "<title>"').
 *
 * Messages (from src/shared/ats/naukri-flow.ts): NK_STATE, NK_START, NK_SEND.
 */
import { naukriApplied, naukriChatForm, naukriChatRoot, naukriChatSave } from '../naukri-chat';

export interface NkState {
  page: 'job' | 'chat' | 'applied' | 'external' | 'unknown';
  /** The chatbot's current question; "" while it is typing or off the chatbot. */
  question: string;
  errors: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const shown = (el: Element | null): el is HTMLElement => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

export function nkState(): NkState {
  const root = naukriChatRoot();
  const question = root ? naukriChatForm()?.fields[0]?.label ?? '' : '';
  const errors = root
    ? [...root.querySelectorAll<HTMLElement>('[class*="error" i], [class*="Error"]')].filter(shown).map((e) => e.innerText.trim()).filter((t) => t && t.length < 200).slice(0, 5)
    : [];
  if (naukriApplied() && !root) return { page: 'applied', question: '', errors };
  if (root) return { page: 'chat', question, errors };
  if (shown(document.querySelector('#apply-button'))) return { page: 'job', question: '', errors };
  if (shown(document.querySelector('#company-site-button'))) return { page: 'external', question: '', errors };
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal" i], [class*="Modal"]')].filter(shown).map((e) => e.innerText.trim()).find(Boolean);
  return { page: 'unknown', question: '', errors: [`page ${location.pathname.slice(0, 60)}${dialog ? `, dialog: ${dialog.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`] };
}

/**
 * Press Apply, then wait for the chatbot's first question or the confirmation. Naukri's page can be loaded but not yet
 * listening (its script attaches the click handler a moment later): a click then does nothing (seen 2026-11-10 from
 * "Apply with AI": "no Apply button or questions found (job)"). So press the visible Apply, and press again, up to 3
 * times, only while nothing happened and Apply is still there.
 */
export async function nkStart(): Promise<NkState & { presses: number }> {
  const button = () => [...document.querySelectorAll<HTMLElement>('#apply-button')].find(shown) ?? null;
  for (let i = 0; i < 25 && !button() && nkState().page !== 'applied'; i += 1) await sleep(400);
  let presses = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const b = button();
    if (!b) break;
    b.scrollIntoView({ block: 'center' });
    b.click();
    presses += 1;
    for (let i = 0; i < 20; i += 1) {
      await sleep(400);
      const s = nkState();
      if (s.page === 'applied' || s.page === 'chat') {
        for (let j = 0; j < 20 && s.page === 'chat' && !nkState().question; j += 1) await sleep(400);
        return { ...nkState(), presses };
      }
    }
    if (nkState().page !== 'job') break;
  }
  return { ...nkState(), presses };
}

/** Press "Save" on the current answer, then wait for the next question (or the confirmation). */
export async function nkSend(): Promise<NkState & { moved: boolean }> {
  const before = nkState().question;
  const save = naukriChatSave();
  if (!save) return { ...nkState(), moved: false };
  save.click();
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    const s = nkState();
    if (s.page === 'applied') return { ...s, moved: true };
    if (s.page === 'chat' && s.question && s.question !== before) return { ...s, moved: true };
    if (s.page !== 'chat' && s.page !== 'unknown') return { ...s, moved: true };
  }
  return { ...nkState(), moved: false };
}

export function handleNaukriMessage(message: { type: string }, sendResponse: (r: unknown) => void): boolean {
  const reply = (p: Promise<unknown>) => {
    p.then((r) => sendResponse({ ok: true, ...(r as object) }), (e: unknown) => sendResponse({ ok: false, error: String(e).slice(0, 200) }));
    return true;
  };
  switch (message.type) {
    case 'NK_STATE': return reply(Promise.resolve(nkState()));
    case 'NK_START': return reply(nkStart());
    case 'NK_SEND': return reply(nkSend());
    default: return false;
  }
}
