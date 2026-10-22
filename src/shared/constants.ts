// Dependency-free constants shared with the content scripts, which run on every Naukri page and must stay tiny.

/** Broadcast from the service worker when stored jobs or statuses change. */
export const DB_CHANGED = 'db-changed';

/** window.postMessage tag between the MAIN-world hook and the collector. */
export const HOOK_TAG = '__naukri_fast_apply_capture__';

/** Max response size the hook forwards (characters of text). */
export const MAX_CAPTURE_CHARS = 5_000_000;

/** Feed responses the hook captures: the recom-jobs feeds and the job-search results (`/jobapi/v3/search?...`). */
export const CAPTURE_URL_RE = /\/jobapi\/v\d+\/search(?:\/recom-jobs|\?)/;

/** Job-search results; their jobs are stored under the `search` feed. */
export const SEARCH_API_RE = /\/jobapi\/v\d+\/search\?/;

/** localStorage keys Naukri uses to cache feeds, e.g. srp_simjobs_reco_wdgt_profile_<hash>. */
export const FEED_CACHE_KEY_RE = /^srp_simjobs_reco_wdgt_([a-z_]+?)_[0-9a-f]{16,}$/;
