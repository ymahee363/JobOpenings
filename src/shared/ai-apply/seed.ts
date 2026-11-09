/**
 * Your AI apply data carried over from job-apply-ai-mvp (profile, remembered answers, resume and cover letter), so
 * nothing has to be typed in again. The build copies `seed/ai-seed.json` (git-ignored: it is personal) into the
 * extension, and the service worker loads it once per seed version.
 */
import type { MemoryMap } from './memory';
import { normalizeProfile, type StoredResume } from './profile';
import type { CandidateProfile } from './types';

export interface AiSeed {
  version: number;
  profile?: Partial<CandidateProfile>;
  formMemory?: MemoryMap;
  resume?: StoredResume | null;
  coverLetter?: StoredResume | null;
}

export interface SeedTarget {
  /** Has a profile been saved in this extension already (from the Profile panel or an earlier seed)? */
  profileSaved: boolean;
  /** The saved profile, when there is one: a newer seed with a longer work history adds it (and education). */
  savedProfile?: CandidateProfile;
  memory: MemoryMap;
  resume: StoredResume | null;
  coverLetter: StoredResume | null;
}

export interface SeedPatch {
  profile?: CandidateProfile;
  memory?: MemoryMap;
  resume?: StoredResume;
  coverLetter?: StoredResume;
}

const isFile = (f: unknown): f is StoredResume => !!f && typeof (f as StoredResume).data === 'string' && typeof (f as StoredResume).name === 'string';

/**
 * What a seed adds. It never overwrites your edits: a saved profile, a resume or cover letter you uploaded, and
 * answers you already have all stay; remembered answers are merged in.
 */
export function seedPatch(seed: AiSeed, target: SeedTarget): SeedPatch {
  const patch: SeedPatch = {};
  if (seed.profile && !target.profileSaved) patch.profile = normalizeProfile(seed.profile);
  // A saved profile keeps your edits, but a seed with more jobs (all roles from the resume, 2026-11-05) fills in the
  // work history and education so every employment block of a form can be filled without the AI.
  else if (seed.profile && target.savedProfile) {
    const seeded = normalizeProfile(seed.profile);
    let next: CandidateProfile = target.savedProfile;
    if (seeded.experience.length > next.experience.length) {
      next = { ...next, experience: seeded.experience, education: seeded.education.length ? seeded.education : next.education };
    }
    // A saved job with no description takes the seed's description for the same company (Dresma, 2026-11-06).
    const seedDesc = new Map(seeded.experience.map((e) => [e.company.trim().toLowerCase(), e.description ?? '']));
    if (next.experience.some((e) => !e.description?.trim() && seedDesc.get(e.company.trim().toLowerCase())?.trim())) {
      next = { ...next, experience: next.experience.map((e) => (e.description?.trim() ? e : { ...e, description: seedDesc.get(e.company.trim().toLowerCase()) || e.description })) };
    }
    // Fields the saved profile does not have yet (address, languages… added 2026-11-05) come from the seed;
    // anything already saved is kept.
    const saved = next as unknown as Record<string, unknown>;
    const extra = Object.fromEntries(Object.entries(seed.profile).filter(([k, v]) => v !== undefined && v !== null && saved[k] === undefined));
    if (Object.keys(extra).length) next = { ...next, ...extra } as CandidateProfile;
    if (next !== target.savedProfile) patch.profile = next;
  }
  if (seed.formMemory && typeof seed.formMemory === 'object') {
    // New questions are added; a question you already have takes the seed's answer only when that one is newer
    // (answers you gave on 2026-11-06 replace older remembered ones).
    const added = Object.entries(seed.formMemory).filter(([k, e]) => typeof e?.answer === 'string'
      && (!(k in target.memory) || (e.updatedAt ?? 0) > (target.memory[k]?.updatedAt ?? 0)));
    if (added.length) patch.memory = { ...target.memory, ...Object.fromEntries(added) };
  }
  // A stored resume with the seed's file name came from an earlier seed: a newer seed replaces it (2026-11-05: the
  // stored copy of Mahendra_IIT_Guwahati_Resume.pdf had one stray byte). A resume you uploaded under another name stays.
  if (isFile(seed.resume) && (!target.resume?.data || (target.resume.name === seed.resume.name && target.resume.data !== seed.resume.data))) {
    patch.resume = seed.resume;
  }
  if (isFile(seed.coverLetter) && !target.coverLetter?.data) patch.coverLetter = seed.coverLetter;
  // The same cover letter stored without its text (uploads kept no text before 2026-11-06): the seed's text is added,
  // for cover letter text boxes (Indeed). Text you typed in the Profile panel stays.
  else if (isFile(seed.coverLetter) && seed.coverLetter.text && target.coverLetter && !target.coverLetter.text?.trim() && target.coverLetter.name === seed.coverLetter.name) {
    patch.coverLetter = { ...target.coverLetter, text: seed.coverLetter.text };
  }
  return patch;
}
