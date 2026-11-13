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

// Apps whose URL scheme another installed app handles (Figma: figma-linux-next owns
// figma://) must not take it over at startup. On Linux, setAsDefaultProtocolClient
// runs `xdg-settings set default-url-scheme-handler`. The desktop entry still
// registers the scheme; <PREFIX>_DEFAULT_PROTOCOL_CLIENT=1 restores the call.
if (config.defaultProtocolClient === false && env('DEFAULT_PROTOCOL_CLIENT') !== '1') {
  electron.app.setAsDefaultProtocolClient = function setAsDefaultProtocolClient() {
    recorder?.record({ kind: 'declined-call', api: 'app.setAsDefaultProtocolClient' });
    return false;
  };
}

// App-specific Linux behaviour (apps/<id>/, added to the app by the build).
for (const hook of config.hooks ?? []) {
  try {
    require(path.join(appRoot, hook))({ electron, env, envPrefix: config.envPrefix, appRoot, record: (event) => recorder?.record(event) });
  } catch (error) {
    console.error(`electron-transplant: hook ${hook} failed:`, error?.message ?? error);
    recorder?.record({ kind: 'hook-failed', api: hook, error: String(error?.message ?? error).slice(0, 240) }, error?.stack);
  }
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
