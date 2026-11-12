const test = require('node:test');
const assert = require('node:assert/strict');
const { macChrome, linuxOptions } = require('../compat/window-chrome.cjs');
const { createFacade, esmSource } = require('../compat/facade.cjs');

test('macChrome recognises macOS hidden title bars and their button position', () => {
  assert.deepEqual(macChrome({ titleBarStyle: 'hidden', trafficLightPosition: { x: 17.4, y: 12 } }),
    { style: 'hidden', position: { x: 17, y: 12 }, hoverOnly: false });
  assert.deepEqual(macChrome({ titleBarStyle: 'hiddenInset' }).position, { x: 12, y: 12 });
  assert.equal(macChrome({ titleBarStyle: 'customButtonsOnHover' }).hoverOnly, true);
  assert.equal(macChrome({ titleBarStyle: 'hidden', trafficLightPosition: { x: 'a', y: 1 } }).position.x, 7);
  for (const options of [{}, { titleBarStyle: 'default' }, { titleBarStyle: 'hidden', frame: false }, { titleBarStyle: 'toString' }, undefined]) {
    assert.equal(macChrome(options), null, JSON.stringify(options));
  }
});

test('linuxOptions keeps a normal frame unless frameless is requested, and never keeps titleBarOverlay', () => {
  const options = { width: 1, titleBarStyle: 'hidden', trafficLightPosition: { x: 1, y: 2 }, minWidth: 5, titleBarOverlay: true };
  assert.deepEqual(linuxOptions(options), { width: 1, minWidth: 5 });
  assert.deepEqual(linuxOptions(options, { frameless: true }), { width: 1, titleBarStyle: 'hidden', trafficLightPosition: { x: 1, y: 2 }, minWidth: 5 });
  assert.equal(options.titleBarOverlay, true);
});

test('the ES facade re-exports Electron and overrides only what it is given', () => {
  const source = esmSource({ BrowserWindow: 1 });
  assert.match(source, /^export \* from 'electron';/);
  assert.match(source, /export const BrowserWindow = facade\.BrowserWindow;/);
  assert.match(source, /export default facade;/);
  assert.throws(() => esmSource({ 'bad name': 1 }), /Invalid export name/);
});

test('the facade overrides one export and lazily forwards the rest', () => {
  let reads = 0;
  const electron = Object.defineProperties({}, {
    app: { enumerable: true, get: () => { reads++; return 'app'; } },
    BrowserWindow: { enumerable: true, get: () => 'real' },
  });
  const facade = createFacade(electron, { BrowserWindow: 'compat' });
  assert.equal(reads, 0);
  assert.equal(facade.app, 'app');
  assert.equal(reads, 1);
  assert.equal(facade.BrowserWindow, 'compat');
  assert.deepEqual(Object.keys(facade).sort(), ['BrowserWindow', 'app']);
});
