// Bundles the extension into dist/. Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { iconPng } from './icon.mjs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('src/manifest.json', `${outdir}/manifest.json`);
cpSync('src/board/board.html', `${outdir}/board.html`);
cpSync('src/board/board.css', `${outdir}/board.css`);
// The links refresh loads. Fail the build on a JSON syntax error; the tests check the entries themselves.
try {
  JSON.parse(readFileSync('sources.json', 'utf8'));
} catch (e) {
  console.error(`sources.json is not valid JSON: ${e.message}`);
  process.exit(1);
}
cpSync('sources.json', `${outdir}/sources.json`);
// Your AI apply data from job-apply-ai-mvp (git-ignored); the service worker loads it once.
if (existsSync('seed/ai-seed.json')) cpSync('seed/ai-seed.json', `${outdir}/ai-seed.json`);
// Your career-site account for the account agent (src/content/account.ts): ACCOUNT_EMAIL and ACCOUNT_PASSWORD from
// .env (git-ignored). Only those two keys are copied, into dist/account.json, which no web page can fetch (the
// manifest lists no web-accessible resources). Nothing from .env is printed.
if (existsSync('.env')) {
  const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]));
  if (env.ACCOUNT_EMAIL && env.ACCOUNT_PASSWORD) {
    writeFileSync(`${outdir}/account.json`, JSON.stringify({ email: env.ACCOUNT_EMAIL, password: env.ACCOUNT_PASSWORD }));
    console.log('account: ACCOUNT_EMAIL/ACCOUNT_PASSWORD found in .env');
  } else {
    console.log('account: .env has no ACCOUNT_EMAIL/ACCOUNT_PASSWORD; account pages will need you');
  }
}
for (const size of [16, 48, 128]) writeFileSync(`${outdir}/icon-${size}.png`, iconPng(size));

const common = {
  bundle: true,
  target: 'chrome116',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
};

const builds = [
  // MAIN-world hook must be a classic script, not a module.
  { ...common, entryPoints: { 'main-hook': 'src/content/main-hook.ts' }, outdir, format: 'iife' },
  { ...common, entryPoints: { collector: 'src/content/collector.ts' }, outdir, format: 'iife' },
  { ...common, entryPoints: { applier: 'src/content/applier.ts' }, outdir, format: 'iife' },
  // AI apply's form engine: injected by the service worker with chrome.scripting, not listed in the manifest.
  { ...common, entryPoints: { 'form-engine': 'src/content/form-engine.ts' }, outdir, format: 'iife' },
  { ...common, entryPoints: { 'service-worker': 'src/background/service-worker.ts' }, outdir, format: 'esm' },
  { ...common, entryPoints: { board: 'src/board/main.tsx' }, outdir, format: 'esm' },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
