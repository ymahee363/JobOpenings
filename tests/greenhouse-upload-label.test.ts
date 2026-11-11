// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormData } from '../src/shared/ai-apply/types';

// Greenhouse job-boards (SonicWall, 2026-11-11): each upload's <label for> says only "Attach"; the slot's name is in the
// group's aria-labelledby ("Resume/CV*", "Cover Letter"). Both read as "Attach", no resume slot was found, and
// Submit came back "Attach: Resume/CV is required".
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
const slot = (id: string, name: string, req: boolean) => `<div role="group" aria-labelledby="upload-label-${id}"${req ? ' aria-required="true"' : ''}><div id="upload-label-${id}">${name}${req ? '<span>*</span>' : ''}</div><div><div><div><div><button type="button">Attach</button><label for="${id}">Attach</label><input id="${id}" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"></div></div><div><button type="button">Dropbox</button></div><div><div><button type="button">Enter manually</button><label for="${id}_text">Enter manually</label></div></div><p>Accepted file types: pdf, doc, docx, txt, rtf</p></div></div></div>`;
describe('Greenhouse upload slots labelled "Attach"', () => {
  it('names each upload after its group', async () => {
    document.body.innerHTML = `<form><label for="first_name">First Name*</label><input id="first_name" type="text">${slot('resume', 'Resume/CV', true)}${slot('cover_letter', 'Cover Letter', false)}<button type="submit">Submit application</button></form>`;
    await import('../src/content/form-engine');
    const form = (await send({ type: 'EXTRACT_FORM' })).data as FormData;
    const files = form.fields.filter((f) => f.type === 'file');
    expect(files.map((f) => f.label)).toEqual([expect.stringMatching(/resume/i), expect.stringMatching(/cover letter/i)]);
    expect(files[0]!.required).toBe(true);
  });
});
