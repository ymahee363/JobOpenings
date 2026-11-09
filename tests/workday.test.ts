// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { detectAts, hasDedicatedApplier } from '../src/shared/ats/detect';
import { buildWorkdayPlan, degreeChoices, wdDate } from '../src/shared/ats/workday-plan';
import { handleWorkdayMessage, wdState, type WorkdayPlan } from '../src/content/ats/workday';
import { runAiApply, type FlowDeps } from '../src/shared/ai-apply/flow';
import { DEFAULT_PROFILE, normalizeProfile } from '../src/shared/ai-apply/profile';

describe('which ATS a page is on', () => {
  it('recognises Workday tenants on any wd<N> and the other platforms', () => {
    expect(detectAts('https://amadeus.wd502.myworkdayjobs.com/en-US/jobs/job/Bangalore/Data-Product-Manager_R38033-1/apply/applyManually')).toBe('workday');
    expect(detectAts('https://sabre.wd1.myworkdayjobs.com/en-US/SabreJobs/job/x')).toBe('workday');
    expect(detectAts('https://job-boards.greenhouse.io/gomotive/jobs/1')).toBe('greenhouse');
    expect(detectAts('https://jobs.ashbyhq.com/tekion/1/application')).toBe('ashby');
    expect(detectAts('https://in.indeed.com/viewjob?jk=1')).toBe('generic');
    expect(detectAts('not a url')).toBe('generic');
    expect(hasDedicatedApplier('workday')).toBe(true);
    expect(hasDedicatedApplier('greenhouse')).toBe(false);
  });
});

const PROFILE = normalizeProfile({
  ...DEFAULT_PROFILE,
  name: 'Mahendra Yadav',
  phone: '6264252896',
  location: 'Bengaluru',
  linkedin: 'https://www.linkedin.com/in/mahendra-yadav/',
  portfolio: 'https://www.mahendrayadavpm.in/',
  expected_ctc: 2700000,
  notice_period: '0',
  skills: ['Product Strategy', 'Market Research', 'Product Management\nTools: Project Management: Jira'],
  custom_fields: [{ id: '1', name: 'Gender', value: 'Male' }, { id: '2', name: 'Country', value: 'India' }],
  experience: [
    { company: 'NU10', title: 'AI Product Lead', start_date: 'April 2026', end_date: 'July 2026', current: false, description: 'Built an MCP server.' },
    { company: 'Dresma', title: 'Product Manager', start_date: 'May 2021', end_date: 'June 2023', current: false },
  ] as never,
  education: [{ degree: 'B.Tech', field_of_study: 'Civil Engineering', institution: 'IIT Guwahati', start_year: 2017, graduation_year: 2021 }],
  address: { line1: 'Koramangala', city: 'Bangalore', postal_code: '560029' },
  languages: [{ name: 'English', fluent: true, level: 'Advanced' }, { name: 'Hindi', fluent: true, level: 'Advanced' }],
} as never);

describe('the Workday plan from your profile', () => {
  it('turns profile dates, degree and links into what Workday asks for', () => {
    expect(wdDate('April 2026')).toEqual({ month: '04', year: '2026' });
    expect(wdDate('2025-08')).toEqual({ month: '08', year: '2025' });
    // B.Tech first, then Bachelor of Engineering, then Workday's general entry (user, 2026-11-06).
    expect(degreeChoices('B.Tech')[0]).toBe('B.Tech');
    expect(degreeChoices('B.Tech')).toContain('Bachelor Degree or equivalent');
    const plan = buildWorkdayPlan(PROFILE, null);
    expect(plan).toMatchObject({
      firstName: 'Mahendra', lastName: 'Yadav', city: 'Bangalore', postalCode: '560029', address: 'Koramangala', phone: '6264252896',
      previousWorker: 'No', country: 'India', gender: ['Male'], privacyConsent: true,
    });
    expect(plan.source[0]).toBe('LinkedIn');
    expect(plan.jobs[0]).toMatchObject({ company: 'NU10', title: 'AI Product Lead', from: { month: '04', year: '2026' }, to: { month: '07', year: '2026' } });
    expect(plan.education[0]).toMatchObject({ school: 'Indian Institute of Technology Guwahati', schoolQuery: 'Guwahati', field: 'Civil Engineering', fromYear: '2017', toYear: '2021' });
    expect(plan.languages.map((l) => l.name)).toEqual(['English', 'Hindi']);
    expect(plan.websites).toEqual(['https://www.linkedin.com/in/mahendra-yadav/', 'https://www.mahendrayadavpm.in/']);
    expect(plan.skills).toContain('Product Strategy');
    expect(plan.skills).toContain('Jira');
    expect(plan.skills).not.toContain('Tools');
    expect(plan.questions.find((q) => /notice/.test(q.pattern))?.answers[0]).toMatch(/Immediately available/);
  });
});

/** A Workday "My Information" step with the automation ids seen live (Amadeus, 2026-11-05). */
function myInformationPage(): void {
  document.body.innerHTML = `
    <div data-automation-id="progressBarActiveStep">current step 1 of 6 My Information</div>
    <div data-automation-id="formField-source"><label>How Did You Hear About Us?*</label>
      <button aria-haspopup="listbox" id="src">Select One</button></div>
    <div data-automation-id="formField-candidateIsPreviousWorker"><legend>Have you worked for Amadeus?*</legend>
      <input type="radio" id="pw-yes" value="true"><label for="pw-yes">Yes</label>
      <input type="radio" id="pw-no" value="false"><label for="pw-no">No</label></div>
    <div data-automation-id="formField-legalName--firstName"><label>Given Name(s)*</label><input type="text"></div>
    <div data-automation-id="formField-legalName--lastName"><label>Family Name*</label><input type="text"></div>
    <div data-automation-id="formField-city"><label>City</label><input type="text"></div>
    <div data-automation-id="formField-postalCode"><label>Postal Code</label><input type="text"></div>
    <div data-automation-id="formField-phoneNumber"><label>Phone Number*</label><input type="text"></div>
    <button data-automation-id="pageFooterNextButton">Save and Continue</button>`;
  Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }] as unknown as DOMRectList; };
  // The source dropdown opens a listbox of options on click; picking one sets the button text.
  document.getElementById('src')!.addEventListener('click', () => {
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    for (const t of ['Glassdoor', 'Indeed', 'LinkedIn']) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = t;
      li.addEventListener('click', () => { document.getElementById('src')!.textContent = t; list.remove(); });
      list.append(li);
    }
    document.body.append(list);
  });
  document.querySelector('[data-automation-id="pageFooterNextButton"]')!.addEventListener('click', () => {
    document.querySelector('[data-automation-id="progressBarActiveStep"]')!.textContent = 'current step 2 of 6 My Experience';
  });
}

const send = (msg: Record<string, unknown>) => new Promise<Record<string, unknown>>((res) => { handleWorkdayMessage(msg as never, (r) => res(r as Record<string, unknown>)); });

describe('the Workday applier on the page', () => {
  it('reads the step, fills My Information from the plan, and moves on', async () => {
    myInformationPage();
    expect(wdState()).toMatchObject({ page: 'step', step: 'My Information' });
    const plan: WorkdayPlan = buildWorkdayPlan(PROFILE, null);
    const r = await send({ type: 'WD_FILL_STEP', plan }) as { filled: string[]; failed: string[] };
    expect(r.failed).toEqual([]);
    expect(document.getElementById('src')!.textContent).toBe('LinkedIn');
    expect((document.getElementById('pw-no') as HTMLInputElement).checked).toBe(true);
    const value = (name: string) => (document.querySelector(`[data-automation-id="formField-${name}"] input`) as HTMLInputElement).value;
    expect([value('legalName--firstName'), value('legalName--lastName'), value('city'), value('postalCode'), value('phoneNumber')])
      .toEqual(['Mahendra', 'Yadav', 'Bangalore', '560029', '6264252896']);
    const moved = await send({ type: 'WD_NEXT' }) as { moved: boolean; step: string };
    expect(moved).toMatchObject({ moved: true, step: 'My Experience' });
  });

  it('uses the search box when "How did you hear" is a prompt, and names required fields still empty', async () => {
    document.body.innerHTML = `
      <div data-automation-id="progressBarActiveStep">My Information</div>
      <div data-automation-id="formField-source"><label>How Did You Hear About Us?*</label>
        <div data-automation-id="multiselectInputContainer"><input type="text" id="srcq"></div></div>
      <div data-automation-id="formField-phoneType"><label>Phone Device Type*</label><button aria-haspopup="listbox">Select One</button></div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>`;
    Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }] as unknown as DOMRectList; };
    // GSK-style prompt: Enter shows results; clicking one adds a selected chip.
    document.getElementById('srcq')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      const list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      for (const t of ['Indeed', 'LinkedIn']) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.textContent = t;
        o.addEventListener('click', () => {
          const chip = document.createElement('div');
          chip.setAttribute('data-automation-id', 'selectedItem');
          chip.textContent = t;
          document.querySelector('[data-automation-id="formField-source"]')!.append(chip);
          list.remove();
        });
        list.append(o);
      }
      document.body.append(list);
    });
    const r = await send({ type: 'WD_FILL_STEP', plan: { ...buildWorkdayPlan(PROFILE, null), phoneDevice: ['Nope'] } }) as { filled: string[]; failed: string[] };
    expect(r.filled).toContain('How did you hear');
    expect(document.querySelector('[data-automation-id="selectedItem"]')!.textContent).toBe('LinkedIn');
    expect(r.failed).toContain('Phone device');
    const moved = await send({ type: 'WD_NEXT' }) as { moved: boolean; empty: string[] };
    expect(moved.moved).toBe(false);
    expect(moved.empty).toEqual(['Phone Device Type']);
  }, 20_000);

  it('fills a GSK-style page: zero-size wrappers, unwrapped radios and a search box for the source', async () => {
    document.body.innerHTML = `
      <div data-automation-id="progressBarActiveStep">current step 1 of 5 My Information</div>
      <label for="source--source">How Did You Hear About Us?*</label>
      <div data-automation-id="multiselectInputContainer"><input type="text" id="source--source"></div>
      <div class="q"><legend>Have you worked for Haleon in the past?*</legend>
        <input type="radio" id="r1" name="candidateIsPreviousWorker" value="true"><label for="r1">Yes</label>
        <input type="radio" id="r2" name="candidateIsPreviousWorker" value="false"><label for="r2">No</label></div>
      <div data-automation-id="formField-phoneNumber" class="wrap"><label for="phoneNumber--phoneNumber">Phone Number*</label>
        <input type="text" id="phoneNumber--phoneNumber" name="phoneNumber"></div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>`;
    // Wrappers have no box of their own; their controls do.
    Element.prototype.getClientRects = function (this: Element) {
      return (/^(INPUT|BUTTON|LABEL|LEGEND|LI|DIV)$/.test(this.tagName) && !this.classList.contains('wrap') && this.getAttribute('data-automation-id') !== 'formField-phoneNumber'
        ? [{ width: 1, height: 1 }] : []) as unknown as DOMRectList;
    };
    document.getElementById('source--source')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      const o = document.createElement('div');
      o.setAttribute('role', 'option');
      o.textContent = 'LinkedIn';
      o.addEventListener('click', () => { const c = document.createElement('div'); c.setAttribute('data-automation-id', 'selectedItem'); c.textContent = 'LinkedIn'; document.getElementById('source--source')!.parentElement!.append(c); o.remove(); });
      document.body.append(o);
    });
    const r = await send({ type: 'WD_FILL_STEP', plan: buildWorkdayPlan(PROFILE, null) }) as { filled: string[]; failed: string[] };
    expect(r.filled).toEqual(expect.arrayContaining(['How did you hear', 'Previous worker', 'Phone number']));
    expect((document.getElementById('r2') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('phoneNumber--phoneNumber') as HTMLInputElement).value).toBe('6264252896');
    expect(document.querySelector('[data-automation-id="selectedItem"]')!.textContent).toBe('LinkedIn');
  }, 20_000);

  it('queues Workday dates for real typing (scripted values are ignored there) and focuses them on request', async () => {
    document.body.innerHTML = `
      <div data-automation-id="progressBarActiveStep">My Experience</div>
      <h3>Work Experience</h3>
      <div data-automation-id="formField-jobTitle"><label>Job Title*</label><input type="text"></div>
      <div data-automation-id="formField-companyName"><label>Company*</label><input type="text"></div>
      <div data-automation-id="formField-startDate"><label>From*</label><div data-automation-id="dateInputWrapper">
        <input data-automation-id="dateSectionMonth-input"><input data-automation-id="dateSectionYear-input"></div></div>
      <div data-automation-id="formField-endDate"><label>To*</label><div data-automation-id="dateInputWrapper">
        <input data-automation-id="dateSectionMonth-input"><input data-automation-id="dateSectionYear-input"></div></div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>`;
    Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }] as unknown as DOMRectList; };
    const plan = { ...buildWorkdayPlan(PROFILE, null), jobs: buildWorkdayPlan(PROFILE, null).jobs.slice(0, 1), education: [], languages: [], skills: [], websites: [] };
    const r = await send({ type: 'WD_FILL_STEP', plan }) as { typing: Array<{ id: string; text: string }> };
    expect(r.typing.map((t) => t.text)).toEqual(['042026', '072026']);
    const f = await send({ type: 'WD_FOCUS', id: r.typing[0]!.id }) as { focused: boolean };
    expect(f.focused).toBe(true);
    expect(document.activeElement?.getAttribute('data-automation-id')).toBe('dateSectionMonth-input');
  }, 20_000);

  it('fills an Allstate-style My Information: Address Line 2, State dropdown, phone box after the code search', async () => {
    document.body.innerHTML = `
      <div data-automation-id="progressBarActiveStep">My Information</div>
      <div data-automation-id="formField-addressLine2"><label>Address Line 2*</label><input type="text"></div>
      <div data-automation-id="formField-countryRegion"><label>State*</label><button aria-haspopup="listbox" id="st">Select One</button></div>
      <div data-automation-id="formField-phoneNumber"><label>Phone Number*</label>
        <div data-automation-id="multiselectInputContainer"><input type="text" id="phoneNumber--countryPhoneCode"></div>
        <input type="text" id="phoneNumber--phoneNumber" name="phoneNumber"></div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>`;
    Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }] as unknown as DOMRectList; };
    document.getElementById('st')!.addEventListener('click', () => {
      for (const t of ['Kerala', 'Karnataka']) {
        const o = document.createElement('div'); o.setAttribute('role', 'option'); o.textContent = t;
        o.addEventListener('click', () => { document.getElementById('st')!.textContent = t; document.querySelectorAll('[role=option]').forEach((x) => x.remove()); });
        document.body.append(o);
      }
    });
    await send({ type: 'WD_FILL_STEP', plan: buildWorkdayPlan(PROFILE, null) });
    expect((document.querySelector('[data-automation-id="formField-addressLine2"] input') as HTMLInputElement).value).toBe('Bangalore');
    expect(document.getElementById('st')!.textContent).toBe('Karnataka');
    expect((document.getElementById('phoneNumber--phoneNumber') as HTMLInputElement).value).toBe('6264252896');
    expect((document.getElementById('phoneNumber--countryPhoneCode') as HTMLInputElement).value).not.toBe('6264252896');
  }, 30_000);

  it('sees a sign-in page', () => {
    document.body.innerHTML = '<input type="email"><input type="password"><button data-automation-id="createAccountSubmitButton">Create Account</button>';
    expect(wdState().page).toBe('signIn');
  });
});

describe('choosing the applier before applying', () => {
  function deps(url: string, sent: string[]): FlowDeps {
    return {
      frames: async () => [0],
      send: async (_f, msg) => {
        sent.push(String(msg.type));
        if (msg.type === 'WD_STATE') return { ok: true, page: 'signIn', step: '', errors: [] } as never;
        if (msg.type === 'EXTRACT_FORM') return { ok: true, data: { url, title: '', page_text: '', fields: [] } } as never;
        if (msg.type === 'FIND_APPLY') return { ok: true, found: false } as never;
        return { ok: true } as never;
      },
      sleep: async () => undefined, now: () => 0, profile: PROFILE, resume: null, memory: {}, bank: [],
      generate: async () => [], saveMemory: async () => undefined, mayClick: async () => null,
      currentUrl: async () => url, workdayPlan: buildWorkdayPlan(PROFILE, null),
    };
  }

  it('uses the Workday applier on myworkdayjobs.com (here it stops at the sign-in page for the Sign in once list)', async () => {
    const sent: string[] = [];
    const r = await runAiApply(deps('https://amadeus.wd502.myworkdayjobs.com/en-US/jobs/job/x/apply', sent), { mode: 'submit', job: { title: '', company: '', url: '' }, settleMs: 0 });
    expect(sent[0]).toBe('WD_STATE');
    expect(r.result).toBe('needs_me');
    expect(r.reason).toMatch(/^amadeus\.wd502\.myworkdayjobs\.com wants you to sign in/);
  });

  it('applies generally anywhere else', async () => {
    const sent: string[] = [];
    await runAiApply(deps('https://job-boards.greenhouse.io/x/jobs/1', sent), { mode: 'submit', job: { title: '', company: '', url: '' }, settleMs: 0 });
    expect(sent).not.toContain('WD_STATE');
  });
});

describe('when you fix a field Workday rejected', () => {
  it('waits, then continues with the remaining steps instead of giving up', async () => {
    let fixed = false;
    let nexts = 0;
    const sent: string[] = [];
    let clock = 0;
    const deps = {
      frames: async () => [0],
      send: async (_f: number, msg: Record<string, unknown>) => {
        sent.push(String(msg.type));
        switch (msg.type) {
          case 'WD_STATE':
            if (!fixed && sent.filter((t) => t === 'WD_STATE').length >= 3) fixed = true; // you fixed State meanwhile
            return { ok: true, page: 'step', step: 'My Information', errors: [], empty: fixed ? [] : ['State'] };
          case 'WD_FILL_STEP': return { ok: true, filled: ['Given name'], failed: [], typing: [] };
          case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://x.wd5.myworkdayjobs.com/a', title: '', page_text: '', fields: [] } };
          case 'WD_NEXT':
            nexts += 1;
            return nexts <= 2
              ? { ok: true, moved: false, page: 'step', step: 'My Information', errors: ['Error-State The field State is required'], empty: ['State'] }
              : { ok: true, moved: true, page: 'review', step: 'Review', errors: [] };
          default: return { ok: true };
        }
      },
      sleep: async (ms: number) => { clock += ms; }, now: () => clock,
      profile: PROFILE, resume: null, memory: {}, bank: [], generate: async () => [], saveMemory: async () => undefined, mayClick: async () => null,
    } as unknown as FlowDeps;
    const { runWorkdayApply } = await import('../src/shared/ats/workday-flow');
    const r = await runWorkdayApply(deps, 'fill', buildWorkdayPlan(PROFILE, null), 'https://x.wd5.myworkdayjobs.com/a');
    expect(r.result).toBe('ready');
    expect(nexts).toBe(3);
  });
});

describe('a press that reloads the page, then the account page (Cisco, 2026-11-06)', () => {
  const run = async (account: { email: string; password: string } | null, realClickNeeded = false) => {
    const clicks: Array<[number, number]> = [];
    let started = false;
    let signedIn = false;
    let stateReads = 0;
    const sent: Array<Record<string, unknown>> = [];
    let clock = 0;
    const deps = {
      frames: async () => [0],
      send: async (_f: number, msg: Record<string, unknown>) => {
        sent.push(msg);
        switch (msg.type) {
          case 'WD_STATE':
            stateReads += 1;
            return !started ? { ok: true, page: 'chooser', step: '', errors: [] }
              // Right after the reload the page is blank for a moment.
              : stateReads < 5 ? { ok: true, page: 'unknown', step: '', errors: [] }
              : !signedIn ? { ok: true, page: 'signIn', step: '', errors: [] }
                : { ok: true, page: 'review', step: 'Review', errors: [] };
          // Apply Manually reloads the page: the answer never comes back.
          case 'WD_START':
            started = true;
            throw new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received');
          case 'ACCOUNT_STEP':
            // Workday ignores the scripted press: nothing happens, the button's place comes back.
            if (realClickNeeded) return { ok: false, page: 'signup', outcome: 'no_effect', point: { x: 380, y: 497 } };
            signedIn = true;
            return { ok: true, page: 'signup', outcome: 'in' };
          case 'ACCOUNT_AFTER':
            signedIn = clicks.length > 0;
            return signedIn ? { ok: true, page: 'signup', outcome: 'in' } : { ok: false, page: 'signup', outcome: 'no_effect' };
          case 'EXTRACT_FORM': return { ok: true, data: { url: 'https://cisco.wd5.myworkdayjobs.com/a', title: '', page_text: '', fields: [] } };
          case 'PAGE_TEXT': return { ok: true, text: '' };
          default: return { ok: true };
        }
      },
      sleep: async (ms: number) => { clock += ms; }, now: () => clock,
      profile: PROFILE, resume: null, memory: {}, bank: [], generate: async () => [], saveMemory: async () => undefined, mayClick: async () => null,
      account,
      clickTrusted: async (x: number, y: number) => { clicks.push([x, y]); return true; },
    } as unknown as FlowDeps;
    const { runWorkdayApply } = await import('../src/shared/ats/workday-flow');
    const r = await runWorkdayApply(deps, 'fill', buildWorkdayPlan(PROFILE, null), 'https://cisco.wd5.myworkdayjobs.com/a');
    return { r, sent, clicks };
  };

  it('reads the new page instead of failing, then signs in or creates the account with your .env account', async () => {
    const { r, sent } = await run({ email: 'test@example.com', password: 'test-only' });
    expect(sent.filter((m) => m.type === 'ACCOUNT_STEP')).toHaveLength(1);
    expect(r.result).toBe('ready');
  });

  it('when Create Account ignores the scripted press, clicks it with a real mouse press and carries on', async () => {
    const { r, sent, clicks } = await run({ email: 'test@example.com', password: 'test-only' }, true);
    expect(clicks).toEqual([[380, 497]]);
    expect(sent.map((m) => m.type)).toContain('ACCOUNT_AFTER');
    expect(r.result).toBe('ready');
  });

  it('without an account in .env, stops at the account page for you', async () => {
    const { r } = await run(null);
    expect(r.result).toBe('needs_me');
    expect(r.reason).toMatch(/sign in or create an account/);
  });
});

describe('custom Workday questions (Allstate Application Questions)', () => {
  it('asks the AI with the real dropdown options for a question no rule covers, and selects the answer', async () => {
    document.body.innerHTML = `
      <div data-automation-id="progressBarActiveStep">Application Questions</div>
      <div data-automation-id="formField-q1"><label>Confirm if your skills, experience, &amp; location match the job description?*</label><button aria-haspopup="listbox" id="np">Select One</button></div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>`;
    Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }] as unknown as DOMRectList; };
    const np = document.getElementById('np')!;
    np.addEventListener('click', () => {
      if (document.querySelector('[role=listbox]')) { document.querySelector('[role=listbox]')!.remove(); return; }
      const list = document.createElement('div'); list.setAttribute('role', 'listbox');
      for (const t of ['Select One', 'Yes', 'No']) {
        const o = document.createElement('div'); o.setAttribute('role', 'option'); o.textContent = t;
        o.addEventListener('click', () => { np.textContent = t; list.remove(); });
        list.append(o);
      }
      document.body.append(list);
    });
    document.querySelector('[data-automation-id="pageFooterNextButton"]')!.addEventListener('click', () => {
      if (np.textContent !== 'Select One') document.querySelector('[data-automation-id="progressBarActiveStep"]')!.textContent = 'Review';
    });
    const asked: Array<{ label: string; options: string[] }> = [];
    let clock = 0;
    const deps = {
      frames: async () => [0],
      send: (_f: number, msg: Record<string, unknown>) => String(msg.type).startsWith('WD_')
        ? send(msg) : Promise.resolve({ ok: true, data: { url: 'https://x.wd5.myworkdayjobs.com/a', title: '', page_text: '', fields: [] } }),
      sleep: async (ms: number) => { clock += ms; await new Promise((r) => setTimeout(r, 0)); }, now: () => clock,
      profile: PROFILE, resume: null, memory: {}, bank: [], saveMemory: async () => undefined, mayClick: async () => null,
      generate: async (req: { fields: Array<{ id: string; label: string; options: string[] }> }) => req.fields.map((f) => {
        asked.push({ label: f.label, options: f.options });
        return { field_id: f.id, answer: 'Yes', confidence: 0.9, source: 'ai_generated', needs_user_input: false };
      }),
    } as unknown as FlowDeps;
    const { runWorkdayApply } = await import('../src/shared/ats/workday-flow');
    const r = await runWorkdayApply(deps, 'fill', buildWorkdayPlan(PROFILE, null), 'https://x.wd5.myworkdayjobs.com/a');
    expect(asked[0]).toEqual({ label: 'Confirm if your skills, experience, & location match the job description?', options: ['Yes', 'No'] });
    expect(np.textContent).toBe('Yes');
    expect(r.result).toBe('ready');
  }, 60_000);
});
