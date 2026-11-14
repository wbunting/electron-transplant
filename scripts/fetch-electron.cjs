#!/usr/bin/env node
// Downloads and verifies every pinned Linux Electron build and its typings into the
// cache (~/.cache/electron-transplant), so the real-Electron tests run instead of
// skipping. Pinned hashes only (pins/electron.json); nothing unpinned is fetched.
//   scripts/fetch-electron.cjs [VERSION...]   (default: every pinned version)
'use strict';
const path = require('node:path');
const { cacheDir, download, verify } = require('../lib/util.cjs');
const { electronZip, pins } = require('../lib/electron.cjs');

const RELEASES = 'https://github.com/electron/electron/releases/download';

async function main(versions) {
  const pinned = pins();
  for (const version of versions.length ? versions : Object.keys(pinned)) {
    if (!pinned[version]) throw Error(`Electron ${version} is not in pins/electron.json`);
    const options = { acceptUnpinned: false, log: console.log };
    await electronZip(version, options);
    const dts = path.join(cacheDir(), `electron-v${version}.d.ts`);
    await download(`${RELEASES}/v${version}/electron.d.ts`, dts);
    await verify(dts, pinned[version]['electron.d.ts']);
    console.log(`Electron ${version}: verified`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
