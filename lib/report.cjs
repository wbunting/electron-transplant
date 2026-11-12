// Summarise a compat recorder log: which macOS/Windows APIs, native loads,
// executables and IPC handlers an app hit, how often and from where.
'use strict';
const fs = require('node:fs');

function summarise(lines) {
  const sessions = [];
  const groups = new Map();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.kind === 'session') { sessions.push(event); continue; }
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
  return { sessions, groups: [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count) };
}

function report(logPath, { json = false, out = console.log } = {}) {
  if (!fs.existsSync(logPath)) {
    out(`No events yet: ${logPath} does not exist (start the app first).`);
    return;
  }
  const { sessions, groups } = summarise(fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean));
  if (json) {
    out(JSON.stringify({ sessions, groups: groups.map((g) => ({ ...g, sessions: g.sessions.size })) }, null, 2));
    return;
  }
  const last = sessions.at(-1);
  out(logPath);
  out(`${sessions.length} session(s)${last ? `; latest ${last.time} ${last.app ?? ''} ${last.version ?? last.linear ?? ''} / Electron ${last.electron} (${last.runtime}), ${last.observed} APIs observed` : ''}`);
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

module.exports = { summarise, report };
