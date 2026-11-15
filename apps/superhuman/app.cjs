// Superhuman: a tabbed shell around https://mail.superhuman.com. Its main process
// (dist/main.js) is webpack output, not minified, and the app has no native code.
// Electron's Linux UA already gets the native sign-in flow (state=native-login,
// handed to the default browser), so no user-agent spoofing is needed. What breaks
// is the browser's side of that sign-in; see signin/ and docs/apps.md.
const MAIN = 'dist/main.js';

module.exports = {
  id: 'superhuman',
  name: 'Superhuman',
  bundleId: 'com.superhuman.electron',
  // SUPERHUMAN_ is the Windows-build port's (and the app's own SUPERHUMAN_REGRESSION).
  envPrefix: 'SUPERHUMAN_DESKTOP',
  // Its own directory: the download is untrusted data, kept apart.
  dmg: { dir: 'superhuman-mac', glob: 'Superhuman-*.dmg', app: 'Superhuman.app' },
  pins: [
    // https://storage.googleapis.com/download.superhuman.com/native-update/Superhuman-1045.0.0-latest.dmg
    // (Intel; latest-mac.yml publishes its SHA-512, which matched).
    { sha256: 'd5e9d30bdfe36658641a4783a58e63711078d76a80d0aefe7fd9610966a77414', version: '1045.0.0', electron: '45.2.3', note: 'x86_64' },
  ],
  install: {
    // `superhuman` is taken by the Windows-build port (superhuman-linux); both can
    // be installed side by side.
    id: 'superhuman-desktop',
    command: 'superhuman-desktop',
    // Tells it apart from the Windows-build port's "Superhuman" in launchers.
    name: 'Superhuman Desktop',
    comment: 'Superhuman — unofficial Linux port of the macOS desktop app',
    categories: 'Network;Email;',
    // Info.plist also lists mailto; it is registered but stays with the current
    // mail handler until chosen in Superhuman's menu ("Set as default email client").
    defaultSchemes: ['superhuman'],
    // The browser extension must stay at a fixed path (browsers keep the path of an
    // unpacked extension), so it goes to share/, not the versioned runtime.
    share: 'signin',
    helpers: [
      {
        command: 'superhuman-desktop-finish-login',
        script: 'finish-login.cjs',
        name: 'Superhuman Desktop — Finish browser sign-in',
        comment: 'Copy the browser sign-in URL, then run this',
        keywords: 'Superhuman;login;sign-in;OAuth;',
        args: ['--notify'],
      },
    ],
  },
  // The app's own window buttons, not emulated ones (checked by ET_SMOKE=1).
  smoke: { trafficLights: false },
  patches: [
    {
      // electron-updater would take its AppImage path on Linux and can never install
      // a macOS release. Every update path (on launch, periodic, menu, the web app's
      // ⌘K "force update") goes through _startUpdate; skip it as in development.
      name: 'no-auto-update-on-linux',
      file: MAIN,
      from: 'if (config_1.default.isDev) {\n            this.setStage(stages.SKIPPED);',
      to: "if (config_1.default.isDev || process.platform === 'linux') {\n            this.setStage(stages.SKIPPED);",
    },
    {
      // The tab bar and mail views are sized from the window's outer bounds, which
      // equal the content area on macOS (hidden title bar). Linux windows keep a
      // frame (and a menu bar when shown), so the views ran past the bottom edge.
      name: 'views-fit-content-on-linux',
      file: MAIN,
      count: 2,
      from: 'const windowBounds = window.getBounds();',
      to: "const windowBounds = process.platform === 'linux' ? window.getContentBounds() : window.getBounds();",
    },
    {
      // The tab bar draws its own macOS window buttons on every non-Windows platform
      // (navigator.platform), wired to close/minimize/fullscreen IPC that works on
      // Linux. On macOS the app hides the native buttons under them; do the same so
      // the emulated ones don't double up.
      name: 'own-window-buttons-on-linux',
      file: MAIN,
      from: "if (process.platform === 'darwin') {\n            this.window.setWindowButtonVisibility(false);",
      to: "if (process.platform === 'darwin' || process.platform === 'linux') {\n            this.window.setWindowButtonVisibility(false);",
    },
    {
      // The macOS app menu would show as a menu bar inside the window: hide it, Alt
      // shows it (as Figma's recipe does).
      name: 'menu-bar-auto-hide-on-linux',
      file: MAIN,
      from: "title: 'Superhuman',\n            x: x,",
      to: "title: 'Superhuman',\n            autoHideMenuBar: process.platform === 'linux',\n            x: x,",
    },
  ],
};
