// Official Linux Electron builds and per-version platform-API tables. Hashes come
// from pins/electron.json; an unpinned version is accepted only on request, using
// the release's SHASUMS256.txt, and the hashes to pin are printed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, cacheDir, download, fetchText, hashFile, verify } = require('./util.cjs');
const { generateTable, tableStats } = require('./platform-apis.cjs');

const RELEASES = 'https://github.com/electron/electron/releases/download';

function pins() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'pins/electron.json'), 'utf8'));
}

async function releaseHash(version, file, { acceptUnpinned, log }) {
  const pinned = pins()[version]?.[file];
  if (pinned) return pinned;
  if (!acceptUnpinned) throw Error(`Electron ${version} ${file} is not in pins/electron.json; re-run with --accept-unpinned`);
  const sums = await fetchText(`${RELEASES}/v${version}/SHASUMS256.txt`);
  const line = sums.split('\n').find((l) => l.trim().endsWith(` *${file}`));
  if (!line) throw Error(`No ${file} in Electron ${version} SHASUMS256.txt`);
  const hash = line.split(' ')[0];
  log(`UNPINNED: Electron ${version} ${file} sha256 ${hash} (from SHASUMS256.txt; add to pins/electron.json)`);
  return hash;
}

const zipName = (version) => `electron-v${version}-linux-x64.zip`;

// The verified zip: options.zip if given (never downloaded), else the cached one.
// options.offline: pinned hashes only, nothing fetched.
async function electronZip(version, options) {
  const file = zipName(version);
  if (options.offline && !pins()[version]?.[file]) throw Error(`Electron ${version} is not in pins/electron.json; an offline build needs a pinned Electron`);
  const hash = await releaseHash(version, file, options);
  if (options.zip) {
    if (!fs.existsSync(options.zip)) throw Error(`Electron zip not found: ${options.zip}`);
    const actual = await hashFile(options.zip);
    if (actual !== hash) throw Error(`${options.zip} is not the pinned ${file}: sha256 ${actual}, expected ${hash}`);
    return path.resolve(options.zip);
  }
  if (options.offline) throw Error(`Offline build: pass --electron-zip PATH (${file}, sha256 ${hash})`);
  const dest = path.join(cacheDir(), file);
  await download(`${RELEASES}/v${version}/${file}`, dest);
  await verify(dest, hash);
  return dest;
}

// compat/platform-apis/electron-<version>.json, generated from the verified typings if missing.
async function platformApis(version, options) {
  const bundled = path.join(ROOT, 'compat/platform-apis', `electron-${version}.json`);
  if (fs.existsSync(bundled)) return bundled;
  if (options.offline) throw Error(`Offline build: no compat/platform-apis/electron-${version}.json in this checkout`);
  const generated = path.join(cacheDir('platform-apis'), `electron-${version}.json`);
  if (fs.existsSync(generated)) return generated;
  const dts = path.join(cacheDir(), `electron-v${version}.d.ts`);
  const hash = await releaseHash(version, 'electron.d.ts', options);
  await download(`${RELEASES}/v${version}/electron.d.ts`, dts);
  await verify(dts, hash);
  const table = generateTable(fs.readFileSync(dts, 'utf8'), version);
  fs.writeFileSync(generated, JSON.stringify(table, null, 1) + '\n');
  const stats = tableStats(table);
  options.log(`Generated platform-API table for Electron ${version}: ${stats.members} non-Linux members, ${stats.exports} main exports`);
  return generated;
}

module.exports = { electronZip, platformApis, pins, zipName, RELEASES };
