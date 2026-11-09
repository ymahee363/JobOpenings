import { describe, expect, it } from 'vitest';
import {
  companyNames, foreignCompanies, institutionAliases, readMonthYear, reviewBeforeSubmit, sameInstitution, type ReviewedAnswer,
} from '../src/shared/ai-apply/pre-submit';
import { DEFAULT_PROFILE } from '../src/shared/ai-apply/profile';
import type { CandidateProfile, FormField } from '../src/shared/ai-apply/types';

const PROFILE: CandidateProfile = {
  ...DEFAULT_PROFILE,
  phone: '6264252896',
  linkedin: 'https://www.linkedin.com/in/mahendra-yadav/',
  portfolio: 'https://www.mahendrayadavpm.in/',
  custom_fields: [{ id: '1', name: 'Github', value: 'https://github.com/ymahee363' }],
};
const JOB = { company: 'Target', title: 'Product Manager' };

let n = 0;
const ans = (label: string, answer: string, over: Partial<FormField> = {}, onPage = true): ReviewedAnswer => ({
  field: { id: `f${n += 1}`, label, type: 'text', required: false, options: [], current_value: answer, ...over }, answer, onPage,
});
const exp = (i: number, label: string, answer: string, over: Partial<FormField> = {}) => ans(label, answer, { entry_type: 'experience', entry_index: i, ...over });
const review = (answers: ReviewedAnswer[], pageText = '', job: { company: string; title: string; url?: string } = JOB) =>
  reviewBeforeSubmit({ profile: PROFILE, job, answers, pageText, reviewPage: !!pageText });

/** A complete, correct work-experience section: five companies, start/end month and year each. */
const goodExperience = () => PROFILE.experience.flatMap((e, i) => {
  const [sm, sy] = e.start_date.split(' ');
  const [em, ey] = e.end_date.split(' ');
  return [
    exp(i, 'Company', e.company.replace(/\s*\(.*$/, '')), exp(i, 'Job title', e.title),
    exp(i, 'Start month', sm!), exp(i, 'Start year', sy!), exp(i, 'End month', em!), exp(i, 'End year', ey!),
  ];
});

describe('names', () => {
  it('knows a company by its short name and brand', () => {
    expect(companyNames('Dresma (DoMyShoot: AI Product Photography & Content Creation Mobile & Web App)')).toEqual(
      expect.arrayContaining(['Dresma', 'DoMyShoot']));
    expect(companyNames('Nu10 (AI Product Development)')).toContain('Nu10');
    expect(companyNames('Nu10 (AI Product Development)')).not.toContain('AI Product Development');
  });

  it('knows IIT Guwahati under all its names', () => {
    const al = institutionAliases('IIT Guwahati');
    for (const v of ['IIT Guwahati', 'Indian Institute of Technology Guwahati', 'Indian Institute of Technology, Guwahati', 'IITG', 'IIT-Guwahati', 'Indian Institute of Technology (IIT), Guwahati']) {
      expect(sameInstitution(v, al), v).toBe(true);
    }
    expect(sameInstitution('IIT Bombay', al)).toBe(false);
    expect(sameInstitution('Guwahati University', al)).toBe(false);
  });

  it('reads months and years in any writing', () => {
    expect(readMonthYear('April')).toEqual({ month: 4, year: undefined });
    expect(readMonthYear('04/2026')).toEqual({ month: 4, year: 2026 });
    expect(readMonthYear('2026-04')).toEqual({ month: 4, year: 2026 });
    expect(readMonthYear('Apr 2026')).toEqual({ month: 4, year: 2026 });
    expect(readMonthYear('7')).toEqual({ month: 7, year: undefined });
  });
});

describe('other companies in a message', () => {
  const allowed = [...PROFILE.experience.flatMap((e) => companyNames(e.company)), ...companyNames('Target'), 'IIT Guwahati'];
  it('flags a company that is not on your resume, or a different addressee', () => {
    expect(foreignCompanies('I am excited to join Flipkart and build data products.', allowed)).toEqual(['Flipkart']);
    expect(foreignCompanies('During my time at Acme Robotics I shipped three products.', allowed)).toEqual(['Acme Robotics']);
    expect(foreignCompanies('I worked at Google on search ads.', allowed)).toEqual(['Google']);
  });

  it('allows your companies, the company you apply to, tools and plain words', () => {
    expect(foreignCompanies('At Xaigi and Dresma (DoMyShoot) I built AI products; I would love to join Target.', allowed)).toEqual([]);
    expect(foreignCompanies('I used Google Analytics, Figma and SQL, and grew target users with linear growth.', allowed)).toEqual([]);
    expect(foreignCompanies('I have experience with Python and worked with Engineering teams.', allowed)).toEqual([]);
    expect(foreignCompanies('My time at IIT Guwahati taught me rigour.', allowed)).toEqual([]);
  });
});

describe('the pre-submit review', () => {
  it('passes a correct application, section by section', () => {
    const r = review([
      ans('Full name', PROFILE.name), ans('Email', PROFILE.email), ans('Phone', '+91 6264252896'),
      ...goodExperience(),
      ans('School or university', 'Indian Institute of Technology Guwahati', { entry_type: 'education' }), ans('Degree', "Bachelor's Degree"), ans('Graduation year', '2021'),
      ans('LinkedIn profile', 'linkedin.com/in/mahendra-yadav'), ans('Website', 'https://github.com/ymahee363'),
      ans('Why Target?', 'At Xaigi I built AI products used by thousands; I want to bring that to Target.', { type: 'textarea' }),
    ]);
    expect(r.findings).toEqual([]);
    expect(r.passed.join(' | ')).toMatch(/all 5 companies.*20 start\/end month-year.*education.*links: 2.*messages: 1/);
  });

  it('catches a wrong month or year and gives the right value in the box\'s own style', () => {
    const answers = goodExperience();
    answers.find((a) => a.field.entry_index === 2 && a.field.label === 'Start month')!.answer = 'July'; // resume: Jun 2024
    answers.find((a) => a.field.entry_index === 0 && a.field.label === 'End year')!.answer = '2025'; // resume: Jul 2026
    const r = review(answers);
    expect(r.findings.map((f) => [f.label, f.set])).toEqual([['End year (Nu10)', '2026'], ['Start month (Xaigi)', 'June']]);
  });

  it('checks one-box dates too ("MM/YYYY") and keeps their format', () => {
    const r = review([exp(1, 'From', '09/2025'), exp(1, 'To', '03/2026')]);
    const dates = r.findings.filter((f) => f.field_id);
    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatchObject({ section: 'experience', problem: 'is "09/2025", your resume says Aug 2025', set: '08/2025' });
  });

  it('notices companies missing from the work experience section', () => {
    const answers = goodExperience().filter((a) => a.field.entry_index! < 3);
    const r = review(answers);
    expect(r.findings).toContainEqual(expect.objectContaining({ section: 'experience', problem: 'missing 2 of 5 companies: Dezigner Hooman, Dresma' }));
  });

  it('does not count a company named only in a cover letter as a work-experience entry (seen live)', () => {
    const answers = [...goodExperience().filter((a) => a.field.entry_index! < 4), ans('Cover letter', 'At Dresma I grew an AI photography app.', { type: 'textarea' })];
    expect(review(answers).findings).toContainEqual(expect.objectContaining({ problem: 'missing 1 of 5 companies: Dresma' }));
  });

  it('accepts companies a Review page lists in its text', () => {
    const r = review([ans('Company', 'Nu10')], 'Work Experience Nu10 BestSpaceFinder Xaigi Dezigner Hooman Dresma');
    expect(r.findings.filter((f) => f.section === 'experience')).toEqual([]);
  });

  it('does not take a job description beside the form for an experience section', () => {
    const r = reviewBeforeSubmit({ profile: PROFILE, job: JOB, answers: [ans('Company', 'Nu10')], pageText: 'Requirements: 5+ years of work experience in product.', reviewPage: false });
    expect(r.findings).toEqual([]);
  });

  it('knows the company you apply to from the site address when the job record has no name', () => {
    const r = review([ans('Why us?', 'I would love to join Allstate and grow its data products.', { type: 'textarea' })], '', { company: '', title: 'PM', url: 'https://allstate.wd5.myworkdayjobs.com/en-US/allstate_careers/job/1' });
    expect(r.findings).toEqual([]);
    const other = review([ans('Why us?', 'I would love to join Allstate and grow its data products.', { type: 'textarea' })], '', { company: '', title: 'PM', url: 'https://target.wd5.myworkdayjobs.com/x' });
    expect(other.findings.map((f) => f.problem)).toEqual(['names Allstate, which is not on your resume']);
  });

  it('fixes a wrong college, and flags a wrong degree or year', () => {
    const r = review([
      ans('University', 'IIT Bombay', { options: ['IIT Bombay', 'Indian Institute of Technology Guwahati'] }),
      ans('Degree', 'Master of Business Administration'),
      ans('Graduation year', '2019'),
    ]);
    expect(r.findings.map((f) => [f.section, f.set])).toEqual([['education', 'Indian Institute of Technology Guwahati'], ['education', undefined], ['education', '2021']]);
  });

  it('puts the right link in each link box; a general link box may hold any of your links', () => {
    const r = review([
      ans('LinkedIn', 'https://github.com/ymahee363'),
      ans('GitHub', ''),
      ans('Portfolio', 'https://www.linkedin.com/in/mahendra-yadav/'),
      ans('Other link', 'https://example.com/someone-else'),
    ]);
    expect(r.findings.map((f) => [f.label, f.set])).toEqual([
      ['LinkedIn', PROFILE.linkedin], ['GitHub', 'https://github.com/ymahee363'], ['Other link', PROFILE.portfolio],
    ]);
  });

  it('rewrites a message that names another company, keeps a placeholder or a strange link out', () => {
    const r = review([
      ans('Cover letter', 'Dear [Hiring Manager], I am thrilled to join Flipkart. See https://my-fake-site.com/me', { type: 'textarea' }),
      ans('Additional information', 'My portfolio: https://www.mahendrayadavpm.in/ and GitHub https://github.com/ymahee363', { type: 'textarea' }),
    ]);
    const msg = r.findings.filter((f) => f.section === 'message');
    expect(msg.map((f) => f.problem)).toEqual([
      'names Flipkart, which is not on your resume or Target',
      'has a placeholder "[Hiring Manager]"',
      'has a link that is not yours: https://my-fake-site.com/me',
    ]);
    expect(msg.every((f) => f.rewrite)).toBe(true);
  });

  it('does not take your title "AI Product Lead" for AI meta-text (seen live)', () => {
    const r = review([ans('Cover letter', 'As an AI Product Lead at Nu10, I shipped three AI products. I am an AI product manager at heart.', { type: 'textarea' })]);
    expect(r.findings).toEqual([]);
  });

  it('stops on an empty required field, AI meta-text, or a wrong email; an earlier page cannot be changed now', () => {
    const r = review([
      ans('Notice period', '', { required: true }),
      ans('Why us?', 'As an AI, I cannot know.', { type: 'textarea' }),
      ans('Email', 'someone@else.com', {}, false),
    ]);
    expect(r.findings.map((f) => [f.section, f.problem.slice(0, 20), f.set])).toEqual([
      ['general', 'required but empty', undefined], ['general', 'holds "As an AI,"', undefined], ['contact', 'is "someone@else.com', undefined],
    ]);
  });
});
