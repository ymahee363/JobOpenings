/**
 * The auto-apply agent's applier on iimjobs job pages. It does nothing until the service worker sends `apply-run`,
 * which it sends only to a tab the agent opened itself; the work is in `applier-run.ts`.
 */
import { ApplyRunMessage, type CollectorMessage } from '../shared/messages';
import { report, runApply } from './applier-run';

let running = false;

try {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    const parsed = ApplyRunMessage.safeParse(raw);
    if (!parsed.success) return false;
    // Acknowledge, so the service worker stops resending; a second request for the same page is ignored.
    sendResponse({ ok: !running });
    if (running) return false;
    running = true;
    const msg = parsed.data;
    // Tell the service worker before each click: if the site then reloads or leaves the page, it still knows to check.
    const beforeClick = () => chrome.runtime.sendMessage({ type: 'apply-progress', token: msg.token }).then(() => undefined, () => undefined);
    runApply(msg, undefined, { beforeClick })
      .catch((e: unknown) => report('error', { reason: String(e).slice(0, 200) }))
      .then((r) => {
        // Trim to the message schema's limits, so an oversized report is never dropped.
        const s = (v: string, n: number) => v.slice(0, n);
        const out: CollectorMessage = {
          type: 'apply-report', token: msg.token, result: r.result, clicked: r.clicked, reason: s(r.reason, 500),
          questions: r.questions.slice(0, 30).map((q) => s(q, 300)),
          answers: r.answers.slice(0, 30).map((a) => ({ question: s(a.question, 300), answer: s(a.answer, 500) })),
          dialogs: r.dialogs.slice(0, 5).map((d) => ({
            title: s(d.title, 300),
            buttons: d.buttons.slice(0, 20).map((b) => s(b, 100)),
            fields: d.fields.slice(0, 30).map((f) => ({ ...f, label: s(f.label, 300), options: f.options.slice(0, 50).map((o) => s(o, 200)) })),
          })),
        };
        chrome.runtime.sendMessage(out).catch(() => undefined);
      });
    return false;
  });
} catch {
  // Extension was reloaded; this page's script is orphaned.
}
