/**
 * Answering application-form fields without the LLM, and checking what the LLM answered. Ported from
 * job-apply-ai-mvp (extension/src/sidepanel/ApplyView.tsx), where these were tested live on Greenhouse, Lever,
 * Workday, LinkedIn Easy Apply and others. Pure: no Chrome or network calls.
 */
import type { Answer, CandidateProfile, ExperienceEntry, FormData, FormField } from './types';

export function normalize(value: string) {
  // Accents dropped first: "Karnātaka" (some ATS) is "Karnataka".
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Plain substring matching treats "female" as containing "male"
// and "british indian ocean territory" as containing "india" (via
// "ind-IA-n") — confirmed bug: gender/country answers matched
// onto the wrong option whenever the wrong one happened to come
// first. Require a whole word/phrase match instead.
export function containsWholeWord(haystack: string, needle: string) {
  if (!needle) {
    return false;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(
    haystack
  );
}

export function fuzzyTextMatch(a: string, b: string) {
  return a === b || containsWholeWord(a, b) || containsWholeWord(b, a);
}

// Placeholder text like "-Select-", "Choose one", "Please select"
// reads as a current_value but isn't a real answer.
// Exact-match only (not startsWith) — these are short, common
// placeholder words that would also be plausible real answers as a
// SUBSTRING of something longer (e.g. "National" contains "na"), so
// only an exact match after stripping is safe.
const EXACT_PLACEHOLDER_VALUES = new Set([
  "na",
  "notapplicable",
  "none",
  "noneselected",
  "notselected",
  "nonespecified"
]);

export function isPlaceholderValue(value: string): boolean {
  const stripped = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  return (
    !stripped ||
    stripped.startsWith("select") ||
    stripped.startsWith("choose") ||
    stripped.startsWith("pleaseselect") ||
    EXACT_PLACEHOLDER_VALUES.has(stripped)
  );
}

// Fields the page already has a real value for don't need the LLM
// at all — answering them again would just burn tokens restating
// what's already there.
export function isAlreadyFilled(field: FormField): boolean {
  if (field.type === "file") {
    return false;
  }

  return !isPlaceholderValue(field.current_value);
}

// ---------------------------------------------------------------
// Deterministic direct-mapping: the biggest token saver. A good
// share of fields on any multi-page application (name, email,
// phone, links) map 1:1 onto the profile as a literal string, with
// no room for the question's wording to change what should be
// written — answering these via regex costs zero LLM tokens and is
// more reliable than asking the model to restate them.
//
// Deliberately excluded: CTC/salary and notice period. These are
// NOT safe to copy verbatim — the question's exact wording changes
// what the correct answer looks like (confirmed bug: current_ctc
// stored as 2700000 was written in raw as "2700000" into a field
// asking "current CTC in LPA", which should read "27" — the direct
// map bypassed the LLM entirely, so nothing ever interpreted the
// wording). Anything where the unit/format has to be inferred from
// the question must go through the LLM, never a blind copy.
// ---------------------------------------------------------------

export function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { first: "", last: "" };
  }

  if (parts.length === 1) {
    return { first: parts[0] ?? "", last: "" };
  }

  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

type DirectMapRule = {
  test: RegExp;
  resolve: (profile: CandidateProfile) => string | undefined;
};

const DIRECT_MAP_RULES: DirectMapRule[] = [
  {
    // Your branch from the profile's education (Civil Engineering), ahead of any older remembered answer
    // ("Technology" on Ashby, QA 2026-11-05). Dropdowns get the closest option via flow.ts fitToOptions.
    test: /^(field of study|discipline|major|branch|speciali[sz]ation)\b/i,
    resolve: p => {
      const e = (p.education ?? [])[0] ?? {};
      const v = e.field_of_study ?? e.major ?? e.discipline ?? e.specialization;
      return typeof v === "string" && v ? v : undefined;
    }
  },
  {
    // "Given Name(s)" (eBay's Phenom form); "Local Given Name" asks for
    // the name in a local script and is left to the LLM.
    test: /^(?!local).*(first\s*name|given\s*name)/i,
    resolve: p => splitName(p.name).first || undefined
  },
  {
    test: /^(?!local).*(last\s*name|surname|family\s*name)/i,
    resolve: p => splitName(p.name).last || undefined
  },
  {
    test: /full\s*name|^name$|^(full\s*)?legal\s*name$/i,
    resolve: p => p.name || undefined
  },
  {
    test: /e[-\s]?mail/i,
    resolve: p => p.email || undefined
  },
  {
    // Excludes "phone country code", "phone type", "phone
    // extension" — those ask for something other than the number
    // itself, so a raw phone-number copy would answer the wrong
    // question. The word-count guard below also catches this, but
    // this is the exact false positive that was seen live, so it's
    // excluded explicitly too.
    test: /(phone|mobile)(?!.*(code|type|extension))/i,
    resolve: p => p.phone || undefined
  },
  {
    test: /linkedin/i,
    resolve: p => p.linkedin || undefined
  },
  {
    // GitHub is its own link, never the portfolio (seen on Lever:
    // "GitHub URL" got the portfolio site). From a custom field named
    // GitHub, or a portfolio that is itself a GitHub link.
    test: /github/i,
    resolve: p =>
      p.custom_fields.find(f => /github/i.test(f.name))?.value ||
      (/github\.com/i.test(p.portfolio || "") ? p.portfolio : undefined)
  },
  {
    test: /portfolio|personal\s*website|website|blog/i,
    resolve: p => p.portfolio || undefined
  },
  {
    test: /^(current\s*|present\s*)?(city|location)$/i,
    resolve: p => p.location || undefined
  }
];

// Checked before DIRECT_MAP_EXCLUSIONS (which skip any "company"
// label, since most ask about someone else's company): these ask
// about the candidate's own most recent employer.
const OWN_COMPANY_PATTERN =
  /^(current|present|most\s*recent|latest|last)\s*(company|employer|organi[sz]ation)(\s*name)?$/i;

const DIRECT_MAP_TYPES = new Set([
  "text",
  "email",
  "tel",
  "number",
  "textarea"
]);

// A label carrying any of these means the field is asking about
// something other than the candidate directly (a reference, an
// emergency contact, the employer, a referral source) — matching
// the field NAME alone ("phone", "website") isn't enough, since
// these qualifiers silently redirect what's actually being asked.
// "\breferr", not "referr": "Preferred First Name" contains "referr"
// and was sent to the LLM (golden form set). Passwords never come from
// the profile: Notion's optional "Portfolio Password" got the portfolio
// URL through the portfolio rule.
const DIRECT_MAP_EXCLUSIONS =
  /reference|emergency|spouse|manager|supervisor|\bcompany\b|employer|\breferr|found|hear\s*about|\bpost\b|password|passcode|secret/i;

// Only apply a direct map to a short, plain field label. The
// moment a label carries extra context ("... in LPA", "notice
// period in weeks", "LinkedIn post URL") that context can change
// what the correct answer looks like — and only the LLM actually
// reads and reasons about that wording. A regex copy must never be
// the one making that call; it only gets to act when there's
// nothing to interpret in the first place.
const DIRECT_MAP_MAX_WORDS = 4;

/**
 * Dropdowns (Greenhouse's Country, Location, Gender) take a profile
 * value too, as long as it is one of the options — or the options
 * only load when the dropdown opens, and the engine's combobox fill
 * types the value and picks the match.
 */
const DIRECT_MAP_CHOICE_TYPES = new Set(["combobox", "select"]);

export function directMapAnswer(
  field: FormField,
  profile: CandidateProfile
): string | undefined {
  if (DIRECT_MAP_CHOICE_TYPES.has(field.type)) {
    const value = directMapValue({ ...field, type: "text" }, profile);
    return value && (field.options.length === 0 || isValidAgainstOptions(field, value))
      ? value
      : undefined;
  }

  return directMapValue(field, profile);
}

function directMapValue(
  field: FormField,
  profile: CandidateProfile
): string | undefined {
  if (!DIRECT_MAP_TYPES.has(field.type)) {
    return undefined;
  }

  // "Location (City)*" → "Location": a bracketed hint names the format,
  // not a different question.
  const plainLabel = field.label
    .replace(/[*:]+\s*$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[*:]+\s*$/, "")
    .trim();

  if (OWN_COMPANY_PATTERN.test(plainLabel)) {
    return profile.experience[0]?.company || undefined;
  }

  const years = techYearsAnswer(plainLabel, field);
  if (years) return years;

  if (
    !plainLabel ||
    plainLabel.split(/\s+/).length > DIRECT_MAP_MAX_WORDS ||
    DIRECT_MAP_EXCLUSIONS.test(plainLabel)
  ) {
    return undefined;
  }

  for (const rule of DIRECT_MAP_RULES) {
    if (rule.test.test(plainLabel)) {
      const value = rule.resolve(profile);
      if (value) {
        return value;
      }
    }
  }

  const labelNorm = normalize(plainLabel);

  // A short label never matches a long saved question it merely appears in: "Experience" (Keka) matched "Have you
  // been part of a founding team… experience" and was answered "Yes" (QA, 2026-11-05).
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const match = profile.custom_fields.find(customField => {
    const nameNorm = normalize(customField.name);
    return (
      nameNorm.length > 0 &&
      !(words(plainLabel) <= 2 && words(customField.name) > words(plainLabel) + 2) &&
      fuzzyTextMatch(labelNorm, nameNorm)
    );
  });

  return match?.value || undefined;
}

// ---------------------------------------------------------------
// Repeatable Work Experience blocks — content.ts's
// prepareRepeatableSection() clicks a section's "+ Add" control
// once per profile.experience entry and tags every field it reveals
// with entry_type/entry_index. The per-field LLM Q&A has no way to
// tell block 1 apart from block 2 (both just see a bare "Job Title"
// label), so title/company/location/description/the "currently work
// here" toggle are answered directly from the matching profile
// entry instead — same reasoning as directMapAnswer, but keyed by
// which entry the field belongs to rather than by the profile as a
// whole.
// ---------------------------------------------------------------

const EXPERIENCE_CURRENT_PATTERN =
  /current(ly)?\s*(work|position|role|employ)|i\s+(currently\s+)?work\s+here|present\b/i;

const EXPERIENCE_FIELD_KEY_RULES: {
  test: RegExp;
  key: keyof ExperienceEntry;
}[] = [
  { test: /job\s*title|^title$|position\s*title|\brole\b/i, key: "title" },
  { test: /company|employer|organi[sz]ation/i, key: "company" },
  { test: /location|city/i, key: "location" },
  {
    test: /description|responsibilit|summary|role\s*description|achievement/i,
    key: "description"
  },
  { test: /^start|from\b/i, key: "start_date" },
  { test: /^end|\bto\b/i, key: "end_date" }
];

export function experienceEntryAnswer(
  field: FormField,
  profile: CandidateProfile
): string | undefined {
  if (
    field.entry_type !== "experience" ||
    field.entry_index === undefined
  ) {
    return undefined;
  }

  const entry = profile.experience[field.entry_index];

  if (!entry) {
    return undefined;
  }

  const plainLabel = field.label.replace(/[*:]+\s*$/, "").trim();

  if (
    field.type === "checkbox" &&
    EXPERIENCE_CURRENT_PATTERN.test(plainLabel)
  ) {
    return entry.current ? "Yes" : "No";
  }

  for (const rule of EXPERIENCE_FIELD_KEY_RULES) {
    if (rule.test.test(plainLabel)) {
      const value = entry[rule.key];

      if (typeof value === "string" && value) {
        // Separate month and year boxes ("Start date month" / "Start date year" on Greenhouse) get their part.
        if (rule.key === "start_date" || rule.key === "end_date") {
          const part = monthYearPart(value, plainLabel);
          if (part !== undefined) return part || undefined;
        }
        return value;
      }
    }
  }

  return undefined;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * The month or the year of a profile date ("APRIL 2026", "2026-04", "04/2026") for a field that asks for only one
 * of them; undefined when the label asks for the whole date, "" when that part is not in the date.
 */
export function monthYearPart(date: string, label: string): string | undefined {
  const wantsMonth = /\bmonth\b/i.test(label);
  const wantsYear = /\byear\b/i.test(label);
  if (wantsMonth === wantsYear) return undefined;
  const year = /\b(19|20)\d{2}\b/.exec(date)?.[0] ?? "";
  if (wantsYear) return year;
  const byName = MONTHS.find(m => new RegExp(`\\b${m.slice(0, 3)}`, "i").test(date));
  if (byName) return byName;
  const num = /\b(\d{1,2})[/-](?:19|20)\d{2}\b|\b(?:19|20)\d{2}[/-](\d{1,2})\b/.exec(date);
  const n = Number(num?.[1] ?? num?.[2]);
  return n >= 1 && n <= 12 ? MONTHS[n - 1]! : "";
}

// Same field-key mapping as experience, for a repeatable Education
// block — profile.education entries are a loose Record (no fixed
// shape the way ExperienceEntry is), so this reads by common key
// aliases rather than a typed property.
const EDUCATION_FIELD_KEY_RULES: {
  test: RegExp;
  keys: string[];
}[] = [
  {
    test: /school|university|college|institution/i,
    keys: ["institution", "school", "university", "college"]
  },
  { test: /degree/i, keys: ["degree"] },
  {
    test: /field\s*of\s*study|major|specialization/i,
    keys: ["field_of_study", "major", "specialization"]
  },
  {
    test: /graduation|grad(uated)?\s*(year|date)/i,
    keys: ["graduation_year", "graduation_date", "year"]
  }
];

export function educationEntryAnswer(
  field: FormField,
  profile: CandidateProfile
): string | undefined {
  if (
    field.entry_type !== "education" ||
    field.entry_index === undefined
  ) {
    return undefined;
  }

  const entry = profile.education[field.entry_index];

  if (!entry) {
    return undefined;
  }

  const plainLabel = field.label.replace(/[*:]+\s*$/, "").trim();

  for (const rule of EDUCATION_FIELD_KEY_RULES) {
    if (rule.test.test(plainLabel)) {
      for (const key of rule.keys) {
        const value = entry[key];

        if (
          (typeof value === "string" && value) ||
          typeof value === "number"
        ) {
          return String(value);
        }
      }
    }
  }

  return undefined;
}

// Anything inside a repeatable block that isn't deterministically
// answered above (date-picker sub-fields with no real label,
// "Industry", "Reason for leaving"...) still goes to the LLM — but
// with the block's own identifying info folded into the label, so
// the model can tell which entry it's answering for instead of
// repeating the same guess across every block. Covers experience/
// education (which have a backing profile array to describe the
// entry with) and any other repeatable section content.ts tagged
// generically (which doesn't — just the section name and index).
export function enrichEntryFieldLabel(
  field: FormField,
  profile: CandidateProfile
): FormField {
  if (
    !field.entry_type ||
    field.entry_index === undefined
  ) {
    return field;
  }

  if (field.entry_type === "experience") {
    const entry = profile.experience[field.entry_index];

    if (!entry) {
      return field;
    }

    const who =
      [entry.title, entry.company].filter(Boolean).join(" at ") ||
      `entry ${field.entry_index + 1}`;

    return {
      ...field,
      label: `Work experience ${field.entry_index + 1} of ${
        profile.experience.length
      } (${who}) — ${field.label || "field"}`
    };
  }

  if (field.entry_type === "education") {
    const entry = profile.education[field.entry_index];

    if (!entry) {
      return field;
    }

    const who =
      [entry.degree, entry.institution]
        .filter(Boolean)
        .join(" from ") || `entry ${field.entry_index + 1}`;

    return {
      ...field,
      label: `Education ${field.entry_index + 1} of ${
        profile.education.length
      } (${who}) — ${field.label || "field"}`
    };
  }

  // A generic repeatable section content.ts couldn't map to a known
  // profile array (Certifications, Languages, Publications...) — no
  // "who" description available, but the section name + entry
  // number still tells the model these are grouped, not one bare
  // repeated label.
  const sectionName = field.entry_type
    .replace(/_/g, " ")
    .trim();

  return {
    ...field,
    label: `${sectionName || "Entry"} ${
      field.entry_index + 1
    } — ${field.label || "field"}`
  };
}
// ---------------------------------------------------------------
// Answer verification layer. The LLM sometimes picks a technically
// present but factually wrong option (confirmed bug: profile said
// India, agent selected a different country) — this checks every
// option-based answer against the field's own option list, and
// specifically cross-checks a "country" field against the
// candidate's stated location rather than trusting the model's
// choice blindly.
// ---------------------------------------------------------------

const OPTION_BASED_TYPES = new Set([
  "select",
  "multi-select",
  "radio",
  "checkbox",
  "combobox"
]);

export function optionsInclude(
  answerPart: string,
  options: string[]
): boolean {
  const target = normalize(answerPart);

  if (!target) {
    return false;
  }

  return options.some(option =>
    fuzzyTextMatch(normalize(option), target)
  );
}

// checkbox/multi-select answers can be comma-separated — every
// part has to correspond to a real option for the answer to count
// as valid.
export function isValidAgainstOptions(
  field: FormField,
  answer: string
): boolean {
  if (
    !OPTION_BASED_TYPES.has(field.type) ||
    field.options.length === 0 ||
    // A searchable list read only in part (the engine keeps 100 options; Greenhouse's School list has thousands
    // and starts at "Aalborg University", 2026-11-05): any answer may be in it, and filling searches for it.
    (field.type === "combobox" && field.options.length >= 100)
  ) {
    return true;
  }

  const parts = answer
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  return (
    parts.length > 0 &&
    parts.every(part => optionsInclude(part, field.options))
  );
}

export function isCountryField(label: string): boolean {
  return (
    /country/i.test(label) &&
    !/code|phone|calling/i.test(label)
  );
}

// "Resume" and "CV" are the same document by two different common
// names ("curriculum vitae" being the third, spelled-out form) —
// matched as whole words/phrases so a label like "Received" doesn't
// false-positive on a stray "cv" substring.
export function isResumeLabel(label: string): boolean {
  const normalized = normalize(label);
  return (
    containsWholeWord(normalized, "resume") ||
    containsWholeWord(normalized, "cv") ||
    (
      containsWholeWord(normalized, "curriculum") &&
      containsWholeWord(normalized, "vitae")
    )
  );
}

// "cover letter" / "cover note" — checked as two whole words rather
// than a single containsWholeWord("cover letter") call, since
// normalize() collapses everything to single spaces and a label
// could plausibly say "Letter of interest / Cover" or similar with
// the words in a different order.
export function isCoverLetterLabel(label: string): boolean {
  const normalized = normalize(label);
  return (
    containsWholeWord(normalized, "cover") &&
    (
      containsWholeWord(normalized, "letter") ||
      containsWholeWord(normalized, "note")
    )
  );
}

// Deterministically figure out which of the field's own options
// the candidate's stated location names, if any — used to
// self-correct a wrong country selection instead of trusting the
// LLM's pick.
export function findLocationMatchingOption(
  options: string[],
  location: string
): string | undefined {
  const locationNorm = ` ${normalize(location)} `;

  const matches = options.filter(option => {
    const optionNorm = normalize(option);
    return (
      optionNorm.length > 2 &&
      locationNorm.includes(` ${optionNorm} `)
    );
  });

  return matches.length === 1 ? matches[0] : undefined;
}

// A DATE field that's really asking for an employment start/
// availability date ("Earliest start date", "Available from",
// "Date of joining"...) driven by notice period.
export function isStartDateField(label: string): boolean {
  return /notice\s*period|start\s*date|joining\s*date|date\s*of\s*joining|available\s*from|earliest\s*(start|join|availability)|availability\s*date|how soon can you join|when can you join|when are you available/i.test(
    label
  );
}

// Parse a free-text notice_period ("15 days", "1 month", "2 weeks",
// "Immediate") into a day count. Returns undefined when it can't be
// confidently parsed, so the caller falls back to the LLM's own
// answer rather than guessing.
export function parseNoticePeriodDays(
  noticePeriod: string
): number | undefined {
  const text = noticePeriod.trim().toLowerCase();

  if (!text) {
    return undefined;
  }

  if (/immediate|immediately|\basap\b|^0\s*(day|days)?$/.test(text)) {
    return 0;
  }

  const match = text.match(/(\d+(?:\.\d+)?)\s*(day|week|month)s?/);

  if (!match) {
    return undefined;
  }

  const amount = parseFloat(match[1] ?? "");
  const unit = match[2];

  if (unit === "day") return Math.round(amount);
  if (unit === "week") return Math.round(amount * 7);
  if (unit === "month") return Math.round(amount * 30);

  return undefined;
}

// A start date computed from "today" is never today itself — even
// notice_period = "Immediate" means "as soon as practically
// possible", i.e. tomorrow, which also sidesteps same-day dates most
// ATSs reject as a start date anyway.
export function noticePeriodStartDate(
  noticePeriod: string
): string | undefined {
  const days = parseNoticePeriodDays(noticePeriod);

  if (days === undefined) {
    return undefined;
  }

  const date = new Date();
  date.setDate(date.getDate() + Math.max(days, 1));

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

export function verifyAndCorrectAnswers(
  fields: FormField[],
  answers: Answer[],
  profile: CandidateProfile
): Answer[] {
  const fieldById = new Map(
    fields.map(field => [field.id, field])
  );

  return answers.map(answer => {
    const field = fieldById.get(answer.field_id);

    if (!field) {
      return answer;
    }

    // A notice-period-driven start date is a deterministic
    // computation from the profile, not a guess — the LLM has no
    // reliable notion of "today" on its own (confirmed live: this
    // is exactly why a date field asking for availability, with
    // notice_period = "Immediate", kept failing validation even
    // after an error-triggered retry — the retry prompt had the
    // same gap). Fix it even when the model returned
    // NEEDS_USER_INPUT or an invalid value (e.g. the literal word
    // "Immediate" written into a date field), since there's nothing
    // genuinely ambiguous here once notice_period parses cleanly.
    if (
      field.type === "date" &&
      isStartDateField(field.label)
    ) {
      const computed = noticePeriodStartDate(
        profile.notice_period
      );

      if (computed) {
        return {
          ...answer,
          answer: computed,
          confidence: 1,
          source: "profile",
          needs_user_input: false
        };
      }
    }

    if (
      answer.needs_user_input ||
      !answer.answer ||
      answer.answer === "NEEDS_USER_INPUT"
    ) {
      return answer;
    }

    if (
      isCountryField(field.label) &&
      field.options.length > 0
    ) {
      const correct = findLocationMatchingOption(
        field.options,
        profile.location
      );

      if (
        correct &&
        normalize(correct) !== normalize(answer.answer)
      ) {
        return {
          ...answer,
          answer: correct,
          confidence: 1,
          source: "profile"
        };
      }
    }

    // A hallucinated option that isn't actually on the field would
    // just silently fail to fill anyway — surface it for the user
    // instead of pretending it worked.
    if (!isValidAgainstOptions(field, answer.answer)) {
      return {
        ...answer,
        answer: "NEEDS_USER_INPUT",
        needs_user_input: true,
        confidence: 0
      };
    }

    return answer;
  });
}

/**
 * url/title alone do not tell wizard steps apart (Workday's steps change neither), so the set of field labels is
 * part of the fingerprint.
 */
export function pageFingerprint(data: FormData | undefined): string {
  if (!data) return '';
  return `${data.url}|${data.title}|${data.fields.map((f) => f.label).join('|')}`;
}

/** A required field the agent could not answer on its own. */
export interface PendingQuestion {
  field_id: string;
  label: string;
  answer: string;
}

export function findPendingQuestions(data: FormData, answers: Answer[]): PendingQuestion[] {
  const answerById = new Map(answers.map((a) => [a.field_id, a]));
  return data.fields
    .filter((field) => {
      const answer = answerById.get(field.id);
      return field.required && field.type !== 'file' && (!answer || answer.needs_user_input);
    })
    .map((field) => ({ field_id: field.id, label: field.label, answer: answerById.get(field.id)?.answer || '' }));
}

// ---------------------------------------------------------------
// "How many years of <skill> experience do you have?": 5 years (user, 2026-11-06), or fewer when the technology
// itself is younger than 5 years (nobody has 5 years of ChatGPT). Total / overall experience is not this rule's.

/** When newer technologies became usable, newest first: years answered = this year minus that year (at least 1). */
const TECH_SINCE: Array<[RegExp, number]> = [
  [/\bmcp\b|model context protocol|vibe cod|claude code/i, 2024],
  [/\bai agents?\b|agentic|langchain|llama ?index|\brag\b|retrieval.augmented|vector (db|database)|\bai workflows?\b|\bai automation\b|copilot|\bclaude\b|\bgemini\b|\bcursor\b/i, 2023],
  [/chat ?gpt|generative ai|\bgen ?ai\b|\bllms?\b|large language|prompt engineer|\bgpt.?[34]|openai/i, 2022],
];
const YEARS_Q = /how many years|years of .*experience|experience (in|with|using|of) .*\(?years?\)?|years? .*(worked|working|hands.on)/i;
const TOTAL_Q = /total|overall|relevant|professional experience$|^years of experience$|work experience$/i;
const PREFERRED_YEARS = 5;

export function techYears(question: string, now = new Date()): number | null {
  // A yes/no question ("Do you have a minimum of 3+ years…?") is not asking for a number.
  if (!YEARS_Q.test(question) || TOTAL_Q.test(question.trim()) || /^(do|does|did|have|has|are|is|can|will|would)\b/i.test(question.trim())) return null;
  const since = TECH_SINCE.find(([re]) => re.test(question))?.[1];
  return since ? Math.max(1, Math.min(PREFERRED_YEARS, now.getFullYear() - since - 1)) : PREFERRED_YEARS;
}

function techYearsAnswer(question: string, field: FormField): string | undefined {
  const n = techYears(question);
  if (n === null) return undefined;
  if (!field.options?.length) return String(n);
  // A list: the option that names n, or the range holding it ("3-5 years", "5+").
  const nums = (o: string) => (o.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  const pick = field.options.find((o) => nums(o).length === 1 && nums(o)[0] === n && !/[<>+]|less|more|above|below/i.test(o))
    ?? field.options.find((o) => { const [a, b] = nums(o); return a !== undefined && b !== undefined && a <= n && n <= b; })
    ?? field.options.find((o) => { const [a] = nums(o); return a !== undefined && a <= n && /\+|more|above|or more/i.test(o); });
  return pick;
}
