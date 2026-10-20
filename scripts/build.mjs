// Bundles the extension into dist/. Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { iconPng } from './icon.mjs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('src/manifest.json', `${outdir}/manifest.json`);
cpSync('src/board/board.html', `${outdir}/board.html`);
cpSync('src/board/board.css', `${outdir}/board.css`);
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
  { ...common, entryPoints: { 'service-worker': 'src/background/service-worker.ts' }, outdir, format: 'esm' },
  { ...common, entryPoints: { board: 'src/board/main.tsx' }, outdir, format: 'esm' },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
