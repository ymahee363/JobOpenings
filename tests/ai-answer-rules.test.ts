// Ported from job-apply-ai-mvp (extension/src/sidepanel/ApplyView.test.ts).
import { describe, expect, it } from "vitest";

import type {
  CandidateProfile,
  ExperienceEntry,
  FormField
} from "../src/shared/ai-apply/types";

import {
  containsWholeWord,
  directMapAnswer,
  educationEntryAnswer,
  enrichEntryFieldLabel,
  experienceEntryAnswer,
  findLocationMatchingOption,
  findPendingQuestions,
  fuzzyTextMatch,
  isCountryField,
  isCoverLetterLabel,
  isPlaceholderValue,
  isResumeLabel,
  isValidAgainstOptions,
  noticePeriodStartDate,
  parseNoticePeriodDays,
  splitName
} from "../src/shared/ai-apply/answer-rules";

function makeField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "f1",
    label: "Label",
    type: "text",
    required: false,
    options: [],
    current_value: "",
    ...overrides
  };
}

function makeExperience(
  overrides: Partial<ExperienceEntry> = {}
): ExperienceEntry {
  return {
    title: "AI Product Lead",
    company: "Nu10",
    location: "Bengaluru",
    start_date: "Apr 2026",
    end_date: "Jul 2026",
    current: false,
    description: "",
    ...overrides
  };
}

function makeProfile(
  overrides: Partial<CandidateProfile> = {}
): CandidateProfile {
  return {
    name: "Mahendra Yadav",
    email: "mahendra@example.com",
    phone: "9999999999",
    location: "Bengaluru",
    notice_period: "15 days",
    education: [
      {
        institution: "IIT Guwahati",
        degree: "B.Tech",
        graduation_year: 2021
      }
    ],
    experience: [makeExperience()],
    skills: ["Product Management"],
    linkedin: "",
    portfolio: "",
    custom_fields: [],
    extra_information: "",
    additional_facts: {},
    ...overrides
  };
}

describe("containsWholeWord / fuzzyTextMatch", () => {
  // Regression test — confirmed live bug: plain substring matching
  // treated "female" as containing "male" and matched the wrong
  // gender/country option because the wrong one happened to come
  // first in DOM order.
  it("does not treat 'male' as contained in 'female'", () => {
    expect(containsWholeWord("female", "male")).toBe(false);
  });

  it("does not treat 'india' as contained in a longer country name via a stray substring", () => {
    expect(
      containsWholeWord("british indian ocean territory", "india")
    ).toBe(false);
  });

  it("matches a real whole-word occurrence", () => {
    expect(containsWholeWord("male", "male")).toBe(true);
    expect(containsWholeWord("prefer male", "male")).toBe(true);
  });

  it("fuzzyTextMatch is symmetric and whole-word based", () => {
    expect(fuzzyTextMatch("india", "india")).toBe(true);
    expect(fuzzyTextMatch("male", "female")).toBe(false);
  });
});

describe("findPendingQuestions", () => {
  // Regression test for "optional data not filling" — an optional
  // field the LLM couldn't answer must never be silently dropped
  // from what findPendingQuestions reports as fillable via a
  // required-only escalation, nor should a REQUIRED field with the
  // same problem go unnoticed.
  it("surfaces a required field the agent could not resolve", () => {
    const field = makeField({
      id: "req1",
      label: "Work authorization",
      required: true
    });

    const pending = findPendingQuestions(
      { url: "", title: "", page_text: "", fields: [field] },
      [
        {
          field_id: "req1",
          answer: "NEEDS_USER_INPUT",
          confidence: 0,
          source: "missing",
          needs_user_input: true
        }
      ]
    );

    expect(pending).toHaveLength(1);
    expect(pending[0]!.field_id).toBe("req1");
  });

  it("does NOT surface an optional field left unanswered (by design — it's meant to just stay blank, not block the run)", () => {
    const field = makeField({
      id: "opt1",
      label: "Twitter handle",
      required: false
    });

    const pending = findPendingQuestions(
      { url: "", title: "", page_text: "", fields: [field] },
      [
        {
          field_id: "opt1",
          answer: "NEEDS_USER_INPUT",
          confidence: 0,
          source: "missing",
          needs_user_input: true
        }
      ]
    );

    expect(pending).toHaveLength(0);
  });

  it("does not surface a required field that already has a confident answer", () => {
    const field = makeField({
      id: "req2",
      label: "Full name",
      required: true
    });

    const pending = findPendingQuestions(
      { url: "", title: "", page_text: "", fields: [field] },
      [
        {
          field_id: "req2",
          answer: "Mahendra Yadav",
          confidence: 1,
          source: "profile",
          needs_user_input: false
        }
      ]
    );

    expect(pending).toHaveLength(0);
  });

  it("never surfaces a file field (handled by a dedicated upload path, not the pending-question UI)", () => {
    const field = makeField({
      id: "file1",
      label: "Resume",
      required: true,
      type: "file"
    });

    const pending = findPendingQuestions(
      { url: "", title: "", page_text: "", fields: [field] },
      []
    );

    expect(pending).toHaveLength(0);
  });
});

describe("experienceEntryAnswer", () => {
  const profile = makeProfile({
    experience: [
      makeExperience({
        title: "AI Product Lead",
        company: "Nu10 (AI Product Development)",
        current: false
      }),
      makeExperience({
        title: "Founder & Product Manager",
        company: "BestSpaceFinder",
        current: true
      })
    ]
  });

  it("maps Job Title deterministically for the matching entry index", () => {
    const field = makeField({
      label: "Job Title",
      entry_type: "experience",
      entry_index: 0
    });

    expect(experienceEntryAnswer(field, profile)).toBe(
      "AI Product Lead"
    );
  });

  it("maps the second block's Company to the second experience entry, not the first", () => {
    const field = makeField({
      label: "Company",
      entry_type: "experience",
      entry_index: 1
    });

    expect(experienceEntryAnswer(field, profile)).toBe(
      "BestSpaceFinder"
    );
  });

  it("answers a 'currently work here' checkbox from entry.current, per block", () => {
    const stillThere = makeField({
      label: "I currently work here",
      type: "checkbox",
      entry_type: "experience",
      entry_index: 1
    });

    const notAnymore = makeField({
      label: "I currently work here",
      type: "checkbox",
      entry_type: "experience",
      entry_index: 0
    });

    expect(experienceEntryAnswer(stillThere, profile)).toBe("Yes");
    expect(experienceEntryAnswer(notAnymore, profile)).toBe("No");
  });

  it("returns undefined for a field with no entry_type (not part of a repeatable block)", () => {
    const field = makeField({ label: "Job Title" });
    expect(experienceEntryAnswer(field, profile)).toBeUndefined();
  });

  it("returns undefined when entry_index has no matching profile entry", () => {
    const field = makeField({
      label: "Job Title",
      entry_type: "experience",
      entry_index: 5
    });

    expect(experienceEntryAnswer(field, profile)).toBeUndefined();
  });
});

describe("educationEntryAnswer", () => {
  const profile = makeProfile({
    education: [
      { institution: "IIT Guwahati", degree: "B.Tech" }
    ]
  });

  it("maps 'Which college did you graduate from' style labels to institution", () => {
    const field = makeField({
      label: "Which college did you complete your graduation from?",
      entry_type: "education",
      entry_index: 0
    });

    expect(educationEntryAnswer(field, profile)).toBe(
      "IIT Guwahati"
    );
  });

  it("maps Degree", () => {
    const field = makeField({
      label: "Degree",
      entry_type: "education",
      entry_index: 0
    });

    expect(educationEntryAnswer(field, profile)).toBe("B.Tech");
  });
});

describe("enrichEntryFieldLabel", () => {
  const profile = makeProfile({
    experience: [
      makeExperience({ title: "AI Product Lead", company: "Nu10" }),
      makeExperience({
        title: "Founder & Product Manager",
        company: "BestSpaceFinder"
      })
    ]
  });

  it("folds the entry's role/company into the label so the LLM can tell blocks apart", () => {
    const field = makeField({
      label: "Start Date Month",
      entry_type: "experience",
      entry_index: 1
    });

    const enriched = enrichEntryFieldLabel(field, profile);

    expect(enriched.label).toContain("Founder & Product Manager");
    expect(enriched.label).toContain("BestSpaceFinder");
    expect(enriched.label).toContain("Start Date Month");
  });

  it("leaves a field with no entry_type completely unchanged", () => {
    const field = makeField({ label: "Email" });
    expect(enrichEntryFieldLabel(field, profile)).toEqual(field);
  });

  it("falls back to the section name for a generic (non experience/education) repeatable block", () => {
    const field = makeField({
      label: "Certification name",
      entry_type: "certifications",
      entry_index: 0
    });

    const enriched = enrichEntryFieldLabel(field, profile);

    expect(enriched.label).toContain("certifications");
    expect(enriched.label).toContain("Certification name");
  });
});

describe("directMapAnswer", () => {
  it("maps email directly from the profile", () => {
    const profile = makeProfile({ email: "a@b.com" });
    const field = makeField({ label: "Email address" });
    expect(directMapAnswer(field, profile)).toBe("a@b.com");
  });

  it("splits full name into first/last for separate fields", () => {
    const profile = makeProfile({ name: "Mahendra Yadav" });
    expect(
      directMapAnswer(makeField({ label: "First name" }), profile)
    ).toBe("Mahendra");
    expect(
      directMapAnswer(makeField({ label: "Last name" }), profile)
    ).toBe("Yadav");
  });

  // Regression guard — confirmed live bug: current_ctc (a raw
  // number like 2700000) was once copied verbatim into a field
  // asking "current CTC in LPA" (which should read "27"), because a
  // direct string copy bypassed the LLM's unit interpretation
  // entirely. CTC/salary must never be direct-mapped.
  it("never direct-maps CTC fields — the unit/format needs LLM interpretation", () => {
    const profile = makeProfile({ current_ctc: 2700000 });
    const field = makeField({ label: "Current CTC (in LPA)" });
    expect(directMapAnswer(field, profile)).toBeUndefined();
  });

  it("does not direct-map a phone field that is actually asking about phone TYPE", () => {
    const profile = makeProfile({ phone: "9999999999" });
    const field = makeField({ label: "Phone type" });
    expect(directMapAnswer(field, profile)).toBeUndefined();
  });

  it("does not direct-map a label redirected to someone else (reference/emergency contact)", () => {
    const profile = makeProfile({ phone: "9999999999" });
    const field = makeField({ label: "Emergency contact phone" });
    expect(directMapAnswer(field, profile)).toBeUndefined();
  });

  it("falls back to a matching custom field by fuzzy label match", () => {
    const profile = makeProfile({
      custom_fields: [
        { id: "1", name: "Work authorization", value: "Yes" }
      ]
    });

    const field = makeField({ label: "Work authorization" });
    expect(directMapAnswer(field, profile)).toBe("Yes");
  });
});

describe("parseNoticePeriodDays / noticePeriodStartDate", () => {
  it("parses days/weeks/months", () => {
    expect(parseNoticePeriodDays("15 days")).toBe(15);
    expect(parseNoticePeriodDays("2 weeks")).toBe(14);
    expect(parseNoticePeriodDays("1 month")).toBe(30);
  });

  it("treats Immediate as 0 days", () => {
    expect(parseNoticePeriodDays("Immediate")).toBe(0);
    expect(parseNoticePeriodDays("ASAP")).toBe(0);
  });

  it("returns undefined for unparseable text rather than guessing", () => {
    expect(parseNoticePeriodDays("Negotiable")).toBeUndefined();
  });

  // A computed start date is never today, even for "Immediate" —
  // most ATS date fields reject a same-day start.
  it("never returns today's date, even for Immediate notice", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(noticePeriodStartDate("Immediate")).not.toBe(today);
  });
});

describe("isValidAgainstOptions", () => {
  it("validates every part of a comma-separated multi-select answer", () => {
    const field = makeField({
      type: "checkbox",
      options: ["Python", "SQL", "Excel"]
    });

    expect(isValidAgainstOptions(field, "Python, SQL")).toBe(true);
    expect(isValidAgainstOptions(field, "Python, Rust")).toBe(false);
  });

  it("passes through fields with no fixed option list (free text)", () => {
    const field = makeField({ type: "text", options: [] });
    expect(isValidAgainstOptions(field, "anything")).toBe(true);
  });
});

describe("isCountryField / findLocationMatchingOption", () => {
  it("identifies a country field but excludes a phone country CODE field", () => {
    expect(isCountryField("Country")).toBe(true);
    expect(isCountryField("Phone country code")).toBe(false);
  });

  // Regression guard — confirmed live bug: "India" matched onto
  // "British Indian Ocean Territory" via plain substring matching.
  it("does not let a real country match a decoy containing it as a substring", () => {
    const options = [
      "British Indian Ocean Territory",
      "India"
    ];

    expect(
      findLocationMatchingOption(options, "Bengaluru, India")
    ).toBe("India");
  });
});

describe("isPlaceholderValue / splitName", () => {
  it("treats select-prompt placeholders as not a real value", () => {
    expect(isPlaceholderValue("-Select-")).toBe(true);
    expect(isPlaceholderValue("Choose one")).toBe(true);
    expect(isPlaceholderValue("Bengaluru")).toBe(false);
  });

  it("treats a native <select>'s unpicked default option as a placeholder even with unfamiliar wording", () => {
    expect(isPlaceholderValue("N/A")).toBe(true);
    expect(isPlaceholderValue("None Selected")).toBe(true);
    expect(isPlaceholderValue("Not Applicable")).toBe(true);
  });

  it("does not mistake a real answer that merely starts with a placeholder-ish substring for a placeholder", () => {
    expect(isPlaceholderValue("National University")).toBe(false);
    expect(isPlaceholderValue("No")).toBe(false);
    expect(isPlaceholderValue("None of the above, I built it myself")).toBe(false);
  });

  it("splits a single-word name without crashing", () => {
    expect(splitName("Madonna")).toEqual({
      first: "Madonna",
      last: ""
    });
  });
});

describe("isResumeLabel / isCoverLetterLabel", () => {
  it("recognizes resume, CV, and curriculum vitae as the same synonym", () => {
    expect(isResumeLabel("Resume")).toBe(true);
    expect(isResumeLabel("Upload your CV")).toBe(true);
    expect(isResumeLabel("Please attach your Curriculum Vitae")).toBe(
      true
    );
    expect(isResumeLabel("Link to CV *")).toBe(true);
  });

  it("does not match on an unrelated label", () => {
    expect(isResumeLabel("Phone number")).toBe(false);
    expect(isResumeLabel("Country")).toBe(false);
  });

  it("recognizes cover letter phrasing regardless of word order", () => {
    expect(isCoverLetterLabel("Cover Letter")).toBe(true);
    expect(isCoverLetterLabel("Letter of interest / Cover")).toBe(
      true
    );
    expect(isCoverLetterLabel("Cover note")).toBe(true);
    expect(isCoverLetterLabel("Resume")).toBe(false);
  });
});
