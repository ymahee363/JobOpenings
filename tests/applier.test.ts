// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runApply, type Timing } from '../src/content/applier-run';
import type { AnswerEntry } from '../src/shared/auto-apply/config';

const FAST: Timing = { pageWaitMs: 300, confirmWaitMs: 300, pollMs: 10, settleMs: 0, dialogGraceMs: 50, beatMs: () => 0 };
const BANK: AnswerEntry[] = [
  { question: 'expected ctc', answer: '55' },
  { question: 'notice period', answer: '30 days' },
  { question: 'relocate', answer: 'Yes' },
];

let storage: Record<string, unknown>;
const clicks: string[] = [];

function stubChrome(): void {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => storage } } });
}

/** A page shaped like a live iimjobs job page (see tests/fixtures/iimjobs-job-pages.json). */
function page(opts: { applied?: boolean; captcha?: boolean; button?: boolean; onApply?: () => void } = {}): void {
  history.replaceState({}, '', '/j/paytm-product-manager-1742187');
  document.title = 'Paytm - Product Manager - Paytm | iimjobs.com';
  const nd = { props: { pageProps: { initialState: { botDetection: { captchaShown: !!opts.captcha }, app: { redirectedFromExpiredJD: false } } } } };
  document.body.innerHTML = `
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script>
    <h1>Paytm - Product Manager</h1>
    ${opts.button === false ? '' : `<button data-track="apply-job" ${opts.applied ? 'disabled' : ''}>${opts.applied ? 'Applied' : 'Apply'}</button>`}`;
  document.querySelector('button')?.addEventListener('click', () => {
    clicks.push('apply');
    opts.onApply?.();
  });
}

function markApplied(): void {
  const b = document.querySelector<HTMLButtonElement>('button[data-track="apply-job"]')!;
  b.textContent = 'Applied';
  b.disabled = true;
}

/** Open a questions dialog; Submit marks the job applied. */
function openDialog(fieldsHtml: string): void {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.innerHTML = `<h2>A few questions</h2><form>${fieldsHtml}</form><button type="button">Cancel</button><button type="button">Submit</button>`;
  document.body.appendChild(d);
  const [cancel, submit] = [...d.querySelectorAll<HTMLButtonElement>('button')];
  cancel!.addEventListener('click', () => { clicks.push('cancel'); d.remove(); });
  submit!.addEventListener('click', () => { clicks.push('submit'); d.remove(); markApplied(); });
}

const ANSWERABLE = `
  <label for="ctc">Expected CTC *</label><input id="ctc" type="number" required>
  <label for="np">Notice period</label><select id="np" required><option value="">Choose</option><option value="15">15 days</option><option value="30">30 days</option></select>
  <fieldset><legend>Willing to relocate?</legend>
    <label><input type="radio" name="rel" value="y">Yes</label><label><input type="radio" name="rel" value="n">No</label></fieldset>`;

const msg = (over: Partial<{ dryRun: boolean; fillForms: boolean; answers: AnswerEntry[] }> = {}) => ({ type: 'apply-run' as const, token: 'abcdef123456', dryRun: false, fillForms: false, answers: BANK, ...over });
const FILL = { fillForms: true };

beforeEach(() => {
  storage = { agent: { autoApply: true, dryRun: false }, safety: { haltedAt: null }, agentState: { haltedAt: null } };
  clicks.length = 0;
  stubChrome();
  // happy-dom does no layout; treat every element as on screen.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 10, height: 10 } as DOMRect);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runApply', () => {
  it("Instahyre's own toast (#insta-toastr-container) counts as applied", async () => {
    page({ onApply: () => {
      const c = document.createElement('div');
      c.id = 'insta-toastr-container';
      c.innerHTML = '<div class="insta-toastr-wrapper"><div class="insta-toastr insta-toastr-success"><div class="insta-toastr-message">Application sent to PagarBook!</div></div></div>';
      document.body.appendChild(c);
    } });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'applied', clicked: true });
  });

  it('Instahyre one-click: the "Application sent to <company>" toast counts, even with the pop-ups that follow', async () => {
    page({ onApply: () => {
      const toast = document.createElement('div');
      toast.id = 'toast-container';
      toast.innerHTML = '<div class="toast toast-success"><div class="toast-message">Application sent to ZenteiQ.ai</div></div>';
      document.body.appendChild(toast);
      openDialog('<p>Are you actively looking for a job?</p>');
    } });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'applied', clicked: true });
    expect(clicks).toEqual(['apply']);
  });

  it('waits for the page to settle before clicking', async () => {
    page({ onApply: markApplied });
    const b = document.querySelector('button')!;
    b.disabled = true;
    setTimeout(() => { b.disabled = false; }, 40);
    expect(await runApply(msg(), { ...FAST, settleMs: 100, pageWaitMs: 1_000 })).toMatchObject({ result: 'applied', clicked: true });
  });

  it('signals the service worker before each click, so a reload after Apply still gets checked', async () => {
    page({ onApply: markApplied });
    const seen: string[] = [];
    const beforeClick = async () => { seen.push(`before:${clicks.length}`); };
    expect(await runApply(msg(), FAST, { beforeClick })).toMatchObject({ result: 'applied' });
    expect(seen).toEqual(['before:0']);
    page({ applied: true });
    seen.length = 0;
    await runApply(msg(), FAST, { beforeClick });
    expect(seen).toEqual([]);
  });

  it('applies to an Instahyre job outside your matches too: it is one click (submitChoiceNonMatching)', async () => {
    page({ onApply: markApplied });
    document.querySelector('button')!.setAttribute('ng-click', 'submitChoiceNonMatching()');
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'applied', clicked: true });
    expect(clicks).toEqual(['apply']);
  });

  it("sees Instahyre's own pop-up once it is shown", async () => {
    page({ onApply: () => {
      const m = document.createElement('div');
      m.className = 'application-modal ng-scope';
      m.innerHTML = '<div class="application-modal-heading">Why are you interested?</div><textarea required></textarea><button>Cancel</button><button>Submit</button>';
      document.body.appendChild(m);
      m.querySelector('button')!.addEventListener('click', () => { clicks.push('cancel'); m.classList.add('ng-hide'); });
    } });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'needs_me', clicked: true });
    expect(clicks).toEqual(['apply', 'cancel']);
  });

  it('a pop-up just before the button turns to "Application sent!" still counts as applied', async () => {
    page({ onApply: () => { openDialog('<p>Similar jobs you may like</p>'); setTimeout(() => { const b = document.querySelector('button')!; b.textContent = 'Application sent!'; b.disabled = true; }, 20); } });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'applied', clicked: true });
    expect(clicks).toEqual(['apply']);
  });

  it('one-click only (default): a form asking for details is closed, nothing submitted', async () => {
    page({ onApply: () => openDialog(ANSWERABLE) });
    const r = await runApply(msg(), FAST);
    expect(r).toMatchObject({ result: 'needs_me', clicked: true, questions: ['Expected CTC', 'Notice period', 'Willing to relocate?'] });
    expect(r.reason).toContain('iimjobs asked for details');
    expect(clicks).toEqual(['apply', 'cancel']);
  });

  it('applies with one click when the button turns to Applied', async () => {
    page({ onApply: markApplied });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'applied', clicked: true });
    expect(clicks).toEqual(['apply']);
  });

  it('does not click a job already applied to, a missing button, or a captcha page', async () => {
    page({ applied: true });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'already_applied', clicked: false });
    page({ button: false });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'not_found' });
    page({ captcha: true });
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'captcha' });
    expect(clicks).toEqual([]);
  });

  it('dry run checks the page and clicks nothing (AR-10)', async () => {
    page({ onApply: markApplied });
    expect(await runApply(msg({ dryRun: true }), FAST)).toMatchObject({ result: 'can_apply', clicked: false });
    expect(clicks).toEqual([]);
  });

  it('re-reads the kill switch, dry run and halts before clicking (AR-9)', async () => {
    for (const s of [
      { agent: { autoApply: false, dryRun: false } },
      { agent: { autoApply: true, dryRun: true } },
      { agent: { autoApply: true, dryRun: false }, safety: { haltedAt: 1 } },
      { agent: { autoApply: true, dryRun: false }, agentState: { haltedAt: 1 } },
    ]) {
      storage = s;
      page({ onApply: markApplied });
      expect(await runApply(msg(), FAST)).toMatchObject({ result: 'stopped', clicked: false });
    }
    expect(clicks).toEqual([]);
  });

  it('fills a questions dialog from the answer bank and submits it (AR-6)', async () => {
    page({ onApply: () => openDialog(ANSWERABLE) });
    const r = await runApply(msg(FILL), FAST);
    expect(r).toMatchObject({ result: 'applied', clicked: true });
    expect(clicks).toEqual(['apply', 'submit']);
    expect(r.answers).toEqual([
      { question: 'Expected CTC', answer: '55' },
      { question: 'Notice period', answer: '30 days' },
      { question: 'Willing to relocate?', answer: 'Yes' },
    ]);
    expect(r.dialogs[0]?.fields.map((f) => [f.label, f.kind, f.required])).toEqual([
      ['Expected CTC', 'number', true], ['Notice period', 'select', true], ['Willing to relocate?', 'radio', false],
    ]);
  });

  it('puts the values in the fields before submitting', async () => {
    let seen: unknown[] = [];
    page({
      onApply: () => {
        openDialog(ANSWERABLE);
        document.querySelectorAll('[role="dialog"] button')[1]!.addEventListener('click', () => {
          seen = [(document.getElementById('ctc') as HTMLInputElement).value, (document.getElementById('np') as HTMLSelectElement).value,
            (document.querySelector('input[value="y"]') as HTMLInputElement).checked];
        }, { capture: true });
      },
    });
    await runApply(msg(FILL), FAST);
    expect(seen).toEqual(['55', '30', true]);
  });

  it('never submits a question it cannot answer: closes the dialog, job needs you', async () => {
    page({ onApply: () => openDialog('<label for="why">Why do you want to join? *</label><textarea id="why" required></textarea>') });
    const r = await runApply(msg(FILL), FAST);
    expect(r).toMatchObject({ result: 'needs_me', clicked: true, questions: ['Why do you want to join?'] });
    expect(clicks).toEqual(['apply', 'cancel']);
  });

  it('stops before Submit when the switch is turned off mid-dialog', async () => {
    page({ onApply: () => { openDialog(ANSWERABLE); storage = { agent: { autoApply: false } }; } });
    expect(await runApply(msg(FILL), FAST)).toMatchObject({ result: 'stopped', clicked: true });
    expect(clicks).toEqual(['apply', 'cancel']);
  });

  it('reports no confirmation when nothing happens after the click', async () => {
    page();
    expect(await runApply(msg(), FAST)).toMatchObject({ result: 'no_confirmation', clicked: true });
  });

  it('treats an unknown dialog without questions as needing you', async () => {
    page({ onApply: () => openDialog('<p>Become a Pro member for early access!</p>') });
    expect(await runApply(msg(FILL), FAST)).toMatchObject({ result: 'needs_me' });
    expect(clicks).toEqual(['apply', 'cancel']);
  });
});
