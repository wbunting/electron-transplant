// Crashes the recorder must surface, in real Linux Electron: a Node utility
// process (like Figma's font worker) that throws, a renderer killed mid-session,
// app.exit() (which skips process 'exit'), and a native main-process crash that no
// JavaScript sees (no session-end, plus a Crashpad minidump `report` lists).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessElectron, probeRuntime, readEvents } = require('./support/probe-app.cjs');
const { summarise, crashDumps, report } = require('../lib/report.cjs');

const VERSION = '44.11.2';

const MAIN = `
const { app, utilityProcess, BrowserWindow, crashReporter } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('crashDumps', process.env.PROBE_DUMPS);
crashReporter.start({ submitURL: '', uploadToServer: false });
app.whenReady().then(async () => {
  switch (process.env.MODE) {
    case 'children': {
      const worker = utilityProcess.fork(require('node:path').join(__dirname, 'worker.js'));
      await sleep(300);
      worker.postMessage('throw');
      const win = new BrowserWindow({ show: false });
      await win.loadURL('data:text/html,probe');
      process.kill(win.webContents.getOSProcessId(), 'SIGKILL');
      await sleep(1500);
      app.quit();
      break;
    }
    case 'app-exit': app.exit(2); break;
    case 'crash': await sleep(300); process.crash(); break;
  }
});
`;
const WORKER = "process.parentPort.on('message', () => { throw new Error('font worker failed'); });\n";

// Like runProbe, but tolerating crashes and without keeping core files.
function run(runtime, dir, mode) {
  const env = { ...process.env, MODE: mode, PROBE_DUMPS: path.join(dir, 'dumps'), PROBE_COMPAT_LOG: path.join(dir, 'events.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = [path.join(runtime, 'electron'), '--ozone-platform=headless', `--user-data-dir=${path.join(dir, `profile-${mode}`)}`];
  const prlimit = ['/usr/bin/prlimit', '/bin/prlimit'].find((p) => fs.existsSync(p));
  const [command, ...args] = prlimit ? [prlimit, '--core=0', '--', ...electron] : electron;
  return spawnSync(command, args, { env, timeout: 60000, stdio: 'ignore' });
}

test(`Electron ${VERSION}: dead child processes, app.exit() and native main-process crashes are all surfaced`, { skip: skipUnlessElectron(VERSION) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-crashes-'));
  try {
    const runtime = probeRuntime(dir, { version: VERSION, files: { 'main.js': MAIN, 'worker.js': WORKER } });
    const log = path.join(dir, 'events.jsonl');

    run(runtime, dir, 'children');
    const children = readEvents(log);
    const gone = children.filter((e) => e.kind === 'child-process-gone').map((e) => `${e.api} | ${e.error}`);
    assert.ok(gone.some((g) => /^Utility: Node Utility Process \| abnormal-exit/.test(g)), gone.join('\n'));
    assert.ok(gone.includes('Renderer | killed (exit code 9)'), gone.join('\n'));
    assert.deepEqual(children.filter((e) => e.kind === 'session-end').map((e) => e.how), ['exit']);

    run(runtime, dir, 'app-exit');
    run(runtime, dir, 'crash');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    const { sessions, groups } = summarise(lines, { isRunning: () => false });
    assert.deepEqual(sessions.map((s) => s.status), ['clean', 'clean', 'abnormal']);
    assert.deepEqual([sessions[1].endedBy, sessions[1].exitCode], ['app.exit', 2]);
    // Session bookkeeping is not reported as something the app hit.
    assert.ok(groups.every((g) => !g.kind.startsWith('session')));

    // The native crash left a minidump where the session said Crashpad writes them.
    assert.equal(sessions[2].crashDumps.replace(/^~/, os.homedir()), path.join(dir, 'dumps'));
    const { dumps } = crashDumps(sessions);
    assert.ok(dumps.length >= 1, 'no minidump from process.crash()');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('report: legacy sessions are "unknown", live ones "running"; dumps are listed newest first', () => {
  const lines = [
    { kind: 'session', pid: 1, time: 't1', runtime: 'r' },
    { kind: 'session', pid: 2, time: 't2', runtime: 'r', endMarker: true },
    { kind: 'session-info', pid: 2, crashDumps: '/nonexistent-dir' },
    { kind: 'uncaught', pid: 2, api: 'uncaughtException', time: 't3', frames: ['main.js:1:1'] },
  ].map((e) => JSON.stringify(e));
  const { sessions, groups } = summarise(lines, { isRunning: (s) => s.pid === 2 });
  assert.deepEqual(sessions.map((s) => s.status), ['unknown', 'running']);
  assert.deepEqual(groups.map((g) => g.kind), ['uncaught']);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'et-dumps-'));
  fs.mkdirSync(path.join(home, 'Crashpad/completed'), { recursive: true });
  for (const [name, seconds] of [['a.dmp', 1000], ['b.dmp', 2000]]) {
    const file = path.join(home, 'Crashpad/completed', name);
    fs.writeFileSync(file, 'MDMP');
    fs.utimesSync(file, seconds, seconds);
  }
  fs.writeFileSync(path.join(home, 'Crashpad/settings.dat'), '');
  const result = crashDumps([{ crashDumps: '~/Crashpad' }], home);
  assert.deepEqual(result.dumps.map((d) => d.file), ['completed/b.dmp', 'completed/a.dmp']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('report output shows the home directory as ~ (it gets pasted into issues)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'et-home-'));
  const log = path.join(home, '.local/state/electron-transplant/app/compat-events.jsonl');
  const printed = [];
  report(log, { home, out: (line) => printed.push(line) });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, JSON.stringify({ kind: 'session', pid: 1, time: 't1', runtime: 'r' }) + '\n');
  report(log, { home, out: (line) => printed.push(line), isRunning: () => false });
  assert.ok(!printed.join('\n').includes(home), printed.join('\n'));
  assert.match(printed[0], /~\/\.local\/state\/electron-transplant\/app\/compat-events\.jsonl/);
  assert.equal(printed[1], '~/.local/state/electron-transplant/app/compat-events.jsonl');
  fs.rmSync(home, { recursive: true, force: true });
});
