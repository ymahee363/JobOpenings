// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { liResume } from '../src/content/ats/linkedin';
import { isLinkedinJobUrl } from '../src/shared/ats/linkedin-flow';

// The resume list as LinkedIn showed it on 2026-11-10 (radios labelled by file name, newest first).
const LIST = ['Mahendra_IIT_Resume.pdf', 'Mahendra_IIT_Guwahati_Resume.pdf', 'Mahendra_IIT_Guwahati_Resume.pdf', 'Mahendra_IIT_Guwahati__Resume.pdf'];

function page() {
  document.body.innerHTML = `<dialog data-testid="dialog" open><h2>Apply to ZynnexAI</h2>${LIST.map((n, i) => `<label><input type="radio" name="r" aria-label="${n}" ${i === 0 ? 'checked' : ''}>${n}</label>`).join('')}<button>Submit application</button></dialog>`;
  // happy-dom has no layout: everything counts as shown.
  for (const el of document.querySelectorAll('*')) (el as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
}

describe('LinkedIn Easy Apply applier', () => {
  it('knows LinkedIn job pages', () => {
    expect(isLinkedinJobUrl('https://www.linkedin.com/jobs/view/4488137195/')).toBe(true);
    expect(isLinkedinJobUrl('https://www.linkedin.com/feed/')).toBe(false);
  });

  it('picks the newest resume named like yours (the 2nd here), not the first', () => {
    page();
    const r = liResume('Mahendra_IIT_Guwahati_Resume.pdf');
    expect(r).toMatchObject({ ok: true, picked: 'Mahendra_IIT_Guwahati_Resume.pdf (#2)' });
    const checked = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')].findIndex((x) => x.checked);
    expect(checked).toBe(1);
  });

  it('says so when no resume matches, and changes nothing', () => {
    page();
    expect(liResume('Other_CV.pdf')).toMatchObject({ ok: false });
    expect(document.querySelector<HTMLInputElement>('input[type=radio]')!.checked).toBe(true);
  });
});

import { resumeForLocation, INDIA_RESUME, ABROAD_RESUME } from '../src/shared/ats/linkedin-flow';
describe('LinkedIn resume by job location', () => {
  it('uses the Guwahati resume in India and the IIT resume elsewhere', () => {
    expect(resumeForLocation('Bengaluru, Karnataka, India')).toBe(INDIA_RESUME);
    expect(resumeForLocation('Gurugram, Haryana')).toBe(INDIA_RESUME);
    expect(resumeForLocation('')).toBe(INDIA_RESUME);
    expect(resumeForLocation('Remote')).toBe(INDIA_RESUME);
    expect(resumeForLocation('European Union')).toBe(ABROAD_RESUME);
    expect(resumeForLocation('Dubai, United Arab Emirates')).toBe(ABROAD_RESUME);
  });
});

import { liState } from '../src/content/ats/linkedin';
describe('LinkedIn closed job', () => {
  it('reads "No longer accepting applications" as closed', () => {
    document.body.innerHTML = '<main><div><p>Remote</p><p>No longer accepting applications</p></div></main>';
    for (const el of document.querySelectorAll('*')) (el as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
    expect(liState()).toMatchObject({ page: 'closed', message: 'No longer accepting applications' });
    document.body.innerHTML = '<main><p>Not currently accepting applications</p></main>';
    for (const el of document.querySelectorAll('*')) (el as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
    expect(liState()).toMatchObject({ page: 'closed', message: 'Not currently accepting applications' });
  });
});
