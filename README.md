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
- It never applies for you.
- Personal use only; no data leaves your machine.

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
