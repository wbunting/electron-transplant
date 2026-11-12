const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { Recorder, observeMissing, observeTagged, observeSpawns, observeIpcHandlers, spawnedCommand, scrub } = require('../compat/runtime.cjs');
const { summarise } = require('../lib/report.cjs');
const { parse, generateTable } = require('../lib/platform-apis.cjs');

function recorder() {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'et-compat-')), 'events.jsonl');
  const r = new Recorder({ logPath, now: () => 't' });
  r.events = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return r;
}

test('missing APIs still read as undefined and still throw when called', () => {
  const r = recorder();
  const prefs = {};
  assert.equal(observeMissing(prefs, 'getUserDefault', 'SystemPreferences.getUserDefault', ['darwin'], r), true);
  assert.equal(typeof prefs.getUserDefault, 'undefined');
  assert.throws(() => prefs.getUserDefault('k', 'string'), TypeError);
  assert.deepEqual(r.events().map((e) => [e.kind, e.api, e.platforms]), [
    ['missing-api', 'SystemPreferences.getUserDefault', ['darwin']],
    ['missing-api', 'SystemPreferences.getUserDefault', ['darwin']],
  ]);
  prefs.getUserDefault = () => 'own';
  assert.equal(prefs.getUserDefault(), 'own');
  assert.equal(observeMissing({ present: 1 }, 'present', 'x', [], r), false);
});

test('platform-tagged methods keep this, arguments and return value', () => {
  const r = recorder();
  class Base { setOverlayIcon(a) { return [this.id, a]; } }
  class Win extends Base {}
  const win = Object.assign(new Win(), { id: 7 });
  assert.equal(observeTagged(Win.prototype, 'setOverlayIcon', 'BaseWindow.setOverlayIcon', ['win32'], r), true);
  assert.equal(observeTagged(Win.prototype, 'setOverlayIcon', 'BaseWindow.setOverlayIcon', ['win32'], r), false);
  assert.deepEqual(win.setOverlayIcon('x'), [7, 'x']);
  assert.equal(r.events()[0].kind, 'platform-tagged-call');
});

test('repeats are capped per call site and summarised on flush', () => {
  const r = recorder();
  const target = {};
  observeMissing(target, 'dock', 'App.dock', ['darwin'], r);
  for (let i = 0; i < 10; i++) void target.dock;
  r.flush();
  const events = r.events();
  assert.equal(events.filter((e) => e.kind === 'missing-api').length, 3);
  assert.deepEqual(events.at(-1), { time: 't', kind: 'suppressed', of: 'missing-api', api: 'App.dock', frame: events[0].frames[0], total: 10 });
  const [group] = summarise(fs.readFileSync(r.logPath, 'utf8').split('\n').filter(Boolean)).groups;
  assert.equal(group.count, 10);
});

test('missing executables are recorded by name only and still fail', async () => {
  const r = recorder();
  observeSpawns(childProcess, r);
  const direct = await new Promise((resolve) => childProcess.execFile('/usr/sbin/linear-compat-missing', ['secret'], (e) => resolve(e.code)));
  const shell = await new Promise((resolve) => childProcess.exec('linear-compat-missing-tool https://example.com/token', (e) => resolve(e.code)));
  childProcess.execFileSync('true');
  assert.equal(direct, 'ENOENT');
  assert.equal(shell, 127);
  assert.deepEqual(r.events().map((e) => e.api), ['/usr/sbin/linear-compat-missing', 'linear-compat-missing-tool']);
  assert.doesNotMatch(fs.readFileSync(r.logPath, 'utf8'), /secret|example\.com/);
});

test('IPC handler errors are recorded and still rejected to the caller', async () => {
  const r = recorder();
  const handlers = new Map();
  const ipcMain = { handle(channel, fn) { handlers.set(channel, fn); } };
  observeIpcHandlers(ipcMain, r);
  ipcMain.handle('capture-screenshot', function () { throw Error(`Screenshot capture is unavailable at ${os.homedir()}/x https://linear.app/a`); });
  ipcMain.handle('ok', (_e, n) => n + 1);
  await assert.rejects(handlers.get('capture-screenshot')({}), /unavailable/);
  assert.equal(await handlers.get('ok')({}, 1), 2);
  assert.deepEqual(r.events().map((e) => [e.kind, e.api, e.error]), [
    ['ipc-handler-error', 'capture-screenshot', 'Screenshot capture is unavailable at ~/x <url>'],
  ]);
});

test('scrub keeps one short line without URLs or the home directory', () => {
  assert.equal(scrub(`a ${os.homedir()}/b linear://x/y\nsecond`), 'a ~/b <url>');
});

test('generator keeps only members with no Linux declaration', () => {
  const dts = [
    'declare namespace Electron {',
    '  interface SystemPreferences extends NodeJS.EventEmitter {',
    '    /**', '     * @platform darwin', '     */',
    '    getUserDefault(key: string): unknown;',
    '    /**', '     * @platform darwin,linux', '     */',
    '    getAccentColor(): string;',
    '    /**', '     * @platform win32', '     */',
    '    on(event: \'x\', listener: Function): this;',
    '    /**', '     * @platform darwin', '     */',
    '    mixed(): void;',
    '    mixed(a: string): void;',
    '    /**', '     * @platform darwin', '     */',
    '    static create(): void;',
    '  }',
    '  namespace Main {',
    '    const systemPreferences: SystemPreferences;',
    '    const session: typeof Session;',
    '    class BrowserWindow extends Electron.BrowserWindow {}',
    '  }',
    '}',
  ].join('\n');
  const { members, mainExports } = parse(dts);
  assert.deepEqual(members, { SystemPreferences: { getUserDefault: { platforms: ['darwin'] }, create: { platforms: ['darwin'], static: true } } });
  assert.deepEqual(mainExports, [
    { name: 'systemPreferences', type: 'SystemPreferences', kind: 'instance' },
    { name: 'session', type: 'Session', kind: 'constructor' },
    { name: 'BrowserWindow', type: 'BrowserWindow', kind: 'class' },
  ]);
});

test('spawnedCommand never returns arguments, assignments or builtins', () => {
  const sh = (cmd) => spawnedCommand({ file: '/bin/sh', args: ['/bin/sh', '-c', cmd] });
  assert.equal(spawnedCommand({ file: '/usr/sbin/screencapture', args: ['/usr/sbin/screencapture', '-i', 'secret'], shell: false }), '/usr/sbin/screencapture');
  assert.equal(sh('open "https://linear.app/x"'), 'open');
  assert.equal(sh('TOKEN=abc osascript -e x'), undefined);
  assert.equal(sh('cd /tmp && open x'), undefined);
  assert.equal(sh('"quoted cmd" x'), undefined);
  assert.equal(spawnedCommand({ file: '/bin/sh', args: ['/bin/sh', 'script.sh', 'secret'] }), '/bin/sh');
});

test('committed platform tables match the generator on the verified typings', (t) => {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-transplant');
  const tables = path.join(__dirname, '../compat/platform-apis');
  let checked = 0;
  for (const file of fs.readdirSync(tables)) {
    const version = /^electron-(.+)\.json$/.exec(file)[1];
    const dts = path.join(cache, `electron-v${version}.d.ts`);
    if (!fs.existsSync(dts)) continue;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tables, file), 'utf8')), generateTable(fs.readFileSync(dts, 'utf8'), version));
    checked++;
  }
  if (!checked) t.skip('no cached electron.d.ts');
});
