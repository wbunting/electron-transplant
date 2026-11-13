// Figma: a local tabbed shell (desktop_shell.js) around figma.com views, with a
// large esbuild main (main.js). Its main already has a Linux path: on
// process.platform === "linux" it never loads bindings.node or desktop_rust.node
// (JS no-ops instead), skips the updater and the bundled font agent, and parses
// argv for URLs. What it lacks is local fonts (an empty list) and a few desktop
// details; see NATIVE.md for the survey and the reasoning behind each entry.
const MAIN = 'main.js';
const WORKER = 'bindings_worker.js';
const FONTS = './linux-figma/fonts.cjs';

module.exports = {
  id: 'figma',
  name: 'Figma',
  bundleId: 'com.figma.Desktop',
  // FIGMA_ is Figma's own (FIGMA_TEST, FIGMA_APP_URL, ...).
  envPrefix: 'FIGMA_DESKTOP',
  // Its own directory: the download is untrusted data, kept apart.
  dmg: { dir: 'figma-desktop-mac', glob: 'Figma-*.dmg', app: 'Figma.app' },
  pins: [
    // https://desktop.figma.com/mac/Figma.dmg (Intel; the JS is the same in every build).
    { sha256: 'e908f72f585ab9f6338bb677ab66e40b508e34889112f1b51ff4f54a48f70ee9', version: '126.11.9', electron: '44.11.2', note: 'x86_64' },
  ],
  install: {
    // figma-linux-next is installed as "Figma" (figma-linux-next.desktop) and stays
    // the user's daily Figma and figma:// handler.
    id: 'figma-desktop',
    command: 'figma-desktop',
    name: 'Figma Desktop',
    comment: 'Figma — unofficial Linux port of the macOS desktop app',
    categories: 'Graphics;2DGraphics;VectorGraphics;',
    defaultHandler: false,
    actions: [
      { id: 'FinishSignIn', name: 'Finish browser sign-in (copy the figma:// link first)', args: ['--finish-sign-in'] },
    ],
  },
  asar: {
    // A placeholder header entry (size -1000, no data) that @electron/asar rejects.
    dropInvalidEntries: ['.codesign'],
  },
  natives: {
    // chokidar only requires it on darwin (in try/catch); its fsevents.js throws
    // off macOS before loading the addon.
    fsevents: { action: 'remove', paths: ['fsevents.node'] },
  },
  nativeFiles: {
    'bindings.node': { action: 'remove', reason: 'main.js uses its own JS no-op object on Linux (DC ? Qtt() : require("./bindings.node"))' },
    'desktop_rust.node': { action: 'remove', reason: 'fonts: main.js and bindings_worker.js load linux-figma/fonts.cjs instead (patches below)' },
  },
  addFiles: {
    'linux-figma/fonts.cjs': 'linux/fonts.cjs',
    'linux-figma/sfnt.cjs': 'linux/sfnt.cjs',
    'linux-figma/hooks.cjs': 'linux/hooks.cjs',
  },
  compat: {
    hooks: ['linux-figma/hooks.cjs'],
    // Figma calls setAsDefaultProtocolClient("figma") at every start; on Linux
    // that is `xdg-settings set default-url-scheme-handler`, which would take
    // figma:// from figma-linux-next.
    defaultProtocolClient: false,
  },
  // Figma's own window buttons, no emulated traffic lights (checked by ET_SMOKE=1).
  smoke: { trafficLights: false },
  patches: [
    {
      // The font utility process: fontconfig instead of an empty list.
      name: 'fonts-worker-linux',
      file: WORKER,
      from: 'if(process.platform==="linux")return{getFonts:()=>"{}",getFontsModifiedAt:()=>null,getModifiedFonts:()=>"{}"};',
      to: `if(process.platform==="linux")return require(${JSON.stringify(FONTS)});`,
    },
    {
      // Ask the utility process on Linux too (DC short-circuits to "no fonts").
      name: 'fonts-utility-process-on-linux',
      file: MAIN,
      from: 'async function RC(t){if(DC)return t==="getFonts"||t==="getModifiedFonts"?{}:null;',
      to: 'async function RC(t){if(DC&&process.platform!=="linux")return t==="getFonts"||t==="getModifiedFonts"?{}:null;',
    },
    {
      // In-process fallback (if the utility process fails) and getFontPreview.
      name: 'fonts-direct-linux',
      file: MAIN,
      from: 'var AC=si(()=>DC?Xtt():',
      to: `var AC=si(()=>process.platform==="linux"?require(${JSON.stringify(FONTS)}):DC?Xtt():`,
    },
    {
      // Main windows are frameless with Figma's own window buttons in the tab bar
      // (its non-macOS layout). Hyprland floats frameless windows, so keep a normal
      // frame on Linux (the compositor draws none); FIGMA_DESKTOP_FRAMELESS=1 opts out.
      // A framed window would also show Figma's application menu as a menu bar
      // (frameless Windows windows don't): auto-hide it, Alt shows it.
      name: 'main-window-frame-on-linux',
      file: MAIN,
      from: 'show:!1,frame:!1,titleBarStyle:"hidden",...se&&{trafficLightPosition:',
      to: 'show:!1,autoHideMenuBar:process.platform==="linux",frame:process.platform==="linux"&&process.env.FIGMA_DESKTOP_FRAMELESS!=="1",titleBarStyle:process.platform==="linux"&&process.env.FIGMA_DESKTOP_FRAMELESS!=="1"?void 0:"hidden",...se&&{trafficLightPosition:',
    },
    {
      // Figma's Linux argv parser treats a flag without "=" as taking the next
      // argument, so `figma-desktop -- figma://...` (the desktop entry's Exec)
      // lost the URL. "--" now ends the flags.
      name: 'argv-double-dash',
      file: MAIN,
      from: 'if(s&&o.startsWith("-")){!o.includes("=")&&n+1<r.length&&!r[n+1].startsWith("-")&&n++;continue}',
      to: 'if(s&&o==="--"){i.push(...r.slice(n+1));break}if(s&&o.startsWith("-")){!o.includes("=")&&n+1<r.length&&!r[n+1].startsWith("-")&&n++;continue}',
    },
  ],
};
