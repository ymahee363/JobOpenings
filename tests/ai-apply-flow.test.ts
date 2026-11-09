import { describe, expect, it } from 'vitest';
import { buildAnswers, runAiApply, type FlowDeps, type FlowMode } from '../src/shared/ai-apply/flow';
import type { AnswerRequest } from '../src/shared/ai-apply/llm';
import { classifyCategory, forgetAnswer, groupMemory, lookupRememberedAnswer, rememberAnswers, type MemoryMap } from '../src/shared/ai-apply/memory';
import { DEFAULT_PROFILE, normalizeProfile, PROFILE_EMAIL } from '../src/shared/ai-apply/profile';
import { seedPatch } from '../src/shared/ai-apply/seed';
import type { Answer, FormField } from '../src/shared/ai-apply/types';
import { DEFAULT_AGENT_CONFIG, normalizeAgentConfig, type AgentConfig } from '../src/shared/auto-apply/config';
import { buildQueue, eligibility } from '../src/shared/auto-apply/match';
import { applyUrlOf, decide } from '../src/shared/auto-apply/runner';
import type { Job } from '../src/shared/types';

const f = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({
  id, label, type: 'text', required: true, options: [], current_value: '', ...over,
});

interface FakePage {
  fields: FormField[];
  apply?: boolean;
  next?: boolean;
  submit?: boolean;
  /** Pressing Next leaves the page as it is (a field the site still rejects). */
  stuck?: boolean;
  captcha?: boolean;
}

/** A fake tab: one frame running a fake form engine over a list of pages. */
function fakePage(pages: FakePage[]) {
  let at = 0;
  let confirmed = false;
  const sent: string[] = [];
  const filled: Array<{ label?: string; answer: string }> = [];
  const page = () => pages[at]!;
  const engine = async (msg: Record<string, unknown>) => {
    sent.push(String(msg.type));
    switch (msg.type) {
      case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://jobs.example.com/apply', title: `Step ${at}`, page_text: 'Senior PM role', fields: page().fields } };
      case 'FIND_APPLY': return { ok: true, found: !!page().apply, text: 'Apply now' };
      case 'FIND_CONTINUE': return { ok: true, found: !!page().next, text: 'Next' };
      case 'FIND_SUBMIT': return { ok: true, found: !!page().submit, text: 'Submit application' };
      case 'CLICK_APPLY': case 'CLICK_CONTINUE':
        if (!page().stuck) at += 1;
        return { ok: true };
      case 'CLICK_SUBMIT':
        confirmed = true;
        return { ok: true };
      case 'FILL_FIELDS': {
        const answers = msg.answers as Array<{ label?: string; answer: string }>;
        filled.push(...answers);
        return { ok: true, results: answers.map(() => ({ filled: true })) };
      }
      case 'FILL_RESUME': return { ok: true, filled: true };
      case 'DETECT_ERRORS': return { ok: true, errors: [] };
      case 'PAGE_SIGNALS': return { ok: true, confirmed, captcha: !!page().captcha };
      default: return { ok: false };
    }
  };
  return { engine, sent, filled, clicks: () => sent.filter((t) => t.startsWith('CLICK_')) };
}

function deps(page: ReturnType<typeof fakePage>, over: Partial<FlowDeps> = {}): FlowDeps & { llmCalls: AnswerRequest[]; saved: MemoryMap[] } {
  let clock = 0;
  const llmCalls: AnswerRequest[] = [];
  const saved: MemoryMap[] = [];
  return {
    llmCalls,
    saved,
    frames: async () => [0],
    send: (_frame, msg) => page.engine(msg),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    profile: { ...DEFAULT_PROFILE, phone: '9999999999' },
    resume: { name: 'cv.pdf', type: 'application/pdf', data: 'JVBERg==', text: 'resume text' },
    memory: {},
    bank: [],
    generate: async (req) => {
      llmCalls.push(req);
      return req.fields.map((field): Answer => ({ field_id: field.id, answer: `AI answer to ${field.label}`, confidence: 0.8, source: 'ai_generated', needs_user_input: false }));
    },
    saveMemory: async (m) => {
      saved.push(m);
    },
    mayClick: async () => null,
    ...over,
  };
}

const run = (d: FlowDeps, mode: FlowMode) => runAiApply(d, { mode, job: { title: 'PM', company: 'Example', url: 'https://jobs.example.com/1' }, pageWaitMs: 2_000 });

const contactPage = (): FakePage => ({ fields: [f('n', 'Full name'), f('e', 'Email'), f('cv', 'Resume/CV', { type: 'file' })], next: true });
const questionPage = (): FakePage => ({ fields: [f('q', 'Why do you want to join us?', { type: 'textarea' }), f('c', 'Cover note', { required: false })], submit: true });

describe('answers in the dropdown words (Motive, Greenhouse)', () => {
  it('maps B.Tech, Civil Engineering and the job source onto the options the form offers', async () => {
    const data = { frameId: 0, url: 'https://job-boards.greenhouse.io/gomotive/jobs/1', title: 'Apply', page_text: '', fields: [
      f('deg', 'Degree*', { type: 'combobox', options: ["Associate's Degree", "Bachelor's Degree", "Master's Degree"] }),
      f('dis', 'Discipline*', { type: 'combobox', options: ['Business', 'Engineering', 'Law'] }),
      f('src', 'How did you hear about this opportunity?*', { type: 'combobox', options: ['Glassdoor', 'LinkedIn', 'Medium'] }),
    ] };
    const memory = {
      degree: { label: 'Degree', answer: 'B.Tech', category: '', updatedAt: 1 },
      discipline: { label: 'Discipline', answer: 'Civil Engineering', category: '', updatedAt: 1 },
      'how did you hear about this opportunity': { label: 'How did you hear about this opportunity?', answer: 'Indeed', category: '', updatedAt: 1 },
    };
    const built = await buildAnswers(data as never, { profile: DEFAULT_PROFILE, resume: null, memory, bank: [], now: () => 0,
      generate: async (req) => req.fields.map((x) => ({ field_id: x.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'missing', needs_user_input: true })) }, '', true);
    const by = Object.fromEntries(built.answers.map((x) => [x.field_id, x.answer]));
    expect(by).toMatchObject({ deg: "Bachelor's Degree", dis: 'Engineering', src: 'LinkedIn' });
  });
});

describe('runAiApply', () => {
  it('presses through an Apply chooser (Workday: Apply, then "Apply Manually") to reach the form', async () => {
    const page = fakePage([
      { fields: [], apply: true },
      { fields: [], apply: true },
      { fields: [f('a', 'Full name'), f('b', 'Email')], submit: true },
    ]);
    const r = await runAiApply(deps(page), { mode: 'submit', job: { title: 'PM', company: 'X', url: 'https://x.wd5.myworkdayjobs.com/job/1' } });
    expect(page.clicks()).toEqual(['CLICK_APPLY', 'CLICK_APPLY', 'CLICK_SUBMIT']);
    expect(r.result).toBe('applied');
  });

  it('waits for the page to settle: a passing sign-in box at load is not taken for the form (Naukri)', async () => {
    const page = fakePage([
      { fields: [], apply: true },
      { fields: [f('a', 'Full name'), f('b', 'Email')], submit: true },
    ]);
    // The first read, right at load, shows Naukri's passing "Email ID" box and no Apply button yet.
    let reads = 0;
    const engine = page.engine;
    const d = deps({ ...page, engine } as never, {
      send: async (_frame, msg) => {
        if (msg.type === 'EXTRACT_FORM' && reads++ === 0) return { ok: true, data: { url: 'https://www.naukri.com/job-listings-x-1', title: 'Job', page_text: '', fields: [f('e', 'Email ID', { type: 'email' })] } };
        if (msg.type === 'FIND_APPLY' && reads <= 1) return { ok: true, found: false, text: '' };
        return engine(msg);
      },
    });
    const r = await runAiApply(d, { mode: 'submit', job: { title: 'PM', company: 'X', url: 'https://www.naukri.com/job-listings-x-1' } });
    expect(page.clicks()).toEqual(['CLICK_APPLY', 'CLICK_SUBMIT']);
    expect(page.filled.map((x) => x.label)).not.toContain('Email ID');
    expect(r.result).toBe('applied');
  });

  it('presses Apply on a posting, fills every page and submits, with the LLM asked only what the profile cannot answer', async () => {
    const page = fakePage([{ fields: [], apply: true }, contactPage(), questionPage(), { fields: [] }]);
    const d = deps(page);
    const r = await run(d, 'submit');
    expect(r.result).toBe('applied');
    expect(r.clicked).toBe(true);
    expect(page.clicks()).toEqual(['CLICK_APPLY', 'CLICK_CONTINUE', 'CLICK_SUBMIT']);
    expect(page.filled.find((a) => a.label === 'Full name')?.answer).toBe('Mahendra Yadav');
    expect(page.filled.find((a) => a.label === 'Email')?.answer).toBe(PROFILE_EMAIL);
    expect(page.sent).toContain('FILL_RESUME');
    // Name and email came from the profile; only page 2's questions went to the LLM, once.
    expect(d.llmCalls).toHaveLength(1);
    // "Cover note" is a cover letter box: your own letter or nothing, never the AI (user, 2026-11-06).
    expect(d.llmCalls[0]!.fields.map((x) => x.label)).toEqual(['Why do you want to join us?']);
    // What the LLM answered is remembered for the next form.
    expect(lookupRememberedAnswer(d.saved.at(-1)!, 'Why do you want to join us?')).toBe('AI answer to Why do you want to join us?');
  });

  it('in fill mode stops at the final Submit for you', async () => {
    const page = fakePage([contactPage(), questionPage()]);
    const r = await run(deps(page), 'fill');
    expect(r.result).toBe('ready');
    expect(decide(r, false).outcome).toBe('filled');
    expect(page.clicks()).toEqual(['CLICK_CONTINUE']);
  });

  it('in a dry run clicks nothing', async () => {
    const posting = fakePage([{ fields: [], apply: true }, contactPage()]);
    expect((await run(deps(posting), 'preview')).result).toBe('can_apply');
    expect(posting.clicks()).toEqual([]);

    const form = fakePage([contactPage()]);
    const r = await run(deps(form), 'preview');
    expect(r.result).toBe('can_apply');
    expect(r.answers.map((a) => a.question)).toEqual(['Full name', 'Email']);
    expect(form.clicks()).toEqual([]);
    expect(form.sent).not.toContain('FILL_FIELDS');
  });

  it('leaves the job for you when a required question has no truthful answer, before any Next', async () => {
    const page = fakePage([questionPage()]);
    const d = deps(page, {
      generate: async (req) => req.fields.map((field) => ({ field_id: field.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'unknown', needs_user_input: true })),
    });
    const r = await run(d, 'submit');
    expect(r.result).toBe('needs_me');
    expect(r.questions).toEqual(['Why do you want to join us?']);
    expect(page.clicks()).toEqual([]);
  });

  it('uses the answer bank and form memory before the LLM', async () => {
    const page = fakePage([{ fields: [f('a', 'Are you authorized to work in India?'), f('b', 'How did you hear about us?')], submit: true }]);
    const d = deps(page, {
      bank: [{ question: 'authorized work', answer: 'Yes' }],
      memory: rememberAnswers({}, [{ label: 'How did you hear about us?', answer: 'LinkedIn' }], 1),
    });
    const r = await run(d, 'submit');
    expect(r.result).toBe('applied');
    expect(d.llmCalls).toHaveLength(0);
    expect(page.filled.map((a) => a.answer)).toEqual(['Yes', 'LinkedIn']);
  });

  it('stops at a login wall or captcha', async () => {
    const login = fakePage([{ fields: [f('e', 'Email'), f('p', 'Password', { type: 'password' })], submit: true }]);
    expect((await run(deps(login), 'submit')).reason).toMatch(/sign in or create an account/);
    expect(login.clicks()).toEqual([]);

    const captcha = fakePage([{ ...contactPage(), captcha: true }]);
    expect((await run(deps(captcha), 'submit')).reason).toMatch(/captcha/);
  });

  it('re-reads the kill switch before every click', async () => {
    const page = fakePage([contactPage(), questionPage()]);
    const r = await run(deps(page, { mayClick: async () => 'auto-apply was turned off' }), 'submit');
    expect(r.result).toBe('stopped');
    expect(page.clicks()).toEqual([]);
  });

  it('gives up on a page that does not move after Next', async () => {
    const page = fakePage([{ ...contactPage(), stuck: true }]);
    const r = await run(deps(page), 'submit');
    expect(r.result).toBe('needs_me');
    expect(r.reason).toMatch(/did not move on/);
  });

  it('never sends a password to the LLM', async () => {
    const d = deps(fakePage([]));
    const built = await buildAnswers({ url: 'u', title: 't', page_text: '', fields: [f('p', 'Password', { type: 'password' }), f('x', 'Favourite tool')] }, d, '', false);
    expect(d.llmCalls[0]!.fields.map((x) => x.id)).toEqual(['x']);
    expect(built.answers.map((a) => a.field_id)).toEqual(['x']);
  });
});

describe('form memory', () => {
  it('remembers by normalized question, skips blanks, and groups by category', () => {
    let m = rememberAnswers({}, [{ label: 'Expected CTC?', answer: '30 LPA' }, { label: 'Notice', answer: 'NEEDS_USER_INPUT' }, { label: '', answer: 'x' }], 5);
    expect(Object.keys(m)).toEqual(['expected ctc']);
    expect(lookupRememberedAnswer(m, 'expected  CTC')).toBe('30 LPA');
    expect(classifyCategory('Do you need visa sponsorship?')).toBe('Work authorization');
    expect(groupMemory(m)[0]!.category).toBe('Compensation');
    m = forgetAnswer(m, 'expected ctc');
    expect(m).toEqual({});
  });
});

describe('profile', () => {
  it('fills in missing fields of a stored or imported profile', () => {
    const p = normalizeProfile({ name: 'X', skills: undefined } as never);
    expect(p.name).toBe('X');
    expect(p.email).toBe(PROFILE_EMAIL);
    expect(p.experience.length).toBeGreaterThan(0);
    expect(p.custom_fields).toEqual([]);
  });
});

describe('AI apply in the queue', () => {
  const NOW = Date.now();
  const job = (over: Partial<Job>): Job => ({
    jobId: 'indeed-1', site: 'indeed', title: 'Product Manager', company: 'Acme', location: 'Bangalore', experience: '', expMin: null, expMax: null,
    salary: '', salaryMinLpa: null, salaryMaxLpa: null, skills: [], postedAt: NOW - 3_600_000, postedLabel: '', postedApprox: false,
    firstSeenAt: NOW, lastSeenAt: NOW, sourceFeeds: [], applyType: 'easy_apply', naukriUrl: 'https://in.indeed.com/viewjob?jk=1', externalUrl: null,
    titleCompanyKey: 'product manager|acme', ...over,
  });
  const cfg = (rest: Partial<AgentConfig>): AgentConfig => ({ ...DEFAULT_AGENT_CONFIG, rules: { ...DEFAULT_AGENT_CONFIG.rules, myYears: 5 }, ...rest });

  it('takes company-site jobs and sites without a one-click applier only with AI apply on', () => {
    const rules = cfg({}).rules;
    const indeed = job({});
    const company = job({ jobId: '123456789', site: 'naukri', applyType: 'company_site', externalUrl: 'https://careers.acme.com/1', expMin: 2, expMax: 5 });
    expect(eligibility(indeed, undefined, false, rules, NOW, ['indeed'])).toMatch(/needs AI apply/);
    expect(eligibility(indeed, undefined, false, rules, NOW, ['indeed'], true)).toBeNull();
    expect(eligibility(company, undefined, false, rules, NOW, ['naukri'])).toBe('applies on a company site');
    expect(eligibility(company, undefined, false, rules, NOW, ['naukri'], true)).toBeNull();
    expect(applyUrlOf(company)).toBe('https://careers.acme.com/1');
    expect(applyUrlOf(indeed)).toBe(indeed.naukriUrl);
    expect(buildQueue([indeed, company], [], [], cfg({ sites: ['indeed', 'naukri'], aiApply: true }), [], NOW)).toHaveLength(2);
    expect(buildQueue([indeed, company], [], [], cfg({ sites: ['indeed', 'naukri'] }), [], NOW)).toHaveLength(0);
  });

  it('keeps LinkedIn out of the agent and AI apply off by default', () => {
    expect(normalizeAgentConfig({ sites: ['linkedin', 'indeed'] } as never).sites).toEqual(['linkedin', 'indeed']);
    expect(DEFAULT_AGENT_CONFIG.aiApply).toBe(false);
    expect(DEFAULT_AGENT_CONFIG.aiSubmit).toBe(false);
  });
});

describe('seed from job-apply-ai-mvp', () => {
  const file = { name: 'cv.pdf', type: 'application/pdf', data: 'AAAA', text: 'cv' };
  const seed = {
    version: 1, profile: { name: 'Mahendra Yadav', phone: '6264252896' },
    formMemory: { 'notice period': { label: 'Notice period', answer: 'Immediate', category: '', updatedAt: 1 }, 'gender': { label: 'Gender', answer: 'Male', category: '', updatedAt: 1 } },
    resume: file, coverLetter: { ...file, name: 'cover.pdf' },
  };

  it('fills an empty extension with everything', () => {
    const patch = seedPatch(seed, { profileSaved: false, memory: {}, resume: null, coverLetter: null });
    expect(patch.profile?.phone).toBe('6264252896');
    expect(patch.profile?.email).toBe(PROFILE_EMAIL);
    expect(Object.keys(patch.memory!)).toEqual(['notice period', 'gender']);
    expect(patch.resume?.name).toBe('cv.pdf');
    expect(patch.coverLetter?.name).toBe('cover.pdf');
  });

  it('never overwrites what you saved yourself', () => {
    const mine = { 'notice period': { label: 'Notice period', answer: '30 days', category: '', updatedAt: 9 } };
    const patch = seedPatch(seed, { profileSaved: true, memory: mine, resume: file, coverLetter: null });
    expect(patch.profile).toBeUndefined();
    expect(patch.memory!['notice period']!.answer).toBe('30 days');
    expect(patch.memory!.gender!.answer).toBe('Male');
    expect(patch.resume).toBeUndefined();
    expect(patch.coverLetter?.name).toBe('cover.pdf');
  });
});
