// The recorder inside real Linux Electron: Mac-only calls behave exactly as on
// stock Electron while being recorded, on every pinned Electron version.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessElectron, probeRuntime, runProbe, readEvents } = require('./support/probe-app.cjs');

const PROBE_MAIN = `
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const electron = require('electron');
const { app, systemPreferences, BrowserWindow } = electron;
const results = {};
function attempt(name, fn) {
  try { results[name] = { ok: true, value: fn() ?? null }; }
  catch (e) { results[name] = { ok: false, error: e.constructor.name }; }
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  results.typeofGetUserDefault = typeof systemPreferences.getUserDefault;
  attempt('getUserDefault', () => systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string'));
  attempt('dockBadge', () => app.dock?.setBadge('1'));
  attempt('menu', () => typeof electron.Menu.buildFromTemplate([{ label: 'x', toolTip: 't' }]));
  attempt('setWindowButtonPosition', () => win.setWindowButtonPosition({ x: 1, y: 1 }));
  attempt('setOverlayIcon', () => win.setOverlayIcon(null, ''));
  attempt('typeOnlyExport', () => typeof electron.IpcMainServiceWorker);
  attempt('machO', () => require(process.env.FAKE_MACHO));
  results.spawn = await new Promise((resolve) => execFile('/usr/sbin/screencapture', ['-i', 'secret-arg'], (e) => resolve(e?.code ?? null)));
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(results));
  app.quit();
});
`;

for (const version of ['44.9.1', '45.1.0']) {
  test(`Electron ${version}: records Mac-only use without changing behaviour`, { skip: skipUnlessElectron(version) }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-compat-electron-'));
    try {
      const runtime = probeRuntime(dir, { version, files: { 'main.js': PROBE_MAIN } });
      const app = path.join(runtime, 'resources/app');
      const macho = path.join(dir, 'fake.node');
      fs.writeFileSync(macho, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.alloc(64)]));
      const log = path.join(dir, 'events.jsonl');
      // Recorder only: the window-chrome facade changes behaviour on purpose (tested separately).
      const run = (main) => {
        const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
        fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ ...pkg, main }));
        const out = path.join(dir, `results-${path.basename(main)}.json`);
        runProbe(runtime, { env: { FAKE_MACHO: macho, PROBE_OUT: out, PROBE_COMPAT_LOG: log, PROBE_COMPAT_FACADE: '0' } });
        return JSON.parse(fs.readFileSync(out, 'utf8'));
      };
      const stock = run('./main.js');
      assert.equal(fs.existsSync(log), false);
      const results = run('./linux-compat/entry.cjs');
      assert.deepEqual(results, stock);
      assert.equal(results.typeofGetUserDefault, 'undefined');
      assert.deepEqual(results.getUserDefault, { ok: false, error: 'TypeError' });
      assert.deepEqual(results.setWindowButtonPosition, { ok: false, error: 'TypeError' });
      assert.deepEqual(results.machO, { ok: false, error: 'Error' });
      assert.equal(results.spawn, 'ENOENT');

      const events = readEvents(log);
      const has = (kind, api) => events.find((e) => e.kind === kind && e.api === api);
      assert.equal(events[0].kind, 'session');
      assert.equal(events[0].app, 'probe');
      assert.equal(events[0].electron, version);
      assert.ok(events[0].observed > 50, `observed ${events[0].observed}`);
      for (const [kind, api] of [
        ['missing-api', 'SystemPreferences.getUserDefault'],
        ['missing-api', 'App.dock'],
        ['missing-api', 'BaseWindow.setWindowButtonPosition'],
        ['platform-tagged-call', 'BaseWindow.setOverlayIcon'],
        ['missing-executable', '/usr/sbin/screencapture'],
      ]) {
        const event = has(kind, api);
        assert.ok(event, `missing ${kind} ${api}: ${JSON.stringify(events.map((e) => [e.kind, e.api]))}`);
        assert.match(event.frames[0], /^main\.js:\d+:\d+/);
      }
      // Not the app's: Electron's own reads of MenuItem options, and type-only names.
      assert.deepEqual(events.filter((e) => e.api?.startsWith('MenuItem.') || e.api?.includes('IpcMainServiceWorker')), []);
      assert.equal(events.find((e) => e.kind === 'native-load-failed')?.format, 'mach-o');
      assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /secret-arg/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
