// Figma on Linux, main-process side (loaded by the compat entry before main.js).
//
// MCP port. The web app starts Figma's MCP server (Dev Mode) on the port it
// asks for, 3845. Another app may hold it: figma-linux-next serves its own MCP
// server there. Figma treats EADDRINUSE as a "user error" and reports nothing;
// here it is recorded and explained once per session, naming the process that
// holds the port. FIGMA_DESKTOP_MCP_PORT=N serves on N instead.
//
// (Browser sign-in needs no code here: patches in app.cjs have it come back
// through figma-desktop://, a scheme only this app registers.)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MCP_CHANNEL = 'web:setEnableMCP';
const FINISH_SIGN_IN = '--finish-sign-in';

// --- MCP port -----------------------------------------------------------------

// LISTEN sockets on `port` (loopback or any address) in /proc/net/tcp{,6} text.
function listeningInodes(tables, port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const text of tables) {
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '0A') continue;
      const [address, localPort] = cols[1].split(':');
      if (localPort !== hexPort) continue;
      const loopbackOrAny = /^(0100007F|00000000|0{32}|0{24}01000000|0{16}FFFF00000100007F)$/i.test(address);
      if (loopbackOrAny && cols[9] !== '0') inodes.add(cols[9]);
    }
  }
  return inodes;
}

// Processes (this user's, which /proc lets us read) holding one of `inodes`.
function socketOwners(inodes, proc = '/proc') {
  const owners = [];
  if (!inodes.size) return owners;
  for (const pid of fs.readdirSync(proc).filter((name) => /^\d+$/.test(name))) {
    let fds;
    try { fds = fs.readdirSync(path.join(proc, pid, 'fd')); } catch { continue; }
    const holds = fds.some((fd) => {
      try { return inodes.has(/^socket:\[(\d+)\]$/.exec(fs.readlinkSync(path.join(proc, pid, 'fd', fd)))?.[1]); } catch { return false; }
    });
    if (!holds) continue;
    let name;
    try { name = path.basename(fs.readlinkSync(path.join(proc, pid, 'exe'))); } catch {}
    try { name ??= fs.readFileSync(path.join(proc, pid, 'comm'), 'utf8').trim(); } catch {}
    owners.push({ pid: Number(pid), name: name ?? 'unknown' });
  }
  return owners;
}

function portOwners(port) {
  const tables = ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } });
  return socketOwners(listeningInodes(tables, port)).filter((owner) => owner.pid !== process.pid);
}

function mcpConflictMessage(port, owners, envName) {
  const who = owners.length
    ? owners.map((o) => `${o.name} (PID ${o.pid})`).join(', ')
    : 'another program';
  return {
    message: `Figma's MCP server could not start: 127.0.0.1:${port} is in use by ${who}.`,
    detail: [
      `Only one app can serve MCP on port ${port}. figma-linux-next serves its own MCP server there.`,
      `To use this app's server: turn off the MCP server in the other app (or quit it), then turn Figma's MCP server off and on again (Dev Mode, or Preferences).`,
      `To run both: start this app with ${envName}=<port> and point your MCP client at http://127.0.0.1:<port>/mcp.`,
    ].join('\n\n'),
  };
}

function installMcpPortHandling({ electron, env, envPrefix, record }) {
  const { ipcMain, dialog, BrowserWindow } = electron;
  const override = Number(env('MCP_PORT'));
  const overridePort = Number.isInteger(override) && override > 1023 && override < 65536 ? override : null;
  const explained = new Set();
  const handle = ipcMain.handle;
  ipcMain.handle = function (channel, listener) {
    if (channel !== MCP_CHANNEL || typeof listener !== 'function') return handle.call(this, channel, listener);
    return handle.call(this, channel, async function (event, enabled, port, ...rest) {
      const effective = enabled && overridePort ? overridePort : port;
      try {
        return await listener.call(this, event, enabled, effective, ...rest);
      } catch (error) {
        if (/EADDRINUSE/.test(String(error?.message)) && Number.isInteger(effective)) {
          const owners = portOwners(effective);
          record({ kind: 'mcp-port-in-use', api: `127.0.0.1:${effective}`, error: owners.map((o) => o.name).join(',') || 'unknown' });
          console.error(`figma-desktop: MCP port ${effective} in use by ${owners.map((o) => `${o.name}[${o.pid}]`).join(', ') || 'unknown'}`);
          if (!explained.has(effective)) {
            explained.add(effective);
            const { message, detail } = mcpConflictMessage(effective, owners, `${envPrefix}_MCP_PORT`);
            const parent = BrowserWindow.getFocusedWindow();
            const options = { type: 'warning', title: 'MCP server', message, detail, buttons: ['OK'] };
            (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).catch(() => {});
          }
        }
        throw error;
      }
    });
  };
  return { overridePort };
}

module.exports = function figmaLinux({ electron, env, envPrefix, record }) {
  installMcpPortHandling({ electron, env, envPrefix, record });
};
Object.assign(module.exports, { listeningInodes, socketOwners, portOwners, mcpConflictMessage, installMcpPortHandling });
