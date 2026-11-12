// Records where an app's main process reaches for macOS/Windows-only behaviour on
// Linux, as groundwork for a compatibility layer. Observation only: every hook
// preserves stock Linux Electron behaviour (missing APIs still read as undefined,
// failed loads and spawns still fail the same way). Events go to a private JSONL
// file; arguments, URLs and page data are never recorded.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECORDER = Symbol.for('electron-transplant.recorder');
const MAX_PER_KEY = 3;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const API_KINDS = new Set(['missing-api', 'platform-tagged-call']);
const MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']);

function defaultLogPath(appId, env = process.env) {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'electron-transplant', appId, 'compat-events.jsonl');
}

function scrub(text, home = os.homedir()) {
  return String(text).split('\n')[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .split(home).join('~')
    .slice(0, 240);
}

class Recorder {
  constructor({ logPath, appRoot, now = () => new Date().toISOString() } = {}) {
    this.logPath = logPath;
    this.appRoot = appRoot;
    this.now = now;
    this.counts = new Map();
  }

  // App-relative frames ("out/main/index.js:81:1234 fn"), skipping this file and Node internals.
  frames(stack) {
    const frames = [];
    for (const line of String(stack ?? '').split('\n').slice(1)) {
      const match = /at (?:(.*?) \()?(.*):(\d+):(\d+)\)?$/.exec(line.trim());
      if (!match || match[2] === __filename || match[2].startsWith('node:')) continue;
      let file = match[2];
      const asar = file.indexOf('app.asar/');
      if (asar !== -1) file = file.slice(asar + 'app.asar/'.length);
      else if (this.appRoot && file.startsWith(this.appRoot + path.sep)) file = path.relative(this.appRoot, file);
      else if (file.startsWith('electron/')) continue;
      frames.push(`${file}:${match[3]}:${match[4]}${match[1] ? ' ' + match[1] : ''}`);
      if (frames.length === 6) break;
    }
    return frames;
  }

  // True when the code touching the API is Electron's own JS (e.g. Menu.buildFromTemplate
  // reading every MenuItem option), not the app's.
  calledByElectron(stack) {
    for (const line of String(stack ?? '').split('\n').slice(1)) {
      if (line.includes(__filename)) continue;
      return /\(?node:electron\//.test(line);
    }
    return false;
  }

  record(event, stack = new Error().stack) {
    if (API_KINDS.has(event.kind) && this.calledByElectron(stack)) return;
    const frames = event.frames ?? this.frames(stack);
    const key = `${event.kind}|${event.api ?? ''}|${frames[0] ?? ''}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count > MAX_PER_KEY) return;
    this.write({ time: this.now(), pid: process.pid, ...event, frames, occurrence: count });
  }

  write(entry) {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(this.logPath).size > MAX_LOG_BYTES) fs.renameSync(this.logPath, this.logPath + '.previous');
      } catch {}
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {}
  }

  // Occurrences beyond MAX_PER_KEY are counted, then summarised once at exit.
  flush() {
    for (const [key, count] of this.counts) {
      if (count <= MAX_PER_KEY) continue;
      const [kind, api, frame] = key.split('|');
      this.write({ time: this.now(), kind: 'suppressed', of: kind, api: api || undefined, frame, total: count });
    }
    this.counts.clear();
  }
}

// Read a missing platform API: record, then behave exactly like Linux Electron (undefined).
function observeMissing(target, name, api, platforms, recorder, kind = 'missing-api') {
  if (!target || (typeof target !== 'object' && typeof target !== 'function') || name in target) return false;
  if (!Object.isExtensible(target)) return false;
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: false,
    get() {
      recorder.record({ kind, api, platforms });
      return undefined;
    },
    // Code that assigns its own value gets a plain property, as before.
    set(value) {
      Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
    },
  });
  return true;
}

// A platform-tagged method that exists on Linux but is a no-op or partial here.
function observeTagged(target, name, api, platforms, recorder) {
  let owner = target;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor || typeof descriptor.value !== 'function' || descriptor.value[RECORDER]) return false;
  const original = descriptor.value;
  const wrapped = {
    [name](...args) {
      recorder.record({ kind: 'platform-tagged-call', api, platforms });
      return original.apply(this, args);
    },
  }[name];
  wrapped[RECORDER] = original;
  try {
    Object.defineProperty(owner, name, { ...descriptor, value: wrapped });
    return true;
  } catch {
    return false;
  }
}

function observeType(target, typeName, table, recorder, { statics = false } = {}) {
  let installed = 0;
  for (const [name, info] of Object.entries(table.members[typeName] ?? {})) {
    if (Boolean(info.static) !== statics) continue;
    const api = `${typeName}.${name}`;
    if (observeMissing(target, name, api, info.platforms, recorder)) installed++;
    else if (observeTagged(target, name, api, info.platforms, recorder)) installed++;
  }
  return installed;
}

function observeExport(electron, exp, table, recorder) {
  const value = electron[exp.name];
  let installed = 0;
  if (exp.kind === 'instance') installed += observeType(value, exp.type, table, recorder);
  if (exp.kind === 'class' && typeof value === 'function') {
    installed += observeType(value.prototype, exp.type, table, recorder);
    installed += observeType(value, exp.type, table, recorder, { statics: true });
  }
  if (exp.kind === 'constructor' && typeof value === 'function') {
    installed += observeType(value, exp.type, table, recorder, { statics: true });
  }
  return installed;
}

function observeElectron(electron, table, recorder) {
  let installed = 0;
  const afterReady = [];
  for (const exp of table.mainExports) {
    // A typed export absent at runtime is a type-only name (IpcMainServiceWorker,
    // WebSocket in Electron 45), not a platform difference: every runtime export
    // exists on Linux. Nothing to observe.
    if (!(exp.name in electron)) continue;
    // Only load modules that have platform-only members to observe.
    if (!table.members[exp.type]) continue;
    // Some modules (screen, powerMonitor...) refuse to load before the app is ready.
    try { installed += observeExport(electron, exp, table, recorder); } catch { afterReady.push(exp); }
  }
  // Instance prototypes Electron only exposes through live objects.
  const { app } = electron;
  let webContentsDone = false;
  app?.on?.('web-contents-created', (_event, contents) => {
    if (webContentsDone) return;
    webContentsDone = true;
    observeType(Object.getPrototypeOf(contents), 'WebContents', table, recorder);
  });
  app?.whenReady?.().then(() => {
    for (const exp of afterReady) {
      try { observeExport(electron, exp, table, recorder); } catch {}
    }
    const session = electron.session?.defaultSession;
    if (session) observeType(Object.getPrototypeOf(session), 'Session', table, recorder);
  }, () => {});
  try {
    const image = electron.nativeImage?.createEmpty?.();
    if (image) installed += observeType(Object.getPrototypeOf(image), 'NativeImage', table, recorder);
  } catch {}
  return installed;
}

function fileFormat(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(4);
      fs.readSync(fd, header, 0, 4, 0);
      if (header.toString('hex') === '7f454c46') return 'elf';
      return MACH_O_MAGICS.has(header.toString('hex')) ? 'mach-o' : 'unknown';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'unreadable';
  }
}

// Native addon loads: record failures (with the binary format), then rethrow unchanged.
function observeNativeLoads(proc, recorder, appRoot) {
  const original = proc.dlopen;
  if (typeof original !== 'function' || original[RECORDER]) return;
  const wrapped = function dlopen(module, filename, ...rest) {
    try {
      return original.call(this, module, filename, ...rest);
    } catch (error) {
      const asar = filename.indexOf('app.asar');
      const shown = asar !== -1 ? filename.slice(asar) : appRoot && filename.startsWith(appRoot) ? path.relative(appRoot, filename) : path.basename(filename);
      recorder.record({ kind: 'native-load-failed', api: shown, format: fileFormat(filename), error: scrub(error.message) }, error.stack);
      throw error;
    }
  };
  wrapped[RECORDER] = original;
  proc.dlopen = wrapped;
}

const SHELL_BUILTINS = new Set(['.', ':', '[', 'cd', 'command', 'echo', 'eval', 'exec', 'export', 'false', 'printf', 'read', 'set', 'source', 'test', 'true', 'type', 'umask', 'unset', 'wait']);

// The command a spawn will run: argv[0], or the first word of `sh -c "..."`.
// Returns undefined rather than risk logging an argument or assignment.
function spawnedCommand(options) {
  const file = options?.file;
  const args = options?.args ?? [];
  let command = file;
  if (/(^|\/)(ba|da)?sh$/.test(file ?? '') && args[1] === '-c') {
    command = String(args[2] ?? '').trim().split(/\s+/)[0];
    if (SHELL_BUILTINS.has(command)) return undefined;
  }
  return /^[\w./+-]+$/.test(command ?? '') ? command : undefined;
}

function resolvesOnPath(command, envPath) {
  if (command.includes('/')) return fs.existsSync(command);
  return String(envPath ?? '').split(':').some((dir) => dir && fs.existsSync(path.join(dir, command)));
}

// Spawning macOS tools (screencapture, osascript, open, defaults...): record commands
// that cannot resolve here. Only the command name is kept, never its arguments.
function observeSpawns(childProcess, recorder) {
  const proto = childProcess.ChildProcess?.prototype;
  const original = proto?.spawn;
  if (typeof original !== 'function' || original[RECORDER]) return;
  const wrapped = function spawn(options) {
    try {
      const command = spawnedCommand(options);
      const envPath = options?.envPairs?.find((pair) => pair.startsWith('PATH='))?.slice(5) ?? process.env.PATH;
      if (command && !resolvesOnPath(command, envPath)) {
        recorder.record({ kind: 'missing-executable', api: command.startsWith('/') ? command : path.basename(command) });
      }
    } catch {}
    return original.apply(this, arguments);
  };
  wrapped[RECORDER] = original;
  proto.spawn = wrapped;
}

// IPC handlers that throw (e.g. a darwin-only feature invoked by the web client).
function observeIpcHandlers(ipcMain, recorder) {
  const original = ipcMain?.handle;
  if (typeof original !== 'function' || original[RECORDER]) return;
  const wrapped = function handle(channel, listener) {
    if (typeof listener !== 'function') return original.call(this, channel, listener);
    return original.call(this, channel, async function (...args) {
      try {
        return await listener.apply(this, args);
      } catch (error) {
        recorder.record({ kind: 'ipc-handler-error', api: String(channel), error: scrub(error?.message ?? error) }, error?.stack);
        throw error;
      }
    });
  };
  wrapped[RECORDER] = original;
  ipcMain.handle = wrapped;
}

function install({ electron, table, appRoot, proc = process, childProcess = require('node:child_process'), logPath, meta = {} }) {
  if (globalThis[RECORDER]) return globalThis[RECORDER];
  const recorder = new Recorder({ logPath, appRoot });
  globalThis[RECORDER] = recorder;
  const observed = observeElectron(electron, table, recorder);
  observeNativeLoads(proc, recorder, appRoot);
  observeSpawns(childProcess, recorder);
  observeIpcHandlers(electron.ipcMain, recorder);
  // Monitor only: does not change how uncaught errors are handled or reported.
  proc.on?.('uncaughtExceptionMonitor', (error, origin) => {
    recorder.record({ kind: 'uncaught', api: origin, error: scrub(`${error?.name ?? 'Error'}: ${error?.message ?? error}`) }, error?.stack);
  });
  proc.on?.('exit', () => recorder.flush());
  recorder.write({ time: recorder.now(), kind: 'session', pid: proc.pid, observed, ...meta });
  return recorder;
}

module.exports = { install, Recorder, observeMissing, observeTagged, observeElectron, observeNativeLoads, observeSpawns, observeIpcHandlers, spawnedCommand, scrub, defaultLogPath, RECORDER };
