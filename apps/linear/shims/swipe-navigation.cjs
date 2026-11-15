// Linux shim for @linear/desktop-swipe-navigation (macOS NSEvent scroll phases:
// phase, momentumPhase, scrollingDeltaX/Y). A Linux port could derive these from
// Wayland pointer axis/axis_stop events in the renderer; see ../NATIVE.md.
'use strict';
const record = (api) => globalThis[Symbol.for('electron-transplant.recorder')]?.record({ kind: 'native-shim', api });
function observe() {
  record('@linear/desktop-swipe-navigation.observe');
  throw Error('Swipe navigation is not yet implemented on Linux');
}
function unobserve() {}
module.exports = { observe, unobserve, linuxShim: true };
