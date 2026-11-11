# Auto fixer: cause catalogue

## C1 Indeed expired job reported as "no application step found (unknown)"
- **Signature**: `Indeed: no application step found \((unknown|job)\)`
- **Root cause**: an expired Indeed posting has no Apply button, only an alert "This job has expired on Indeed"; `inState()` returned `unknown` and the flow waited 40 s, then asked the person.
- **Fix**: `src/content/ats/indeed.ts` (inState: `closed` page), `src/shared/ats/indeed-flow.ts` (report `closed` → skipped). Commit "auto-fixer: C1 C2" (2026-11-11).
- **Test**: `tests/indeed-applier.test.ts` (fails before: page was `unknown`, result `needs_me`).
- **Status**: fixed (verified live on jk=fddbd84641b96aed and jk=53949a43a0d8b6a3: both show the expired alert).
- **Seen**: 6, 2026-11-11.

## C2 Apply buttons on other jobs' cards hide the posting's own Apply
- **Signature**: `no application form or Apply button found`
- **Root cause**: foundit job pages list similar jobs (`jobCard__actions`) with "Quick Apply" / "Apply Now"; `pickClearApplyCandidate` saw a close rival and gave up, the AI fallback picked nothing.
- **Fix**: `src/shared/ai-apply/apply-button.ts` (`isOtherJobCard`, `ApplyCandidate.container`), `src/content/form-engine.ts` (`ancestorNames`).
- **Test**: `tests/apply-button.test.ts` "Apply controls on other jobs' cards".
- **Status**: fixed (live on foundit 69709714: the posting's "Apply Now" is now the clear winner; not pressed, as foundit applies in one click).
- **Seen**: 3 foundit + 1 iimjobs (iimjobs not reproduced), 2026-11-11.

## C3 LinkedIn stuck on a step with no labels ("80 Apply to <Company> | 0 notifications")
- **Signature**: `LinkedIn: stuck on "\d* ?Apply to .*\| \d+ notifications"`
- **Root cause**: unknown; the step state read the page's notification heading, so the dialog lookup may have matched the wrong container. Live repro blocked (no browser permission for linkedin.com this run).
- **Status**: watching.
- **Seen**: 2 (Orbit Verify, Magicbricks), 2026-11-11.

## C4 General flow answers a chat widget ("Type your message here") and finds no Next
- **Signature**: `page 1: no Next or Submit button`
- **Root cause**: a careers-site chat widget was read as the only form field (Naukri → Pixxel Space company site). Not reproduced.
- **Status**: watching.
- **Seen**: 2, 2026-11-11.

## C5 Workday step fill timed out
- **Signature**: `no answer from the page after 90 s \(WD_FILL_STEP\)`
- **Status**: watching (1, Caresource).

## C6 Not fixable by software
- Keka CAPTCHA before "Apply Now"; sign-in required (Deloitte USI, cambiumlearning Workday); Indeed question asking for a Loom video (CLANX); LinkedIn CGPA question (a fact only the person has; not in the profile).
- **Status**: not-fixable. Add CGPA to the profile to unblock that kind of question.
