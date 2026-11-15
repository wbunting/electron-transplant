// The real pipeline on every app whose pinned DMG is in ~/Downloads (or the download
// cache): extract, verify, patch, assemble, as a package build does it (offline,
// explicit inputs, no HOME), then a staged package install. Inputs other than the
// DMG come from the cache (downloaded and verified if missing). ET_SMOKE=1 also
// launches each build headless (network: the apps load their web clients) and
// checks that the main window gets traffic lights and nothing crashes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listApps, loadApp } = require('../lib/apps.cjs');
const { dmgDir, dmgPattern } = require('../lib/build.cjs');
const { electronZip } = require('../lib/electron.cjs');
const { find7zip } = require('../lib/dmg.cjs');
const { npmTarball } = require('../lib/natives.cjs');
const { cachedDmgs } = require('../lib/fetch.cjs');
const { hashFile } = require('../lib/util.cjs');
const { readEvents } = require('./support/probe-app.cjs');

const CLI = path.join(__dirname, '../bin/electron-transplant');

// PATH for a build without HOME: the real Python first, in case python3 on PATH is a
// version-manager shim that needs HOME itself.
function homelessPath(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(), path.join(bin, 'python3'));
  return `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`;
}

async function pinnedDmg(config) {
  const dir = dmgDir(config);
  const pattern = dmgPattern(config);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => pattern.test(n)).map((n) => path.join(dir, n)) : [];
  for (const file of [...files, ...cachedDmgs(config.id)]) {
    const sha = await hashFile(file);
    const pin = config.pins.find((p) => p.sha256 === sha);
    if (pin) return { file, pin };
  }
  return null;
}

for (const id of listApps()) {
  test(`${id}: pinned DMG builds into a Linux runtime`, async (t) => {
    const { config } = loadApp(id);
    const found = await pinnedDmg(config);
    if (!found) return t.skip(`no pinned ${config.dmg.glob} in ${dmgDir(config)} or the download cache`);
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `et-build-${id}-`));
    try {
      const args = ['build', id, '--offline', '--out', path.join(workRoot, 'out'), '--dmg', found.file,
        '--electron-zip', await electronZip(found.pin.electron, { log: () => {} }), '--sevenzip', find7zip()];
      for (const spec of Object.values(config.natives ?? {}).filter((s) => s.action === 'npm-prebuild')) args.push('--npm-tarball', await npmTarball(spec, {}));
      const home = path.join(workRoot, 'homeless-shelter');
      const env = { PATH: homelessPath(workRoot), HOME: home, SOURCE_DATE_EPOCH: '1700000000' };
      const lines = execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' }).split('\n');
      assert.equal(fs.existsSync(home), false);
      const result = { runtime: path.join(workRoot, 'out/runtime'), appDir: path.join(workRoot, 'out/app') };
      for (const patch of config.patches ?? []) assert.ok(lines.includes(`  patch ${patch.name}: applied`), `${patch.name} not applied`);
      const transplant = JSON.parse(fs.readFileSync(path.join(result.runtime, 'TRANSPLANT.json'), 'utf8'));
      assert.equal(transplant.app, id);
      assert.equal(transplant.dmg.pinned, true);
      assert.ok(fs.existsSync(path.join(result.runtime, 'electron')));
      assert.ok(!fs.existsSync(path.join(result.runtime, 'resources/default_app.asar')));
      for (const name of config.resources?.drop ?? []) assert.ok(!fs.existsSync(path.join(result.runtime, 'resources', name)), name);
      for (const file of Object.keys(config.nativeFiles ?? {})) assert.ok(!fs.existsSync(path.join(result.appDir, file)), file);
      for (const file of Object.keys(config.addFiles ?? {})) assert.ok(fs.existsSync(path.join(result.appDir, file)), file);
      for (const { to } of config.resources?.derive ?? []) assert.ok(fs.existsSync(path.join(result.runtime, 'resources', to)), to);
      assert.deepEqual(fs.readdirSync(path.join(result.runtime, 'resources')).filter((n) => n.includes(':')), []);
      assert.equal(transplant.builtAt, '2023-11-14T22:13:20.000Z');

      // Staged as a package for /usr.
      const destdir = path.join(workRoot, 'pkg');
      execFileSync(process.execPath, [CLI, 'install', id, '--from', path.join(workRoot, 'out'), '--layout', 'package', '--prefix', '/usr', '--destdir', destdir], { env, stdio: 'ignore' });
      const { id: installId, command } = config.install;
      assert.deepEqual(fs.readdirSync(destdir), ['usr']);
      assert.ok(fs.statSync(path.join(destdir, 'usr/lib', installId, 'electron')).mode & 0o100);
      assert.match(fs.readFileSync(path.join(destdir, 'usr/bin', command), 'utf8'), /^prefix=\/usr$/m);
      const entry = fs.readFileSync(path.join(destdir, 'usr/share/applications', `${installId}.desktop`), 'utf8');
      assert.ok(entry.split('\n').includes(`Exec=/usr/bin/${command} -- %u`), entry);
      for (const scheme of config.install.schemes ?? []) assert.match(entry, new RegExp(`x-scheme-handler/${scheme};`));
      assert.ok(fs.existsSync(path.join(destdir, `usr/share/icons/hicolor/${transplant.iconSize}x${transplant.iconSize}/apps/${installId}.png`)));

      if (process.env.ET_SMOKE !== '1') return;
      const out = path.join(workRoot, 'smoke');
      const script = path.join(workRoot, 'smoke.json');
      fs.writeFileSync(script, JSON.stringify([{ wait: 1000, bounds: [1280, 800] }, { wait: 15000, state: true }]));
      execFileSync('node', [path.join(__dirname, '../scripts/dev-snapshot.cjs'), result.runtime, out, script], { stdio: 'ignore', timeout: 180000 });
      const harness = fs.readFileSync(path.join(out, 'harness.log'), 'utf8');
      // Apps that keep their own window buttons (Figma's non-macOS tab bar) get none.
      if (config.smoke?.trafficLights !== false) assert.match(harness, /"lights",\{"x":\d+,"y":\d+,"width":54,"height":16\}/);
      else assert.doesNotMatch(harness, /"lights"/);
      const events = readEvents(path.join(out, 'events.jsonl'));
      assert.equal(events[0].kind, 'session');
      assert.deepEqual(events.filter((e) => e.kind === 'uncaught' || e.kind === 'native-load-failed'), []);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });
}
