// @vitest-environment happy-dom
/**
 * LinkedIn Easy Apply's "Location (city)*" (2026-11-10): a text box with aria-autocomplete="list", generated classes
 * and no aria-controls; its role=listbox appears only after typing. Typed text without a picked suggestion is not
 * accepted ("stuck on 16 First name* | ..."), and the tag-input fallback clicked a page menu item behind the dialog,
 * which closed the dialog ("more than 12 steps").
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
let listener: Listener;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (msg: Record<string, unknown>) => new Promise<any>((resolve) => listener(msg, {}, resolve));
let engine: typeof import('../src/content/form-engine');
let pageMenuClicked = false;

beforeAll(async () => {
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (l: Listener) => { listener = l; } } } });
  Element.prototype.getClientRects = function (this: Element) { return (this.closest('[hidden]') ? [] : [{ width: 1, height: 1 }]) as unknown as DOMRectList; };
  engine = await import('../src/content/form-engine');
});

function page() {
  pageMenuClicked = false;
  document.body.innerHTML = `
    <nav><ul role="menu"><li role="menuitem" id="pm">Bengaluru, Karnataka, India</li></ul></nav>
    <dialog data-testid="dialog" open>
      <h2>Apply to Time Hack Consulting</h2>
      <div><div><label for="city">Location (city)*</label><div><input id="city" type="text" aria-autocomplete="list" placeholder="Enter city or location"></div></div></div>
      <button>Next</button>
    </dialog>`;
  document.getElementById('pm')!.addEventListener('click', () => { pageMenuClicked = true; });
  const input = document.getElementById('city') as HTMLInputElement;
  input.addEventListener('input', () => {
    document.getElementById('ta')?.remove();
    if (input.value.length < 3) return;
    const list = document.createElement('div');
    list.id = 'ta';
    list.setAttribute('role', 'listbox');
    for (const city of ['Bengaluru, Karnataka, India', 'Bengaluru East, Karnataka, India']) {
      const o = document.createElement('div');
      o.setAttribute('role', 'option');
      o.textContent = city;
      o.addEventListener('click', () => { input.value = city; input.dataset.picked = city; list.remove(); });
      list.append(o);
    }
    // Portaled: added at the end of the dialog, not next to the box.
    document.querySelector('dialog')!.append(list);
  });
}

describe('typeahead in a modal (LinkedIn Location (city))', () => {
  it('reads aria-autocomplete=list as a typeahead and options outside the modal as not its own', () => {
    page();
    const input = document.getElementById('city') as HTMLInputElement;
    expect(engine.isDeclaredTypeahead(input)).toBe(true);
    expect(engine.nearField(input, document.getElementById('pm')!)).toBe(false);
  });

  it('picks the suggestion after typing and never clicks the page behind the dialog', async () => {
    page();
    const r = await send({ type: 'EXTRACT_FORM' });
    const field = (r.data.fields as Array<{ id: string; label: string }>).find((f) => /location/i.test(f.label))!;
    expect(field).toBeTruthy();
    await send({ type: 'FILL_FIELDS', answers: [{ field_id: field.id, answer: 'Bengaluru, Karnataka, India', label: field.label, confidence: 1, source: 'profile', needs_user_input: false }] });
    const input = document.getElementById('city') as HTMLInputElement;
    expect(input.dataset.picked).toBe('Bengaluru, Karnataka, India');
    expect(pageMenuClicked).toBe(false);
  }, 30_000);
});
