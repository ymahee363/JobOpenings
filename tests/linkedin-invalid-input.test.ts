// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { liState } from '../src/content/ats/linkedin';

// LinkedIn Easy Apply step 4/5 (Orbit Verify, 2026-11-11): a numbers-only box rejects "5 years" with "Invalid input"
// in its aria-describedby helper text (no role=alert, generated classes). The run stopped as "stuck" with no error.
describe('liState reads "Invalid input" under a rejected answer', () => {
  it('lists it as an error', () => {
    document.body.innerHTML = `<dialog open data-testid="dialog"><h2>Apply to Acme</h2><p>4/5 pages</p><div><p>how many years of experience do you have in Product Manager?*</p><input required id="r1" aria-describedby="r1-info" aria-label="how many years of experience do you have in Product Manager?" type="text" value="5 years"><div data-testid="text-input-helper-text" id="r1-info"><p>Invalid input</p><div><p aria-live="polite"><span aria-hidden="true">7/20</span><span>7 of 20 characters</span></p></div></div></div><button>Back</button><button>Review</button></dialog>`;
    for (const el of document.querySelectorAll('*')) (el as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
    const s = liState();
    expect(s.page).toBe('step');
    expect(s.errors.join(' ')).toMatch(/invalid input/i);
  });
});
