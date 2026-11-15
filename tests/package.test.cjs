// Package builds: offline builds that take every input explicitly, and the staged
// system install (install --layout package) that pacman and Nix packages use.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { installPackage, packagePrefix } = require('../lib/install.cjs');
const { buildTime } = require('../lib/build.cjs');
const { electronZip, platformApis } = require('../lib/electron.cjs');
const { find7zip } = require('../lib/dmg.cjs');
const { handleNatives } = require('../lib/natives.cjs');
const { loadApp } = require('../lib/apps.cjs');

const CLI = path.join(__dirname, '../bin/electron-transplant');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `et-${name}-`));
const { config: notion, dir: notionDir } = loadApp('notion');
const { config: superhuman, dir: superhumanDir } = loadApp('superhuman');

// The CLI as a Nix build runs it: no HOME directory, nothing but PATH.
function cli(args, env = {}) {
  const home = path.join(tmp('nohome'), 'homeless-shelter');
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...env } });
  assert.equal(fs.existsSync(home), false, 'HOME was created');
  return result;
}

test('offline builds name each missing input before touching anything', () => {
  const dir = tmp('offline');
  const fake = path.join(dir, 'Linear-0.0.0-universal.dmg');
  fs.writeFileSync(fake, 'not a dmg');
  const out = path.join(dir, 'out');
  const fail = (args, pattern) => {
    const r = cli(['build', ...args, '--offline']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(fs.existsSync(out), false);
  };
  fail(['linear', '--dmg', fake], /Offline build: pass --out DIR/);
  fail(['linear', '--out', out], /Offline build: pass --dmg PATH \(Linear-\*\.dmg/);
  fail(['linear', '--dmg', fake, '--out', out], /is not pinned in apps\/linear\/app\.cjs/);
  fail(['linear', '--dmg', fake, '--out', out, '--accept-unpinned'], /Offline build: pass --electron-zip PATH/);
  fail(['notion', '--dmg', fake, '--out', out, '--accept-unpinned', '--electron-zip', fake], /Offline build: pass --npm-tarball PATH for better-sqlite3 13\.0\.1/);
  fail(['linear', '--dmg', fake, '--out', out, '--accept-unpinned', '--electron-zip', fake, '--npm-tarball', path.join(dir, 'nope.tgz')], /npm tarball not found/);
  // Without 7-Zip on PATH (or --sevenzip), no fallback download.
  const r = cli(['build', 'linear', '--dmg', fake, '--out', out, '--accept-unpinned', '--electron-zip', fake, '--offline'], { PATH: path.dirname(process.execPath) });
  assert.match(r.stderr, /Offline build: no 7zz or 7z on PATH; pass --sevenzip PATH/);
  assert.match(cli(['build', 'linear', '--offline', '--install', '--out', out]).stderr, /stage them with `install --from DIR --layout package`/);
  // --out must be new or empty.
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'x'), '');
  assert.match(cli(['build', 'linear', '--dmg', fake, '--out', out, '--accept-unpinned', '--electron-zip', fake, '--offline', '--sevenzip', fake]).stderr, /is not empty/);
});

test('offline inputs: pinned hashes only, nothing fetched or read from the caches', async () => {
  const dir = tmp('offline-inputs');
  const log = () => {};
  const zip = path.join(dir, 'electron-v44.9.1-linux-x64.zip');
  fs.writeFileSync(zip, 'tampered');
  await assert.rejects(electronZip('44.9.1', { offline: true, zip, log }), /is not the pinned electron-v44\.9\.1-linux-x64\.zip: sha256 [0-9a-f]{64}, expected 994bc366/);
  await assert.rejects(electronZip('44.9.1', { offline: true, log }), /pass --electron-zip PATH \(electron-v44\.9\.1-linux-x64\.zip, sha256 994bc366/);
  await assert.rejects(electronZip('1.2.3', { offline: true, acceptUnpinned: true, zip, log }), /Electron 1\.2\.3 is not in pins\/electron\.json; an offline build needs a pinned Electron/);
  await assert.rejects(platformApis('1.2.3', { offline: true, log }), /no compat\/platform-apis\/electron-1\.2\.3\.json/);
  assert.match(await platformApis('44.9.1', { offline: true, log }), /compat\/platform-apis\/electron-44\.9\.1\.json$/);
  assert.throws(() => find7zip({ explicit: path.join(dir, 'missing-7z'), offline: true }), /7-Zip not found/);

  // npm prebuilds: a given tarball is matched by its pinned integrity.
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(path.join(staging, 'package/prebuilds'), { recursive: true });
  const elf = Buffer.alloc(64);
  elf.write('7f454c46', 'hex');
  elf.writeUInt16LE(0x3e, 18);
  fs.writeFileSync(path.join(staging, 'package/prebuilds/linux-x64.node'), elf);
  const tarball = path.join(dir, 'abc123-sqlite-13.0.1.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
  const appDir = path.join(dir, 'app');
  const moduleDir = path.join(appDir, 'node_modules/sqlite');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: 'sqlite', version: '13.0.1' }));
  const natives = { sqlite: { action: 'npm-prebuild', package: 'sqlite', version: '13.0.1', integrity, sha256: 'c'.repeat(64), files: { 'prebuilds/linux-x64.node': 'prebuilds/linux-x64.node' } } };
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(dir, 'must-not-exist');
  try {
    await assert.rejects(handleNatives(appDir, natives, dir, { offline: true, tarballs: [zip] }), /pass --npm-tarball PATH for sqlite 13\.0\.1 \(https:\/\/registry\.npmjs\.org\/sqlite\/-\/sqlite-13\.0\.1\.tgz, sha256 c{64}\)/);
    assert.deepEqual(await handleNatives(appDir, natives, dir, { offline: true, tarballs: [zip, tarball] }), [['sqlite', 'npm-prebuild']]);
    assert.deepEqual(fs.readFileSync(path.join(moduleDir, 'prebuilds/linux-x64.node')), elf);
    assert.deepEqual(fs.readdirSync(path.join(appDir, 'node_modules')), ['sqlite']);
    assert.equal(fs.existsSync(process.env.XDG_CACHE_HOME), false);
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
  }
});

test('builtAt follows SOURCE_DATE_EPOCH', () => {
  assert.equal(buildTime({ SOURCE_DATE_EPOCH: '1700000000' }), '2023-11-14T22:13:20.000Z');
  assert.throws(() => buildTime({ SOURCE_DATE_EPOCH: 'yesterday' }), /whole seconds/);
  assert.match(buildTime({}), /^\d{4}-\d\d-\d\dT/);
});

// A built runtime as the build leaves it (fake electron records argv).
function fakeBuild(dir, transplant) {
  const runtime = path.join(dir, 'build/runtime');
  fs.mkdirSync(path.join(runtime, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'electron'), `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/argv"
echo "RUN_AS_NODE=\${ELECTRON_RUN_AS_NODE-unset}" >> "$HOME/argv"
echo "LAUNCHER=\${ET_APP_LAUNCHER-unset}" >> "$HOME/argv"
echo "ICON=\${ET_APP_ICON-unset}" >> "$HOME/argv"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(runtime, 'chrome-sandbox'), '', { mode: 0o755 });
  fs.writeFileSync(path.join(runtime, 'resources/app.asar'), 'asar');
  fs.writeFileSync(path.join(runtime, 'app-icon.png'), 'png');
  fs.writeFileSync(path.join(runtime, 'LICENSE'), 'electron licence');
  fs.writeFileSync(path.join(runtime, 'LICENSES.chromium.html'), 'chromium licences');
  fs.writeFileSync(path.join(runtime, 'TRANSPLANT.json'), JSON.stringify({ iconSize: 512, ...transplant }));
  // As unzip restores Electron 45.1.0's zip (umask does not apply to chmod).
  fs.chmodSync(path.join(runtime, 'electron'), 0o777);
  fs.chmodSync(path.join(runtime, 'chrome-sandbox'), 0o777);
  fs.chmodSync(path.join(runtime, 'resources/app.asar'), 0o666);
  fs.chmodSync(path.join(runtime, 'resources'), 0o777);
  return path.dirname(runtime);
}

const listTree = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
};

test('install --layout package stages a system layout under DESTDIR with final paths and no side effects', () => {
  const dir = tmp('package');
  const from = fakeBuild(dir, { app: 'notion', version: '7.43.0', urlSchemes: ['notion', 'notion-agents'] });
  const destdir = path.join(dir, 'pkg');
  // Every tool a rootless install calls, recording if called.
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin);
  for (const tool of ['xdg-mime', 'update-desktop-database', 'gtk-update-icon-cache', 'gtk4-update-icon-cache', 'xdg-settings']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho ${tool} >> "${dir}/side-effects.log"\n`, { mode: 0o755 });
  }
  const r = cli(['install', 'notion', '--from', from, '--layout', 'package', '--prefix', '/usr', '--destdir', destdir], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'side-effects.log')), false);
  assert.deepEqual(listTree(destdir), [
    'usr/', 'usr/bin/', 'usr/bin/notion-desktop',
    'usr/lib/', 'usr/lib/notion-desktop/', 'usr/lib/notion-desktop/LICENSE', 'usr/lib/notion-desktop/LICENSES.chromium.html', 'usr/lib/notion-desktop/TRANSPLANT.json',
    'usr/lib/notion-desktop/app-icon.png', 'usr/lib/notion-desktop/chrome-sandbox', 'usr/lib/notion-desktop/electron', 'usr/lib/notion-desktop/resources/', 'usr/lib/notion-desktop/resources/app.asar',
    'usr/share/', 'usr/share/applications/', 'usr/share/applications/notion-desktop.desktop',
    'usr/share/icons/', 'usr/share/icons/hicolor/', 'usr/share/icons/hicolor/512x512/', 'usr/share/icons/hicolor/512x512/apps/', 'usr/share/icons/hicolor/512x512/apps/notion-desktop.png',
    'usr/share/licenses/', 'usr/share/licenses/notion-desktop/', 'usr/share/licenses/notion-desktop/LICENSE.electron', 'usr/share/licenses/notion-desktop/LICENSE.electron-transplant', 'usr/share/licenses/notion-desktop/LICENSES.chromium.html',
  ]);
  const launcher = fs.readFileSync(path.join(destdir, 'usr/bin/notion-desktop'), 'utf8');
  assert.match(launcher, /^prefix=\/usr$/m);
  assert.match(launcher, /^app_dir="\$\{NOTION_APP_DIR:-\$prefix\/lib\/notion-desktop\}"$/m);
  assert.ok(fs.statSync(path.join(destdir, 'usr/bin/notion-desktop')).mode & 0o111);
  const entry = fs.readFileSync(path.join(destdir, 'usr/share/applications/notion-desktop.desktop'), 'utf8');
  assert.ok(entry.split('\n').includes('Exec=/usr/bin/notion-desktop -- %u'), entry);
  assert.match(entry, /^Icon=notion-desktop$/m);
  assert.match(entry, /^MimeType=x-scheme-handler\/notion;x-scheme-handler\/notion-agents;$/m);
  assert.match(entry, /^StartupWMClass=notion-desktop$/m);
  for (const file of ['usr/bin/notion-desktop', 'usr/share/applications/notion-desktop.desktop']) {
    assert.ok(!fs.readFileSync(path.join(destdir, file), 'utf8').includes(dir), `${file} mentions the staging directory`);
  }
  // Modes as an archive left them (Electron 45.1.0's zip: 0666/0777) lose group and other write.
  for (const file of ['electron', 'chrome-sandbox', 'resources/app.asar']) assert.equal(fs.statSync(path.join(destdir, 'usr/lib/notion-desktop', file)).mode & 0o022, 0, file);
  // Re-staging replaces the runtime rather than merging into it.
  fs.writeFileSync(path.join(destdir, 'usr/lib/notion-desktop/stale'), '');
  assert.equal(cli(['install', 'notion', '--from', path.join(from, 'runtime'), '--layout', 'package', '--prefix', '/usr', '--destdir', destdir]).status, 0);
  assert.equal(fs.existsSync(path.join(destdir, 'usr/lib/notion-desktop/stale')), false);
});

test('a package prefix can be any plain absolute path (a Nix store path); launchers and helpers run from it', () => {
  const dir = tmp('package-prefix');
  const from = fakeBuild(dir, { app: 'superhuman', version: '1045.0.0', urlSchemes: ['mailto', 'superhuman'] });
  // No DESTDIR: the prefix is the output directory, as with Nix's $out.
  const prefix = path.join(dir, 'store/0000-superhuman-desktop-1045.0.0');
  installPackage({ config: superhuman, configDir: superhumanDir, runtime: path.join(from, 'runtime'), prefix, log: () => {} });
  assert.deepEqual(fs.readdirSync(prefix).sort(), ['bin', 'lib', 'share']);
  assert.ok(fs.existsSync(path.join(prefix, 'share/superhuman-desktop/finish-login.cjs')));
  assert.ok(fs.existsSync(path.join(prefix, 'share/superhuman-desktop/browser-extension/manifest.json')));
  assert.deepEqual(fs.readdirSync(path.join(prefix, 'share/applications')).sort(), ['superhuman-desktop-finish-login.desktop', 'superhuman-desktop.desktop']);
  const run = (command, args) => {
    const home = tmp('home');
    execFileSync('bash', [path.join(prefix, 'bin', command), ...args], { env: { PATH: process.env.PATH, HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') } });
    return fs.readFileSync(path.join(home, 'argv'), 'utf8').trim().split('\n');
  };
  assert.deepEqual(run('superhuman-desktop', ['--', 'superhuman://x']).slice(-5, -2), ['--', 'superhuman://x', 'RUN_AS_NODE=unset']);
  assert.deepEqual(run('superhuman-desktop-finish-login', ['--notify']), [
    path.join(prefix, 'share/superhuman-desktop/finish-login.cjs'), '--notify', 'RUN_AS_NODE=1',
    `LAUNCHER=${path.join(prefix, 'bin/superhuman-desktop')}`, `ICON=${path.join(prefix, 'share/icons/hicolor/512x512/apps/superhuman-desktop.png')}`,
  ]);
  const helper = fs.readFileSync(path.join(prefix, 'share/applications/superhuman-desktop-finish-login.desktop'), 'utf8');
  assert.ok(helper.split('\n').includes(`Exec=${path.join(prefix, 'bin/superhuman-desktop-finish-login')} --notify`), helper);

  assert.throws(() => packagePrefix('usr'), /absolute plain path/);
  assert.throws(() => packagePrefix('/opt/my apps'), /absolute plain path/);
  assert.throws(() => packagePrefix('/usr/../etc'), /absolute plain path/);
  assert.throws(() => packagePrefix('/'), /other than \//);
  assert.throws(() => packagePrefix('/opt/100%'), /absolute plain path/);
  assert.equal(packagePrefix('/usr/'), '/usr');
  assert.throws(() => installPackage({ config: notion, configDir: notionDir, runtime: path.join(from, 'runtime'), prefix: '/usr', destdir: path.join(dir, 'd'), log: () => {} }), /is a superhuman build, not notion/);
  assert.throws(() => installPackage({ config: notion, configDir: notionDir, runtime: path.join(from, 'runtime'), prefix: '/usr', destdir: 'relative', log: () => {} }), /--destdir must be absolute/);
  assert.match(cli(['install', 'notion', '--from', dir, '--layout', 'package', '--prefix', '/usr']).stderr, /No build in/);
  assert.match(cli(['install', 'notion', '--from', from, '--layout', 'package']).stderr, /needs --prefix/);
  assert.match(cli(['install', 'notion', '--from', from, '--destdir', dir]).stderr, /--destdir is for --layout package/);
});
