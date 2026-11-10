// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormData } from '../src/shared/ai-apply/types';

// LinkedIn Easy Apply (Wing Assistant, 2026-11-10): a checkbox question with no name, no aria-label and empty labels,
// each option's text in a sibling <p>. It must read as one question with its options.
const opt = (id: string, text: string) => `<div><div><div><input id="${id}" type="checkbox"><label for="${id}"></label></div><p>${text}</p></div></div>`;

type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
let listener: Listener;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (msg: Record<string, unknown>) => new Promise<any>((resolve) => listener(msg, {}, resolve));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (l: Listener) => { listener = l; } } } });
  Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }] as unknown as DOMRectList; };
  delete (window as unknown as { __aiFormEngine?: boolean }).__aiFormEngine;
});

describe('nameless checkbox group in a fieldset', () => {
  it('is one question with its options', async () => {
    document.body.innerHTML = `<form><div><p>Which industries have you worked in? (Select all that apply.)*</p><fieldset>${opt('a', 'Customer Service')}${opt('b', 'E-Commerce')}${opt('c', 'Healthcare/Medical')}</fieldset></div><button>Next</button></form>`;
    await import('../src/content/form-engine');
    const r = await send({ type: 'EXTRACT_FORM' });
    const form = r.data as FormData;
    const q = form.fields.filter((f) => f.type === 'checkbox');
    expect(q).toHaveLength(1);
    expect(q[0]!.label).toMatch(/industries/i);
    expect(q[0]!.options).toEqual(['Customer Service', 'E-Commerce', 'Healthcare/Medical']);
  });
});
