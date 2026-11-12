// Real-Electron probe apps for tests: the pinned, cached Linux Electron with a probe
// main installed exactly as a build installs an app (linux-compat/ entry, config,
// platform table). Tests skip when the Electron zip is not cached.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installCompat } = require('../../lib/build.cjs');

const ROOT = path.resolve(__dirname, '../..');

function electronZip(version) {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-transplant', `electron-v${version}-linux-x64.zip`);
}

const skipUnlessElectron = (version) => (fs.existsSync(electronZip(version)) ? false : `no cached ${electronZip(version)}`);

const PROBE_CONFIG = { id: 'probe', envPrefix: 'PROBE', install: { id: 'probe-desktop' }, compat: {} };

// files: { 'main.js': source, ... } written into the app; main is ./main.js unless given.
function probeRuntime(dir, { version, files, main = './main.js', config = PROBE_CONFIG, pkg = {} }) {
  const runtime = path.join(dir, 'runtime');
  execFileSync('unzip', ['-q', '-o', electronZip(version), '-d', runtime]);
  fs.rmSync(path.join(runtime, 'resources/default_app.asar'), { force: true });
  const app = path.join(runtime, 'resources/app');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true });
    fs.writeFileSync(path.join(app, name), source);
  }
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'probe', version: '0.0.0', main, ...pkg }));
  installCompat(app, config, path.join(ROOT, 'compat/platform-apis', `electron-${version}.json`), version);
  return runtime;
}

function runProbe(runtime, { env = {}, args = [], scale, timeout = 90000, profile }) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  execFileSync(path.join(runtime, 'electron'), [
    '--ozone-platform=headless',
    ...(scale ? [`--force-device-scale-factor=${scale}`] : []),
    `--user-data-dir=${profile ?? path.join(path.dirname(runtime), 'profile')}`,
    ...args,
  ], { env: childEnv, timeout, stdio: ['ignore', 'ignore', process.env.PROBE_DEBUG ? 'inherit' : 'ignore'] });
}

const readEvents = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

module.exports = { electronZip, skipUnlessElectron, probeRuntime, runProbe, readEvents, PROBE_CONFIG, ROOT };
