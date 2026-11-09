// @vitest-environment happy-dom
// @ts-nocheck -- QA-only runner using Node APIs; the project has no @types/node.
/**
 * QA offline check: runs the real form engine and AI apply's answer logic on page snapshots saved by
 * scripts/qa-serve.cjs (POST /save), for sites whose CSP blocks loading the engine into the live page.
 *
 *   QA_SNAPSHOTS=<dir> npx vitest run tests/qa-offline.test.ts
 *
 * For each snapshot it writes <dir>/<name>.report.json: the fields the engine reads, each answer and where it came
 * from (profile, memory, AI), the questions nobody could answer, and whether a Next / Submit button was found.
 * Uses your seed profile and remembered answers (dist/ai-seed.json) and the AI backend on localhost:8000.
 * Skipped when QA_SNAPSHOTS is not set, so the normal test run never touches the network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { findPendingQuestions } from '../src/shared/ai-apply/answer-rules';
import { buildAnswers } from '../src/shared/ai-apply/flow';
import { backendClient } from '../src/shared/ai-apply/llm';
import { normalizeProfile } from '../src/shared/ai-apply/profile';
import type { FrameFormData } from '../src/shared/ai-apply/types';

const dir = process.env.QA_SNAPSHOTS;
const only = process.env.QA_ONLY;
const snaps = dir && fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.html') && (!only || f.startsWith(only)))
  : [];
const nodeFetch = globalThis.fetch;

describe.skipIf(!snaps.length)('QA offline', () => {
  it.each(snaps)('%s', async (file) => {
    vi.resetModules();
    const html = fs.readFileSync(path.join(dir!, file), 'utf8');
    let listener: (m: unknown, s: unknown, r: (x: unknown) => void) => boolean = () => false;
    vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (l: typeof listener) => { listener = l; } } } });
    Element.prototype.getClientRects = function (this: Element) {
      return (this.closest('[data-golden-hidden]') ? [] : [{ width: 1, height: 1 }]) as unknown as DOMRectList;
    };
    delete (window as unknown as { __aiFormEngine?: boolean }).__aiFormEngine;
    document.body.innerHTML = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
    await import('../src/content/form-engine');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (m: Record<string, unknown>) => new Promise<any>((res) => { if (listener(m, {}, res) !== true) res(undefined); });

    const r = await send({ type: 'EXTRACT_FORM' });
    expect(r?.ok, String(r?.error)).toBe(true);
    const data = { ...r.data, frameId: 0 } as FrameFormData;
    const seed = JSON.parse(fs.readFileSync('dist/ai-seed.json', 'utf8'));
    // QA_NO_LLM=1: no AI backend (it may be down); every AI question comes back unanswered.
    const llm = process.env.QA_NO_LLM ? async (req) => req.fields.map((f) => ({ field_id: f.id, answer: 'NEEDS_USER_INPUT', confidence: 0, source: 'missing', needs_user_input: true })) : backendClient({ url: process.env.QA_BACKEND ?? 'http://localhost:8000', accessKey: process.env.QA_BACKEND_KEY ?? '' }, nodeFetch);
    const built = await buildAnswers(data, {
      profile: normalizeProfile(seed.profile), resume: { name: 'resume.pdf', type: 'application/pdf', data: 'JVBERg==', text: '' },
      memory: seed.formMemory ?? {}, bank: [], now: () => Date.now(), generate: llm,
    } as never, '', true);
    const byId = new Map(data.fields.map((f) => [f.id, f]));
    const out = {
      page: file.replace(/\.html$/, ''),
      title: document.title,
      fields: data.fields.map((f) => ({ label: f.label, type: f.type, required: f.required, options: f.options.slice(0, 12) })),
      answers: built.answers.map((a) => ({ label: byId.get(a.field_id)?.label, answer: a.answer.slice(0, 120), source: a.source })),
      unanswered: findPendingQuestions(data, built.answers).map((p) => p.label),
      needsYou: built.answers.filter((a) => a.needs_user_input || a.answer === 'NEEDS_USER_INPUT').map((a) => byId.get(a.field_id)?.label),
      next: (await send({ type: 'FIND_CONTINUE' }))?.text ?? null,
      submit: (await send({ type: 'FIND_SUBMIT' }))?.text ?? null,
      counts: built.counts,
    };
    fs.writeFileSync(path.join(dir!, `${out.page}.report.json`), JSON.stringify(out, null, 2));
  }, 180_000);
});
