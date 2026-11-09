# Build plan: iimjobs Auto-Apply Agent

Implements [PRD-auto-apply.md](PRD-auto-apply.md) in 5 steps. Each step ends with `npm run check` green
(typecheck + tests + build) and leaves the extension shippable: the agent is **off by default** and **dry run is
on by default**, so no step can apply to a real job until I turn both switches myself.

| # | Step | Delivers (PRD IDs) | Exit gate | Estimate |
| --- | --- | --- | --- | --- |
| 1 | **Discovery (M0)** | Read-only look at a live iimjobs job page in my Chrome: Apply button, applied and closed states, page markers. Saved as an anonymised HTML fixture. No Apply click | Selectors and states written into `src/shared/auto-apply/iimjobs-page.ts` with a fixture test; unknowns listed in the PRD | 0.5 day |
| 2 | **Rules engine** | AR-1, AR-2, answer bank (section 7), queue order (AR-3), caps and pacing (AR-7), per-company cap (AR-16) as pure functions | Unit tests for every acceptance case in PRD 6 that does not need a browser | 1 day |
| 3 | **Data and audit** | Dexie v3: `attempts` table (AR-11), `appliedBy` on statuses; settings `autoApply` (off) and `dryRun` (on), rules, answer bank; CSV export; retention 180 days | Repo tests: attempts round-trip, crash recovery query (AR-14 / edge case), retention, v2 to v3 upgrade keeps data | 0.5 day |
| 4 | **Agent runtime** | Applier content script (AR-4 to AR-6, fail closed), scheduler in the service worker (AR-7 to AR-10, AR-14, AR-15), shared halt with refreshes, kill switch, at most one agent tab, never while a refresh runs | Applier tests against fixtures (apply found, applied, closed, questions, unknown question, captcha); runner tests with fake clock and fake tabs; message validation tests | 2 days |
| 5 | **Board UI and docs** | Header toggle and status (AR-9), Agent panel: Queue, Needs me (AR-13), Log + CSV (AR-11), daily summary (AR-12), rules and answer bank editor; README, PRD and PRD-auto-apply updated | `npm run check` green; build loads in Chrome; dry-run smoke test | 1 day |

## Design rules for every step

- **Fail closed.** Any page the applier does not recognise ends the attempt with no click. Unknown question, no
  submit. Three "Apply button not found" in a row halt the agent ("Agent needs update").
- **One selector file.** Every iimjobs DOM selector and text pattern lives in `iimjobs-page.ts`, tested against
  saved HTML, so a site change touches one file.
- **Pure core, thin shell.** Matching, answers, pacing and outcome classification are pure and unit-tested; the
  content script and service worker only wire them to Chrome.
- **Shared safety.** The agent uses `safety.ts`: a captcha from a refresh or an apply halts both; Resume restarts
  both. Agent page opens count toward the iimjobs hourly refresh gap and vice versa.
- **Trust boundary.** The applier acts only on a `apply-run` message from the service worker, only in a tab the
  agent opened itself (tab ID kept by the scheduler), and only on `https://www.iimjobs.com/`. Its replies are
  zod-validated and checked against the sender's tab and URL, like collector messages. A page can never start an
  apply.
- **Testable runtime.** The scheduler is a pure `decideNext()` plus a small runner that takes its Chrome calls
  (open tab, send message, wait, clock) as injected dependencies, as `runSources` already does for refresh.
- **Observability.** Every attempt and every skip reason goes to the `attempts` table and the activity log; the
  header shows today's count, next run and halt reason.
- **No live apply during the build.** I never press Apply on a real job while building. Turning live mode on is
  my decision, after at least one day of dry-run results.

## Rollback

`autoApply: false` stops the agent at once with no rebuild. The Dexie v3 migration only adds a table and a field,
so older builds still read the database.

## Risks to the plan

| Risk | Mitigation |
| --- | --- |
| The apply dialog (questions, resume picker) can't be seen without applying | Step 4 treats any dialog it can't fully map as **Needs me**. The first live applies (my call) record the dialog HTML into the log so the selector file can be extended |
| iimjobs terms forbid automation | Checked in step 1; if they do, live mode stays off and I decide |
| Service worker is stopped mid-apply | The attempt is persisted before the click; on start-up, unfinished attempts are re-checked (AR-14 edge case) |
