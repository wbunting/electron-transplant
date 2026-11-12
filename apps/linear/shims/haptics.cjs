// Linux shim for @linear/desktop-haptics (macOS NSHapticFeedbackManager).
// Linux has no trackpad haptics API; the preload already gates calls to darwin.
'use strict';
const record = (api) => globalThis[Symbol.for('electron-transplant.recorder')]?.record({ kind: 'native-shim', api });
function perform(pattern) {
  record('@linear/desktop-haptics.perform');
  if (typeof pattern !== 'string') throw TypeError('Expected exactly one haptic pattern string');
}
module.exports = { perform, linuxShim: true };
