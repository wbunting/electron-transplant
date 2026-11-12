// Build steps that don't need Electron: patches, native handling, binary scan,
// compat installation and app-config validation.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applyPatch } = require('../lib/patch.cjs');
const { handleNatives, foreignBinaries, stubSource } = require('../lib/natives.cjs');
const { installCompat, COMPAT_FILES } = require('../lib/build.cjs');
const { listApps, loadApp, validate } = require('../lib/apps.cjs');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `et-${name}-`));
const MACHO = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.alloc(32)]);
const ELF = (machine) => { const b = Buffer.alloc(64); b.write('7f454c46', 'hex'); b.writeUInt16LE(machine, 18); return b; };

test('patches match an exact count, fail loudly on drift, and are not applied twice', () => {
  const dir = tmp('patch');
  fs.writeFileSync(path.join(dir, 'main.js'), 'a("darwin");b("darwin");');
  const twice = { name: 'two', file: 'main.js', from: '"darwin"', to: '"linux"', count: 2 };
  assert.equal(applyPatch(dir, twice), 'applied');
  assert.equal(fs.readFileSync(path.join(dir, 'main.js'), 'utf8'), 'a("linux");b("linux");');
  assert.equal(applyPatch(dir, twice), 'already');
  assert.throws(() => applyPatch(dir, { name: 'gone', file: 'main.js', from: 'missing', to: 'x' }), /expected 1 match\(es\) in main\.js, found 0/);
  fs.writeFileSync(path.join(dir, 'main.js'), 'x;x;');
  assert.throws(() => applyPatch(dir, { name: 'dup', file: 'main.js', from: 'x;', to: 'y;' }), /found 2/);
  assert.throws(() => applyPatch(dir, { name: 'escape', file: '../outside.js', from: 'a', to: 'b' }), /outside app/);
});

function fakeModule(appDir, name, version = '1.0.0') {
  const dir = path.join(appDir, 'node_modules', name);
  fs.mkdirSync(path.join(dir, 'build/Release'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build/Release/addon.node'), MACHO);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: './build/Release/addon.node', gypfile: true, os: ['darwin'] }));
  return dir;
}

test('native modules are shimmed, stubbed, trimmed or replaced from an integrity-pinned npm prebuild', async () => {
  const appDir = tmp('natives');
  const configDir = tmp('config');
  fs.writeFileSync(path.join(configDir, 'shim.cjs'), "module.exports = { perform() {}, linuxShim: true };\n");
  const shimmed = fakeModule(appDir, '@x/haptics');
  const stubbed = fakeModule(appDir, 'cf-prefs');
  const trimmed = fakeModule(appDir, '@x/native');
  fs.writeFileSync(path.join(trimmed, 'module.js'), 'module.exports = {};');
  const replaced = fakeModule(appDir, 'sqlite', '13.0.1');

  // A local "npm tarball" in the cache, so the test needs no network.
  const cache = tmp('cache');
  const staging = tmp('tarball');
  fs.mkdirSync(path.join(staging, 'package/prebuilds'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'package/prebuilds/linux-x64.node'), ELF(0x3e));
  fs.mkdirSync(path.join(cache, 'electron-transplant/npm'), { recursive: true });
  const tarball = path.join(cache, 'electron-transplant/npm/sqlite-13.0.1.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    const results = await handleNatives(appDir, {
      '@x/haptics': { action: 'shim', shim: 'shim.cjs' },
      'cf-prefs': { action: 'stub', exports: ['getPreferenceValue'] },
      '@x/native': { action: 'remove', paths: ['build'] },
      sqlite: { action: 'npm-prebuild', package: 'sqlite', version: '13.0.1', integrity, files: { 'prebuilds/linux-x64.node': 'prebuilds/linux-x64.node' }, remove: ['build'] },
    }, configDir);
    assert.deepEqual(results.map(([, action]) => action), ['shim', 'stub', 'remove', 'npm-prebuild']);
    assert.equal(require(shimmed).linuxShim, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shimmed, 'package.json'))).os, ['linux']);
    const stub = require(stubbed);
    assert.throws(() => stub.getPreferenceValue('x'), /cf-prefs is not available on Linux/);
    assert.equal(fs.existsSync(path.join(trimmed, 'build')), false);
    assert.equal(fs.existsSync(path.join(trimmed, 'module.js')), true);
    assert.equal(fs.readFileSync(path.join(replaced, 'prebuilds/linux-x64.node')).readUInt16LE(18), 0x3e);
    assert.deepEqual(foreignBinaries(appDir), []);

    // A tampered tarball or a version the config doesn't pin is refused.
    const other = fakeModule(tmp('natives2'), 'sqlite', '13.0.1');
    await assert.rejects(handleNatives(path.dirname(path.dirname(other)), {
      sqlite: { action: 'npm-prebuild', package: 'sqlite', version: '13.0.1', integrity: 'sha512-AAAA', files: { 'prebuilds/linux-x64.node': 'x.node' } },
    }, configDir), /Checksum mismatch/);
    await assert.rejects(handleNatives(path.dirname(path.dirname(fakeModule(tmp('natives3'), 'sqlite', '12.0.0'))), {
      sqlite: { action: 'npm-prebuild', package: 'sqlite', version: '13.0.1', integrity, files: {} },
    }, configDir), /ships 12\.0\.0, config pins 13\.0\.1/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
  }
});

test('the binary scan reports Mach-O, Windows and non-x86-64 ELF anywhere', () => {
  const dir = tmp('scan');
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a/b/helper'), MACHO);
  fs.writeFileSync(path.join(dir, 'win.dll'), Buffer.from('MZ\x90\x00'));
  fs.writeFileSync(path.join(dir, 'arm.node'), ELF(0xb7));
  fs.writeFileSync(path.join(dir, 'ok.node'), ELF(0x3e));
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'MZ is just text here');
  assert.deepEqual(foreignBinaries(dir).sort((a, b) => a.file.localeCompare(b.file)), [
    { file: 'a/b/helper', kind: 'mach-o' }, { file: 'arm.node', kind: 'elf-other' }, { file: 'win.dll', kind: 'pe' },
  ]);
});

test('generated stubs are valid modules that record and throw', () => {
  const file = path.join(tmp('stub'), 'stub.cjs');
  fs.writeFileSync(file, stubSource('@x/thing', ['a', 'b']));
  const calls = [];
  globalThis[Symbol.for('electron-transplant.recorder')] = { record: (event) => calls.push(event.api) };
  try {
    const stub = require(file);
    assert.throws(() => stub.b(), /@x\/thing is not available on Linux/);
    assert.deepEqual(calls, ['@x/thing.b']);
  } finally {
    delete globalThis[Symbol.for('electron-transplant.recorder')];
  }
});

test('the compat entry replaces main, keeps the original, and names the desktop file', () => {
  const appDir = tmp('compat');
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'x', main: './out/main.js' }));
  const config = { id: 'demo', envPrefix: 'DEMO', install: { id: 'demo-desktop' }, compat: { pageAdapter: { origins: ['https://demo.app'] } } };
  const table = path.join(__dirname, '../compat/platform-apis/electron-44.9.1.json');
  installCompat(appDir, config, table, '44.9.1');
  installCompat(appDir, config, table, '44.9.1');
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  assert.deepEqual([pkg.main, pkg.originalMain, pkg.desktopName], ['./linux-compat/entry.cjs', './out/main.js', 'demo-desktop.desktop']);
  for (const name of COMPAT_FILES) assert.ok(fs.existsSync(path.join(appDir, 'linux-compat', name)), name);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(appDir, 'linux-compat/config.json'))), {
    appId: 'demo', envPrefix: 'DEMO', platformApis: 'electron-44.9.1-platform-apis.json', pageAdapter: { origins: ['https://demo.app'] },
  });
});

test('every bundled app config is valid and its shims exist', () => {
  assert.deepEqual(listApps(), ['linear', 'notion']);
  for (const id of listApps()) {
    const { config } = loadApp(id);
    assert.equal(config.id, id);
    assert.ok(config.pins.length > 0);
  }
  assert.throws(() => loadApp('../etc'), /Invalid app id/);
  const dir = path.join(tmp('apps'), 'bad');
  fs.mkdirSync(dir);
  const base = { id: 'bad', name: 'Bad', bundleId: 'b', envPrefix: 'BAD', dmg: { glob: 'B-*.dmg', app: 'B.app' }, install: { id: 'bad', command: 'bad' } };
  assert.doesNotThrow(() => validate(base, dir));
  assert.throws(() => validate({ ...base, envPrefix: 'bad' }, dir), /UPPER_SNAKE/);
  assert.throws(() => validate({ ...base, install: { id: 'Bad App', command: 'bad' } }, dir), /install\.id/);
  assert.throws(() => validate({ ...base, natives: { x: { action: 'shim', shim: 'missing.cjs' } } }, dir), /shim file not found/);
  assert.throws(() => validate({ ...base, patches: [{ name: 'p', file: 'f', from: 'a', to: 'a' }] }, dir), /different to/);
  assert.throws(() => validate({ ...base, resources: { derive: [{ to: '../x.png', from: 'a.png', recolor: '000000' }] } }, dir), /plain to\/from/);
  assert.throws(() => validate({ ...base, compat: { pageAdapter: { origins: ['http://x'] } } }, dir), /https origins/);
});
