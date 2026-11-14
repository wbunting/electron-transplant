// Summarise a compat recorder log: which macOS/Windows APIs, native loads,
// executables and IPC handlers an app hit, how often and from where; child
// processes that died; sessions that ended without a clean exit (a native crash
// in the main process, a SIGKILL or power loss); and Crashpad minidumps.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Kinds that describe sessions rather than something the app hit.
const SESSION_KINDS = new Set(['session', 'session-end', 'session-info']);

// Whether `pid` is still this session's process (pids are reused).
function defaultIsRunning(session) {
  try {
    return fs.readlinkSync(`/proc/${session.pid}/exe`).includes(`/${session.runtime}/`);
  } catch {
    return false;
  }
}

function summarise(lines, { isRunning = defaultIsRunning } = {}) {
  const sessions = [];
  const groups = new Map();
  const open = new Map();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.kind === 'session') {
      const session = { ...event, status: event.endMarker ? 'abnormal' : 'unknown' };
      sessions.push(session);
      open.set(event.pid, session);
      continue;
    }
    if (event.kind === 'session-end') {
      const session = open.get(event.pid);
      if (session) {
        Object.assign(session, { status: 'clean', ended: event.time, endedBy: event.how, exitCode: event.code });
        open.delete(event.pid);
      }
      continue;
    }
    if (event.kind === 'session-info') {
      const session = open.get(event.pid);
      if (session && event.crashDumps) session.crashDumps = event.crashDumps;
      continue;
    }
    const kind = event.kind === 'suppressed' ? event.of : event.kind;
    const frame = event.kind === 'suppressed' ? event.frame : event.frames?.[0];
    const key = `${kind}|${event.api ?? ''}|${frame ?? ''}`;
    const group = groups.get(key) ?? { kind, api: event.api, frame, count: 0, sessions: new Set(), first: event.time, last: event.time, detail: undefined };
    // A suppressed summary replaces the logged count for that process with its total.
    if (event.kind === 'suppressed') group.count += event.total - 3;
    else group.count += 1;
    group.sessions.add(event.pid);
    group.last = event.time;
    group.detail ??= event.error ?? event.format ?? event.platforms?.join(',');
    group.frames ??= event.frames;
    groups.set(key, group);
  }
  for (const session of sessions) {
    if (session.status === 'abnormal' && isRunning(session)) session.status = 'running';
  }
  return { sessions, groups: [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count) };
}

// Minidumps under the latest session's Crashpad directory, newest first.
function crashDumps(sessions, home = os.homedir()) {
  const recorded = [...sessions].reverse().find((s) => s.crashDumps)?.crashDumps;
  if (!recorded) return { dir: null, dumps: [] };
  const dir = recorded.startsWith('~') ? path.join(home, recorded.slice(1)) : recorded;
  const dumps = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.dmp')) {
        const stat = fs.statSync(full);
        dumps.push({ file: path.relative(dir, full), time: stat.mtime.toISOString(), size: stat.size });
      }
    }
  };
  walk(dir);
  return { dir: recorded, dumps: dumps.sort((a, b) => b.time.localeCompare(a.time)) };
}

// Output is meant to be pasted into issues: the home directory (and so the user
// name) is shown as ~.
const tildify = (file, home = os.homedir()) => (file === home || file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file);

function report(logPath, { json = false, out = console.log, isRunning, home } = {}) {
  if (!fs.existsSync(logPath)) {
    out(`No events yet: ${tildify(logPath, home)} does not exist (start the app first).`);
    return;
  }
  const { sessions, groups } = summarise(fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean), { isRunning });
  const dumps = crashDumps(sessions, home);
  if (json) {
    out(JSON.stringify({ sessions, groups: groups.map((g) => ({ ...g, sessions: g.sessions.size })), crashDumps: dumps }, null, 2));
    return;
  }
  const last = sessions.at(-1);
  out(tildify(logPath, home));
  out(`${sessions.length} session(s)${last ? `; latest ${last.time} ${last.app ?? ''} ${last.version ?? last.linear ?? ''} / Electron ${last.electron} (${last.runtime}), ${last.observed} APIs observed` : ''}`);
  const count = (status) => sessions.filter((s) => s.status === status).length;
  out(`Exits: ${count('clean')} clean, ${count('running')} running, ${count('abnormal')} without a clean exit${count('unknown') ? `, ${count('unknown')} from before exits were recorded` : ''}`);
  for (const session of sessions.filter((s) => s.status === 'abnormal')) {
    out(`  [no clean exit] session ${session.time} (pid ${session.pid}, ${session.runtime}): native crash, SIGKILL or power loss`);
  }
  if (dumps.dir) {
    out(`Crash dumps (Crashpad) in ${dumps.dir}: ${dumps.dumps.length}`);
    for (const dump of dumps.dumps.slice(0, 5)) out(`  ${dump.time}  ${dump.file}  ${Math.round(dump.size / 1024)} KiB`);
  }
  if (!groups.length) {
    out('No platform-specific failures or calls recorded.');
    return;
  }
  for (const group of groups) {
    out(`\n[${group.kind}] ${group.api ?? ''}  ×${group.count} in ${group.sessions.size} session(s)${group.detail ? `  (${group.detail})` : ''}`);
    out(`  first ${group.first}  last ${group.last}`);
    for (const frame of group.frames ?? []) out(`    at ${frame}`);
  }
}

module.exports = { summarise, crashDumps, report };
