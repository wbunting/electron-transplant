// Notion: a large webpack main process (.webpack/main/index.js) that already has
// Linux support of its own (tray, single instance, notion:// argv, PipeWire, Flatpak
// updater). On Linux it uses Windows-style overlay controls; these patches give it
// the macOS window chrome instead, and its local tab bar lays out around the buttons.
const MAIN = '.webpack/main/index.js';
const TABS = '.webpack/renderer/tabs/index.js';
const LINUX_TOO = '"darwin"===process.platform||"linux"===process.platform';

module.exports = {
  id: 'notion',
  name: 'Notion',
  bundleId: 'notion.id',
  envPrefix: 'NOTION',
  dmg: { glob: 'Notion-*.dmg', app: 'Notion.app' },
  source: {
    page: 'https://www.notion.com/desktop',
    feed: { type: 'electron-builder', url: 'https://desktop-release.notion-static.com/latest-mac.yml' },
    // Per pin note.
    dmg: {
      universal: 'https://desktop-release.notion-static.com/Notion-{version}-universal.dmg',
      x86_64: 'https://desktop-release.notion-static.com/Notion-{version}.dmg',
    },
    hosts: ['desktop-release.notion-static.com'],
    retention: 'all',
  },
  // Same code: the builds differ only in the embedded targetPlatform string.
  pins: [
    { sha256: 'efcf69504162f3349ac3792d1009b1906c98381667463fd42647f8886fd438ce', version: '7.43.0', electron: '45.1.0', note: 'universal' },
    { sha256: '86651bcc1b70d1c18c5c64531bcaefa309eb8e7a23b63744bc560e162c61961b', version: '7.43.0', electron: '45.1.0', note: 'x86_64' },
  ],
  install: {
    // `notion` is the Notion CLI.
    id: 'notion-desktop',
    command: 'notion-desktop',
    comment: 'Notion — unofficial Linux port of the macOS desktop app',
    categories: 'Office;',
    // Packages that install /usr/bin/notion-desktop (Omarchy's notion-desktop; the
    // AUR's notion-desktop-git provides it).
    conflicts: ['notion-desktop'],
  },
  natives: {
    // The local database. v13 is Node-API (ABI-stable across Electron versions) and
    // its npm package ships prebuilds; Notion stripped them and built a Mach-O one.
    'better-sqlite3': {
      action: 'npm-prebuild',
      package: 'better-sqlite3',
      version: '13.0.1',
      integrity: 'sha512-LYpmOXdkpQYf4wmlxkdzW01XGlOXNIbjLg45yNkh0FQ4814VbK9PdOFmhZpYbej+EZtR/i3FDdhEG98HqZdgnA==',
      // The same tarball, for packagers whose source lists take SHA-256.
      sha256: '92935ff8280f933aff78f87e04eb718a21af003aec4e5bd0076f287aa1709da4',
      files: { 'prebuilds/linux-x64.node': 'prebuilds/linux-x64.node' },
      remove: ['build'],
    },
    // module.js has a pure-JS Linux path (no-ops + optional PipeWire); only the
    // macOS addon goes.
    '@notionhq/desktop-native': { action: 'remove', paths: ['build'] },
    // CFPreferences policy reads, only on darwin.
    'cf-prefs': { action: 'stub', exports: ['getPreferenceValue', 'isPreferenceForced'] },
    // macOS progress window; not required anywhere in 7.43.0.
    '@jasonscheirer/native-progress-bar': { action: 'stub', exports: ['ProgressBar'] },
  },
  resources: {
    // Mach-O native-messaging host for the meeting-notes browser extension. Notion's
    // Linux code checks the path exists before registering it.
    drop: ['notion-meeting-notes-host'],
    // Notion's Linux tray loads these from resources/ (Inverted when the desktop
    // prefers dark); the Mac bundle only has the menu-bar template, an alpha mask.
    derive: [
      { to: 'linuxTrayIcon.png', from: 'menuBarIconTemplate@2x.png', recolor: '000000' },
      { to: 'linuxTrayIconInverted.png', from: 'menuBarIconTemplate@2x.png', recolor: 'ffffff' },
    ],
  },
  patches: [
    {
      // Main window: macOS title bar (hiddenInset, plus titleBarOverlay with virtual
      // tabs) instead of Windows-style overlay controls.
      name: 'main-window-mac-title-bar',
      file: MAIN,
      from: 'k="darwin"!==process.platform?{titleBarStyle:"hidden",titleBarOverlay:(0,T.windowControlCustomizationsSelector)(m)}:{titleBarStyle:"hiddenInset",...w?{titleBarOverlay:!0}:{}}',
      to: `k=!(${LINUX_TOO})?{titleBarStyle:"hidden",titleBarOverlay:(0,T.windowControlCustomizationsSelector)(m)}:{titleBarStyle:"hiddenInset",...w?{titleBarOverlay:!0}:{}}`,
    },
    {
      name: 'main-window-traffic-light-position',
      file: MAIN,
      from: '..."darwin"===process.platform?{trafficLightPosition:(0,p.getDefaultTrafficLightPosition)(w?d.VIRTUAL_TAB_BAR_HEIGHT_PX:void 0)}:{}',
      to: `...${LINUX_TOO}?{trafficLightPosition:(0,p.getDefaultTrafficLightPosition)(w?d.VIRTUAL_TAB_BAR_HEIGHT_PX:void 0)}:{}`,
    },
    {
      // Re-centres the buttons on the tab bar when its height or the zoom changes.
      name: 'tab-bar-button-position',
      file: MAIN,
      count: 2,
      from: '"darwin"===process.platform&&this.browserWindow.setWindowButtonPosition((0,w.getTrafficLightPosition)({tabBarHeight:(0,j.tabBarHeightSelector)(e),',
      to: `(${LINUX_TOO})&&this.browserWindow.setWindowButtonPosition((0,w.getTrafficLightPosition)({tabBarHeight:(0,j.tabBarHeightSelector)(e),`,
    },
    {
      name: 'virtual-tabs-button-position',
      file: MAIN,
      from: 'updateTrafficLightPosition(){if("darwin"!==process.platform)return;',
      to: `updateTrafficLightPosition(){if(!(${LINUX_TOO}))return;`,
    },
    {
      // "Applecart" window (Notion's app switcher/onboarding surface).
      name: 'applecart-mac-title-bar',
      file: MAIN,
      from: 'n="darwin"===process.platform;this.browserWindow=new g.BrowserWindow({',
      to: `n=${LINUX_TOO};this.browserWindow=new g.BrowserWindow({`,
    },
    {
      name: 'applecart-rtl-button-position',
      file: MAIN,
      from: 'if("darwin"!==process.platform||this.browserWindow.isDestroyed())return;const[e]=this.browserWindow.getContentSize()',
      to: `if(!(${LINUX_TOO})||this.browserWindow.isDestroyed())return;const[e]=this.browserWindow.getContentSize()`,
    },
    // The tab bar (a local page) pads around the buttons on darwin and around the
    // overlay controls elsewhere. Only its padding follows macOS: the Notion app-menu
    // button stays, since Linux has no global menu bar.
    {
      name: 'tab-bar-start-padding',
      file: TABS,
      from: 'return"darwin"===a?(0,d.areLocaleDirectionsAligned)(e)?b({paddingType:"start"',
      to: 'return("darwin"===a||"linux"===a)?(0,d.areLocaleDirectionsAligned)(e)?b({paddingType:"start"',
    },
    {
      name: 'tab-bar-end-padding',
      file: TABS,
      from: 'return"darwin"===a?(0,d.areLocaleDirectionsAligned)(e)?u({isFullscreen:t})',
      to: 'return("darwin"===a||"linux"===a)?(0,d.areLocaleDirectionsAligned)(e)?u({isFullscreen:t})',
    },
    {
      name: 'tab-bar-end-drag-padding',
      file: TABS,
      from: 'function v(r){return"darwin"===r.systemPlatform?u({isFullscreen:r.isFullscreen}):0}',
      to: 'function v(r){return("darwin"===r.systemPlatform||"linux"===r.systemPlatform)?u({isFullscreen:r.isFullscreen}):0}',
    },
  ],
};
