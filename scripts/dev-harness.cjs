// DEV ONLY: loaded by a throwaway copy of a built app (scripts/dev-snapshot.cjs),
// never installed. Runs a JSON script of steps against the app's main window under
// Electron's headless platform and writes composited snapshots, so layout can be
// checked without putting a window on anyone's desktop.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LIGHTS = 'traffic-lights.html';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = (electron) => {
  const script = JSON.parse(fs.readFileSync(process.env.ET_DEV_SCRIPT, 'utf8'));
  const outDir = path.dirname(process.env.ET_DEV_SCRIPT);
  const log = (...args) => fs.appendFileSync(path.join(outDir, 'harness.log'), args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');

  const mainWindow = () => electron.BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && w.isVisible())
    .sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0];

  // Views bottom to top: the window's own contents, then contentView children.
  function views(win) {
    const { width, height } = win.getContentBounds();
    const list = [{ contents: win.webContents, bounds: { x: 0, y: 0, width, height }, name: 'window' }];
    for (const view of win.contentView.children) {
      if (!view.webContents || view.webContents === win.webContents || view.webContents.isDestroyed()) continue;
      if (typeof view.getVisible === 'function' && !view.getVisible()) continue;
      const url = view.webContents.getURL();
      list.push({ contents: view.webContents, bounds: view.getBounds(), name: url.endsWith(LIGHTS) ? 'lights' : url.split('?')[0].slice(-60) });
    }
    return list;
  }

  async function snapshot(win, file) {
    const scale = Number(process.env.ET_DEV_SCALE || 1);
    const { width, height } = win.getContentBounds();
    const W = Math.round(width * scale), H = Math.round(height * scale);
    const canvas = Buffer.alloc(W * H * 4);
    const layers = [];
    for (const layer of views(win)) {
      const image = await layer.contents.capturePage();
      const bitmap = image.toBitmap();
      if (!bitmap.length) continue;
      // Bitmaps are in device pixels; getSize() may report either unit.
      let pw = Math.round(layer.bounds.width * scale);
      if (!Number.isInteger(bitmap.length / 4 / pw)) pw = image.getSize().width;
      const ph = bitmap.length / 4 / pw;
      const ox = Math.round(layer.bounds.x * scale), oy = Math.round(layer.bounds.y * scale);
      for (let y = 0; y < ph; y++) {
        const cy = oy + y;
        if (cy < 0 || cy >= H) continue;
        for (let x = 0; x < pw; x++) {
          const cx = ox + x;
          if (cx < 0 || cx >= W) continue;
          const src = (y * pw + x) * 4, dst = (cy * W + cx) * 4;
          const alpha = bitmap[src + 3] / 255;
          // Premultiplied BGRA, source over.
          for (let c = 0; c < 3; c++) canvas[dst + c] = Math.min(255, Math.round(bitmap[src + c] + canvas[dst + c] * (1 - alpha)));
          canvas[dst + 3] = 255;
        }
      }
      layers.push([layer.name, layer.bounds]);
    }
    fs.writeFileSync(path.join(outDir, file), electron.nativeImage.createFromBitmap(canvas, { width: W, height: H }).toPNG());
    log('snapshot', file, { width: W, height: H, layers });
  }

  // Topmost view under a window point, and the point in its coordinates.
  function hit(win, x, y) {
    const list = views(win).reverse();
    const layer = list.find(({ bounds: b }) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height);
    return layer && { contents: layer.contents, x: x - layer.bounds.x, y: y - layer.bounds.y, name: layer.name };
  }

  async function step(win, s) {
    if (s.wait) await sleep(s.wait);
    if (s.bounds) { win.setBounds({ x: 0, y: 0, width: s.bounds[0], height: s.bounds[1] }); await sleep(600); }
    if (s.fullscreen !== undefined) { win.setFullScreen(s.fullscreen); await sleep(1200); }
    if (s.focus) { win.focus(); await sleep(300); }
    if (s.blur) { win.blur(); await sleep(300); }
    if (s.hover || s.click) {
      const [x, y] = s.hover ?? s.click;
      const target = hit(win, x, y);
      if (!target) { log('no view at', [x, y]); return; }
      target.contents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
      if (s.click) {
        target.contents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        target.contents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
      }
      log(s.click ? 'click' : 'hover', [x, y], 'on', target.name);
      await sleep(s.settle ?? 800);
    }
    if (s.eval) {
      // "in": the view whose URL contains this text (for views under a transparent overlay).
      const target = s.in ? views(win).find((v) => v.contents.getURL().includes(s.in)) : s.at ? hit(win, ...s.at) : { contents: views(win).at(-1).contents };
      if (!target) { log('no view matching', s.in); return; }
      log('eval', await target.contents.executeJavaScript(s.eval).catch((e) => `error: ${e.message}`));
    }
    if (s.main) {
      // Main-process code (an async function body) given electron, win and views.
      const AsyncFunction = (async () => {}).constructor;
      log('main', await new AsyncFunction('electron', 'win', 'views', s.main)(electron, win, views).catch((e) => `error: ${e.message}`));
    }
    if (s.state) {
      log('state', { bounds: win.getContentBounds(), fullScreen: win.isFullScreen(), focused: win.isFocused(), views: views(win).map((v) => [v.name, v.bounds]) });
    }
    if (s.snapshot) await snapshot(win, s.snapshot);
  }

  electron.app.whenReady().then(async () => {
    let win;
    for (let i = 0; i < 120 && !(win = mainWindow()); i++) await sleep(500);
    if (!win) { log('no window'); electron.app.exit(2); return; }
    for (const s of script) {
      try { await step(win, s); } catch (error) { log('step failed', s, error.stack); }
    }
    log('done');
    // Quit the way a user would; app.exit() skips close events, which some apps'
    // listeners don't expect (Linear throws "Object has been destroyed").
    setTimeout(() => electron.app.exit(0), 8000);
    electron.app.quit();
  });
};
