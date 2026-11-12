// App entry on Linux (package.json "main"): start the compat recorder and the
// electron facade, then load the app's original main. Settings come from the
// config.json the build writes next to this file; per-app environment switches
// use the app's prefix, e.g. LINEAR_TRAFFIC_LIGHTS=0.
'use strict';
const path = require('node:path');
const compatDir = __dirname;
const appRoot = path.resolve(compatDir, '..');
const config = require('./config.json');
const pkg = require(path.join(appRoot, 'package.json'));
const env = (name) => process.env[`${config.envPrefix}_${name}`];
const electron = require('electron');

let recorder;
try {
  const runtime = require('./runtime.cjs');
  recorder = runtime.install({
    electron,
    table: require(`./${config.platformApis}`),
    appRoot,
    logPath: env('COMPAT_LOG') || runtime.defaultLogPath(config.appId),
    meta: {
      app: config.appId,
      version: pkg.version,
      electron: process.versions.electron,
      runtime: path.basename(path.resolve(appRoot, '../..')),
    },
  });
} catch (error) {
  // Recording must never stop the app from starting.
  console.error('electron-transplant: recorder unavailable:', error?.message ?? error);
}

// <PREFIX>_COMPAT_FACADE=0 leaves `electron` untouched (debugging only: Mac
// title-bar windows then come out frameless with no buttons).
if (env('COMPAT_FACADE') !== '0') {
  const { createWindowChrome } = require('./window-chrome.cjs');
  const chrome = createWindowChrome({
    electron,
    // <PREFIX>_TRAFFIC_LIGHTS=0: normal frame instead of emulated macOS buttons.
    enabled: env('TRAFFIC_LIGHTS') !== '0',
    // <PREFIX>_FRAMELESS=1: frameless as on macOS (for desktops that draw a title
    // bar; Hyprland floats frameless windows, so not the default).
    frameless: env('FRAMELESS') === '1',
    record: (event) => recorder?.record(event),
    pageAdapter: config.pageAdapter && {
      preload: path.join(compatDir, 'title-bar-page-adapter.cjs'),
      origins: (env('COMPAT_PAGE_ORIGINS') ?? config.pageAdapter.origins.join(',')).split(',').filter(Boolean),
    },
  });
  require('./facade.cjs').installFacade({
    electron,
    appRoot,
    overrides: { BrowserWindow: chrome.BrowserWindow },
    exclude: [compatDir + path.sep],
  });
}

const main = path.join(appRoot, pkg.originalMain);
if (pkg.type === 'module' || main.endsWith('.mjs')) {
  // ES main (may use top-level await): load it the way Electron would.
  import(require('node:url').pathToFileURL(main).href).catch((error) => {
    console.error(error);
    electron.app.exit(1);
  });
} else {
  require(main);
}
