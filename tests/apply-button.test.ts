import { describe, expect, it } from 'vitest';
import {
  APPLY_CHOICE_ID, applyChoiceField, isSideFormContext, looksLikeApplicationForm, parseApplyChoice, pickApplyCandidate, pickClearApplyCandidate, scoreApplyCandidate,
} from '../src/shared/ai-apply/apply-button';
import { runAiApply, type FlowDeps } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { Answer, FormField } from '../src/shared/ai-apply/types';

const f = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({
  id, label, type: 'text', required: true, options: [], current_value: '', ...over,
});

describe('scoring the Apply control by meaning', () => {
  it('finds the Apply link on a careers page that opens Workday (Target)', () => {
    const cands = [
      { text: 'Search jobs', href: 'https://corporate.target.com/jobs' },
      { text: 'Share', href: '' },
      { text: 'Apply', href: 'https://target.wd5.myworkdayjobs.com/targetcareers/job/Bangalore/Product-Manager_R0000475834/apply' },
      { text: 'Sign up for job alerts' },
    ];
    expect(pickApplyCandidate(cands)).toBe(2);
  });

  it.each([
    'Apply now', 'Apply Now', 'Apply on company site', 'Start your application', 'Submit resume', "I'm interested",
    'Easy Apply', 'Apply for this role', 'Begin application', 'Quick apply', 'Continue to apply',
  ])('accepts "%s"', (text) => {
    expect(scoreApplyCandidate({ text })).toBeGreaterThanOrEqual(7);
  });

  it.each([
    'Applied', 'Apply filters', 'Apply changes', 'Job alerts', 'Sign in', 'Share this job', 'Save job', 'Similar jobs',
    'Apply with LinkedIn', 'Join our talent community', 'How to apply for jobs at our company and what to expect next',
  ])('rejects "%s"', (text) => {
    expect(scoreApplyCandidate({ text })).toBeLessThan(7);
  });

  it('reads an icon button by its aria-label, and a link to an ATS apply page', () => {
    expect(scoreApplyCandidate({ text: '', label: 'Apply for Product Manager' })).toBeGreaterThanOrEqual(7);
    expect(scoreApplyCandidate({ text: 'Get started', attrs: 'btn job-apply-cta', href: 'https://jobs.lever.co/acme/1/apply' })).toBeGreaterThanOrEqual(7);
  });

  it('finds N-able\'s "Begin Your N-able Journey Here" by its id and iCIMS link, never "Refer" (2026-11-06)', () => {
    const cands = [
      { text: 'N-able Home', href: 'https://www.n-able.com/' },
      { text: 'Search Jobs', href: 'https://careers.n-able.com/jobs' },
      { text: 'Begin Your N-able Journey Here', attrs: 'link-apply apply __button btn-primary primary-bg-color', href: 'https://globalcareers-n-able.icims.com/jobs/21086/login' },
      { text: 'Refer', attrs: 'link-recruit-refer apply __button btn-primary', href: 'https://globalcareers-n-able.icims.com/jobs/21086/referral' },
    ];
    expect(scoreApplyCandidate(cands[3]!)).toBeLessThan(0);
    expect(pickClearApplyCandidate(cands)).toBe(2);
  });

  it('leaves two close, different candidates to the AI; the same Apply twice is still clear', () => {
    expect(pickClearApplyCandidate([{ text: 'Apply now', href: 'https://a.com/jobs/1' }, { text: 'Easy Apply', href: 'https://b.com/x' }])).toBe(-1);
    // A link to an /apply address is a clear winner over a plain one.
    expect(pickClearApplyCandidate([{ text: 'Apply now', href: 'https://a.com/apply' }, { text: 'Easy Apply', href: 'https://b.com/x' }])).toBe(0);
    expect(pickClearApplyCandidate([{ text: 'Apply', href: 'https://a.com/apply' }, { text: 'Apply', href: 'https://a.com/apply' }])).toBe(0);
    expect(pickClearApplyCandidate([{ text: 'Apply', href: 'https://jobs.lever.co/x/1/apply' }, { text: 'Apply with LinkedIn' }])).toBe(0);
  });

  it('prefers the real button when two say apply', () => {
    expect(pickApplyCandidate([{ text: 'Apply' }, { text: 'Apply', href: 'https://jobs.lever.co/acme/1/apply' }])).toBe(1);
  });
});

describe('side forms and the form checker', () => {
  it('knows a job-alert sign-up is not the application', () => {
    expect(isSideFormContext('job-alert-signup-form-first-name job-alert-signup--fields job-alert-signup')).toBe(true);
    expect(isSideFormContext('newsletter-form email')).toBe(true);
    expect(isSideFormContext('Join our Talent Community')).toBe(true);
    expect(isSideFormContext('application-form first_name candidate-details')).toBe(false);
  });

  it('tells an application from a job search', () => {
    expect(looksLikeApplicationForm([f('k', 'Keyword'), f('l', 'Location')])).toBe(false);
    expect(looksLikeApplicationForm([f('n', 'First Name'), f('e', 'Email')])).toBe(true);
    expect(looksLikeApplicationForm([f('x', 'Attach', { type: 'file' })])).toBe(true);
  });
});

describe('the AI choice', () => {
  it('offers numbered options and reads the pick back', () => {
    const field = applyChoiceField([{ text: 'Careers' }, { text: 'Join us', href: 'https://acme.com/join' }]);
    expect(field.options).toEqual(['1. Careers', '2. Join us -> acme.com/join', 'None of these']);
    const ans = (answer: string): Answer[] => [{ field_id: APPLY_CHOICE_ID, answer, confidence: 1, source: 'ai_generated', needs_user_input: false }];
    expect(parseApplyChoice(ans('2. Join us -> acme.com/join'), 2)).toBe(1);
    expect(parseApplyChoice(ans('None of these'), 2)).toBe(-1);
    expect(parseApplyChoice(ans('7. Something'), 2)).toBe(-1);
  });
});

interface Posting { fields: FormField[]; apply: boolean; candidates?: Array<{ text: string }>; submitHere?: boolean }

/** A fake tab: a posting (page 0), then after any Apply press the application form (page 1). */
function page(posting: Posting) {
  let at = 0;
  let confirmed = false;
  const sent: Array<Record<string, unknown>> = [];
  const form = [f('n', 'Full name'), f('e', 'Email')];
  const engine = async (msg: Record<string, unknown>) => {
    sent.push(msg);
    const onPosting = at === 0;
    switch (msg.type) {
      case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://acme.com/jobs/1', title: 'Job', page_text: '', fields: onPosting ? posting.fields : form } };
      case 'FIND_APPLY': return { ok: true, found: onPosting && posting.apply, text: 'Apply' };
      case 'APPLY_CANDIDATES': return { ok: true, candidates: onPosting ? posting.candidates ?? [] : [] };
      case 'CLICK_APPLY': at = 1; return { ok: true };
      case 'FIND_SUBMIT': return { ok: true, found: !onPosting || !!posting.submitHere, text: 'Submit' };
      case 'FIND_CONTINUE': return { ok: true, found: false };
      case 'CLICK_SUBMIT': confirmed = true; return { ok: true };
      case 'FILL_FIELDS': return { ok: true, results: (msg.answers as unknown[]).map(() => ({ filled: true })) };
      case 'DETECT_ERRORS': return { ok: true, errors: [] };
      case 'PAGE_SIGNALS': return { ok: true, confirmed, captcha: false, closed: false };
      default: return { ok: true };
    }
  };
  return { engine, clicks: () => sent.filter((m) => String(m.type).startsWith('CLICK_')) };
}

function deps(p: ReturnType<typeof page>, pick: (field: FormField) => string): FlowDeps & { asked: FormField[] } {
  let clock = 0;
  const asked: FormField[] = [];
  return {
    asked,
    frames: async () => [0],
    send: (_f, msg) => p.engine(msg),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    profile: { ...DEFAULT_PROFILE, phone: '9999999999' },
    resume: null,
    memory: {},
    bank: [],
    generate: async (req) => req.fields.map((field): Answer => {
      asked.push(field);
      return { field_id: field.id, answer: pick(field), confidence: 0.9, source: 'ai_generated', needs_user_input: false };
    }),
    saveMemory: async () => {},
    mayClick: async () => null,
  };
}

const job = { title: 'PM', company: 'Acme', url: 'https://acme.com/jobs/1' };

describe('runAiApply finds its way to the form', () => {
  it('presses Apply even when the posting has other fields that are not an application (a job search)', async () => {
    const p = page({ fields: [f('k', 'Keyword'), f('l', 'Location')], apply: true });
    const r = await runAiApply(deps(p, () => 'x'), { mode: 'submit', job, settleMs: 1_000 });
    expect(p.clicks().map((m) => m.type)).toEqual(['CLICK_APPLY', 'CLICK_SUBMIT']);
    expect(r.result).toBe('applied');
  });

  it('asks the AI which control opens the form when no wording matches, and presses that one', async () => {
    const p = page({ fields: [], apply: false, candidates: [{ text: 'Careers' }, { text: 'Join the team' }] });
    const d = deps(p, (field) => (field.options.length ? field.options[1]! : 'x'));
    const r = await runAiApply(d, { mode: 'submit', job, settleMs: 1_000 });
    expect(d.asked[0]!.id).toBe(APPLY_CHOICE_ID);
    expect(p.clicks()[0]).toEqual({ type: 'CLICK_APPLY', index: 1 });
    expect(r.result).toBe('applied');
  });

  it('does not click anything when the AI says none of them opens an application', async () => {
    const p = page({ fields: [], apply: false, candidates: [{ text: 'Careers' }] });
    const r = await runAiApply(deps(p, () => 'None of these'), { mode: 'submit', job, settleMs: 1_000 });
    expect(p.clicks()).toEqual([]);
    expect(r.result).toBe('needs_me');
  });

  it('after Indeed, lists the careers page\'s buttons and lets the AI choose there too (N-able, 2026-11-06)', async () => {
    // Page 0: Indeed ("Apply on company site" found by its wording). Page 1: N-able, nothing reads as Apply.
    // Page 2: the application form.
    let at = 0;
    let confirmed = false;
    const sent: Array<Record<string, unknown>> = [];
    const engine = async (msg: Record<string, unknown>) => {
      sent.push(msg);
      switch (msg.type) {
        case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://x', title: 't', page_text: '', fields: at === 2 ? [f('n', 'First Name'), f('e', 'Email')] : [] } };
        case 'FIND_APPLY': return { ok: true, found: at === 0, text: 'Apply on company site' };
        case 'APPLY_CANDIDATES': return { ok: true, candidates: at === 1 ? [{ text: 'Search Jobs' }, { text: 'Begin Your N-able Journey Here' }] : [] };
        case 'CLICK_APPLY': at += 1; return { ok: true };
        case 'FIND_SUBMIT': return { ok: true, found: at === 2, text: 'Submit' };
        case 'FIND_CONTINUE': return { ok: true, found: false };
        case 'CLICK_SUBMIT': confirmed = true; return { ok: true };
        case 'FILL_FIELDS': return { ok: true, results: (msg.answers as unknown[]).map(() => ({ filled: true })) };
        case 'DETECT_ERRORS': return { ok: true, errors: [] };
        case 'PAGE_SIGNALS': return { ok: true, confirmed, captcha: false, closed: false };
        default: return { ok: true };
      }
    };
    const statuses: string[] = [];
    const d = { ...deps({ engine, clicks: () => [] }, (field) => (field.options.length ? field.options[1]! : 'x')), status: (t: string) => statuses.push(t) };
    const r = await runAiApply(d, { mode: 'submit', job, settleMs: 1_000 });
    expect(sent.filter((m) => m.type === 'CLICK_APPLY')).toEqual([{ type: 'CLICK_APPLY' }, { type: 'CLICK_APPLY', index: 1 }]);
    expect(statuses.join(' | ')).toMatch(/Buttons on the page \(2\): "Search Jobs", "Begin Your N-able Journey Here".*AI chose "Begin Your N-able Journey Here"/);
    expect(r.result).toBe('applied');
  });

  it('follows Indeed -> a careers page with a stray field (a captcha box) -> its own Apply -> the form (Target)', async () => {
    const steps = [
      { fields: [] as FormField[], apply: true },
      { fields: [f('r', "I'm not a robot", { type: 'checkbox', options: ['Yes', 'No'], current_value: 'No', required: false })], apply: true },
      { fields: [f('n', 'First Name'), f('e', 'Email')], apply: false },
    ];
    let at = 0;
    let confirmed = false;
    const clicks: string[] = [];
    const engine = async (msg: Record<string, unknown>) => {
      const s = steps[at]!;
      switch (msg.type) {
        case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://x', title: 't', page_text: '', fields: s.fields } };
        case 'FIND_APPLY': return { ok: true, found: s.apply, text: 'Apply' };
        case 'CLICK_APPLY': clicks.push('apply'); at += 1; return { ok: true };
        case 'FIND_SUBMIT': return { ok: true, found: at === 2, text: 'Submit' };
        case 'FIND_CONTINUE': return { ok: true, found: false };
        case 'CLICK_SUBMIT': clicks.push('submit'); confirmed = true; return { ok: true };
        case 'FILL_FIELDS': return { ok: true, results: (msg.answers as unknown[]).map(() => ({ filled: true })) };
        case 'DETECT_ERRORS': return { ok: true, errors: [] };
        case 'PAGE_SIGNALS': return { ok: true, confirmed, captcha: false, closed: false };
        default: return { ok: true };
      }
    };
    const d = deps({ engine, clicks: () => [] }, () => 'x');
    const r = await runAiApply(d, { mode: 'submit', job, settleMs: 1_000 });
    expect(clicks).toEqual(['apply', 'apply', 'submit']);
    expect(r.result).toBe('applied');
  });

  it('fills a form that is already on the page without pressing Apply or asking the AI', async () => {
    const p = page({ fields: [f('n', 'Full name'), f('e', 'Email')], apply: false, submitHere: true });
    const d = deps(p, () => 'x');
    const r = await runAiApply(d, { mode: 'submit', job, settleMs: 1_000 });
    expect(p.clicks().map((m) => m.type)).toEqual(['CLICK_SUBMIT']);
    expect(d.asked.some((x) => x.id === APPLY_CHOICE_ID)).toBe(false);
    expect(r.result).toBe('applied');
  });
});
