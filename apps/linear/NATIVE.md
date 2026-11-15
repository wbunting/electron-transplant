# macOS native modules

Linear 1.32.8 ships three Mach-O N-API addons, all optional and all lazily
required inside `try/catch`. The preload (`out/preload/index.js`) and
`main/index.js` also gate them on `process.platform === 'darwin'`, so on Linux
they are never called; the shims in `shims/` replace the binaries so nothing Mach-O
is packed and each has an obvious place for a Linux implementation.

| Module | macOS API | Called from | Linux status |
| --- | --- | --- | --- |
| `desktop-haptics` | `perform(pattern)` → NSHapticFeedbackManager | `ElectronBridge.performHapticFeedback` (darwin-gated) | No equivalent; inert shim |
| `desktop-force-press` | `observe(nativeWindowHandle, cb)`, `unobserve(id)` → NSEvent pressure stages | `forcePressEnabledChange` IPC (darwin-gated) | No libinput equivalent; throws "unavailable" |
| `desktop-swipe-navigation` | `observe(nativeWindowHandle, cb)`, `unobserve(id)` → NSEvent scroll `phase`/`momentumPhase`/`scrollingDeltaX/Y` | `ElectronBridge.onSwipeGesture` (darwin-gated) | Not ported; candidate (see below) |

Other darwin-only bridge features: `captureScreenshot` (undefined off macOS),
`systemPreferences.getUserDefault` reads (AutoUpdateDisabled, titlebar
double-click). Traffic-light window buttons are emulated by
`compat/window-chrome.cjs` (see docs/how-it-works.md).

## Porting swipe navigation

The native module is per-window and sends `{phase, momentumPhase, deltaX, deltaY,
x, y}` events to the renderer via `swipeGesture` IPC. Linux has no main-process
equivalent without a native addon, but Chromium on Wayland already receives
two-finger touchpad scrolling as precise wheel events, with scroll end signalled
by Wayland `axis_stop`. A port would:

1. Drop the darwin gates on `onSwipeGesture` (preload) and the attach (main).
2. Replace this shim with a renderer-side synthesiser, or an addon reading
   `zwp_pointer_gestures_v1` swipe events, and map them to the same payload.
3. Verify on a real touchpad that vertical scrolling and text selection are unaffected.
