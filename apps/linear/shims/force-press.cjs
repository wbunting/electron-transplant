// Linux shim for @linear/desktop-force-press (macOS NSEvent pressure stages).
// No Linux equivalent: libinput reports no Force Touch stages. main/index.js
// only attaches on darwin and treats a throw here as "unavailable".
'use strict';
const record = (api) => globalThis[Symbol.for('electron-transplant.recorder')]?.record({ kind: 'native-shim', api });
function observe() {
  record('@linear/desktop-force-press.observe');
  throw Error('Force Touch press is not available on Linux');
}
function unobserve() {}
module.exports = { observe, unobserve, linuxShim: true };
