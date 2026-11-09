import { describe, expect, it } from 'vitest';
import {
  appliedConfirmationJobId, classifyAfterClick, confirmedJobIds, classifyPage, jobIdFromIimjobsPath, jobPageOf, submitButtonOf, type PageSnapshot,
} from '../src/shared/auto-apply/job-page';
import pages from './fixtures/iimjobs-job-pages.json';

const open = pages.open as PageSnapshot;
const applied = pages.applied as PageSnapshot;
const snap = (over: Partial<PageSnapshot>): PageSnapshot => ({ ...open, ...over });

describe('classifyPage', () => {
  it('reads the saved live pages', () => {
    expect(classifyPage(open)).toBe('can_apply');
    expect(classifyPage(applied)).toBe('applied');
  });

  it('fails closed on anything it does not recognise', () => {
    expect(classifyPage(snap({ applyButtons: [] }))).toBe('not_found');
    expect(classifyPage(snap({ applyButtons: [{ text: 'Apply', disabled: true }] }))).toBe('not_found');
    expect(classifyPage(snap({ applyButtons: [{ text: 'Quick apply with Pro', disabled: false }] }))).toBe('not_found');
  });

  it('spots captcha, logout, closed and off-site jobs', () => {
    expect(classifyPage(snap({ captchaShown: true }))).toBe('captcha');
    expect(classifyPage(snap({ path: '/login' }))).toBe('logged_out');
    expect(classifyPage(snap({ applyButtons: [{ text: 'Login to apply', disabled: false }] }))).toBe('logged_out');
    expect(classifyPage(snap({ expiredRedirect: true }))).toBe('closed');
    expect(classifyPage(snap({ path: '/ai-search' }))).toBe('closed');
    expect(classifyPage(snap({ text: 'This job is no longer accepting applications' }))).toBe('closed');
    expect(classifyPage(snap({ applyButtons: [{ text: 'Apply on company site', disabled: false }] }))).toBe('external');
  });

  it('a captcha wins over everything', () => {
    expect(classifyPage({ ...applied, captchaShown: true })).toBe('captcha');
  });
});

describe('classifyAfterClick', () => {
  it('sees the button turn to Applied', () => {
    expect(classifyAfterClick(applied)).toBe('applied');
    expect(classifyAfterClick(snap({ noticeText: 'You have successfully applied to this job' }))).toBe('applied');
    // A similar job's status in the page text is not this job's confirmation.
    expect(classifyAfterClick(snap({ text: 'Similar jobs | Product Manager | Application sent!' }))).toBe('waiting');
    expect(classifyAfterClick(snap({ noticeText: 'Application sent to ZenteiQ.ai' }))).toBe('applied');
  });

  it('sees a dialog, a captcha, or nothing yet', () => {
    const dialog = { title: 'A few questions', fields: [], buttons: ['Submit'] };
    expect(classifyAfterClick(snap({ dialog }))).toBe('dialog');
    expect(classifyAfterClick(snap({ dialog: { ...dialog, title: 'Verify you are human' } }))).toBe('captcha');
    expect(classifyAfterClick(open)).toBe('waiting');
  });
});

describe('submitButtonOf', () => {
  it('needs exactly one submit button, never an upsell', () => {
    expect(submitButtonOf({ title: '', fields: [], buttons: ['Cancel', 'Submit'] })).toBe('Submit');
    expect(submitButtonOf({ title: '', fields: [], buttons: ['Submit', 'Apply'] })).toBeNull();
    expect(submitButtonOf({ title: '', fields: [], buttons: ['Buy Pro', 'Upgrade'] })).toBeNull();
  });
});

describe('jobIdFromIimjobsPath', () => {
  it('reads the ID from a job path', () => {
    expect(jobIdFromIimjobsPath('/j/paytm-product-manager-1742187')).toBe('iimjobs-1742187');
    expect(jobIdFromIimjobsPath('/j/1742187')).toBe('iimjobs-1742187');
    expect(jobIdFromIimjobsPath('/ai-search')).toBeNull();
    expect(jobIdFromIimjobsPath('/j/paytm-product-manager')).toBeNull();
    expect(classifyPage(snap({ path: '/j/1742187' }))).toBe('can_apply');
  });
});

describe('confirmation page (seen after a real apply on 2026-10-27)', () => {
  it('reads the job from /job/applied?jobId=', () => {
    expect(appliedConfirmationJobId('https://www.iimjobs.com/job/applied?ref=jd&jobId=1742112')).toBe('iimjobs-1742112');
    expect(appliedConfirmationJobId('https://www.iimjobs.com/job/applied/?jobId=7')).toBe('iimjobs-7');
    expect(appliedConfirmationJobId('https://www.iimjobs.com/job/applied?jobId=abc')).toBeNull();
    expect(appliedConfirmationJobId('https://evil.example/job/applied?jobId=1742112')).toBeNull();
    expect(appliedConfirmationJobId('https://www.iimjobs.com/j/paytm-product-manager-1742187')).toBeNull();
  });

  it('counts the confirmation page and its message as applied', () => {
    expect(classifyAfterClick(snap({ path: '/job/applied', applyButtons: [], title: 'Job Applied' }))).toBe('applied');
    expect(classifyAfterClick(snap({ applyButtons: [], noticeText: 'Your application has been submitted successfully!' }))).toBe('applied');
  });
});

describe('Instahyre job pages (read-only, 2026-10-27)', () => {
  const insta = (over: Partial<PageSnapshot>): PageSnapshot => ({
    site: 'instahyre', path: '/job-447327-product-owner-at-zenteiq-bangalore/', title: 'Product Owner job at ZenteiQ.ai - Instahyre',
    text: 'Product Owner | at ZenteiQ.ai | Bangalore', applyButtons: [{ text: 'Apply now', disabled: false }],
    captchaShown: false, expiredRedirect: false, dialog: null, ...over,
  });
  it('reads open and applied pages', () => {
    expect(classifyPage(insta({}))).toBe('can_apply');
    expect(classifyPage(insta({ applyButtons: [{ text: 'Application sent!', disabled: true }], text: 'Application sent! | on October 26, 2026' }))).toBe('applied');
    expect(classifyAfterClick(insta({ applyButtons: [{ text: 'Application sent!', disabled: true }] }))).toBe('applied');
    expect(classifyPage(insta({ path: '/candidate/opportunities/' }))).toBe('closed');

  });
  it('finds the site and job in a URL', () => {
    expect(jobPageOf('https://www.instahyre.com/job-447327-product-owner-at-zenteiq-bangalore/')).toEqual({ site: 'instahyre', jobId: 'instahyre-447327' });
    expect(jobPageOf('https://www.instahyre.com/job-447327/')).toEqual({ site: 'instahyre', jobId: 'instahyre-447327' });
    expect(jobPageOf('https://www.iimjobs.com/j/paytm-product-manager-1742187')).toEqual({ site: 'iimjobs', jobId: 'iimjobs-1742187' });
    expect(jobPageOf('http://www.instahyre.com/job-447327/')).toBeNull();
    expect(jobPageOf('https://cutshort.io/job/123456-product-manager')).toBeNull();
  });
});

describe('Naukri job pages (read-only, 2026-10-27)', () => {
  const nk = (over: Partial<PageSnapshot>): PageSnapshot => ({
    site: 'naukri', path: '/job-listings-senior-business-analyst-straive-hyderabad-gurugram-bengaluru-2-to-5-years-211026003705',
    title: 'Senior Business Analyst - Straive', text: 'Senior Business Analyst', applyButtons: [{ text: 'Apply', disabled: false }],
    captchaShown: false, expiredRedirect: false, dialog: null, ...over,
  });
  it('reads Easy Apply, applied and company-site pages', () => {
    expect(classifyPage(nk({}))).toBe('can_apply');
    expect(classifyPage(nk({ applyButtons: [{ text: 'Applied', disabled: false }] }))).toBe('applied');
    expect(classifyPage(nk({ applyButtons: [{ text: 'Apply on company site', disabled: false }] }))).toBe('external');
    expect(classifyPage(nk({ path: '/mnjuser/recommendedjobs' }))).toBe('closed');
  });
  it('uses the bare Naukri job ID, as the board does', () => {
    expect(jobPageOf('https://www.naukri.com/job-listings-product-manager-ii-leadsquared-bengaluru-6-to-9-years-211026501633'))
      .toEqual({ site: 'naukri', jobId: '211026501633' });
    expect(jobPageOf('https://www.naukri.com/job-listings-job-261026003057?src=x')).toEqual({ site: 'naukri', jobId: '261026003057' });
    expect(jobPageOf('https://www.naukri.com/mnjuser/homepage')).toBeNull();
  });
});

describe('Wellfound job pages (read-only, 2026-10-27)', () => {
  const wf = (over: Partial<PageSnapshot>): PageSnapshot => ({
    site: 'wellfound', path: '/jobs/4875034-product-manager', title: 'Product Manager at Kulfi • Bengaluru | Wellfound', text: 'Product Manager',
    applyButtons: [{ text: 'Apply', disabled: false }, { text: 'Apply now', disabled: false }],
    captchaShown: false, expiredRedirect: false, dialog: null, ...over,
  });
  it('reads open and applied pages', () => {
    expect(classifyPage(wf({}))).toBe('can_apply');
    expect(classifyPage(wf({ applyButtons: [{ text: 'Applied', disabled: true }] }))).toBe('applied');
    expect(classifyPage(wf({ path: '/jobs/applications' }))).toBe('closed');
  });
  it('finds the job in a URL', () => {
    expect(jobPageOf('https://wellfound.com/jobs/4875034-product-manager')).toEqual({ site: 'wellfound', jobId: 'wellfound-4875034' });
    expect(jobPageOf('https://wellfound.com/jobs')).toBeNull();
  });
});

describe('Naukri confirmation page (seen on a real apply, 2026-10-27)', () => {
  // The query string Naukri used after applying to job 151026032180, with the numeric profile IDs replaced.
  const url = 'https://www.naukri.com/myapply/saveApply?strJobsarr=[151026032180]&applytype=single&resId=1&ApplyMode=1&id=2&src=h'
    + '&logstr=----F-0-1---&applySrc=----F-0-1---&multiApplyResp=%7B%22151026032180%22%3A200%7D&jobTitle=Product%20Owner';
  it('reads the applied job and its 200 response', () => {
    expect(confirmedJobIds(url)).toEqual(['151026032180']);
    expect(confirmedJobIds(url.replace('%3A200', '%3A409'))).toEqual([]);
    expect(confirmedJobIds('https://www.naukri.com/myapply/saveApply?multiApplyResp=not-json')).toEqual([]);
    expect(confirmedJobIds('https://evil.example/myapply/saveApply?multiApplyResp=%7B%22151026032180%22%3A200%7D')).toEqual([]);
    expect(confirmedJobIds('https://www.iimjobs.com/job/applied?ref=jd&jobId=1742112')).toEqual(['iimjobs-1742112']);
  });
  it('counts the confirmation page as applied when the page itself sees it', () => {
    expect(classifyAfterClick({ site: 'naukri', path: '/myapply/saveApply', title: 'Apply Confirmation', text: 'Applied to "Product Owner"',
      applyButtons: [], captchaShown: false, expiredRedirect: false, dialog: null })).toBe('applied');
  });
});
