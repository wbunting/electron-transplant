// Build and install features added for Figma, tested on their own: asar headers
// with placeholder entries, loose native files, app-supplied files and hooks, the
// default-protocol-client guard, desktop actions and non-default scheme handlers.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { readRawHeader, withoutInvalidEntries } = require('../lib/asar-header.cjs');
const { handleNativeFiles } = require('../lib/natives.cjs');
const { extractAsar, addFiles } = require('../lib/build.cjs');
const { install, desktopEntry } = require('../lib/install.cjs');
const { validate } = require('../lib/apps.cjs');
const { skipUnlessElectron, probeRuntime, runProbe, readEvents } = require('./support/probe-app.cjs');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `et-${name}-`));
const MACHO = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.alloc(32)]);

// An archive like Figma's: a normal asar plus a header-only placeholder entry.
async function archiveWithPlaceholder(dir, placeholder = { size: -1000, offset: '0' }) {
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(src, 'main.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(src, 'lib/a.txt'), 'hello');
  fs.writeFileSync(path.join(src, 'addon.node'), MACHO);
  const plain = path.join(dir, 'plain.asar');
  await asar.createPackageWithOptions(src, plain, { unpack: '*.node' });
  const { header, dataOffset } = readRawHeader(plain);
  header.files['.codesign'] = placeholder;
  const json = Buffer.from(JSON.stringify(header));
  const pad = (4 - (json.length % 4)) % 4;
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const payload = Buffer.concat([u32(json.length), json, Buffer.alloc(pad)]);
  const pickle = Buffer.concat([u32(payload.length), payload]);
  const out = path.join(dir, 'app.asar');
  fs.writeFileSync(out, Buffer.concat([u32(4), u32(pickle.length), pickle, fs.readFileSync(plain).subarray(dataOffset)]));
  fs.cpSync(`${plain}.unpacked`, `${out}.unpacked`, { recursive: true });
  return { out, headerString: json.toString() };
}

test('placeholder asar entries: integrity uses the stored header; only named invalid entries are left out', async () => {
  const dir = tmp('asar');
  const { out, headerString } = await archiveWithPlaceholder(dir);
  assert.throws(() => asar.extractAll(out, path.join(dir, 'x')), /Invalid archive header at "\/\.codesign"/);
  assert.equal(readRawHeader(out).headerString, headerString);
  const sha = crypto.createHash('sha256').update(readRawHeader(out).headerString).digest('hex');
  assert.equal(sha, crypto.createHash('sha256').update(headerString).digest('hex'));

  const appDir = path.join(dir, 'app');
  extractAsar(out, appDir, { asar: { dropInvalidEntries: ['.codesign'] } }, path.join(dir, 'scratch'));
  assert.equal(fs.readFileSync(path.join(appDir, 'lib/a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(appDir, 'main.js'), 'utf8'), 'module.exports = 1;\n');
  assert.deepEqual(fs.readFileSync(path.join(appDir, 'addon.node')), MACHO);
  assert.equal(fs.existsSync(path.join(appDir, '.codesign')), false);

  // Valid entries are never dropped, and unnamed invalid ones still fail.
  assert.throws(() => withoutInvalidEntries(out, path.join(dir, 'y/app.asar'), ['main.js']), /valid entry; refusing/);
  assert.throws(() => extractAsar(out, path.join(dir, 'z'), {}, path.join(dir, 's2')), /Invalid archive header/);
  assert.throws(() => withoutInvalidEntries(out, path.join(dir, 'w/app.asar'), ['../etc']), /bad entry name/);
});

test('loose native files are removed only when they are foreign binaries inside the app', () => {
  const appDir = tmp('loose');
  fs.writeFileSync(path.join(appDir, 'bindings.node'), MACHO);
  fs.writeFileSync(path.join(appDir, 'main.js'), 'x');
  assert.deepEqual(handleNativeFiles(appDir, { 'bindings.node': { action: 'remove', reason: 'r' } }), [['bindings.node', 'remove']]);
  assert.equal(fs.existsSync(path.join(appDir, 'bindings.node')), false);
  assert.throws(() => handleNativeFiles(appDir, { 'main.js': { action: 'remove' } }), /not a foreign native binary/);
  assert.throws(() => handleNativeFiles(appDir, { 'gone.node': { action: 'remove' } }), /missing/);
  assert.throws(() => handleNativeFiles(appDir, { '../x.node': { action: 'remove' } }), /outside app/);
});

test('app files are added inside the app only, and configs referencing them are validated', () => {
  const appDir = tmp('add');
  const configDir = tmp('cfg');
  fs.mkdirSync(path.join(configDir, 'linux'));
  fs.writeFileSync(path.join(configDir, 'linux/hook.cjs'), 'module.exports = () => {};');
  assert.deepEqual(addFiles(appDir, configDir, { 'linux-x/hook.cjs': 'linux/hook.cjs' }), ['linux-x/hook.cjs']);
  assert.ok(fs.existsSync(path.join(appDir, 'linux-x/hook.cjs')));
  assert.throws(() => addFiles(appDir, configDir, { '../evil.cjs': 'linux/hook.cjs' }), /outside app/);

  const dir = path.join(tmp('apps'), 'x');
  fs.mkdirSync(path.join(dir, 'linux'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'linux/hook.cjs'), '');
  const base = { id: 'x', name: 'X', bundleId: 'x', envPrefix: 'X', dmg: { glob: 'X-*.dmg', app: 'X.app' }, install: { id: 'x-desktop', command: 'x-desktop' } };
  assert.doesNotThrow(() => validate({ ...base, dmg: { ...base.dmg, dir: 'x-mac' }, addFiles: { 'l/hook.cjs': 'linux/hook.cjs' }, compat: { hooks: ['l/hook.cjs'], defaultProtocolClient: false } }, dir));
  assert.throws(() => validate({ ...base, dmg: { ...base.dmg, dir: '..' } }, dir), /dmg\.dir/);
  assert.throws(() => validate({ ...base, compat: { hooks: ['l/hook.cjs'] } }, dir), /must be one of addFiles/);
  assert.throws(() => validate({ ...base, addFiles: { 'l/h.cjs': 'missing.cjs' } }, dir), /existing source/);
  assert.throws(() => validate({ ...base, nativeFiles: { 'a.node': { action: 'remove' } } }, dir), /reason/);
  assert.throws(() => validate({ ...base, install: { ...base.install, actions: [{ id: 'A', name: 'a', args: ['; rm -rf ~'] }] } }, dir), /plain --flags/);
});

test('desktop entries carry a display name and actions; defaultHandler false never sets the default', () => {
  const config = {
    id: 'x', name: 'X', envPrefix: 'X',
    install: { id: 'x-desktop', command: 'x-desktop', name: 'X Desktop', defaultHandler: false, actions: [{ id: 'FinishSignIn', name: 'Finish sign-in', args: ['--finish-sign-in'] }] },
  };
  const entry = desktopEntry(config, '/p', ['x']);
  assert.match(entry, /^Name=X Desktop$/m);
  assert.match(entry, /^MimeType=x-scheme-handler\/x;$/m);
  assert.match(entry, /^Actions=FinishSignIn;$/m);
  assert.match(entry, /^\[Desktop Action FinishSignIn\]\nName=Finish sign-in\nExec="\/p\/bin\/x-desktop" --finish-sign-in$/m);

  // Installed into the data home with a recording xdg-mime first on PATH.
  const home = tmp('defaulthandler');
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'xdg-mime'), `#!/bin/sh\necho "$@" >> "${home}/xdg-mime.log"\n`, { mode: 0o755 });
  const runtime = path.join(home, 'runtime');
  fs.mkdirSync(path.join(runtime, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'resources/app.asar'), 'a');
  fs.writeFileSync(path.join(runtime, 'TRANSPLANT.json'), JSON.stringify({ version: '1.0.0', urlSchemes: ['x'] }));
  const saved = { PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.XDG_DATA_HOME = path.join(home, 'share');
  try {
    install({ config, runtime, prefix: home, log: () => {} });
    assert.equal(fs.existsSync(path.join(home, 'xdg-mime.log')), false);
    install({ config: { ...config, install: { ...config.install, defaultHandler: undefined } }, runtime, prefix: home, log: () => {} });
    assert.equal(fs.readFileSync(path.join(home, 'xdg-mime.log'), 'utf8').trim(), 'default x-desktop.desktop x-scheme-handler/x');
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const GUARD_MAIN = `
const fs = require('node:fs');
const { app } = require('electron');
app.whenReady().then(() => {
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({
    guarded: String(app.setAsDefaultProtocolClient).includes('declined-call'),
    result: app.setAsDefaultProtocolClient('et-probe-scheme'),
    hook: globalThis.__probeHook ?? null,
  }));
  app.quit();
});
`;
const HOOK = `module.exports = ({ electron, envPrefix, record }) => {
  globalThis.__probeHook = { envPrefix, hasApp: typeof electron.app.whenReady === 'function' };
  record({ kind: 'probe-hook', api: 'loaded' });
};`;

test('Electron 44.11.2: the protocol-client guard declines and records; hooks load before main', { skip: skipUnlessElectron('44.11.2') }, () => {
  const dir = tmp('guard');
  // If the guard ever failed, Electron would run these instead of the real tools.
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin);
  for (const tool of ['xdg-settings', 'xdg-mime']) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho ${tool} "$@" >> "${dir}/xdg.log"\n`, { mode: 0o755 });
  const config = { id: 'probe', envPrefix: 'PROBE', install: { id: 'probe-desktop' }, compat: { defaultProtocolClient: false, hooks: ['hooks/probe.cjs'] } };
  const runtime = probeRuntime(dir, { version: '44.11.2', files: { 'main.js': GUARD_MAIN, 'hooks/probe.cjs': HOOK }, config });
  const env = { PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: path.join(dir, 'data'), XDG_CONFIG_HOME: path.join(dir, 'config'), PROBE_OUT: path.join(dir, 'out.json'), PROBE_COMPAT_LOG: path.join(dir, 'events.jsonl') };
  runProbe(runtime, { env });
  assert.deepEqual(JSON.parse(fs.readFileSync(env.PROBE_OUT, 'utf8')), { guarded: true, result: false, hook: { envPrefix: 'PROBE', hasApp: true } });
  assert.equal(fs.existsSync(path.join(dir, 'xdg.log')), false);
  const kinds = readEvents(env.PROBE_COMPAT_LOG).map((e) => `${e.kind}:${e.api ?? ''}`);
  assert.ok(kinds.includes('declined-call:app.setAsDefaultProtocolClient'), kinds.join(' '));
  assert.ok(kinds.includes('probe-hook:loaded'));

  // <PREFIX>_DEFAULT_PROTOCOL_CLIENT=1 leaves Electron's own method in place.
  runProbe(runtime, { env: { ...env, PROBE_DEFAULT_PROTOCOL_CLIENT: '1' } });
  assert.equal(JSON.parse(fs.readFileSync(env.PROBE_OUT, 'utf8')).guarded, false);
});
