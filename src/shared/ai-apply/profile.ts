/**
 * Your candidate profile for the AI apply flow, the LLM backend's address, and your resume. The default profile is
 * the one job-apply-ai-mvp seeded for mahendra.iitg@gmail.com; edit it in the board's Profile panel.
 */
import type { CandidateProfile, ExperienceEntry } from './types';

export const PROFILE_EMAIL = 'mahendra.iitg@gmail.com';

export const DEFAULT_PROFILE: CandidateProfile = {
  name: "Mahendra Yadav",
  email: PROFILE_EMAIL,
  phone: "",
  location: "Bengaluru",

  current_ctc: 2700000,
  expected_ctc: 3000000,

  notice_period: "15 days",

  education: [
    {
      degree: "B.Tech",
      institution: "IIT Guwahati",
      graduation_year: 2021
    }
  ],

  // Ordered most recent first — this order is what the agent uses
  // to fill a repeatable "+ Add" Work Experience section (LinkedIn,
  // Workday, etc.), one entry per block in this sequence.
  experience: [
    {
      title: "AI Product Lead",
      company: "Nu10 (AI Product Development)",
      location: "",
      start_date: "Apr 2026",
      end_date: "Jul 2026",
      current: false,
      description: ""
    },
    {
      title: "Founder & Product Manager",
      company:
        "BestSpaceFinder (Marketplace to Find Shared Flats and Flatmates)",
      location: "",
      start_date: "Aug 2025",
      end_date: "Mar 2026",
      current: false,
      description: ""
    },
    {
      title: "AI Product Manager",
      company: "Xaigi (AI Product Development)",
      location: "",
      start_date: "Jun 2024",
      end_date: "Jul 2025",
      current: false,
      description: ""
    },
    {
      title: "Product Manager (Consultant)",
      company: "Dezigner Hooman (Product Development)",
      location: "",
      start_date: "Jul 2023",
      end_date: "May 2024",
      current: false,
      description: ""
    },
    {
      title: "Product Manager",
      company:
        "Dresma (DoMyShoot: AI Product Photography & Content Creation Mobile & Web App)",
      location: "",
      start_date: "May 2021",
      end_date: "Jun 2023",
      current: false,
      description: ""
    }
  ] as ExperienceEntry[],

  skills: [
    "Product Management",
    "AI",
    "Generative AI",
    "Data Products"
  ],

  linkedin: "",
  portfolio: "",

  custom_fields: [],

  extra_information: "",

  additional_facts: {}
};

/** A stored profile with every field present, whatever an older version or an import left out. */
export function normalizeProfile(saved: Partial<CandidateProfile> | null | undefined): CandidateProfile {
  const s = saved ?? {};
  const arr = <T>(v: unknown, fallback: T[]): T[] => (Array.isArray(v) ? (v as T[]) : fallback);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    ...DEFAULT_PROFILE,
    ...s,
    current_ctc: s.current_ctc === undefined ? DEFAULT_PROFILE.current_ctc : num(s.current_ctc),
    expected_ctc: s.expected_ctc === undefined ? DEFAULT_PROFILE.expected_ctc : num(s.expected_ctc),
    education: arr(s.education, DEFAULT_PROFILE.education),
    experience: arr(s.experience, DEFAULT_PROFILE.experience),
    skills: arr(s.skills, DEFAULT_PROFILE.skills),
    custom_fields: arr(s.custom_fields, []),
    extra_information: typeof s.extra_information === 'string' ? s.extra_information : '',
    additional_facts: s.additional_facts && typeof s.additional_facts === 'object' ? s.additional_facts : {},
  };
}

/** Where the LLM backend (backend/ in this repo) runs, and its X-App-Key when it has one. */
export interface AiBackend {
  url: string;
  accessKey: string;
}

export const DEFAULT_BACKEND: AiBackend = { url: 'http://localhost:8000', accessKey: '' };

/** Your resume file, attached to upload fields, and its text, given to the LLM as grounding. */
export interface StoredResume {
  name: string;
  type: string;
  /** The file, base64. */
  data: string;
  /** Pasted plain text of the resume; "" when none. */
  text: string;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
