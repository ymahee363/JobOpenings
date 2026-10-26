// Dependency-free constants shared with the content scripts, which run on every Naukri page and must stay tiny.

/** Broadcast from the service worker when stored jobs or statuses change. */
export const DB_CHANGED = 'db-changed';

/** window.postMessage tag between the MAIN-world hook and the collector. */
export const HOOK_TAG = '__naukri_fast_apply_capture__';

/** Max response size the hook forwards (characters of text). */
export const MAX_CAPTURE_CHARS = 5_000_000;

/** Feed responses the hook captures: the recom-jobs feeds and the job-search results (`/jobapi/v3/search?...`). */
export const CAPTURE_URL_RE = /\/jobapi\/v\d+\/search(?:\/recom-jobs|\?)/;

/** Indeed GraphQL calls; the hook forwards only responses that carry job cards. */
export const INDEED_CAPTURE_URL_RE = /^https:\/\/apis\.indeed\.com\/graphql/;

/** Instahyre job-search results (`/api/v1/job_search?...`), requested when you run a search or saved search. */
export const INSTAHYRE_CAPTURE_URL_RE = /\/api\/v1\/job_search(?:\?|$)/;

/** Wellfound GraphQL calls; the hook forwards only responses that list jobs (`highlightedJobListings`). */
export const WELLFOUND_CAPTURE_URL_RE = /^(?:https:\/\/wellfound\.com)?\/graphql(?:\?|$)/;

/** Job-search results; their jobs are stored under the `search` feed. */
export const SEARCH_API_RE = /\/jobapi\/v\d+\/search\?/;

/** localStorage keys Naukri uses to cache feeds, e.g. srp_simjobs_reco_wdgt_profile_<hash>. */
export const FEED_CACHE_KEY_RE = /^srp_simjobs_reco_wdgt_([a-z_]+?)_[0-9a-f]{16,}$/;
