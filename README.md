# Naukri Fast-Apply Board

A personal Chrome extension that lists the openings Naukri recommends to you, plus a saved
[product manager search](https://www.naukri.com/product-manager-jobs?k=%22product%20manager%22&nignbevent_src=jobsearchDeskGNB&jobAge=30&functionAreaIdGid=10&experience=6&cityTypeGid=97),
**newest first**, split into
**Easy Apply** (apply on Naukri) and **Company Site** (apply on the employer's site) tabs. Everything stays in
your browser. See [PRD.md](PRD.md) for the product spec.

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

## Using it

| Action | How |
| --- | --- |
| Apply (Easy Apply tab) | **Apply** or Enter: opens the Naukri job page. The job becomes Applied when Naukri shows "Applied", or after you answer **Yes** on the board |
| Apply (Company Site tab) | **Open site**: opens the employer's page in a new tab; confirm with **Yes** or **Mark applied** |
| Dismiss | **Dismiss** or `d`, with 5-second Undo (`u`) |
| Move / search / tabs | `j` / `k`, `/`, `1`–`4` |
| Refresh | **Refresh** opens Naukri's recommended jobs, then the saved search sorted by date, in a background tab. Further search pages load only while the previous page had new jobs (up to 10). At most once every 15 minutes |

Jobs also arrive whenever you browse Naukri yourself; that never counts against the limit.

## How it works

| Part | File | Job |
| --- | --- | --- |
| Hook | `src/content/main-hook.ts` | Runs in the page; copies `jobapi/v*/search/recom-jobs` and `jobapi/v3/search?...` (job search) responses the page already loads |
| Collector | `src/content/collector.ts` | Relays hook captures, reads Naukri's cached feeds (`srp_simjobs_reco_wdgt_*` in localStorage), reports logged-out or captcha pages, watches job pages for "Applied" |
| Service worker | `src/background/service-worker.ts` | Validates and parses captures, stores them, runs refreshes and safety pauses |
| Parser | `src/shared/parse.ts` | zod-validated mapping from Naukri's job fields to ours |
| Store | `src/db/` | IndexedDB (Dexie): `jobs`, `statuses` (your actions, never touched by refresh), `log` |
| Board | `src/board/` | React page with tabs, filters, stats, settings and backups |

**Field mapping** (confirmed on the live page on 2026-10-21): `companyApplyJob` → apply type,
`applyRedirectUrl` / `companyApplyUrl` → external link, `createdDate` (epoch ms) → posted time,
`footerPlaceholderLabel` → fallback when `createdDate` is missing, `placeholders[]` → experience, salary, location.

## Account safety

- No direct calls to Naukri's APIs: the extension only reads pages your browser loads.
- App-initiated page loads: at most 1 every 15 minutes, and none for 1 hour after a captcha or logout.
- It never applies for you.
- Personal use only; no data leaves your machine.

## When Naukri changes its site

The board shows **"Parser needs update"** and keeps your existing data.

1. Open the board's **Log** panel to see which field failed.
2. Save a fresh, anonymised sample to `tests/fixtures/` and add a failing test.
3. Fix `src/shared/parse.ts`, then run `npm run check`, rebuild and reload the extension.

## Development

```powershell
npm run check     # typecheck + tests + build
npm run watch     # rebuild on change
```

Back up your data from **Data → Export backup** before uninstalling; Chrome deletes extension storage on removal.
