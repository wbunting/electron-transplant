// Linear: a thin Electron shell around https://linear.app. Main is out/main/index.js.
const MAIN = 'out/main/index.js';

module.exports = {
  id: 'linear',
  name: 'Linear',
  bundleId: 'com.linear',
  envPrefix: 'LINEAR',
  dmg: { glob: 'Linear-*.dmg', app: 'Linear.app' },
  source: {
    page: 'https://linear.app/download',
    // What the app's own updater reads (Resources/app-update.yml).
    feed: { type: 'electron-builder', url: 'https://releases.linear.app/latest-mac.yml' },
    dmg: 'https://releases.linear.app/Linear-{version}-universal.dmg',
    hosts: ['releases.linear.app'],
    // Older releases stay downloadable.
    retention: 'all',
  },
  pins: [
    { sha256: '08d42b917bc44068231d47a9e14ae9fdac2ca95fa6b451e810fcda0f756ed4a3', version: '1.32.8', electron: '44.9.1', note: 'universal' },
  ],
  install: {
    // `linear` is the Linear CLI.
    id: 'linear-desktop',
    command: 'linear-desktop',
    comment: 'Linear — unofficial Linux port of the macOS desktop app',
    categories: 'Development;ProjectManagement;',
    // Registered at runtime by setAsDefaultProtocolClient; not in Info.plist.
    schemes: ['linear'],
  },
  // Three optional Mac trackpad addons, lazily required in try/catch and darwin-gated.
  // See NATIVE.md for their APIs and what a Linux swipe-navigation port would need.
  natives: {
    '@linear/desktop-haptics': { action: 'shim', shim: 'shims/haptics.cjs' },
    '@linear/desktop-force-press': { action: 'shim', shim: 'shims/force-press.cjs' },
    '@linear/desktop-swipe-navigation': { action: 'shim', shim: 'shims/swipe-navigation.cjs' },
  },
  patches: [
    {
      // electron-updater would take its AppImage path on Linux and can never
      // install a macOS release. Treat Linux like AutoUpdateDisabled=YES.
      name: 'disable-auto-update-on-linux',
      file: MAIN,
      from: 'get autoUpdateDisabled(){return process.platform===`darwin`&&',
      to: 'get autoUpdateDisabled(){return process.platform===`linux`||process.platform===`darwin`&&',
    },
    {
      // Main windows ask for the macOS hidden title bar and button position on
      // Linux too. Only the window options: the same flag (TH) also drives macOS
      // close-to-hide and dock behaviour.
      name: 'mac-title-bar-on-linux',
      file: MAIN,
      from: 'titleBarStyle:TH?`hidden`:`default`,trafficLightPosition:TH?{x:17,y:12}:void 0',
      to: 'titleBarStyle:TH||process.platform===`linux`?`hidden`:`default`,trafficLightPosition:TH||process.platform===`linux`?{x:17,y:12}:void 0',
    },
  ],
  compat: {
    // linear.app only makes room for the buttons when navigator.platform is MacIntel
    // (which also selects ⌘ shortcuts), so the page adapter clears the title-bar row.
    pageAdapter: { origins: ['https://linear.app'] },
  },
};
