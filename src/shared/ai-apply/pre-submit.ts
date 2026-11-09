/**
 * The pre-submit QA agent: before the final Submit (and before a filled form is handed to you), it reviews the whole
 * application against your profile, section by section:
 *
 *  - Work experience: every company on your resume is in the form, and each entry's start/end month and year match
 *    your profile (a month box, a year box or one "MM/YYYY" date).
 *  - Messages (cover letter, "why us", any long answer): no company other than the ones on your resume, the company
 *    you are applying to and your college; no leftover placeholder ("[Company Name]"); no link that is not yours;
 *    no AI meta-text ("As an AI…").
 *  - Education: the college is your college, under any of its names ("IIT Guwahati", "Indian Institute of
 *    Technology Guwahati", "IITG"); the degree and graduation year match.
 *  - Links: LinkedIn, GitHub, portfolio fields hold your links (and the right one in each).
 *  - Contact: name, email and phone are yours.
 *  - General: no required field left empty, no "NEEDS_USER_INPUT", "undefined", "[object Object]".
 *
 * It reads everything answered on every page of the application (earlier pages too) plus the final page's own text
 * (a Review page lists every section). Each finding says whether it can be fixed on the page now (a value to set, a
 * message to rewrite) or stops the Submit. Pure: tests in tests/pre-submit.test.ts; the flow runs it.
 */
import type { CandidateProfile, FormField } from './types';

export type Section = 'experience' | 'education' | 'links' | 'message' | 'contact' | 'general';

export interface ReviewedAnswer {
  field: FormField;
  answer: string;
  /** On the page that is open now (so it can still be changed). */
  onPage: boolean;
}

export interface Finding {
  section: Section;
  field_id?: string;
  label: string;
  problem: string;
  /** A value that fixes it, set on the page now. */
  set?: string;
  /** Rewrite this message so it mentions only `allowed` companies. */
  rewrite?: { allowed: string[] };
}

export interface ReviewInput {
  profile: CandidateProfile;
  /** `url`: the application's address; a name in its host ("target.wd5.myworkdayjobs.com") is the employer's. */
  job: { company: string; title: string; url?: string };
  answers: ReviewedAnswer[];
  /** The open page's text (a Review page shows every section). */
  pageText: string;
  /**
   * The page is a Review/summary page listing every section (Workday's Review). Only then does its text count as the
   * form's sections; elsewhere it is often the job description ("5 years of work experience at a startup").
   */
  reviewPage?: boolean;
}

export interface Review {
  findings: Finding[];
  /** What was checked and is fine, for the log: "experience: 5 of 5 companies, dates match". */
  passed: string[];
}

// ------------------------------------------------------------------ names

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (s: string) => norm(s).replace(/ /g, '');

/** A company's names: "Dresma (DoMyShoot: AI Product Photography …)" → "Dresma (DoMyShoot: …)", "Dresma", "DoMyShoot". */
export function companyNames(company: string): string[] {
  const out = new Set<string>();
  const c = company.trim();
  if (!c) return [];
  out.add(c);
  const base = c.replace(/\s*\(.*$/, '').trim();
  if (base) out.add(base);
  const inner = /\(([^):]+)[:)]/.exec(c)?.[1]?.trim();
  // "(DoMyShoot: …)" names a product brand; "(AI Product Development)" only describes the work.
  if (inner && inner.split(/\s+/).length <= 3 && !/development|marketplace|consult|services|product|platform|app\b/i.test(inner)) out.add(inner);
  // Without a legal suffix: "Acme Technologies Pvt Ltd" → "Acme Technologies", "Acme".
  const bare = base.replace(/\b(private|pvt|limited|ltd|llp|inc|corp(oration)?|co|gmbh|plc|technologies|technology|labs|solutions|software|systems|india)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
  if (bare && bare.length >= 3) out.add(bare);
  return [...out];
}

/** A college's names: "Indian Institute of Technology Guwahati" ↔ "IIT Guwahati" ↔ "IITG". */
export function institutionAliases(name: string): string[] {
  const out = new Set<string>([name]);
  const n = norm(name).replace(/\biit\b/, 'indian institute of technology').replace(/\bnit\b/, 'national institute of technology').replace(/\biim\b/, 'indian institute of management');
  const long = n;
  const forms: Array<[RegExp, string]> = [
    [/^indian institute of technology (.+)$/, 'IIT'], [/^national institute of technology (.+)$/, 'NIT'], [/^indian institute of management (.+)$/, 'IIM'],
  ];
  out.add(long);
  for (const [re, short] of forms) {
    const m = re.exec(long);
    if (m) {
      out.add(`${short} ${m[1]}`);
      out.add(`${short}${m[1]![0]!.toUpperCase()}`); // IITG
      out.add(`${short} ${m[1]![0]!.toUpperCase()}`);
    }
  }
  return [...out];
}

export function sameInstitution(value: string, aliases: string[]): boolean {
  const v = compact(value.replace(/\(\s*iit\s*\)/i, ''));
  return !!v && aliases.some((a) => {
    const c = compact(a);
    return v === c || v.includes(c) || (c.length >= 8 && c.includes(v) && v.length >= 6);
  });
}

// ------------------------------------------------------------------ dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Apr 2026" → { month: 4, year: 2026 }. */
export function profileMonthYear(s: string): { month?: number; year?: number } {
  const t = s.trim().toLowerCase();
  const m = MONTHS.findIndex((x) => t.includes(x));
  const y = /\b(19|20)\d{2}\b/.exec(t);
  return { month: m >= 0 ? m + 1 : undefined, year: y ? Number(y[0]) : undefined };
}

/** What a form value says: "April" → month 4; "2026" → year; "04/2026", "2026-04", "Apr 2026" → both. */
export function readMonthYear(v: string): { month?: number; year?: number } {
  const t = v.trim().toLowerCase();
  if (!t) return {};
  const word = MONTHS.findIndex((x) => new RegExp(`\\b${x}`).test(t));
  const year = /\b(19|20)\d{2}\b/.exec(t);
  let month: number | undefined = word >= 0 ? word + 1 : undefined;
  if (month === undefined) {
    const iso = /\b(?:19|20)\d{2}[-/.](\d{1,2})\b/.exec(t);
    const us = /\b(\d{1,2})[-/.](?:\d{1,2}[-/.])?(?:19|20)\d{2}\b/.exec(t);
    const alone = /^(\d{1,2})$/.exec(t);
    const n = Number(iso?.[1] ?? us?.[1] ?? alone?.[1]);
    if (n >= 1 && n <= 12) month = n;
  }
  return { month, year: year ? Number(year[0]) : undefined };
}

const isStart = (label: string) => /\b(start|from|began|joined|joining|since)\b/i.test(label);
const isEnd = (label: string) => /\b(end|to|until|till|left|leaving|through)\b/i.test(label);
const isMonthOnly = (label: string, value: string) => /\bmonth\b/i.test(label) && !/\byear\b/i.test(label) || (/^(\d{1,2}|[a-z]{3,9})$/i.test(value.trim()) && !/^\d{4}$/.test(value.trim()));
const isYearOnly = (label: string, value: string) => /\byear\b/i.test(label) && !/\bmonth\b/i.test(label) || /^\d{4}$/.test(value.trim());

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The expected value written like the one in the box: "April" / "Apr" / "04" / "4" for a month, "MM/YYYY" etc. */
function expectedLike(current: string, want: { month?: number; year?: number }, part: 'month' | 'year' | 'both', options: string[]): string | undefined {
  if (!want.month && part !== 'year') return undefined;
  if (!want.year && part !== 'month') return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  const pick = (cands: string[]) => (options.length ? options.find((o) => cands.some((c) => norm(o) === norm(c))) : cands[0]);
  if (part === 'year') return pick([String(want.year)]);
  if (part === 'month') {
    const m = want.month!;
    const cands = /^\d/.test(current) ? [pad(m), String(m), MONTH_NAMES[m - 1]!, MONTH_NAMES[m - 1]!.slice(0, 3)] : [MONTH_NAMES[m - 1]!, MONTH_NAMES[m - 1]!.slice(0, 3), pad(m), String(m)];
    return pick(cands);
  }
  const t = current.trim();
  if (/^\d{4}-\d{1,2}/.test(t)) return `${want.year}-${pad(want.month!)}`;
  if (/^[a-z]{3,9}\s+\d{4}$/i.test(t)) return `${(/^[a-z]{4,}/i.test(t) ? MONTH_NAMES[want.month! - 1] : MONTH_NAMES[want.month! - 1]!.slice(0, 3))} ${want.year}`;
  return `${pad(want.month!)}/${want.year}`;
}

// ------------------------------------------------------------------ messages

/** Placeholders a template left behind. */
const PLACEHOLDER = /\[(?:company|company name|hiring manager|role|job title|position|name|your name)[^\]]*\]|\{(?:company|role|name|position)[^}]*\}|<(?:company|role|name)[^>]*>|\b(?:XYZ|ABC) (?:company|corp|ltd|inc)\b|\bcompany name here\b/i;
// "As an AI, I…" / "as an AI language model": not "as an AI Product Lead" (your title; seen live 2026-11-06).
const META = /\bas an ai(?:\s*[,.;:]|\s+(?:language model|model|assistant|system)\b)|\bi (?:am|'m) (?:an ai\b(?!\s+product)|a language model)\b|\bi cannot (?:help|provide)\b|NEEDS_USER_INPUT|\[object Object\]|\bundefined\b|\bnull\b(?! and void)/i;

/** Companies that, named anywhere in a message (with their capitals), are a claim about an employer or the addressee. */
const KNOWN_COMPANIES = [
  'Flipkart', 'Swiggy', 'Zomato', 'Paytm', 'PhonePe', 'Razorpay', 'CRED', 'Myntra', 'Meesho', 'Zepto', 'Blinkit', 'BigBasket', 'Nykaa',
  "Byju's", 'Byjus', 'Unacademy', 'Freshworks', 'Zoho', 'Infosys', 'TCS', 'Tata Consultancy Services', 'Wipro', 'HCL', 'Tech Mahindra', 'Accenture',
  'Deloitte', 'McKinsey', 'BCG', 'KPMG', 'PwC', 'Capgemini', 'Cognizant', 'Walmart', 'Allstate', 'Cisco', 'Sophos',
  'PayU', 'Nielsen', 'Groww', 'Zerodha', 'Rapido', 'Dunzo', 'Urban Company', 'Lenskart', 'Delhivery', 'Juspay', 'InMobi', 'ShareChat',
  'Dream11', 'MakeMyTrip', 'OYO', 'Udaan', 'Cars24', 'PolicyBazaar', 'Pine Labs', 'BharatPe', 'upGrad', 'Vedantu', 'Practo',
  'PharmEasy', 'Tata 1mg', 'HealthifyMe', 'Cult.fit', 'Curefit', 'Reliance', 'Airtel', 'HDFC', 'ICICI', 'Kotak', 'Goldman Sachs',
  'JPMorgan', 'J.P. Morgan', 'Morgan Stanley', 'American Express', 'Mastercard', 'PayPal', 'Intuit', 'VMware', 'Samsung', 'Uber', 'Airbnb',
  'Netflix', 'Booking.com', 'Expedia', 'Agoda', 'Gojek', 'Shopee', 'Rakuten', 'Coinbase', 'Binance', 'Palantir', 'Twilio',
  'Okta', 'Cloudflare', 'GitLab', 'HackerRank', 'Brex', 'Zapier', 'Replit', 'Hugging Face', 'eBay', 'Consilio', 'CareSource',
];
/**
 * Names that are also products, tools or plain words ("Google Analytics", "my LinkedIn", "target users", "linear
 * growth"): a claim only after "worked at / joining / role at".
 */
const CONTEXT_ONLY_COMPANIES = [
  'Google', 'Amazon', 'Microsoft', 'Apple', 'Meta', 'Facebook', 'Salesforce', 'Adobe', 'Oracle', 'SAP', 'IBM', 'LinkedIn', 'Twitter', 'Slack',
  'Figma', 'Notion', 'Atlassian', 'Zoom', 'Stripe', 'Shopify', 'OpenAI', 'Anthropic', 'Canva', 'Nvidia', 'Intel', 'Dropbox', 'HubSpot',
  'Snowflake', 'Databricks', 'Mixpanel', 'Amplitude', 'Tableau', 'Spotify',
  'Target', 'Linear', 'Ramp', 'Motive', 'Grab', 'Ola', 'Bain', 'Discord', 'Sardine', 'Jio', 'Spinny', 'Slice', 'Jupiter', 'Navi', 'EY',
];
/** A sentence that says where you worked or which company you are joining: the name comes right after. */
const CLAIM = String.raw`\b(?:join(?:ing|ed)?(?:\s+the)?(?:\s+\w+)?\s+team\s+at|join(?:ing|ed)?|work(?:ed|ing)?\s+(?:at|for)|work\s+at|role\s+at|position\s+at|opportunity\s+at|career\s+at|time\s+at|tenure\s+at|years?\s+at|interned\s+at|internship\s+at|employed\s+(?:at|by)|team\s+at|apply(?:ing)?\s+(?:to|at)|applied\s+(?:to|at)|contribute\s+to)\s+(?:the\s+)?`;
/** Not employers, even after "worked at" / "joining": skills, tools, places, generic words. */
const NOT_A_COMPANY =
  /^(I|The|This|Your|Our|My|A|An|It|We|You|They|Product|Products|AI|Team|Data|Engineering|Design|Marketing|Sales|Customer|Customers|Users?|India|Bangalore|Bengaluru|Mumbai|Delhi|Pune|Hyderabad|Chennai|Scale|Speed|Growth|Startups?|Companies|Company|Global|Fortune|Python|SQL|Java|JavaScript|TypeScript|React|AWS|Azure|GCP|Jira|Excel|Agile|Scrum|Kubernetes|Docker|Figma|Analytics|Machine Learning|ML|NLP|LLMs?|GenAI|Generative AI|B2B|B2C|SaaS|Fintech|Healthcare|E-commerce|Ecommerce)$/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The company name at the start of `raw`: capitalised words ("Acme Robotics"), joined by of/and/&, stopping at
 * punctuation, a lowercase word or a lone letter ("Acme Robotics I shipped…" → "Acme Robotics"). A dot inside a
 * word stays ("Booking.com").
 */
function takeName(raw: string): string {
  const out: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    const word = tok.replace(/['’]s$/, '');
    const end = /[.,;:!?)]$/.test(word);
    const clean = word.replace(/[.,;:!?)]+$/, '');
    const connector = /^(of|and|&)$/i.test(clean);
    if (connector ? !out.length : !/^[A-Z][A-Za-z0-9&'.-]+$/.test(clean)) break;
    out.push(clean);
    if (end) break;
  }
  while (out.length && /^(of|and|&)$/i.test(out[out.length - 1]!)) out.pop();
  return out.join(' ');
}

/**
 * Companies named in a message that are not allowed: well-known companies anywhere (with their capitals),
 * tool-like or plain-word names only in a "worked at / joining / role at" phrase, and any other capitalised name in
 * such a phrase ("excited to join Acme Robotics").
 */
export function foreignCompanies(text: string, allowed: string[]): string[] {
  const ok = allowed.map(compact).filter((a) => a.length >= 2);
  const isAllowed = (name: string) => {
    const c = compact(name);
    return ok.some((a) => c === a || (c.length >= 4 && a.length >= 4 && (a.includes(c) || c.includes(a))));
  };
  const found = new Set<string>();
  for (const name of KNOWN_COMPANIES) {
    if (new RegExp(`(?<![\\w-])(?:${escapeRe(name)}|${escapeRe(name.toUpperCase())})(?![\\w-])`).test(text) && !isAllowed(name)) found.add(name);
  }
  for (const name of CONTEXT_ONLY_COMPANIES) {
    const re = new RegExp(`${CLAIM}${escapeRe(name)}(?![\\w-])(?!\\s+(?:analytics|ads|cloud|workspace|docs|sheets|maps|web services|teams|office|excel|users|audience|market))`, 'i');
    if (re.test(text) && !isAllowed(name)) found.add(name);
  }
  const claimRe = new RegExp(`${CLAIM}((?:[A-Z][\\w&'.-]*|[A-Z]{2,})(?:\\s+(?:[A-Z][\\w&'.-]*|of|and|&)){0,3})`, 'gi');
  for (const m of text.matchAll(claimRe)) {
    // Only capitalised names: the "i" flag above was for the claim words.
    const raw = m[1]!;
    if (!/^[A-Z]/.test(raw)) continue;
    const name = takeName(raw);
    if (!name || name.length < 3 || NOT_A_COMPANY.test(name) || /^(Product|Senior|Lead|Principal|Head|Director|Manager|Engineer|Designer|Analyst)\b/.test(name)) continue;
    // A known name already reported, or one only flagged in context ("Google" in "worked at Google"), is not new.
    if ([...CONTEXT_ONLY_COMPANIES, ...KNOWN_COMPANIES].some((t) => compact(name).startsWith(compact(t)))) continue;
    if (!isAllowed(name)) found.add(name);
  }
  return [...found];
}

// ------------------------------------------------------------------ the review

const LINK_FIELDS: Array<{ test: RegExp; host: RegExp; of: (p: CandidateProfile) => string | undefined; name: string }> = [
  { test: /linked\s?in/i, host: /linkedin\.com\/in\//i, of: (p) => p.linkedin, name: 'LinkedIn' },
  { test: /git\s?hub/i, host: /github\.com\//i, of: (p) => p.custom_fields.find((c) => /github/i.test(c.name))?.value, name: 'GitHub' },
  { test: /portfolio|personal (web)?site|website|blog/i, host: /./, of: (p) => p.portfolio, name: 'portfolio' },
];
const sameUrl = (a: string, b: string) => {
  const n = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#]+$/, '');
  return !!a && !!b && n(a) === n(b);
};

const isMessage = (f: FormField, answer: string) =>
  f.type === 'textarea' || /cover letter|why|tell us|describe|summary|about (you|yourself)|motivation|message|additional information|anything else/i.test(f.label) || answer.length > 120;

export function reviewBeforeSubmit(input: ReviewInput): Review {
  const { profile, job, answers } = input;
  // Text outside the form counts only on a Review page (elsewhere it is the job description).
  const pageText = input.reviewPage ? input.pageText : '';
  const findings: Finding[] = [];
  const passed: string[] = [];
  const valueOf = (a: ReviewedAnswer) => (a.answer || '').trim();
  const add = (f: Finding) => findings.push(f);

  // ---------- allowed company names
  const resumeCompanies = profile.experience.map((e) => e.company).filter(Boolean);
  const colleges = profile.education.map((e) => String(e.institution ?? e.school ?? e.college ?? '')).filter(Boolean);
  // The employer's name is also in the application's address: "target" in target.wd5.myworkdayjobs.com.
  const hostWords = (() => {
    try {
      return new URL(job.url ?? '').hostname.split('.').filter((w) => w.length >= 4 && !/^wd\d+$/.test(w)
        && !/^(www|jobs|careers|career|apply|boards|myworkdayjobs|myworkdaysite|greenhouse|lever|ashbyhq|workable|smartrecruiters|icims|taleo|successfactors|oraclecloud|com|net|org)$/.test(w));
    } catch {
      return [];
    }
  })();
  const allowed = [
    ...resumeCompanies.flatMap(companyNames), ...companyNames(job.company), ...colleges.flatMap(institutionAliases), ...hostWords,
  ];

  // ---------- general
  for (const a of answers) {
    const v = valueOf(a);
    if (a.field.type === 'file' || a.field.type === 'password') continue;
    // A CAPTCHA is yours to type just before Submit: never a finding.
    if (/captcha|below image|image text|security code/i.test(`${a.field.label} ${a.field.placeholder ?? ''}`)) continue;
    if (a.field.required && !v && !['checkbox', 'radio'].includes(a.field.type)) {
      add({ section: 'general', field_id: a.field.id, label: a.field.label, problem: 'required but empty' });
    } else if (v && META.test(v)) {
      add({ section: 'general', field_id: a.field.id, label: a.field.label, problem: `holds "${(META.exec(v)?.[0] ?? '').slice(0, 30)}"`, rewrite: isMessage(a.field, v) ? { allowed } : undefined });
    }
  }

  // ---------- contact
  const contact: Array<[RegExp, string, (v: string) => boolean]> = [
    [/^(full )?name\b|^your name|^legal name/i, profile.name, (v) => norm(v) === norm(profile.name)],
    [/\be-?mail\b/i, profile.email, (v) => v.trim().toLowerCase() === profile.email.trim().toLowerCase()],
    [/\b(phone|mobile)\b(?!.*code)/i, profile.phone, (v) => {
      const d = (s: string) => s.replace(/\D/g, '').slice(-10);
      return d(v) === d(profile.phone);
    }],
  ];
  let contactOk = 0;
  for (const a of answers) {
    for (const [re, want, same] of contact) {
      if (!want || !re.test(a.field.label) || a.field.entry_type) continue;
      const v = valueOf(a);
      if (!v) continue;
      if (same(v)) contactOk += 1;
      else add({ section: 'contact', field_id: a.field.id, label: a.field.label, problem: `is "${v.slice(0, 60)}", your profile says "${want}"`, set: a.onPage ? want : undefined });
    }
  }
  if (contactOk) passed.push(`contact: ${contactOk} field(s) match your profile`);

  // ---------- work experience
  const expFields = answers.filter((a) => a.field.entry_type === 'experience' || /\b(company|employer|organi[sz]ation)\b/i.test(a.field.label) && !/\b(apply|applying|hear|current company you|why)\b/i.test(a.field.label));
  const hasExperienceSection = answers.some((a) => a.field.entry_type === 'experience') || expFields.filter((a) => /\b(company|employer)\b/i.test(a.field.label)).length >= 2 || (!!input.reviewPage && /work experience|employment history|work history/i.test(pageText));
  if (hasExperienceSection && resumeCompanies.length) {
    // Only the experience section itself counts: a company named in a cover letter is not a work-experience entry
    // (seen live: Dresma's block was missing but the letter named Dresma, and the form went through).
    const sectionText = compact(`${expFields.filter((a) => !isMessage(a.field, valueOf(a))).map(valueOf).join('\n')}\n${pageText}`);
    const missing = resumeCompanies.filter((c) => !companyNames(c).some((n) => sectionText.includes(compact(n))));
    if (missing.length) add({ section: 'experience', label: 'Work experience', problem: `missing ${missing.length} of ${resumeCompanies.length} companies: ${missing.map((m) => companyNames(m)[1] ?? m).join(', ')}` });
    let dated = 0;
    let dateProblems = 0;
    for (const a of answers.filter((x) => x.field.entry_type === 'experience' && typeof x.field.entry_index === 'number')) {
      const entry = profile.experience[a.field.entry_index!];
      if (!entry) continue;
      const label = a.field.label;
      const start = isStart(label);
      const end = !start && isEnd(label);
      if (!start && !end) continue;
      const v = valueOf(a);
      if (end && entry.current) {
        if (v && !/present|current|now/i.test(v) && !/^(no|false)$/i.test(v)) {
          dateProblems += 1;
          add({ section: 'experience', field_id: a.field.id, label, problem: `${companyNames(entry.company)[1] ?? entry.company} is your current job; end date should be empty, not "${v}"` });
        }
        continue;
      }
      const want = profileMonthYear(start ? entry.start_date : entry.end_date);
      const got = readMonthYear(v);
      const part: 'month' | 'year' | 'both' = isMonthOnly(label, v) && !/\d{4}/.test(v) ? 'month' : isYearOnly(label, v) ? 'year' : 'both';
      const fix = expectedLike(v, want, part, a.field.options);
      const ok = (part === 'month' ? got.month === want.month : part === 'year' ? got.year === want.year : got.month === want.month && got.year === want.year);
      if (!want.month && !want.year) continue;
      dated += 1;
      if (!ok) {
        dateProblems += 1;
        const name = companyNames(entry.company)[1] ?? entry.company;
        add({ section: 'experience', field_id: a.field.id, label: `${label} (${name})`, problem: v ? `is "${v}", your resume says ${start ? entry.start_date : entry.end_date}` : `empty, your resume says ${start ? entry.start_date : entry.end_date}`, set: a.onPage ? fix : undefined });
      }
    }
    if (!missing.length) passed.push(`experience: all ${resumeCompanies.length} companies are in the form`);
    if (dated && !dateProblems) passed.push(`experience: ${dated} start/end month-year value(s) match your resume`);
  }

  // ---------- education
  const aliases = colleges.flatMap(institutionAliases);
  let eduOk = 0;
  for (const a of answers) {
    const label = a.field.label;
    const v = valueOf(a);
    if (!v) continue;
    const isEdu = a.field.entry_type === 'education' || /\b(college|university|institut(e|ion)|school|degree|graduat\w*|major|field of study|discipline|passing year)\b/i.test(label);
    if (!isEdu || /high school|\b(10th|12th|secondary)\b/i.test(label)) continue;
    if (/\b(college|university|institut(e|ion)|school)\b/i.test(label) && !/degree|major|field|year|gpa|grade|location|city|country/i.test(label) && aliases.length) {
      if (sameInstitution(v, aliases)) eduOk += 1;
      else add({ section: 'education', field_id: a.field.id, label, problem: `is "${v.slice(0, 60)}", your college is ${colleges[0]}`, set: a.onPage ? (a.field.options.find((o) => sameInstitution(o, aliases)) ?? (a.field.options.length ? undefined : colleges[0])) : undefined });
    }
    const edu = profile.education[0];
    if (edu && /\bdegree\b/i.test(label) && !/field|major|discipline/i.test(label)) {
      const degree = String(edu.degree ?? '');
      const bachelor = /b\.?\s?tech|b\.?\s?e\b|bachelor/i.test(degree);
      if (bachelor && /master|m\.?\s?tech|mba|phd|doctor|diploma|associate|high school/i.test(v)) add({ section: 'education', field_id: a.field.id, label, problem: `is "${v}", your degree is ${degree}` });
      else eduOk += 1;
    }
    const year = Number(edu?.graduation_year ?? 0);
    if (year && /graduat|passing|completion|end year|year of (passing|completion)/i.test(label)) {
      if (readMonthYear(v).year === year || v.includes(String(year))) eduOk += 1;
      else add({ section: 'education', field_id: a.field.id, label, problem: `is "${v}", you graduated in ${year}`, set: a.onPage ? (a.field.options.find((o) => o.includes(String(year))) ?? (a.field.options.length ? undefined : String(year))) : undefined });
    }
  }
  if (aliases.length && /iit|indian institute|college|university/i.test(pageText) && !answers.some((a) => sameInstitution(valueOf(a), aliases)) && !aliases.some((al) => compact(pageText).includes(compact(al))) && /education/i.test(pageText)) {
    add({ section: 'education', label: 'Education', problem: `${colleges[0]} is not in the education section` });
  }
  if (eduOk) passed.push(`education: ${eduOk} value(s) match (${colleges[0] ?? 'your college'})`);

  // ---------- links
  // A LinkedIn field takes your LinkedIn and a GitHub field your GitHub; any other link field ("Website", "Portfolio",
  // "URL", "Other link") may hold any of your links: portfolio, LinkedIn or GitHub.
  const own = {
    linkedin: profile.linkedin || '',
    github: LINK_FIELDS[1]!.of(profile) || '',
    portfolio: profile.portfolio || '',
  };
  const anyOwn = [own.portfolio, own.linkedin, own.github].filter(Boolean);
  const GENERIC_LINK = /\b(url|link|links|website|web site|portfolio|personal site|blog|profile link|online profile)\b/i;
  let linksOk = 0;
  for (const a of answers) {
    const v = valueOf(a);
    if (a.field.type === 'file' || (isMessage(a.field, v) && v.length > 200)) continue;
    const named = /linked\s?in/i.test(a.field.label) ? 'linkedin' : /git\s?hub/i.test(a.field.label) ? 'github' : GENERIC_LINK.test(a.field.label) || a.field.type === 'url' ? 'any' : null;
    if (!named) continue;
    const spec = named === 'any' ? null : LINK_FIELDS[named === 'linkedin' ? 0 : 1]!;
    const want = named === 'any' ? anyOwn[0] ?? '' : own[named];
    if (!v) {
      // An optional link field you have no link for stays empty; one you have a link for gets it.
      if (want) add({ section: 'links', field_id: a.field.id, label: a.field.label, problem: `empty; your ${named === 'any' ? 'link' : spec!.name} is ${want}`, set: a.onPage ? want : undefined });
      continue;
    }
    if (/^(n\/?a|none|not applicable|-)$/i.test(v)) continue;
    if (spec && !spec.host.test(v)) {
      add({ section: 'links', field_id: a.field.id, label: a.field.label, problem: `"${v.slice(0, 60)}" is not a ${spec.name} link`, set: a.onPage && want ? want : undefined });
    } else if (spec && want && !sameUrl(v, want)) {
      add({ section: 'links', field_id: a.field.id, label: a.field.label, problem: `"${v.slice(0, 60)}" is not your ${spec.name} (${want})`, set: a.onPage ? want : undefined });
    } else if (!spec && anyOwn.length && !anyOwn.some((u) => sameUrl(v, u))) {
      add({ section: 'links', field_id: a.field.id, label: a.field.label, problem: `"${v.slice(0, 60)}" is none of your links (portfolio, LinkedIn, GitHub)`, set: a.onPage ? want : undefined });
    } else {
      linksOk += 1;
    }
  }
  if (linksOk) passed.push(`links: ${linksOk} link field(s) hold your links`);

  // ---------- messages
  const ownLinks = [profile.linkedin, profile.portfolio, ...profile.custom_fields.map((c) => c.value)].filter((u): u is string => !!u && /^https?:|\.\w{2,}\//i.test(u));
  let messages = 0;
  for (const a of answers) {
    const v = valueOf(a);
    if (!v || a.field.type === 'file' || !isMessage(a.field, v)) continue;
    messages += 1;
    const others = foreignCompanies(v, allowed);
    if (others.length) add({ section: 'message', field_id: a.field.id, label: a.field.label, problem: `names ${others.join(', ')}, which ${others.length > 1 ? 'are' : 'is'} not on your resume${job.company ? ` or ${companyNames(job.company)[1] ?? job.company}` : ''}`, rewrite: a.onPage ? { allowed } : undefined });
    if (PLACEHOLDER.test(v)) add({ section: 'message', field_id: a.field.id, label: a.field.label, problem: `has a placeholder "${PLACEHOLDER.exec(v)?.[0]}"`, rewrite: a.onPage ? { allowed } : undefined });
    const links = v.match(/https?:\/\/[^\s)]+|(?:www\.)?[a-z0-9-]+\.(?:com|in|io|me|dev|co)\/[^\s)]*/gi) ?? [];
    const strange = links.filter((l) => !ownLinks.some((o) => sameUrl(l, o)) && !(job.company && compact(l).includes(compact(companyNames(job.company)[1] ?? job.company))));
    if (strange.length) add({ section: 'message', field_id: a.field.id, label: a.field.label, problem: `has a link that is not yours: ${strange[0]}`, rewrite: a.onPage ? { allowed } : undefined });
  }
  if (messages && !findings.some((f) => f.section === 'message')) passed.push(`messages: ${messages} answer(s) name only your companies${job.company ? ` and ${companyNames(job.company)[1] ?? job.company}` : ''}`);

  return { findings, passed };
}
