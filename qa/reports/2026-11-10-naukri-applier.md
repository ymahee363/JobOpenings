# QA report: Naukri applier (2026-11-10)

Scope: the new dedicated Naukri applier (`src/content/ats/naukri.ts`, `src/shared/ats/naukri-flow.ts`), run live in
the user's signed-in Chrome (Claude in Chrome) on
https://www.naukri.com/job-listings-product-manager-azentio-software-bengaluru-7-to-10-years-101126006440,
'submit' mode, user's real profile, resume and saved answers (served once by qa-serve at a secret token path,
naukri.com origin only).

- NK_STATE before: `{page:'job'}` (Easy Apply, signed in, not applied).
- **Applied.** Apply was one click (no recruiter questions): Naukri opened /myapply/saveApply with
  `multiApplyResp {"101126006440":200}` and the page reads 'Applied to "Product Manager"'.
- The chatbot path (questions, Save after each, the confirmation page ending the reply) is covered by
  `tests/naukri-applier.test.ts`, not yet live: this job asked nothing.
- Fill/preview mode never presses Apply (Naukri has no review step: Apply or the last Save sends the application).

## Live chatbot run: EPAM Product Manager (job 261026030203)

- Apply opened the chatbot with one question, "What is your Notice Period?" (8 radio choices). The applier ticked
  "Available now" (notice 0), waited 30 s for review (new: wait before every Save), pressed Save.
- **Applied**: /myapply/saveApply with `multiApplyResp {"261026030203":200}`. The chatbot path now works live.
