// macOS window chrome on Linux. Electron silently ignores `titleBarStyle: 'hidden'`
// window buttons and `trafficLightPosition` off macOS, and has no
// setWindowButtonPosition/Visibility. This translates them: windows created with
// a hidden title bar get macOS-style traffic lights drawn by a small overlay view,
// and the Mac-only button APIs move, hide and show them.
//
// Apps reach the translation through the electron facade (facade.cjs), whose
// BrowserWindow is the subclass made here.
'use strict';
const path = require('node:path');

const CHANNEL = 'linux-compat:traffic-lights';
const PAGE_CHANNEL = 'linux-compat:chrome';
// macOS standard window buttons: 14x16 frames, 20px apart, 12px circles inside.
const BUTTON = { width: 14, height: 16, pitch: 20 };
const GROUP = { width: BUTTON.pitch * 2 + BUTTON.width, height: BUTTON.height };
// Space a page keeps clear to the right of the buttons (Linear's Mac safe zone uses 12).
const CLEAR_GAP = 12;
// Approximate AppKit positions when an app gives no trafficLightPosition.
const DEFAULT_POSITIONS = { hidden: { x: 7, y: 6 }, hiddenInset: { x: 12, y: 12 }, customButtonsOnHover: { x: 7, y: 6 } };
const ACTIONS = new Set(['close', 'minimize', 'zoom']);

function isPoint(value) {
  return value != null && Number.isFinite(value.x) && Number.isFinite(value.y);
}

// The macOS chrome a set of BrowserWindow options asks for, or null.
function macChrome(options) {
  if (!options || options.frame === false) return null;
  const style = options.titleBarStyle;
  if (!Object.hasOwn(DEFAULT_POSITIONS, style)) return null;
  const position = isPoint(options.trafficLightPosition)
    ? { x: Math.round(options.trafficLightPosition.x), y: Math.round(options.trafficLightPosition.y) }
    : { ...DEFAULT_POSITIONS[style] };
  return { style, position, hoverOnly: style === 'customButtonsOnHover' };
}

// Linux options for a window that asked for macOS chrome. Electron makes a hidden
// title bar frameless on Linux, but a frameless window asks for client-side
// decorations and Hyprland then floats it. With server-side decorations (Hyprland
// draws none) a normal frame already looks like macOS's hidden title bar, so keep
// it unless `frameless` is requested (for desktops that draw a title bar).
// titleBarOverlay always goes: on Linux it makes Electron draw its own
// Windows-style buttons as well (on macOS it only exposes the overlay APIs).
function linuxOptions(options, { frameless = false } = {}) {
  const { titleBarOverlay, ...withoutOverlay } = options;
  if (frameless) return withoutOverlay;
  const { titleBarStyle, trafficLightPosition, ...rest } = withoutOverlay;
  return rest;
}

class TrafficLights {
  constructor(win, chrome, { electron, overlayDir, record = () => {}, onActiveContentsChanged = () => {} }) {
    this.win = win;
    this.initial = chrome.position;
    this.position = { ...chrome.position };
    this.hoverOnly = chrome.hoverOnly;
    this.userVisible = true;
    this.dark = electron.nativeTheme.shouldUseDarkColors;
    this.record = record;
    this.onActiveContentsChanged = onActiveContentsChanged;
    this.activeContents = null;
    this.view = new electron.WebContentsView({
      webPreferences: {
        // Separate in-memory session: none of the app's session handlers or preloads.
        partition: 'linux-compat-window-chrome',
        preload: path.join(overlayDir, 'traffic-lights-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.view.setBackgroundColor('#00000000');
    const contents = this.view.webContents;
    contents.loadFile(path.join(overlayDir, 'traffic-lights.html'));
    contents.on('did-finish-load', () => this.sendState());
    // Like macOS, clicking the buttons must not take focus from the page.
    contents.on('focus', () => setImmediate(() => this.refocusPage()));
    this.keepOnTop();
    win.contentView.addChildView(this.view);
    const update = () => this.update();
    for (const event of ['focus', 'blur', 'enter-full-screen', 'leave-full-screen', 'show']) win.on(event, update);
    this.onTheme = () => { this.dark = electron.nativeTheme.shouldUseDarkColors; this.sendState(); };
    electron.nativeTheme.on('updated', this.onTheme);
    win.once('closed', () => {
      electron.nativeTheme.off('updated', this.onTheme);
      if (!contents.isDestroyed()) contents.close();
    });
    this.update();
  }

  // Apps (Linear's tab views, for one) add views after ours; keep the buttons above them.
  keepOnTop() {
    const contentView = this.win.contentView;
    const add = contentView.addChildView;
    const remove = contentView.removeChildView;
    const lights = this;
    contentView.addChildView = function addChildView(view, ...rest) {
      const result = add.call(this, view, ...rest);
      if (view !== lights.view) {
        add.call(this, lights.view);
        lights.viewsChanged();
      }
      return result;
    };
    contentView.removeChildView = function removeChildView(view, ...rest) {
      const result = remove.call(this, view, ...rest);
      lights.viewsChanged();
      return result;
    };
  }

  // The page the user sees: the topmost visible web view other than ours.
  topContents() {
    const children = this.win.isDestroyed() ? [] : this.win.contentView.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const view = children[i];
      if (view === this.view || !view.webContents || view.webContents.isDestroyed()) continue;
      if (typeof view.getVisible === 'function' && !view.getVisible()) continue;
      return view.webContents;
    }
    return this.win.isDestroyed() ? null : this.win.webContents;
  }

  owns(contents) {
    if (this.win.isDestroyed() || contents === this.view.webContents) return false;
    return contents === this.win.webContents || this.win.contentView.children.some((view) => view.webContents === contents);
  }

  // Visibility changes follow addChildView synchronously; read the result afterwards.
  viewsChanged() {
    clearImmediate(this.pendingViews);
    this.pendingViews = setImmediate(() => {
      if (this.win.isDestroyed()) return;
      const top = this.topContents();
      if (top !== this.activeContents) {
        this.activeContents = top;
        this.onActiveContentsChanged(this, top);
      }
    });
  }

  refocusPage() {
    if (this.win.isDestroyed() || !this.win.isFocused()) return;
    const page = this.topContents();
    if (page && !page.isDestroyed()) page.focus();
  }

  get visible() {
    return this.userVisible && !this.win.isDestroyed() && !this.win.isFullScreen();
  }

  update() {
    if (this.win.isDestroyed()) return;
    const { x, y } = this.position;
    this.view.setBounds({ x, y, width: GROUP.width, height: GROUP.height });
    this.view.setVisible(this.visible);
    this.sendState();
    this.viewsChanged();
  }

  sendState() {
    const contents = this.view.webContents;
    if (contents.isDestroyed() || contents.isLoading()) return;
    contents.send(`${CHANNEL}:state`, { focused: this.win.isFocused(), dark: this.dark, hoverOnly: this.hoverOnly });
  }

  // Emulated BrowserWindow APIs.
  setPosition(position) {
    if (position === null) this.position = { ...this.initial };
    else if (isPoint(position)) this.position = { x: Math.round(position.x), y: Math.round(position.y) };
    else throw TypeError('Expected a { x, y } point or null');
    this.update();
  }

  getPosition() {
    return { ...this.position };
  }

  setUserVisible(visible) {
    this.userVisible = Boolean(visible);
    this.update();
  }

  // What a page beside the buttons must keep clear, in window coordinates.
  zone() {
    return { lit: this.visible, x: this.position.x, width: GROUP.width, clearRight: this.position.x + GROUP.width + CLEAR_GAP };
  }

  setPageTheme(dark) {
    if (typeof dark !== 'boolean' || dark === this.dark) return;
    this.dark = dark;
    this.sendState();
  }

  perform(action, alternate) {
    const win = this.win;
    if (win.isDestroyed()) return;
    this.record({ kind: 'emulated', api: `traffic-light.${action}` });
    if (action === 'close') win.close();
    else if (action === 'minimize') {
      if (win.isMinimizable()) win.minimize();
    } else if (alternate) {
      // Option-click on macOS zooms; on Linux, maximize.
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
    } else if (win.isFullScreenable()) {
      win.setFullScreen(!win.isFullScreen());
    }
    if (action !== 'close') this.refocusPage();
  }
}


// Returns the BrowserWindow subclass to hand to the app (see facade.cjs).
function createWindowChrome({ electron, enabled = true, frameless = false, record = () => {}, pageAdapter }) {
  const overlayDir = __dirname;
  const lightsByWindow = new WeakMap();
  const allLights = new Set();
  const findLights = (contents, predicate) => {
    for (const lights of allLights) if (predicate(lights, contents)) return lights;
    return null;
  };

  const pageState = (lights, contents) => {
    if (!pageAdapter || !lights.owns(contents)) return null;
    const url = contents.getURL();
    // Prefix match so file:// fixtures work too; the trailing slash keeps
    // https://linear.app from matching https://linear.app.example.
    return pageAdapter.origins.some((origin) => url === origin || url.startsWith(`${origin}/`)) ? lights.zone() : null;
  };
  const pushPageState = (lights) => {
    if (!pageAdapter || lights.win.isDestroyed()) return;
    for (const contents of [lights.win.webContents, ...lights.win.contentView.children.map((view) => view.webContents)]) {
      if (!contents || contents.isDestroyed() || contents === lights.view.webContents) continue;
      const state = pageState(lights, contents);
      if (state) contents.send(`${PAGE_CHANNEL}:state`, state);
    }
  };

  const ElectronBrowserWindow = electron.BrowserWindow;
  // Must be named BrowserWindow: Electron's getAllWindows/getFocusedWindow/fromId keep
  // only windows whose constructor.name === 'BrowserWindow'.
  class BrowserWindow extends ElectronBrowserWindow {
    constructor(options = {}) {
      const chrome = process.platform === 'linux' ? macChrome(options) : null;
      super(chrome ? linuxOptions(options, { frameless: enabled && frameless }) : options);
      if (!chrome) return;
      record({ kind: 'emulated', api: `BrowserWindowConstructorOptions.titleBarStyle=${chrome.style}` });
      if (options.titleBarOverlay) record({ kind: 'emulated', api: 'BrowserWindowConstructorOptions.titleBarOverlay(dropped)' });
      if (!enabled) return;
      const lights = new TrafficLights(this, chrome, {
        electron,
        overlayDir,
        record,
        onActiveContentsChanged: (owner, contents) => {
          pushPageState(owner);
          if (contents && !contents.isDestroyed()) contents.send(`${PAGE_CHANNEL}:request`);
        },
      });
      lightsByWindow.set(this, lights);
      allLights.add(lights);
      // The page keeps its space clear only while the buttons show.
      for (const event of ['enter-full-screen', 'leave-full-screen']) this.on(event, () => pushPageState(lights));
      this.once('closed', () => allLights.delete(lights));
    }

    setWindowButtonPosition(position) {
      record({ kind: 'emulated', api: 'BaseWindow.setWindowButtonPosition' });
      const lights = lightsByWindow.get(this);
      if (!lights) return;
      lights.setPosition(position);
      pushPageState(lights);
    }

    getWindowButtonPosition() {
      record({ kind: 'emulated', api: 'BaseWindow.getWindowButtonPosition' });
      return lightsByWindow.get(this)?.getPosition() ?? null;
    }

    setWindowButtonVisibility(visible) {
      record({ kind: 'emulated', api: 'BaseWindow.setWindowButtonVisibility' });
      const lights = lightsByWindow.get(this);
      if (!lights) return;
      lights.setUserVisible(visible);
      pushPageState(lights);
    }
  }

  electron.ipcMain.on(`${CHANNEL}:action`, (event, action, alternate) => {
    if (!ACTIONS.has(action)) return;
    findLights(event.sender, (lights, sender) => lights.view.webContents === sender)?.perform(action, alternate === true);
  });

  if (pageAdapter) {
    electron.ipcMain.handle(`${PAGE_CHANNEL}:hello`, (event) => {
      const lights = findLights(event.sender, (candidate, sender) => candidate.owns(sender));
      return lights ? pageState(lights, event.sender) : null;
    });
    // A page reports where its title-bar row is, as Linear's Mac client does via
    // updateTrafficLightPosition. Only the page on top of the window is followed.
    electron.ipcMain.on(`${PAGE_CHANNEL}:layout`, (event, layout) => {
      const lights = findLights(event.sender, (candidate, sender) => candidate.topContents() === sender);
      if (!lights || !pageState(lights, event.sender) || typeof layout !== 'object' || layout === null) return;
      lights.setPageTheme(layout.dark);
      const y = layout.centerY;
      const position = Number.isFinite(y) && y > 0 && y < 200 ? { x: lights.initial.x, y: Math.round(y - GROUP.height / 2) } : null;
      const current = lights.getPosition();
      const next = position ?? lights.initial;
      if (next.x !== current.x || next.y !== current.y) lights.setPosition(position);
    });
    const register = () => {
      for (const session of [electron.session.defaultSession]) {
        session.registerPreloadScript({ type: 'frame', id: 'linux-compat-window-chrome', filePath: pageAdapter.preload });
      }
    };
    if (electron.app.isReady()) register(); else electron.app.once('ready', register);
  }

  return { BrowserWindow, lightsFor: (win) => lightsByWindow.get(win) };
}

module.exports = { createWindowChrome, macChrome, linuxOptions, TrafficLights, GROUP, BUTTON, CLEAR_GAP, CHANNEL, PAGE_CHANNEL };
