// Reads macOS .app bundles out of DMGs with 7-Zip (UDIF + HFS+), without mounting
// or executing anything. Volume names vary ("Linear", "Notion Installer"), so the
// app is located by listing the image.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, cacheDir, run } = require('./util.cjs');

function find7zip() {
  if (process.env.SEVENZIP) return process.env.SEVENZIP;
  for (const name of ['7zz', '7z']) {
    try {
      return run('sh', ['-c', `command -v ${name}`]).trim();
    } catch {}
  }
  const tools = cacheDir('tools');
  const cached = fs.readdirSync(tools).filter((d) => d.startsWith('7zip-')).sort().reverse()
    .map((d) => path.join(tools, d, 'usr/lib/7zip/7z')).find((file) => fs.existsSync(file));
  if (cached) return cached;
  // Downloads Arch's 7zip package and verifies it with pacman-key (no sudo).
  return run('bash', [path.join(ROOT, 'scripts/fetch-7zip.sh')], { stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function listPaths(sevenZip, dmg) {
  const out = run(sevenZip, ['l', '-slt', '-ba', dmg]);
  return out.split('\n').filter((line) => line.startsWith('Path = ')).map((line) => line.slice(7));
}

// The bundle's Contents/ prefix inside the image, e.g. "Notion Installer/Notion.app/Contents/".
// Nested helper apps share the suffix, so take the shortest match.
function findApp(paths, appName) {
  const suffix = `${appName}/Contents/Info.plist`;
  const matches = paths.filter((p) => p === suffix || p.endsWith(`/${suffix}`)).sort((a, b) => a.length - b.length);
  if (!matches.length) throw Error(`No ${appName} found in the DMG`);
  return matches[0].slice(0, -'Info.plist'.length);
}

function extractApp(sevenZip, dmg, outDir, contents) {
  // HFS+ extended attributes (code signatures, quarantine) would come out as
  // "file:com.apple.*" files; exclude them.
  run(sevenZip, ['x', '-y', dmg, `-o${outDir}`, '-r', '-x!*:com.apple.*',
    `${contents}Info.plist`,
    `${contents}Resources/*`,
    `${contents}Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist`,
  ]);
  const dir = path.join(outDir, contents);
  if (!fs.existsSync(path.join(dir, 'Resources/app.asar'))) throw Error('No Resources/app.asar extracted; is this an Electron app?');
  return dir;
}

module.exports = { find7zip, listPaths, findApp, extractApp };
