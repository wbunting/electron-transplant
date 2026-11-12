#!/usr/bin/env node
// DEV ONLY: run a built runtime headless with the dev harness and a step script,
// leaving snapshots in OUT_DIR. The runtime is copied (never modified) and runs
// with a throwaway profile, so nothing touches the desktop or real app data.
//   scripts/dev-snapshot.cjs RUNTIME_DIR OUT_DIR SCRIPT.json [--scale N] [-- APP_ARGS...]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const asar = require(require.resolve('@electron/asar', { paths: [ROOT] }));

async function main(argv) {
  const sep = argv.indexOf('--');
  const appArgs = sep === -1 ? [] : argv.slice(sep + 1);
  const args = sep === -1 ? argv : argv.slice(0, sep);
  const scaleAt = args.indexOf('--scale');
  const scale = scaleAt === -1 ? '2' : args.splice(scaleAt, 2)[1];
  const [runtime, outDir, scriptFile] = args.map((p) => path.resolve(p));
  if (!scriptFile) throw Error('Usage: dev-snapshot.cjs RUNTIME_DIR OUT_DIR SCRIPT.json [--scale N] [-- APP_ARGS...]');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const dev = path.join(outDir, 'devrt');
  fs.rmSync(dev, { recursive: true, force: true });
  fs.cpSync(runtime, dev, { recursive: true, verbatimSymlinks: true });
  const app = path.join(outDir, 'devapp');
  fs.rmSync(app, { recursive: true, force: true });
  asar.extractAll(path.join(runtime, 'resources/app.asar'), app);
  fs.copyFileSync(path.join(__dirname, 'dev-harness.cjs'), path.join(app, 'linux-compat/dev-harness.cjs'));
  fs.appendFileSync(path.join(app, 'linux-compat/entry.cjs'), "\n// DEV ONLY (dev-snapshot copy).\nrequire('./dev-harness.cjs')(electron);\n");
  fs.rmSync(path.join(dev, 'resources/app.asar'));
  fs.rmSync(path.join(dev, 'resources/app.asar.unpacked'), { recursive: true, force: true });
  await asar.createPackageWithOptions(app, path.join(dev, 'resources/app.asar'), { unpack: '*.node' });
  fs.copyFileSync(scriptFile, path.join(outDir, 'script.json'));
  fs.rmSync(path.join(outDir, 'harness.log'), { force: true });
  const env = { ...process.env, ET_DEV_SCRIPT: path.join(outDir, 'script.json'), ET_DEV_SCALE: scale, ELECTRON_IS_DEV: '0', ELECTRON_FORCE_IS_PACKAGED: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.endsWith('_COMPAT_LOG')) delete env[key];
  const prefix = JSON.parse(fs.readFileSync(path.join(app, 'linux-compat/config.json'), 'utf8')).envPrefix;
  env[`${prefix}_COMPAT_LOG`] = path.join(outDir, 'events.jsonl');
  let status = 0;
  try {
    execFileSync(path.join(dev, 'electron'), [
      '--ozone-platform=headless', `--force-device-scale-factor=${scale}`, `--user-data-dir=${path.join(outDir, 'profile')}`, ...appArgs,
    ], { env, stdio: ['ignore', fs.openSync(path.join(outDir, 'stdout.log'), 'w'), 'inherit'], timeout: 10 * 60 * 1000 });
  } catch (error) {
    status = error.status ?? 1;
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
  const log = fs.existsSync(path.join(outDir, 'harness.log')) ? fs.readFileSync(path.join(outDir, 'harness.log'), 'utf8') : '';
  process.stdout.write(log || 'no harness log\n');
  if (status) process.stdout.write(`app exited with status ${status}\n`);
  // The steps ran to the end: the app's own exit status is reported, not fatal.
  if (!/^done$/m.test(log)) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
