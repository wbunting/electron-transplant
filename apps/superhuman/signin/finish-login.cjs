// Fallback for Superhuman's Linux browser sign-in without the extension: forward a
// copied callback URL to the app. Same validator as the extension (callback.js).
// Installed by electron-transplant and run by the app's own Electron in Node mode
// (no system Node or Python). The launcher sets ET_APP_LAUNCHER and ET_APP_ICON.
//
// Never prints, logs or notifies the URL or a subprocess error: messages are fixed
// strings. The app still validates its own pending OAuth state.
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { nativeCallback } = require('./browser-extension/callback.js');

const TITLE = 'Superhuman sign-in';
const quiet = { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8' };

// Wayland first, then X11. Returns null when no clipboard tool works.
function readClipboard(exec = execFileSync) {
  for (const [cmd, args] of [['wl-paste', ['--no-newline']], ['xclip', ['-o', '-selection', 'clipboard']], ['xsel', ['--clipboard', '--output']]]) {
    try { return exec(cmd, args, quiet).trim(); } catch {}
  }
  return null;
}

function clearClipboard(exec = execFileSync) {
  for (const [cmd, args] of [['wl-copy', ['--clear']], ['xsel', ['--clipboard', '--clear']]]) {
    try { exec(cmd, args, quiet); return true; } catch {}
  }
  return false;
}

function report(message, { notify, error = false, exec = execFileSync, log = console.log }) {
  if (notify) {
    const icon = process.env.ET_APP_ICON ? [`--icon=${process.env.ET_APP_ICON}`] : [];
    try { exec('notify-send', ['--app-name=Superhuman', ...icon, TITLE, message], quiet); } catch { log(message); }
  } else {
    log(message);
  }
  return error ? 1 : 0;
}

// Opens the callback in the installed app: its own launcher when known (no
// dependence on which app owns superhuman:// right now), else the system handler.
function openInApp(target, { launcher = process.env.ET_APP_LAUNCHER, run = spawn } = {}) {
  const [cmd, args] = launcher && isExecutable(launcher) ? [launcher, ['--', target]] : ['gio', ['open', target]];
  const child = run(cmd, args, { stdio: 'ignore', detached: true });
  child.unref?.();
}

function isExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

function main(argv = process.argv.slice(2), deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const notify = argv.includes('--notify');
  const say = (message, error) => report(message, { notify, error, exec, log: deps.log });
  const url = readClipboard(exec);
  if (url === null) return say('Could not read the clipboard (needs wl-clipboard, xclip or xsel). Copy the login URL and try again.', true);
  const target = nativeCallback(url);
  if (!target) return say('Copy the full URL of the Superhuman sign-in browser tab, then try again. Nothing was forwarded.', true);
  try {
    openInApp(target, deps);
  } catch {
    return say('Could not open Superhuman. Open the app and try again; the clipboard was kept.', true);
  }
  // Leave a newer clipboard selection alone.
  if (readClipboard(exec) === url && !clearClipboard(exec)) {
    return say('Callback forwarded, but the clipboard could not be cleared. Clear it manually.');
  }
  return say('Callback forwarded to Superhuman. If sign-in does not complete, start a new sign-in from the app.');
}

module.exports = { main, readClipboard, openInApp };
if (require.main === module) process.exitCode = main();
