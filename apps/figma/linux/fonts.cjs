// Local fonts for Figma on Linux. On macOS, Figma lists fonts with its Rust addon
// (desktop_rust.node, CoreText); on Linux its main.js substitutes an empty list.
// This module has the same interface (getFonts / getFontsModifiedAt /
// getModifiedFonts / getFontPreview, JSON strings like the addon), built from
// fontconfig, and is loaded by patches in main.js and bindings_worker.js (which
// runs it in Figma's font utility process, as on macOS).
//
// Shape (from the addon's FontInfo / FontVariationAxisInfo structs):
//   { "/path/font.ttf": [{ family, style, postscript, weight, stretch, italic,
//       variationAxes: [{ tag, name, value, min, max, default, hidden }],
//       modified_at, user_installed }] }
// Figma serves a listed file's bytes itself (getFontFileToken / desktop-file:),
// and only for paths in this list.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readVariationInfo } = require('./sfnt.cjs');

const FIELDS = ['file', 'index', 'family[0]', 'style[0]', 'postscriptname', 'weight', 'slant', 'width', 'variable', 'fontformat'];
const FORMAT = FIELDS.map((f) => `%{${f}}`).join('\t') + '\n';
// Outline formats Figma can render; bitmap (PCF/BDF) and Type 1 fonts are skipped.
const FORMATS = new Set(['TrueType', 'CFF']);

// fontconfig weight -> OpenType usWeightClass (fontconfig's own piecewise-linear map).
const WEIGHTS = [[0, 100], [40, 200], [50, 300], [55, 350], [75, 380], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900], [215, 1000]];
function openTypeWeight(fc) {
  if (!Number.isFinite(fc)) return 400;
  if (fc <= 0) return 100;
  for (let i = 1; i < WEIGHTS.length; i++) {
    const [fc1, ot1] = WEIGHTS[i];
    if (fc <= fc1) {
      const [fc0, ot0] = WEIGHTS[i - 1];
      return Math.round(ot0 + ((fc - fc0) * (ot1 - ot0)) / (fc1 - fc0));
    }
  }
  return 1000;
}

// fontconfig width (percent) -> usWidthClass 1..9 (5 = normal).
const WIDTHS = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
function stretchClass(fc) {
  if (!Number.isFinite(fc)) return 5;
  let best = 5;
  let distance = Infinity;
  WIDTHS.forEach((width, i) => {
    if (Math.abs(width - fc) < distance) { distance = Math.abs(width - fc); best = i + 1; }
  });
  return best;
}

function userFontDirs(env = process.env, home = os.homedir()) {
  const data = env.XDG_DATA_HOME || path.join(home, '.local/share');
  return [path.join(data, 'fonts'), path.join(home, '.fonts')].map((dir) => dir + path.sep);
}

// fc-list rows -> [{file, face, instance, family, style, postscript, weight, slant, width, variable}]
function parseFcList(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length !== FIELDS.length) continue;
    const [file, index, family, style, postscript, weight, slant, width, variable, format] = parts;
    if (!path.isAbsolute(file) || !family || !FORMATS.has(format)) continue;
    const rawIndex = Number(index) || 0;
    rows.push({
      file,
      face: rawIndex & 0xffff,
      // fontconfig numbers a variable font's named instances from 1 in the high bits.
      instance: (rawIndex >>> 16) - 1,
      family,
      style: style || 'Regular',
      postscript,
      weight: Number(weight),
      slant: Number(slant),
      width: Number(width),
      // The whole-font row of a variable font carries ranges ("[0 210]").
      variableRange: variable === 'True' || weight.startsWith('['),
    });
  }
  return rows;
}

function axesAt(variation, coords) {
  return variation.axes.map((axis) => ({
    tag: axis.tag,
    name: axis.name,
    value: coords?.[axis.tag] ?? axis.default,
    min: axis.min,
    max: axis.max,
    default: axis.default,
    hidden: axis.hidden,
  }));
}

// Builds the font map from fc-list rows. `stat` and `variationOf` are injectable for tests.
function buildFontMap(rows, { userDirs = userFontDirs(), stat = fs.statSync, variationOf = readVariationInfo, log = () => {} } = {}) {
  const fonts = {};
  const variations = new Map();
  const variation = (row) => {
    const key = `${row.file}\0${row.face}`;
    if (!variations.has(key)) {
      let info = null;
      try { info = variationOf(row.file, row.face); } catch (error) { log(`fonts: no variation data for a font: ${error.message}`); }
      variations.set(key, info);
    }
    return variations.get(key);
  };
  const seen = new Set();
  // Variable fonts with no named instances still need one (default) entry.
  const rangeOnly = [];
  for (const row of rows) {
    if (row.variableRange) { rangeOnly.push(row); continue; }
    let modified;
    try { modified = Math.floor(stat(row.file).mtimeMs / 1000); } catch { continue; }
    const info = row.instance >= 0 ? variation(row) : null;
    const instance = info?.instances[row.instance];
    const entry = {
      family: row.family,
      style: row.style,
      postscript: instance?.postscript || row.postscript || `${row.family}-${row.style}`.replace(/\s+/g, ''),
      weight: openTypeWeight(row.weight),
      stretch: stretchClass(row.width),
      italic: row.slant > 0,
      variationAxes: info ? axesAt(info, instance?.coords) : [],
      modified_at: modified,
      user_installed: userDirs.some((dir) => row.file.startsWith(dir)),
    };
    const key = `${row.file}\0${entry.postscript}\0${entry.style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (fonts[row.file] ??= []).push(entry);
  }
  for (const row of rangeOnly) {
    if (fonts[row.file]) continue;
    const info = variation(row);
    if (!info) continue;
    let modified;
    try { modified = Math.floor(stat(row.file).mtimeMs / 1000); } catch { continue; }
    fonts[row.file] = [{
      family: row.family,
      style: 'Regular',
      postscript: row.postscript || row.family.replace(/\s+/g, ''),
      weight: 400,
      stretch: 5,
      italic: row.slant > 0,
      variationAxes: axesAt(info, null),
      modified_at: modified,
      user_installed: userDirs.some((dir) => row.file.startsWith(dir)),
    }];
  }
  return fonts;
}

function listFonts() {
  const text = execFileSync('fc-list', ['--format', FORMAT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  return buildFontMap(parseFcList(text));
}

// Font directories seen in the last scan; their mtimes change when fonts are added or removed.
let lastFonts = null;
let lastScanAt = 0;

function scan() {
  const started = Date.now();
  lastFonts = listFonts();
  lastScanAt = Math.floor(started / 1000);
  // Evidence in the launcher log that fonts reached Figma (counts only, no paths).
  const faces = Object.values(lastFonts).reduce((n, entries) => n + entries.length, 0);
  console.log(`figma-desktop fonts: ${Object.keys(lastFonts).length} files, ${faces} faces from fontconfig in ${Date.now() - started} ms (${process.type === 'utility' ? 'font worker' : 'main process'})`);
  return lastFonts;
}

// Failures: recorded when running in the main process (the compat recorder lives
// there), always logged. In Figma's font worker a throw ends the worker, which the
// recorder sees as child-process-gone; Figma then retries in the main process.
function reported(name, fn) {
  return function (...args) {
    try {
      return fn.apply(this, args);
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0].split(os.homedir()).join('~').slice(0, 240);
      console.error(`figma-desktop fonts: ${name} failed: ${message}`);
      globalThis[Symbol.for('electron-transplant.recorder')]?.record({ kind: 'linux-impl-error', api: `figma fonts.${name}`, error: message }, error?.stack);
      throw error;
    }
  };
}

function fontDirs() {
  const dirs = new Set(userFontDirs().map((dir) => dir.slice(0, -1)));
  for (const file of Object.keys(lastFonts ?? {})) dirs.add(path.dirname(file));
  return dirs;
}

module.exports = {
  getFonts: reported('getFonts', () => JSON.stringify(scan())),
  // Latest change to any font directory (seconds), so Figma knows when to ask
  // for getModifiedFonts. Stable while fonts don't change (not the scan time,
  // which would make every poll look like a change).
  getFontsModifiedAt: reported('getFontsModifiedAt', () => {
    if (!lastFonts) scan();
    let latest = 0;
    for (const dir of fontDirs()) {
      try { latest = Math.max(latest, Math.floor(fs.statSync(dir).mtimeMs / 1000)); } catch {}
    }
    return latest;
  }),
  // Fonts added or changed since the previous scan.
  getModifiedFonts: reported('getModifiedFonts', () => {
    const since = lastScanAt;
    const fonts = scan();
    const changed = {};
    for (const [file, entries] of Object.entries(fonts)) {
      if (entries.some((entry) => entry.modified_at >= since)) changed[file] = entries;
    }
    return JSON.stringify(changed);
  }),
  // On macOS this renders an SVG sample with the bundled figma_agent; Figma's own
  // Linux stub returns "" too, and the font menu then shows plain names.
  getFontPreview() {
    return '';
  },
  getMacOsGpuData: async () => ({ gpuUsagePercent: 0, ramTotal: 0, ramUsage: 0 }),
  // For tests.
  parseFcList,
  buildFontMap,
  openTypeWeight,
  stretchClass,
  userFontDirs,
};
