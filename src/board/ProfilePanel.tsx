import { useEffect, useState } from 'react';
import { backendHealth } from '../shared/ai-apply/llm';
import { forgetAnswer, groupMemory, type MemoryMap } from '../shared/ai-apply/memory';
import { bytesToBase64, normalizeProfile, PROFILE_EMAIL, type AiBackend, type StoredResume } from '../shared/ai-apply/profile';
import type { CandidateProfile } from '../shared/ai-apply/types';
import { load, save } from '../shared/store';

const list = (csv: string) => csv.split(',').map((s) => s.trim()).filter(Boolean);
const lakhsOrUndefined = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Math.round(Number(s) * 100_000));
const lakhs = (n: number | undefined) => (n === undefined ? '' : String(n / 100_000));

/** "Question: answer" lines, one per custom fact. */
function factsToText(p: CandidateProfile): string {
  return p.custom_fields.map((f) => `${f.name}: ${f.value}`).join('\n');
}

function textToFacts(text: string): CandidateProfile['custom_fields'] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.includes(':')).map((line, i) => {
    const at = line.indexOf(':');
    return { id: `f${i}`, name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
  }).filter((f) => f.name && f.value);
}

interface Draft {
  name: string; email: string; phone: string; location: string; currentLakhs: string; expectedLakhs: string; notice: string;
  linkedin: string; portfolio: string; skills: string; experience: string; education: string; facts: string; extra: string;
}

function toDraft(p: CandidateProfile): Draft {
  return {
    name: p.name, email: p.email, phone: p.phone, location: p.location, currentLakhs: lakhs(p.current_ctc), expectedLakhs: lakhs(p.expected_ctc),
    notice: p.notice_period, linkedin: p.linkedin ?? '', portfolio: p.portfolio ?? '', skills: p.skills.join(', '),
    experience: JSON.stringify(p.experience, null, 2), education: JSON.stringify(p.education, null, 2), facts: factsToText(p), extra: p.extra_information,
  };
}

/** The draft as a profile, or the reason it is not valid yet. */
function fromDraft(d: Draft, base: CandidateProfile): CandidateProfile | string {
  let experience: unknown;
  let education: unknown;
  try {
    experience = JSON.parse(d.experience || '[]');
  } catch {
    return 'Work experience is not valid JSON';
  }
  try {
    education = JSON.parse(d.education || '[]');
  } catch {
    return 'Education is not valid JSON';
  }
  if (!Array.isArray(experience) || !Array.isArray(education)) return 'Work experience and education must be JSON lists';
  return normalizeProfile({
    ...base, name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim(), location: d.location.trim(),
    current_ctc: lakhsOrUndefined(d.currentLakhs), expected_ctc: lakhsOrUndefined(d.expectedLakhs), notice_period: d.notice.trim(),
    linkedin: d.linkedin.trim(), portfolio: d.portfolio.trim(), skills: list(d.skills), experience, education,
    custom_fields: textToFacts(d.facts), extra_information: d.extra,
  } as CandidateProfile);
}

/** AI apply's knowledge of you: profile, resume, the LLM backend and the answers it has learned. */
export function ProfilePanel() {
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [backend, setBackend] = useState<AiBackend | null>(null);
  const [resume, setResume] = useState<StoredResume | null>(null);
  const [coverLetter, setCoverLetter] = useState<StoredResume | null>(null);
  const [memory, setMemory] = useState<MemoryMap>({});
  const [note, setNote] = useState('');
  const [importText, setImportText] = useState('');

  useEffect(() => {
    Promise.all([load('aiProfile'), load('aiBackend'), load('aiResume'), load('formMemory'), load('aiCoverLetter')]).then(([p, b, r, m, c]) => {
      setCoverLetter(c);
      const np = normalizeProfile(p);
      setProfile(np);
      setDraft(toDraft(np));
      setBackend(b);
      setResume(r);
      setMemory(m);
    }).catch(() => undefined);
  }, []);
  if (!profile || !draft || !backend) return <section className="panel"><p className="hint">Loading…</p></section>;

  const field = (key: keyof Draft, label: string, props: Record<string, unknown> = {}) => (
    <label>{label}
      <input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} {...props} />
    </label>
  );
  const area = (key: keyof Draft, label: string, rows: number) => (
    <label className="wide">{label}
      <textarea rows={rows} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} spellCheck={key === 'extra'} />
    </label>
  );

  const saveProfile = async () => {
    const next = fromDraft(draft, profile);
    if (typeof next === 'string') {
      setNote(next);
      return;
    }
    await save('aiProfile', next);
    setProfile(next);
    setDraft(toDraft(next));
    setNote('Profile saved');
  };

  const importProfile = async () => {
    try {
      const raw = JSON.parse(importText) as Record<string, unknown>;
      // A whole chrome.storage dump from job-apply-ai-mvp keeps the profile under `candidateProfile`.
      const p = normalizeProfile((raw.candidateProfile ?? raw) as Partial<CandidateProfile>);
      await save('aiProfile', p);
      setProfile(p);
      setDraft(toDraft(p));
      setImportText('');
      setNote('Profile imported');
    } catch {
      setNote('That is not valid JSON');
    }
  };

  const onCoverLetterFile = async (file: File | undefined) => {
    if (!file || file.size > 5_000_000) return;
    const next: StoredResume = { name: file.name, type: file.type || 'application/pdf', data: bytesToBase64(new Uint8Array(await file.arrayBuffer())), text: coverLetter?.text ?? '' };
    await save('aiCoverLetter', next);
    setCoverLetter(next);
    setNote(`Cover letter ${file.name} saved`);
  };

  const onResumeFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5_000_000) {
      setNote('Resume is over 5 MB; use a smaller PDF');
      return;
    }
    const next: StoredResume = { name: file.name, type: file.type || 'application/pdf', data: bytesToBase64(new Uint8Array(await file.arrayBuffer())), text: resume?.text ?? '' };
    await save('aiResume', next);
    setResume(next);
    setNote(`Resume ${file.name} saved`);
  };

  const groups = groupMemory(memory);

  return (
    <section className="panel profile" aria-labelledby="profile-h">
      <h2 id="profile-h">Profile for AI apply ({profile.email || PROFILE_EMAIL})</h2>
      <p className="hint">
        AI apply answers application forms from this profile first, then your answer bank (Agent panel), then answers it
        remembered from earlier forms, and asks the AI backend only for the rest. It never invents experience: a required
        question it cannot answer truthfully leaves the job under "Asked for details".
      </p>

      <h3>About you</h3>
      <div className="agent-rules">
        {field('name', 'Full name')}
        {field('email', 'Email', { type: 'email' })}
        {field('phone', 'Phone', { type: 'tel' })}
        {field('location', 'Location')}
        {field('currentLakhs', 'Current CTC (LPA)', { type: 'number', min: 0, step: 0.1 })}
        {field('expectedLakhs', 'Expected CTC (LPA)', { type: 'number', min: 0, step: 0.1 })}
        {field('notice', 'Notice period')}
        {field('linkedin', 'LinkedIn URL')}
        {field('portfolio', 'Portfolio / website')}
        {field('skills', 'Skills (comma separated)')}
      </div>
      {area('experience', 'Work experience, most recent first (JSON: title, company, location, start_date, end_date, current, description)', 8)}
      {area('education', 'Education (JSON: degree, institution, graduation_year, …)', 4)}
      {area('facts', 'Facts for common questions, one per line as "Question: answer" (e.g. "Work authorization: Indian citizen, no sponsorship needed")', 5)}
      {area('extra', 'Anything else worth knowing for open questions (career gap, projects, awards)', 4)}
      <div className="btn-row">
        <button type="button" className="btn primary" onClick={saveProfile}>Save profile</button>
        {note && <span className="hint" role="status">{note}</span>}
      </div>

      <h3>Resume</h3>
      <p className="hint">Attached to resume upload fields. The text below is what the AI reads (paste it from your PDF).</p>
      <div className="btn-row">
        <input type="file" accept=".pdf,.doc,.docx" aria-label="Resume file" onChange={(e) => { onResumeFile(e.target.files?.[0]).catch(() => undefined); }} />
        {resume ? <span className="hint">{resume.name} ({Math.round((resume.data.length * 3) / 4 / 1024)} KB)</span> : <span className="hint warn-text">No resume yet: upload fields are left for you.</span>}
      </div>
      <label className="wide">Resume text
        <textarea rows={6} value={resume?.text ?? ''} placeholder="Paste your resume's text here"
          onChange={(e) => setResume({ ...(resume ?? { name: '', type: '', data: '' }), text: e.target.value })}
          onBlur={() => { if (resume) save('aiResume', resume).catch(() => undefined); }} />
      </label>

      <h3>Cover letter</h3>
      <p className="hint">Attached to cover letter upload fields. Where a form has a cover letter text box (Indeed), the text below goes in word for word; the AI never writes one.</p>
      <div className="btn-row">
        <input type="file" accept=".pdf,.doc,.docx" aria-label="Cover letter file" onChange={(e) => { onCoverLetterFile(e.target.files?.[0]).catch(() => undefined); }} />
        {coverLetter ? <span className="hint">{coverLetter.name}</span> : <span className="hint">None: cover letter uploads are skipped.</span>}
      </div>
      <label className="wide">Cover letter text
        <textarea rows={8} value={coverLetter?.text ?? ''} placeholder="Paste your cover letter's text here"
          onChange={(e) => setCoverLetter({ ...(coverLetter ?? { name: '', type: '', data: '' }), text: e.target.value })}
          onBlur={() => { if (coverLetter) save('aiCoverLetter', coverLetter).catch(() => undefined); }} />
      </label>

      <h3>AI backend</h3>
      <p className="hint">
        The FastAPI service in <code>backend/</code> of this repo (Gemini, with Groq as fallback). Start it with
        <code> backend\start-backend.bat</code>; keys stay in <code>backend/.env</code>.
      </p>
      <div className="agent-rules">
        <label>Backend URL
          <input value={backend.url} onChange={(e) => setBackend({ ...backend, url: e.target.value })} onBlur={() => save('aiBackend', backend).catch(() => undefined)} />
        </label>
        <label>Access key (X-App-Key, if the backend has one)
          <input type="password" value={backend.accessKey} onChange={(e) => setBackend({ ...backend, accessKey: e.target.value })} onBlur={() => save('aiBackend', backend).catch(() => undefined)} />
        </label>
      </div>
      <div className="btn-row">
        <button type="button" className="btn" onClick={async () => {
          await save('aiBackend', backend);
          setNote((await backendHealth(backend)) ?? 'Backend is up');
        }}>Test backend</button>
      </div>

      <h3>Import</h3>
      <p className="hint">
        Paste a profile as JSON. From job-apply-ai-mvp: open its service worker console (chrome://extensions → Job Apply AI
        → service worker) and run <code>chrome.storage.local.get('candidateProfile').then(r =&gt; copy(JSON.stringify(r)))</code>, then paste here.
      </p>
      <textarea rows={3} className="wide" aria-label="Profile JSON" value={importText} onChange={(e) => setImportText(e.target.value)} />
      <div className="btn-row">
        <button type="button" className="btn" disabled={!importText.trim()} onClick={importProfile}>Import profile</button>
      </div>

      <h3>Remembered answers ({Object.keys(memory).length})</h3>
      <p className="hint">Learned from earlier forms and reused when a question is asked again in the same words. Remove any that are wrong.</p>
      {groups.length === 0 ? <p className="hint">Nothing remembered yet.</p> : groups.map((g) => (
        <div key={g.category}>
          <h4>{g.category}</h4>
          <ul className="agent-answers">
            {g.entries.map((e) => (
              <li key={e.key}>
                <span><strong>{e.label}</strong>: {e.answer}</span>
                <button type="button" className="chip-x" aria-label={`Forget the answer to "${e.label}"`}
                  onClick={async () => {
                    const next = forgetAnswer(memory, e.key);
                    await save('formMemory', next);
                    setMemory(next);
                  }}>×</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
