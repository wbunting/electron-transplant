// The window-chrome translation in real Linux Electron: traffic lights for Mac
// title-bar windows however the app reaches Electron, the emulated button APIs,
// stacking above app views, button actions, and the page adapter making room.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessElectron, probeRuntime, runProbe, readEvents } = require('./support/probe-app.cjs');

const ELECTRON = '44.9.1';
// A Linear-like title-bar row: [sidebar toggle][spacer][recent][back][forward], 42px tall.
const FIXTURE = `<!doctype html><html><body style="margin:0">
<div id="row" style="display:flex;align-items:center;gap:4px;height:42px;padding-left:12px;width:240px">
  <button id="toggle" style="width:28px;height:28px">T</button><div style="flex:1"></div>
  <button style="width:28px;height:28px">R</button><button style="width:28px;height:28px">B</button><button style="width:28px;height:28px">F</button>
</div>
<!-- A content header below with a control further left: must not be taken for the title bar. -->
<div id="header" style="display:flex;align-items:center;height:44px;width:400px">
  <button id="crumb" style="margin-left:4px;width:28px;height:28px">H</button><div style="flex:1"></div><button style="width:28px;height:28px">X</button>
</div><p style="margin-top:400px">body</p></body></html>`;

const PROBE_MAIN = `
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow, WebContentsView } = electron;
const out = {};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const overlayOf = (win) => win.contentView.children.find((v) => v.webContents?.getURL().endsWith('traffic-lights.html'));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(50); }
  return null;
}
// The probe opens and closes windows; quitting is explicit.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // Other ways of reaching Electron get the same facade.
  const viaMain = require('./via-main.cjs')();
  const viaImport = await (await import('./via-import.mjs')).default();
  await wait(300);
  out.viaMain = Boolean(overlayOf(viaMain)) && typeof viaMain.getWindowButtonPosition === 'function';
  out.viaImport = Boolean(overlayOf(viaImport)) && typeof viaImport.getWindowButtonPosition === 'function';
  viaMain.destroy(); viaImport.destroy();
  // Notion's macOS options: hiddenInset with overlay controls requested.
  const inset = new BrowserWindow({ show: false, titleBarStyle: 'hiddenInset', titleBarOverlay: { color: '#000', height: 36 }, trafficLightPosition: { x: 12, y: 12 } });
  await wait(300);
  out.insetBounds = overlayOf(inset)?.getBounds() ?? null;
  inset.destroy();
  const plain = new BrowserWindow({ show: false });
  out.plainOverlay = Boolean(overlayOf(plain));
  out.plainPosition = plain.getWindowButtonPosition();
  const win = new BrowserWindow({ width: 900, height: 600, titleBarStyle: 'hidden', trafficLightPosition: { x: 17, y: 12 }, webPreferences: { sandbox: true } });
  out.instanceOf = win instanceof BrowserWindow && BrowserWindow.getAllWindows().includes(win);
  // The overlay's URL is only known once its navigation commits.
  const overlay = await until(() => overlayOf(win));
  out.overlayBounds = overlay?.getBounds() ?? null;
  if (!overlay) { fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out)); app.quit(); return; }
  await until(() => !overlay.webContents.isLoading());
  // An app view added later (Linear's tabs) must stay below the buttons.
  const tab = new WebContentsView();
  win.contentView.addChildView(tab);
  out.overlayOnTop = win.contentView.children.at(-1) === overlay;
  win.contentView.removeChildView(tab);
  // Headless Ozone starts windows at 1x1 until bounds are set explicitly.
  win.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  await win.loadFile(process.env.FIXTURE);
  // The page adapter shifts the row clear of the buttons and centres them on it (42/2 - 8).
  out.adapted = await until(async () => {
    const toggleLeft = await win.webContents.executeJavaScript("document.getElementById('toggle').getBoundingClientRect().left");
    return toggleLeft >= 17 + 54 + 12 && overlay.getBounds().y === 13 ? { toggleLeft, y: overlay.getBounds().y } : null;
  });
  out.rowMarked = await win.webContents.executeJavaScript("document.getElementById('row').hasAttribute('data-linux-compat-clear')");
  out.headerUntouched = await win.webContents.executeJavaScript("!document.getElementById('header').hasAttribute('data-linux-compat-clear') && document.getElementById('crumb').getBoundingClientRect().left === 4");
  // Stable: a few more layout passes neither move the buttons nor switch rows.
  await wait(1000);
  out.stable = overlay.getBounds().y === 13 && await win.webContents.executeJavaScript("document.getElementById('row').hasAttribute('data-linux-compat-clear')");
  win.setWindowButtonPosition({ x: 30, y: 40 });
  out.moved = overlay.getBounds();
  out.position = win.getWindowButtonPosition();
  win.setWindowButtonPosition(null);
  out.reset = win.getWindowButtonPosition();
  win.setWindowButtonVisibility(false);
  out.hiddenVisible = overlay.getVisible();
  // Hidden buttons: the page gives the space back.
  out.released = await until(() => win.webContents.executeJavaScript("!document.getElementById('row').hasAttribute('data-linux-compat-clear')"));
  win.setWindowButtonVisibility(true);
  out.shownVisible = overlay.getVisible();
  // Clicking the red button closes the window through the normal close path.
  const closed = new Promise((resolve) => win.once('closed', () => resolve(true)));
  let closeEvents = 0;
  win.on('close', () => closeEvents++);
  overlay.webContents.sendInputEvent({ type: 'mouseDown', x: 7, y: 8, button: 'left', clickCount: 1 });
  overlay.webContents.sendInputEvent({ type: 'mouseUp', x: 7, y: 8, button: 'left', clickCount: 1 });
  out.closedByButton = await Promise.race([closed, wait(5000).then(() => false)]);
  out.closeEvents = closeEvents;
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out));
  app.quit();
});
`;

const VIA_MAIN = `module.exports = () => new (require('electron/main').BrowserWindow)({ show: false, titleBarStyle: 'hidden' });`;
const VIA_IMPORT = `import { BrowserWindow } from 'electron';
export default () => new BrowserWindow({ show: false, titleBarStyle: 'hidden' });`;
const CONFIG = { id: 'probe', envPrefix: 'PROBE', install: { id: 'probe-desktop' }, compat: { pageAdapter: { origins: ['https://probe.example'] } } };

function run(dir, env = {}) {
  const runtime = path.join(dir, 'runtime');
  if (!fs.existsSync(runtime)) {
    probeRuntime(dir, { version: ELECTRON, config: CONFIG, files: { 'main.js': PROBE_MAIN, 'via-main.cjs': VIA_MAIN, 'via-import.mjs': VIA_IMPORT } });
    fs.writeFileSync(path.join(dir, 'fixture.html'), FIXTURE);
  }
  const out = path.join(dir, `results-${Object.values(env).join('-') || 'default'}.json`);
  runProbe(runtime, { env: {
    ...env, PROBE_OUT: out, FIXTURE: path.join(dir, 'fixture.html'),
    PROBE_COMPAT_LOG: path.join(dir, 'events.jsonl'), PROBE_COMPAT_PAGE_ORIGINS: 'file://',
  } });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('Mac title-bar windows get working traffic lights on Linux', { skip: skipUnlessElectron(ELECTRON) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-window-chrome-'));
  try {
    const out = run(dir);
    assert.equal(out.viaMain, true, "require('electron/main') bypassed the facade");
    assert.equal(out.viaImport, true, "import from 'electron' bypassed the facade");
    assert.deepEqual(out.insetBounds, { x: 12, y: 12, width: 54, height: 16 });
    assert.equal(out.plainOverlay, false);
    assert.equal(out.plainPosition, null);
    assert.equal(out.instanceOf, true);
    assert.deepEqual(out.overlayBounds, { x: 17, y: 12, width: 54, height: 16 });
    assert.equal(out.overlayOnTop, true);
    assert.ok(out.adapted, 'page adapter did not clear the row and centre the buttons');
    assert.equal(out.rowMarked, true);
    assert.equal(out.headerUntouched, true);
    assert.equal(out.stable, true);
    assert.deepEqual(out.moved, { x: 30, y: 40, width: 54, height: 16 });
    assert.deepEqual(out.position, { x: 30, y: 40 });
    assert.deepEqual(out.reset, { x: 17, y: 12 });
    assert.equal(out.hiddenVisible, false);
    assert.equal(out.released, true);
    assert.equal(out.shownVisible, true);
    assert.equal(out.closedByButton, true);
    assert.equal(out.closeEvents, 1);

    const emulated = new Set(readEvents(path.join(dir, 'events.jsonl')).filter((e) => e.kind === 'emulated').map((e) => e.api));
    for (const api of ['BrowserWindowConstructorOptions.titleBarStyle=hidden', 'BrowserWindowConstructorOptions.titleBarStyle=hiddenInset',
      'BrowserWindowConstructorOptions.titleBarOverlay(dropped)', 'BaseWindow.setWindowButtonPosition', 'BaseWindow.setWindowButtonVisibility', 'traffic-light.close']) {
      assert.ok(emulated.has(api), `no emulated ${api}: ${[...emulated]}`);
    }

    // Opted out: a normal frame, no buttons, and the button APIs are inert.
    const off = run(dir, { PROBE_TRAFFIC_LIGHTS: '0' });
    assert.equal(off.instanceOf, true);
    assert.equal(off.overlayBounds, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ES-module main with top-level await starts through the compat entry', { skip: skipUnlessElectron(ELECTRON) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-esm-main-'));
  try {
    const main = `import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
await app.whenReady();
const win = new BrowserWindow({ show: false, titleBarStyle: 'hidden' });
await new Promise((resolve) => setTimeout(resolve, 500));
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ lights: win.contentView.children.some((v) => v.webContents?.getURL().endsWith('traffic-lights.html')) }));
app.quit();
`;
    const runtime = probeRuntime(dir, { version: ELECTRON, files: { 'main.mjs': main }, main: './main.mjs', pkg: { type: 'module' } });
    const out = path.join(dir, 'out.json');
    runProbe(runtime, { env: { PROBE_OUT: out, PROBE_COMPAT_LOG: path.join(dir, 'events.jsonl') } });
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { lights: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
