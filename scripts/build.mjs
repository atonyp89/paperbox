// Builds the extension into dist/. Load dist/ in chrome://extensions → "Load unpacked".
//   node scripts/build.mjs           one-off build
//   node scripts/build.mjs --watch   rebuild on change (then reload the extension to pick it up)
//
// background.ts (the service worker: session key, signing) is bundled with viem; content.js and bridge.js
// are plain scripts and are copied as they are, together with the manifest.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'dist';
const copies = [
  ['manifest.json', 'manifest.json'],
  ['src/content.js', 'content.js'],
  ['src/bridge.js', 'bridge.js'],
];

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  for (const [from, to] of copies) await cp(from, `${outdir}/${to}`);
}

const copyStaticPlugin = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      await copyStatic();
      console.log(`[${new Date().toLocaleTimeString()}] built → ${outdir}/`);
    });
  },
};

await rm(outdir, { recursive: true, force: true });

const options = {
  entryPoints: { background: 'src/background.ts' },
  outdir,
  bundle: true,
  format: 'esm', // the manifest declares a module service worker
  target: 'chrome111',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [copyStaticPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // esbuild only watches what it bundles; poll the copied files too.
  const { watch: fsWatch } = await import('node:fs');
  for (const [from] of copies) fsWatch(from, () => copyStatic().then(() => console.log(`[${new Date().toLocaleTimeString()}] copied ${from}`)));
  console.log('watching for changes…');
} else {
  await esbuild.build(options);
}
