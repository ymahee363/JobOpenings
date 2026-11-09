# QA learnings

What each QA run learned about the sites and application forms. Read before testing; update after.

## Open issues

- Re-check after each build: AI apply on Naukri must not treat the passing "Email ID" box at page load as the form
  (fixed 2026-11-04 in `flow.ts` step 0, "let the page settle").
- Re-check: iimjobs one-click apply through AI apply must end "applied", not "no application form" (fixed
  2026-11-04: `appliedButtonShown()` in `form-engine.ts`, and the post-Apply poll in `flow.ts`).

## Resolved

- 2026-11-04: Naukri, Instahyre and Wellfound apply reports were dropped by the service worker (only iimjobs was
  accepted), so every one-click apply there ended "no report from the job page".
- 2026-11-04: Naukri's job search bar (`#ni-gnb-searchbar`, a plain div) was read as an application form, so AI
  apply skipped the Apply button. Now excluded by `SITE_CHROME_SELECTOR`.
- 2026-11-04: Naukri's chatbot questions were invisible to the form engine (contenteditable answer box). Now handled
  by `src/content/naukri-chat.ts`.

## Sites

### Naukri

- Job page: `/job-listings-<slug>-<id>`; `/job-listings-<id>` also works. Easy Apply: `button#apply-button`
  ("Apply"). Applied: `#already-applied`. Company site: `#company-site-button` ("Apply on company site").
- No CSP header: the engine server fetch works.
- At load, for under 0.5 s, the page shows an "Email ID" field and no Apply button. Sample a few times before judging.
- Apply opens a chatbot drawer `.chatbot_Drawer`: greeting first ("thank you for showing interest…"), then one
  question at a time in `.botMsg`; answer in `div.textArea[contenteditable=true]`; send with `div.sendMsg` ("Save"),
  whose parent loses class `disabled` once text is typed (execCommand insertText works). Choice questions show
  Yes/No options (read as radio).
- After the last answer Naukri navigates to `/myapply/saveApply?...` titled "Apply Confirmation", text
  'Applied to "<title>"'. Jobs with no questions go there straight from Apply.

### iimjobs

- Job page `/j/<id>` or `/j/<slug>-<id>`. Apply `button[data-track="apply-job"]`; after a one-click apply the same
  button reads "Applied" (disabled). Applies in one click for many jobs, with no form.
- CSP blocks fetching the engine from localhost: test with DOM reads.

### Instahyre

- Job page `/job-<id>-<slug>`. Success is a toast "Application sent to <company>" (see `job-page.ts`).

### Wellfound

- `/jobs/<id>-<slug>`; `button[class*="applyButton"]`. Applied state not yet seen.

### Indeed / Cutshort / foundit

- No one-click applier: AI apply only.

### LinkedIn

- AI apply only (Easy Apply modal, sometimes in an iframe). Never press Easy Apply during QA.

## Application forms (company sites / ATS)

- Greenhouse (Discord): 18 dropdowns; extraction takes about 7 s in happy-dom because each dropdown is opened to read
  its options (golden test timeout is 30 s).

### Oracle Candidate Experience (e.g. American Express, `*.fa.*.oraclecloud.com/hcmUI/CandidateExperience/...`)

- Seen 2026-11-05. A closed side menu `div.app-menu[role=dialog]` with `visibility: hidden` stays laid out on every
  page; it used to be taken for an open dialog and hid "Apply Now" (fixed: `isHiddenShell`).
- "Apply Now" opens `/apply/email`: Email Address, "I agree with the terms and conditions" checkbox, a Terms popup
  (Close / Agree), then Next. A hidden honeypot `input#honey-pot-1` must never be filled (fixed: `isHoneypot`).
  The terms link's label leaks Knockout code "ko if: showError /ko" (now dropped).
- After Next, Oracle emails a one-time verification code: AI apply stops there as "Needs me" until you enter it.

### Workday (e.g. GSK, `*.myworkdayjobs.com`)

- Seen 2026-11-05. Job page Apply is `a[data-automation-id="adventureButton"]`; it opens a "Start Your
  Application" dialog: Autofill with Resume / Apply Manually (`applyManually`) / Use My Last Application. The engine
  now presses Apply Manually, and the flow allows up to 3 Apply presses in a row.
- Apply Manually leads to Create Account / Sign In (per company tenant). AI apply stops there as "Needs me" until
  you sign in once in this browser; later runs go straight to the form. Hidden bot trap `input[data-automation-id=
  beecatcher]` is skipped.
- CSP: fetching the engine from localhost hangs (45 s CDP timeout); use DOM reads in QA.

### Greenhouse (job-boards.greenhouse.io, e.g. BitGo)

- Seen 2026-11-05. The form is server-rendered on the job page (17 fields on BitGo: name, email, country and city
  pickers, phone, resume, degree + years, LinkedIn, website, 5 react-select questions). Options load only when a
  dropdown is opened. CSP blocks loading the engine from localhost, and a proxied copy does not hydrate
  ("Application Error"): test extraction offline (curl the page, run the engine in happy-dom) instead.
- Open issue: a live BitGo run filled 17/17 and stopped at "Pressing Submit" with no outcome (a call into the tab
  never answered). Calls now time out (service worker `withTimeout`); re-check what Greenhouse shows after Submit.
- reCAPTCHA's hidden `g-recaptcha-response` box was read as a required "Captcha" question; now skipped.
- 2026-11-05 (Amadeus, wd502): typed values that never lose focus are NOT committed. Four "Work Experience" blocks
  showed on screen but only the last was saved (Review showed one job, descriptions "No Response"). Press Tab / blur
  after every field before "Add Another" or "Save and Continue". Check the Review page, not the form, to confirm.
  "Back" on a step with unsaved changes opens "Discard Application?" — choose Continue, never Discard.
- Workday date fields: month+year typed as MMYYYY into dateSectionMonth-input. Degree list: "Bachelor Degree or
  equivalent"; Field of Study search has "Civil Engineering"; School search "Guwahati" finds IIT Guwahati.

### Workday, new UI (GSK/Haleon gsknch.wd3, 2026-11-05) — applied end to end to Review with the Workday applier
- formField-* wrappers have no box (getClientRects 0): check visibility on the controls inside, not the wrapper.
- Some controls have no formField wrapper: "How did you hear" = input#source--source (search prompt, value + Enter
  selects "LinkedIn"); "Have you worked for X in the past?" = radios name=candidateIsPreviousWorker.
- The step title renders before the form: wait for formField-* to appear and settle before filling.
- Date boxes (dateSectionMonth/Day/Year-input) commit ONLY real keystrokes: scripted value, execCommand insertText
  and synthetic key events all leave "Invalid Date: 04/". The agent types them via chrome.debugger (debugger
  permission), e.g. "042026" into the month box (auto-advances to year), then Tab.
- Languages need Overall + Reading + Speaking + Writing; levels are Beginner / Intermediate / Fluent (no Advanced).
- Application Questions (Haleon): legally eligible Yes; sponsorship No; government official No; close links No;
  other opportunities Yes; accuracy acknowledgement Yes. Voluntary Disclosures: gender, Date of Birth (MM/DD/YYYY),
  privacy notice checkbox. No Education section on this tenant.
- "<file> successfully uploaded" appears as role=alert: not an error.

### Workday: Allstate (allstate.wd5, via Indeed → allstate.jobs → Workday), 2026-11-06
- Two new-tab hops (Indeed → careers page → Workday); the agent must follow tabs opened by the CURRENT tab only.
- My Information requires Address Line 2 and State (formField-countryRegion dropdown) — GSK does not.
- formField-phoneNumber contains the country-code search box before the number box: target input[name=phoneNumber].
- Fields now filled by label meaning (fillBySemantics) and a retry pass runs after Workday errors.
