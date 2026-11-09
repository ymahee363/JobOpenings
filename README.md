# Naukri Fast-Apply Board

A personal Chrome extension that lists the openings Naukri recommends to you, plus a saved
[product manager search](https://www.naukri.com/product-manager-jobs?k=%22product%20manager%22&nignbevent_src=jobsearchDeskGNB&jobAge=30&functionAreaIdGid=10&experience=6&cityTypeGid=97),
your [Indeed "Jobs for you"](https://in.indeed.com/?from=gnav-homepage--homepage-frontend) list,
the first page of your Instahyre saved search "PM BLR WFH", and the first page of
[Wellfound jobs](https://wellfound.com/jobs) with your saved filters, the
[Cutshort jobs matching your profile](https://cutshort.io/profile/all-jobs?matchesfor=621ce92d9b95180034a9b0e4),
a [foundit search](https://www.foundit.in/search/product-manager-jobs-in-bengaluru-bangalore?start=1&limit=20&query=product+manager&location=bengaluru+%2F+bangalore&queryDerived=true&jobFreshness=3)
(product manager, Bengaluru, last 3 days, up to 5 pages), an [iimjobs AI search](https://www.iimjobs.com/ai-search?query=product-manager)
(product manager, no experience filter), and the LinkedIn jobs you look at yourself,
**newest first**, split into **Easy Apply** (apply on Naukri, Instahyre or Wellfound, or Indeed Apply) and **Company Site** (apply
on the employer's site) tabs. The **Sites** checkboxes show any mix of sites at once (none ticked, or **All**, shows every site). Everything stays in your browser. See [PRD.md](PRD.md) for the product spec.

## Install

```powershell
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `dist` folder.
3. Log in to Naukri in the same Chrome profile and open
   [your recommended jobs](https://www.naukri.com/mnjuser/recommendedjobs) once.
4. Click the extension's toolbar icon to open the board.

After pulling changes, run `npm run build` and click the reload icon on the extension card.

## Adding links to search from

Open the board's **Sources** panel and paste a link into **Link**, with an optional name and page count, then
**Add link**. You can also turn links off, rename them, reorder them or remove them there. Changes apply from the
next refresh, with no rebuild. **Reset to sources.json defaults** throws your list away.

The defaults live in [`sources.json`](sources.json): Naukri recommended jobs, the Naukri product manager search (up to
10 pages), the Indeed homepage, the Instahyre "PM BLR WFH" saved search and Wellfound jobs. They are used until you first edit the list in the panel. To change the defaults,
add an entry there:

```json
{ "name": "Indeed: product manager, Bengaluru", "url": "https://in.indeed.com/jobs?q=product+manager&l=Bengaluru", "maxPages": 3 }
```

- Links must be on `www.naukri.com`, `in.indeed.com`, `www.instahyre.com`, `wellfound.com`, `cutshort.io`, `www.foundit.in` or `www.iimjobs.com`.
- `https://wellfound.com/jobs` opens with the filters you last set on Wellfound (role, location, job type), so
  change the search there. Only the first page of results is read.
- Instahyre ignores the filters in a pasted search link and shows your recommended jobs instead. So an Instahyre
  entry opens the opportunities page and clicks one of your saved searches, named in `savedSearch` as it appears
  under **Saved Searches** on Instahyre (case does not matter). Only the first page of results is read:
  ```json
  { "name": "Instahyre: PM Blr WFH", "url": "https://www.instahyre.com/candidate/opportunities/?matching=true", "savedSearch": "PM BLR WFH" }
  ```
  In the Sources panel, fill in **Saved search** when adding an Instahyre link.
- `maxPages` (default 1) is how many result pages to load; later pages load only while the previous one found new jobs.
- Search links are sorted newest first (Naukri `sort=f`, Indeed `sort=date`) unless the link already sets a sort.
  foundit searches are paged with `start=1, 2, …` and kept recent by their own `jobFreshness` filter.
- `"enabled": false` skips a link without deleting it.
- One refresh opens at most 40 pages in total.

Then run `npm run build` and reload the extension. `npm test` checks the file; bad entries are skipped and named in
the board's Log panel.

## Using it

| Action | How |
| --- | --- |
| Apply (Easy Apply tab) | **Apply** or Enter: opens the Naukri job page. The job becomes Applied when Naukri shows "Applied", or after you answer **Yes** on the board |
| Apply (Company Site tab) | **Open site**: opens the employer's page in a new tab; confirm with **Yes** or **Mark applied** |
| Dismiss | **Dismiss** or `d`, with 5-second Undo (`u`) |
| Hide by title | **Settings → Hide jobs whose title has these words** (default: Designer, Engineer). Whole words, any case, plurals included; hidden jobs stay saved and the Applied tab shows everything |
| Move / search / tabs | `j` / `k`, `/`, `1`–`4` |
| Refresh | **Refresh** opens each link in your Sources list in a background tab, one after another, each for 2+ minutes. At most once every 15 minutes |

Jobs also arrive whenever you browse Naukri yourself; that never counts against the limit.

## How it works

| Part | File | Job |
| --- | --- | --- |
| Hook | `src/content/main-hook.ts` | Runs in the page; copies `jobapi/v*/search/recom-jobs` and `jobapi/v3/search?...` (job search) responses the page already loads |
| Collector | `src/content/collector.ts` | Relays hook captures, reads Naukri's cached feeds (`srp_simjobs_reco_wdgt_*` in localStorage), reports logged-out or captcha pages, watches job pages for "Applied" |
| Service worker | `src/background/service-worker.ts` | Validates and parses captures, stores them, runs refreshes and safety pauses |
| Parser | `src/shared/parse.ts`, `src/shared/parse-indeed.ts`, `src/shared/parse-instahyre.ts`, `src/shared/parse-wellfound.ts` | zod-validated mapping from each site's job fields to ours |
| Sources | `src/shared/sources.ts`, `src/shared/refresh.ts`, `src/board/SourcesPanel.tsx` | The link list (sources.json or your edited copy), page URLs, and the refresh order and stop rules |
| Page helpers | `src/shared/page.ts` | Captcha / logged-out detection, feed names, Indeed's embedded job cards |
| Store | `src/db/` | IndexedDB (Dexie): `jobs`, `statuses` (your actions, never touched by refresh), `log` |
| Board | `src/board/` | React page with tabs, filters, stats, settings and backups |

**Indeed** (confirmed on in.indeed.com on 2026-10-23): the homepage embeds its job cards in
`window.mosaic.providerData["mosaic-provider-jobcards-*"]`, and scrolling loads more from `apis.indeed.com/graphql`
(the same model as a JSON string). `src/shared/parse-indeed.ts` maps `jobkey` → job ID `indeed-<jobkey>`,
`indeedApplyable` → apply type, `pubDate` → posted time, `extractedSalary` → LPA, and `appliedOrGreater` → marks
the job Applied. Indeed shows no experience range, so the experience filter lets Indeed jobs through.

**Instahyre** (confirmed on www.instahyre.com on 2026-10-26): opening a search link directly redirects to
`/candidate/opportunities/?matching=true` (recommended jobs). Clicking a saved search (`.search-title` +
`.search-btn a` in the Saved Searches box) requests `/api/v1/job_search?...`, which returns
`{ meta, objects: [...] }` with 35 jobs (the page shows 30). `src/shared/parse-instahyre.ts` maps `id` → job ID
`instahyre-<id>`, `public_url` → job page, `keywords` → skills; feed `instahyre-search`. The response has no
posted date, experience or salary, so jobs are dated by when the board first saw them. Applying happens on
Instahyre, so they go in Easy Apply.

**LinkedIn** (confirmed on www.linkedin.com on 2026-10-26): the jobs search is server-rendered React
(`flagship-web`), so there is no job JSON to capture. The content script reads each card,
`[componentkey="job-card-component-ref-<jobId>"]`, as lines of text: title (screen-reader copy may prefix
"Selected, " or add " (Verified job)", then the title repeats), company, location, a hidden "Posted 4 hours ago",
and footer items such as "Applied" or "Easy Apply". `src/shared/parse-linkedin.ts` turns them into jobs
(`linkedin-<jobId>`, `/jobs/view/<jobId>/`); "Applied" marks the job Applied. No salary or experience is shown.

**iimjobs** (confirmed on www.iimjobs.com on 2026-10-26): `/ai-search?query=product-manager` loads
`gladiator.iimjobs.com/job/search?...&page=0` (`{ data: [...], limit: 50, totalJobs, hasMore }`). It first runs the
search with the experience range from your profile (`minexp=7&maxexp=10`) and then without it; captures with an
experience range are ignored, so no experience filter is applied. `src/shared/parse-iimjobs.ts` maps `id` → job ID
`iimjobs-<id>`, `createdTimeMs` → posted time, `min`/`max` → experience, `tags` → skills, `jobDetailUrl` → job page
and `applied` → marks the job Applied. Jobs with an off-site `applyUrl` (Lever, Turbohire, ...) go in **Company
Site**, the rest in **Easy Apply**.

**foundit** (confirmed on www.foundit.in on 2026-10-26): a `/search/...?start=<page>` page loads
`/home/api/searchResultsPage?start=<offset>&limit=20&...` (`{ data: [...], meta: { paging: { total } } }`).
`src/shared/parse-foundit.ts` maps `jobId` → job ID `foundit-<jobId>`, `postedAt` (ms) → posted time,
`minimumExperience`/`maximumExperience` → experience, salary `absoluteValue` (yearly ₹) → LPA unless hidden,
`skills[].text` → skills, `jdUrl` → job page and `isApplied` → marks the job Applied. Many listings are syndicated
from LinkedIn or company career sites: when `applyUrl` points off foundit the job goes in **Company Site** with that
link, otherwise **Easy Apply**. foundit runs Akamai bot detection, so keep its page count modest.

**Cutshort** (confirmed on cutshort.io on 2026-10-26): `/profile/all-jobs?matchesfor=<profile>` loads
`/findjobs/q?page=N&matchesfor=...` (`{ page, totalPages, total_count, page_size: 5, results }`), page 1 on load and
the next pages as the job column scrolls. Only that column scrolls, not the page, so the refresh's scrolling falls
back to the tallest scrollable element. `src/shared/parse-cutshort.ts` maps `_id` → job ID `cutshort-<_id>`,
`headline` → title, `expRange.minVanity`/`maxVanity` → experience, `salaryRangeText` → salary ("Best in industry"
means undisclosed), `hiringIntentShownOn` (else `creationDate`) → posted time, `publicUrl` → job page; feed
`cutshort-search`. The list is "recently active" jobs, so some were posted weeks ago: widen "Posted within" to see them.

**Wellfound** (confirmed on wellfound.com on 2026-10-26): `/jobs` applies your saved filters and loads results
with the `JobSearchResultsX` query to `/graphql` (nothing job-related is embedded in `__NEXT_DATA__`).
`data.talent.jobSearchResults.startups.edges[].node` is a company, or a promoted one under `promotedStartup`; each
lists its jobs in `highlightedJobListings`. The first page has about 10 companies and 14 jobs.
`src/shared/parse-wellfound.ts` maps `id` → job ID `wellfound-<id>`, `liveStartAt` (seconds) → posted time,
`compensation` → salary (₹ lakh ranges to LPA), `slug` → `/jobs/<id>-<slug>`, and `currentUserApplied` → marks the
job Applied; feed `wellfound-search`. Listings show "Apply on Wellfound", so they go in Easy Apply.

**Naukri field mapping** (confirmed on the live page on 2026-10-21): `companyApplyJob` → apply type,
`applyRedirectUrl` / `companyApplyUrl` → external link, `createdDate` (epoch ms) → posted time,
`footerPlaceholderLabel` → fallback when `createdDate` is missing, `placeholders[]` → experience, salary, location.

## Account safety

- No direct calls to any site's API: the extension only reads pages your browser loads.
  On Instahyre it clicks your saved search, as you would; that happens only in tabs the app opened.
- **Naukri** refreshes automatically at your interval plus a random 30 s to 15 min, a different delay every time,
  only between 9:00 and 22:00. A refresh that would fall at night moves to a random time between 9:00 and 9:30 the
  next morning. Each refresh sets the next one. At most once every 15 minutes.
- **Indeed**, **Instahyre**, **Wellfound**, **Cutshort**, **foundit** and **iimjobs** refresh automatically once a day at a random time between 9:00 and 22:00, and when
  you open the board (switch this off in Settings). Each at most once an hour.
- **Refresh** does every site, skipping any that is still inside its minimum gap. The board header shows when each
  site's next automatic refresh is due.
- Every page the app opens stays open for 2 minutes plus up to 90 random seconds, with a random 5 to 20 second gap
  before the next page. One refresh opens at most 15 pages.
- Once a page the app opened has loaded, it scrolls for 5 to 12 seconds in uneven steps, mostly down with an
  occasional step back up. Pages you open yourself are never scrolled.
- A captcha on any of the sites, even on a page you opened yourself, stops everything: the open tab closes, the next
  automatic refresh is cancelled, and nothing restarts until you press **Resume** on the board. You also get a
  desktop notification.
- A Naukri logout pauses Naukri refreshes for 1 hour; the other sites keep going. If an Instahyre saved
  search is not found (renamed or deleted), the Log panel says so.
- **LinkedIn is never opened or refreshed by the app**, on any timer or button. Its jobs are saved only when you
  open a LinkedIn jobs page yourself (for example your
  [product manager search](https://www.linkedin.com/jobs/search-results/?keywords=%22Product%20manager%22&f_TPR=r86400&f_AL=true)):
  the extension reads the job cards already on screen, and again as you scroll or change page. It sends no
  requests, clicks nothing and does not hook LinkedIn's network calls. LinkedIn links are refused in the Sources panel.
- It never applies for you, except the optional **iimjobs auto-apply** agent below, which is off until you turn it on.
- Personal use only; no data leaves your machine.

## Auto-apply on iimjobs, Instahyre, Naukri and Wellfound (optional)

Spec: [PRD-auto-apply.md](PRD-auto-apply.md); build plan: [PLAN-auto-apply.md](PLAN-auto-apply.md).

The **Agent** panel can apply to iimjobs jobs for you: only jobs that apply on iimjobs itself (Easy Apply) and
pass every rule you set (title phrases, excluded words, your years of experience, locations, salary floor, company
blocklist, posted within N days). It is **off** and in **dry run** until you change both.

1. Open **Agent**, set **My years of experience** (no job matches until you do) and check the other rules.
2. Add answers to the **Answer bank** (for example `notice period` → `30 days`, `expected ctc` → `55`).
3. Press **Start auto-apply** in the header. In dry run it opens each matching job page, checks it, and logs
   **Would apply** without clicking.
4. When the dry-run results look right, tick **Live applying** (it unlocks after the dry run has checked a job).

How it behaves:

- **Apply on:** tick **All platforms** or any of iimjobs, Instahyre and Naukri in the Agent panel (iimjobs only by
  default). On Naukri it presses only `Apply` (Easy Apply), never "Apply on company site"; Naukri's chatbot
  questions count as a form, so those jobs are left for you. Wellfound usually asks for a note to the company, so
  in one-click mode most Wellfound jobs end up under **Asked for details**.
- If it pressed Apply but could not confirm the result (even after reloading the page), it never presses Apply on
  that job again; the job is listed under **Pressed Apply, not confirmed** for you to check. Instahyre shows no
  experience range, so its jobs pass that rule; every other rule applies to both.
- **Platforms take turns:** the queue takes one job from each platform in round-robin order (2 Naukri, 1 Instahyre,
  3 iimjobs → Naukri, iimjobs, Instahyre, Naukri, iimjobs, iimjobs). **Seconds between two applications on the same
  platform** (default 300) is kept per platform; between different platforms the wait is that gap divided by the
  number of platforms queued (never under 10 s), plus up to 15% random. **Run now** skips the wait.
- One job page at a time, in a background tab, only inside your **Start at / Stop at**
  hours (default 9:00 to 22:00, up to midnight), at most 20 pages a day **per platform** (1 to 100 in the panel; dry run counts too; a platform that reaches it sits out
  until tomorrow while the others carry on). It never has a site's page open while a refresh has a page of that site open.
- Success is iimjobs' "Job Applied" page (`/job/applied?jobId=…`) or the button turning to "Applied"; on Instahyre the
  button turning to "Application sent!"; on Naukri "Applied" (`#already-applied`). Anything unclear after a click is checked by reloading the job page.
- It presses `Apply` on the job page and counts the job as applied only when the button turns to **Applied**.
- **One-click only by default:** if iimjobs opens anything that asks for details after Apply, the agent closes it
  without submitting and moves the job to the board's **Extra Details** tab (with the reason) and the Agent panel's
  **Asked for details** list; it stays on your board to apply yourself and the
  agent does not try it again. Ticking **Also fill in forms from the answer bank** lets it fill such forms, only from
  your stored answers and only when every required question has one. It never guesses and never uploads files.
- Right before every click it re-reads the switches: **Stop auto-apply** stops the very next click.
- A captcha stops everything (refreshes too) until **Resume**. A logout, or three pages in a row where it can't find
  the Apply button (iimjobs changed its page), stops only the agent until **Resume**.
- Every attempt is in the Agent panel's **Log** (exportable as CSV, kept 180 days), with the rules it matched and
  the answers it gave. Jobs it applied to show **Applied by agent**. Other sites are never auto-applied.

| Part | File |
| --- | --- |
| Rules, queue, answer bank, pacing, outcomes (pure, tested) | `src/shared/auto-apply/` |
| iimjobs selectors and page states (one file) | `src/shared/auto-apply/iimjobs-page.ts` |
| Applier in the job page | `src/content/applier-run.ts` (tested against a fake page), wired in `src/content/applier.ts`; runs only when the agent asks, in its own tab |
| Scheduler | `src/background/service-worker.ts` (auto-apply section) |
| Panel | `src/board/AgentPanel.tsx` |

## AI apply: any site, company career pages included (optional)

AI apply comes from job-apply-ai-mvp. It fills **any** application form for you: Greenhouse, Lever, Workday, a
company's own career page, or a job board's apply pop-up. It answers from your profile (seeded for
mahendra.iitg@gmail.com), the answer bank, answers it remembered from earlier forms, and an LLM.

**Setup (once)**

1. Start the AI backend (FastAPI; Gemini, with Groq as the fallback). The API keys stay in `backend/.env`, which git
   ignores:
   ```bat
   cd backend
   python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
   start-backend.bat
   ```
   It listens on `http://127.0.0.1:8000` and restarts itself if it exits. The job-apply-ai-mvp backend on port 8000 works
   too.
2. Open the board, go to **Profile**, check your details, upload your resume and paste its text. You can also import
   the profile from job-apply-ai-mvp with the steps shown there. Press **Test backend**.
3. In the **Agent** panel, press **Allow AI apply on all sites**. Chrome asks once, because AI apply has to read forms
   on sites the extension does not know in advance.

**Using it**

- **Apply with AI** on any job on the board, or paste any job or career-page URL into the Agent panel. It runs now, in
  a tab you can watch. It presses Apply, fills each page, attaches your resume, presses Next, and stops at the final
  Submit for you. Turn on **AI apply presses the final Submit** to let it submit too.
- **In auto-apply:** tick **Use AI apply in auto-apply**. The agent then also takes jobs that apply on a company site,
  Indeed, Cutshort and foundit jobs (sites with no one-click applier), and one-click jobs whose site asks for details.
  Dry run still clicks nothing: it only reads the form and logs the answers it would give. LinkedIn is never applied to
  on its own; use **Apply with AI** on a LinkedIn job yourself.
- **Where answers come from**, in order: what the page already holds, your profile (name, email, phone, CTC,
  experience entries and so on), the answer bank, remembered answers, then the LLM. The LLM is told to answer truthfully
  and never invent experience. What it answers is remembered, so the same question costs nothing next time. You can
  review and delete remembered answers in **Profile**.
- **It stops and leaves the job for you** ("Asked for details") when a required question has no truthful answer, the
  site wants a login or a new account, a captcha shows, the form rejects an answer twice, or Next does not move on.
  Answer the questions in the Agent panel: the answers go into the answer bank and the job goes back in the queue.
- A form filled and left for your Submit shows as **Filled by AI, waiting for your Submit**. Its tab stays open, and
  the agent never fills it again.

| Part | File |
| --- | --- |
| Form engine, ported from job-apply-ai-mvp (reads, fills, finds Apply/Next/Submit) | `src/content/form-engine.ts`, injected by the service worker into the agent's tab |
| The flow: pages, answers, memory, Submit (pure, tested with a fake page) | `src/shared/ai-apply/flow.ts` |
| Profile mapping and answer checks (MVP's tests ported) | `src/shared/ai-apply/answer-rules.ts` |
| Profile, form memory, LLM client | `src/shared/ai-apply/profile.ts`, `memory.ts`, `llm.ts` |
| Profile panel | `src/board/ProfilePanel.tsx` |
| LLM backend | `backend/app/main.py` |

## When a site changes

The board shows **"Parser needs update"** and keeps your existing data.

1. Open the board's **Log** panel to see which field failed.
2. Save a fresh, anonymised sample to `tests/fixtures/` and add a failing test.
3. Fix `src/shared/parse.ts` (Naukri), `src/shared/parse-indeed.ts` (Indeed), `src/shared/parse-instahyre.ts`
   (Instahyre) or `src/shared/parse-wellfound.ts` (Wellfound), then run `npm run check`, rebuild and reload the extension.

## Development

```powershell
npm run check     # typecheck + tests + build
npm run watch     # rebuild on change
```

Back up your data from **Data → Export backup** before uninstalling; Chrome deletes extension storage on removal.
