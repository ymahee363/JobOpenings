/**
 * What the Workday applier fills, from your profile (pure, so it is unit-tested). Your answer rules (2026-11-05,
 * also in seed/applicant_profile.py): "How did you hear" → LinkedIn first; B.Tech → "Bachelor Degree or
 * equivalent"; privacy notice → yes; text-message opt-ins are not touched.
 */
import type { CandidateProfile } from '../ai-apply/types';
import { monthYearPart } from '../ai-apply/answer-rules';
import type { WorkdayPlan, WdJob, WdEducation, WdLanguage, WdFile } from '../../content/ats/workday';

type Loose = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "April 2026" / "2026-04" / "04/2026" → { month: "04", year: "2026" }. */
export function wdDate(text: string): { month?: string; year?: string } {
  if (!text) return {};
  const monthName = monthYearPart(text, 'month');
  const year = monthYearPart(text, 'year') || undefined;
  const i = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : -1;
  return { month: i >= 0 ? String(i + 1).padStart(2, '0') : undefined, year };
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

function custom(p: CandidateProfile, name: RegExp): string {
  return str(p.custom_fields.find((f) => name.test(f.name))?.value);
}

/** Degree words → Workday's degree list, best first. */
export function degreeChoices(degree: string): string[] {
  // B.Tech / Bachelor of Technology first, then Bachelor of Engineering, then Workday's general bachelor's entry
  // (user, 2026-11-06).
  if (/b\.?\s?tech|bachelor of tech/i.test(degree)) return ['B.Tech', 'B. Tech', 'BTech', 'Bachelor of Technology', 'Bachelor of Engineering', 'B.E.', 'Bachelor Degree or equivalent', "Bachelor's Degree", 'Bachelors', 'Bachelor'];
  if (/b\.?e\b|bachelor of eng/i.test(degree)) return ['Bachelor of Engineering', 'B.E.', 'Bachelor of Technology', 'B.Tech', 'Bachelor Degree or equivalent', "Bachelor's Degree", 'Bachelors', 'Bachelor'];
  if (/bachelor/i.test(degree)) return ['Bachelor Degree or equivalent', "Bachelor's Degree", 'Bachelors', 'Bachelor'];
  if (/m\.?\s?tech|master|mba|m\.?s\b/i.test(degree)) return ['Master Degree or equivalent', "Master's Degree", 'Masters', 'Master'];
  if (/ph\.?d|doctor/i.test(degree)) return ['Ph.D. Degree or equivalent', 'Doctorate', 'PhD'];
  if (/diploma/i.test(degree)) return ['Diploma Degree or equivalent', 'Diploma'];
  return [degree];
}

/** A one- or two-word query Workday's search box finds (it struggles with full names). */
function schoolQuery(name: string): string {
  const m = /iit\s*([a-z]+)|technology,?\s*([a-z]+)$/i.exec(name);
  return (m?.[1] ?? m?.[2]) || name.split(/\s+/).slice(-1)[0] || name;
}

const fullSchool = (s: string) => (/^iit\s+/i.test(s) ? `Indian Institute of Technology ${s.replace(/^iit\s+/i, '')}` : s);

export function buildWorkdayPlan(profile: CandidateProfile, resume?: WdFile | null): WorkdayPlan {
  const p = profile as CandidateProfile & Loose;
  const { first, last } = splitName(profile.name);
  const address = (p.address ?? {}) as Loose;
  const jobs: WdJob[] = profile.experience.map((e) => {
    const x = e as unknown as Loose;
    return {
      title: str(x.title) || str(x.role),
      company: str(x.company),
      location: str(x.location) || undefined,
      from: wdDate(str(x.start_date)),
      to: wdDate(str(x.end_date)),
      current: x.current === true,
      description: str(x.description) || undefined,
    };
  }).filter((j) => j.title && j.company);
  const education: WdEducation[] = profile.education.map((e) => {
    const schoolText = str(e.institution) || str(e.school);
    const school = fullSchool(schoolText);
    const fieldOfStudy = str(e.field_of_study) || str(e.major) || str(e.discipline);
    return {
      school,
      schoolQuery: schoolQuery(school),
      schoolText,
      degree: degreeChoices(str(e.degree)),
      field: fieldOfStudy || undefined,
      fieldQuery: fieldOfStudy ? fieldOfStudy.split(/\s+/)[0] : undefined,
      fromYear: str(e.start_year) || wdDate(str(e.start_date)).year,
      toYear: str(e.graduation_year) || str(e.end_year) || wdDate(str(e.end_date)).year,
    };
  }).filter((e) => e.school);
  const languages: WdLanguage[] = ((p.languages as Loose[] | undefined) ?? []).map((l) => ({
    name: str(l.name),
    fluent: l.fluent !== false,
    level: [str(l.level) || 'Advanced', 'Fluent', 'Native', 'Advanced'],
  })).filter((l) => l.name);
  // Resume skills come as "Tools: Project Management: Jira, Confluence | Design: Figma": split on : , | and drop
  // the category headings, keeping real skills such as Stakeholder Management.
  const HEADINGS = /^(tools|project management|design|analytics|marketing|payment|automation|ai assistant)$/i;
  const skills = profile.skills.flatMap((s) => s.split(/\n|:|,|\|/)).map((s) => s.trim())
    .filter((s) => s && s.length <= 40 && !HEADINGS.test(s));
  const expected = Number(profile.expected_ctc) || 0;
  const notice = str(profile.notice_period);
  return {
    source: ['LinkedIn', 'Linkedin', 'Job Board', 'Indeed', 'Naukri', 'Other'],
    previousWorker: 'No',
    country: custom(profile, /^country$/i) || 'India',
    firstName: first,
    lastName: last,
    address: str(address.line1) || undefined,
    address2: str(address.line2) || str(address.city) || str(profile.location) || undefined,
    state: str(address.state) || (/bangalore|bengaluru/i.test(str(address.city) || str(profile.location)) ? 'Karnataka' : undefined),
    city: str(address.city) || str(profile.location) || undefined,
    postalCode: str(address.postal_code) || str(address.pincode) || undefined,
    phoneDevice: ['Mobile', 'Mobile Phone', 'Cell'],
    phoneCountry: custom(profile, /^country$/i) || 'India',
    phone: str(profile.phone).replace(/^\+?91[\s-]?/, ''),
    jobs,
    education,
    languages,
    skills: [...new Set(skills)].slice(0, 15),
    websites: [profile.linkedin, profile.portfolio, custom(profile, /github/i)].map(str).filter(Boolean),
    resume: resume ?? null,
    gender: [custom(profile, /^gender$/i) || 'Male'],
    privacyConsent: true,
    dateOfBirth: (() => {
      const dob = str(p.date_of_birth) || custom(profile, /date of birth|dob/i);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
      return m ? { year: m[1], month: m[2], day: m[3] } : undefined;
    })(),
    questions: [
      { pattern: 'minimum age', answers: ['Yes'] },
      { pattern: 'legally eligible', answers: ['Yes'] },
      { pattern: 'government official or have you been', answers: ['No'] },
      { pattern: 'close links to a government', answers: ['No'] },
      { pattern: 'considered for other (opportunities|roles|positions)', answers: ['Yes'] },
      // The accuracy declaration some tenants require before Submit (GSK).
      { pattern: '^i acknowledge that my responses are accurate', answers: ['Yes', 'I Acknowledge', 'I agree'] },
      { pattern: 'right to work|authori[sz]ed to work|legally (allowed|eligible)', answers: ['Yes - I hold citizenship', 'Yes – I hold citizenship', 'Yes'] },
      { pattern: 'sponsorship|visa', answers: ['No'] },
      { pattern: 'worked (or are you currently working )?for|previously (worked|employed)|former employee', answers: ['No'] },
      { pattern: 'related to|relative|family member', answers: ['No'] },
      { pattern: 'salary expectation|expected (ctc|salary|compensation)', answers: [expected ? `INR ${expected.toLocaleString('en-IN')} per annum (fixed), open to discussion.` : ''] },
      { pattern: 'current (ctc|salary|compensation)', answers: [Number(profile.current_ctc) ? `INR ${Number(profile.current_ctc).toLocaleString('en-IN')} per annum (fixed)` : ''] },
      // Text boxes take the sentence; dropdowns the first option that matches one of the short forms.
      { pattern: 'notice period', answers: notice === '0' || /immediate/i.test(notice)
        ? ['Immediately available (0 days notice).', 'Immediate', 'Immediately', 'Immediate joiner', '0 days', '0', 'Less than 15 days', '15 days or less', '0-15 days', '15 days']
        : [notice] },
    ].filter((q) => q.answers[0]),
  };
}
