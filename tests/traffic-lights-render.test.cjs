// Renders the traffic-light overlay in real Electron at 1x, 1.5x and 2x and
// measures it: each glyph must be centred on its circle, and each circle's centre
// must sit on a device-pixel boundary so its edge renders symmetrically.
// TRAFFIC_LIGHTS_CAPTURE_DIR=dir keeps the captures; TRAFFIC_LIGHTS_HTML=file
// measures another version of the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ELECTRON = '44.9.1';
const zip = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-transplant', `electron-v${ELECTRON}-linux-x64.zip`);
const compat = path.join(__dirname, '..', 'compat');
const SCALES = [1, 1.5, 2];

const PROBE_MAIN = `
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const BG = { r: 9, g: 9, b: 9 };
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (error) => { console.error('PROBE ERROR', error?.stack ?? error); app.exit(1); });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 200, height: 80, backgroundColor: '#090909', webPreferences: { preload: path.join(__dirname, 'traffic-lights-preload.cjs'), sandbox: true } });
  // Too small a window has no surface to capture; only the top-left 54x16 is measured.
  win.setBounds({ x: 0, y: 0, width: 200, height: 80 });
  await win.loadFile(process.env.LIGHTS_HTML);
  await win.webContents.executeJavaScript("document.documentElement.style.background = '#090909'");
  win.webContents.send('linux-compat:traffic-lights:state', { focused: true, dark: true });
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  // Hover the group so the glyphs show.
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 27, y: 8 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage();
  const { width, height } = image.getSize();
  const scale = Number(process.env.SCALE);
  const bitmap = image.toBitmap();
  // getSize() may report device pixels or DIPs; trust whichever matches the bitmap.
  const pixelWidth = bitmap.length === width * height * 4 ? width : Math.round(width * scale);
  if (bitmap.length !== pixelWidth * Math.round(bitmap.length / 4 / pixelWidth) * 4) throw Error('unexpected bitmap size ' + bitmap.length + ' for ' + width + 'x' + height + '@' + scale);
  if (process.env.CAPTURE) fs.writeFileSync(process.env.CAPTURE, image.toPNG());
  const at = (x, y) => { const i = (y * pixelWidth + x) * 4; return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2] }; };
  const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  const buttons = [];
  for (let index = 0; index < 3; index++) {
    const x0 = Math.floor(index * 20 * scale), x1 = Math.ceil((index * 20 + 14) * scale);
    const y1 = Math.round(16 * scale);
    // The circle: weight every pixel by how far it is from the background.
    let w = 0, sx = 0, sy = 0;
    const fills = new Map();
    for (let y = 0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const c = at(x, y);
      const weight = Math.min(1, dist(c, BG) / 120);
      w += weight; sx += weight * (x + 0.5); sy += weight * (y + 0.5);
      if (weight === 1) { const key = c.r + ',' + c.g + ',' + c.b; fills.set(key, (fills.get(key) ?? 0) + 1); }
    }
    const circle = { x: sx / w, y: sy / w };
    // The fill is the most common saturated colour; the glyph is whatever is darker.
    const fill = [...fills].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
    const fillLum = 0.3 * fill[0] + 0.59 * fill[1] + 0.11 * fill[2];
    let gw = 0, gx = 0, gy = 0;
    const radius = 4.6 * scale;
    for (let y = 0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (Math.hypot(x + 0.5 - circle.x, y + 0.5 - circle.y) > radius) continue;
      const c = at(x, y);
      const lum = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
      const weight = Math.max(0, Math.min(1, (fillLum - lum) / (fillLum * 0.6)));
      gw += weight; gx += weight * (x + 0.5); gy += weight * (y + 0.5);
    }
    buttons.push({ circle, glyph: { x: gx / gw, y: gy / gw }, glyphWeight: gw });
  }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ buttons, width, height, pixelWidth }));
  app.quit();
});
`;

function measure(html, scale, dir) {
  const runtime = path.join(dir, 'runtime');
  const app = path.join(runtime, 'resources/app');
  if (!fs.existsSync(runtime)) {
    execFileSync('unzip', ['-q', zip, '-d', runtime]);
    fs.rmSync(path.join(runtime, 'resources/default_app.asar'));
    fs.mkdirSync(app, { recursive: true });
    fs.copyFileSync(path.join(compat, 'traffic-lights-preload.cjs'), path.join(app, 'traffic-lights-preload.cjs'));
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'lights-probe', main: 'main.js' }));
    fs.writeFileSync(path.join(app, 'main.js'), PROBE_MAIN);
  }
  const out = path.join(dir, `measure-${scale}.json`);
  const captureDir = process.env.TRAFFIC_LIGHTS_CAPTURE_DIR;
  const env = {
    ...process.env, LIGHTS_HTML: html, SCALE: String(scale), PROBE_OUT: out,
    CAPTURE: captureDir ? path.join(captureDir, `lights-${scale}x.png`) : '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(path.join(runtime, 'electron'), ['--ozone-platform=headless', `--force-device-scale-factor=${scale}`, `--user-data-dir=${path.join(dir, 'profile')}`], { env, timeout: 60000, stdio: ['ignore', 'ignore', process.env.TRAFFIC_LIGHTS_REPORT ? 'inherit' : 'ignore'] });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('glyphs are centred on circles that sit on the device-pixel grid', { skip: !fs.existsSync(zip) && `no cached ${zip}` }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-lights-render-'));
  const html = process.env.TRAFFIC_LIGHTS_HTML || path.join(compat, 'traffic-lights.html');
  try {
    const report = [];
    for (const scale of SCALES) {
      const { buttons } = measure(html, scale, dir);
      buttons.forEach(({ circle, glyph, glyphWeight }, index) => {
        const name = ['close', 'minimize', 'zoom'][index];
        const offset = { x: glyph.x - circle.x, y: glyph.y - circle.y };
        const grid = { x: Math.abs(circle.x - Math.round(circle.x)), y: Math.abs(circle.y - Math.round(circle.y)) };
        report.push({ scale, name, circle, offset, grid, glyphWeight });
      });
    }
    if (process.env.TRAFFIC_LIGHTS_REPORT) {
      for (const r of report) {
        console.log(`${r.scale}x ${r.name.padEnd(8)} circle (${r.circle.x.toFixed(2)}, ${r.circle.y.toFixed(2)})  glyph offset (${r.offset.x.toFixed(2)}, ${r.offset.y.toFixed(2)}) px  off-grid (${r.grid.x.toFixed(2)}, ${r.grid.y.toFixed(2)})`);
      }
    }
    for (const r of report) {
      const label = `${r.scale}x ${r.name}`;
      assert.ok(r.glyphWeight > 3, `${label}: no glyph rendered`);
      assert.ok(Math.abs(r.offset.x) < 0.12 && Math.abs(r.offset.y) < 0.12, `${label}: glyph off-centre by (${r.offset.x.toFixed(2)}, ${r.offset.y.toFixed(2)}) device px`);
      assert.ok(r.grid.x < 0.12 && r.grid.y < 0.12, `${label}: circle centre (${r.circle.x.toFixed(2)}, ${r.circle.y.toFixed(2)}) is between device pixels`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
