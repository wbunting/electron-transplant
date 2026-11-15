// Downloads of a pin's inputs (sources.cjs): the vendor DMG, the Linux Electron zip
// and npm prebuild tarballs. HTTPS only; vendor downloads (and every redirect) stay
// on the recipe's source.hosts. Each file is written as <name>.partial, verified
// against its pinned SHA-256 and only then renamed, so a file under its final name
// is always a verified one. Nothing downloaded is executed.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { hashFile } = require('./util.cjs');
const { pinSource } = require('./sources.cjs');

const MAX_REDIRECTS = 5;

function cacheRoot() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-transplant');
}

// Default home of a fetched DMG: downloads/<app>/<sha256>/<vendor file name>.
function downloadsDir(appId) {
  return path.join(cacheRoot(), 'downloads', appId);
}

function checkUrl(url, hosts) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw Error(`Refusing a non-HTTPS download: ${url}`);
  if (hosts && !hosts.includes(parsed.hostname)) throw Error(`Refusing ${parsed.hostname}: not one of this app's download hosts (${hosts.join(', ')})`);
  return parsed;
}

// Downloads url to dest unless dest already holds the file. hosts: allowed host
// names (null: any HTTPS host, for hash-pinned public archives such as Electron's).
async function fetchFile(url, dest, { sha256, hosts = null, mismatch = '', fetch: fetchImpl = fetch, log = () => {} }) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw Error(`No pinned sha256 for ${url}`);
  if (fs.existsSync(dest)) {
    const actual = await hashFile(dest);
    if (actual === sha256) {
      log(`already there: ${dest}`);
      return { path: dest, downloaded: false };
    }
    throw Error(`${dest} exists but is not the pinned file (sha256 ${actual}); not overwriting it`);
  }
  let current = url;
  let response;
  for (let hop = 0; ; hop++) {
    checkUrl(current, hosts);
    response = await fetchImpl(current, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (hop === MAX_REDIRECTS) throw Error(`Too many redirects: ${url}`);
    const location = response.headers.get('location');
    if (!location) throw Error(`Redirect without a location: ${current}`);
    current = new URL(location, current).href;
  }
  if (!response.ok) throw Error(`Download failed (${response.status}): ${current}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const partial = `${dest}.partial`;
  const hash = crypto.createHash('sha256');
  const tee = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body), tee, fs.createWriteStream(partial, { mode: 0o600 }));
    const actual = hash.digest('hex');
    if (actual !== sha256) throw Error(`${url} has sha256 ${actual}, but the pin is ${sha256}; deleted it.${mismatch ? ` ${mismatch}` : ''}`);
    fs.renameSync(partial, dest);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  log(`downloaded: ${dest}`);
  return { path: dest, downloaded: true };
}

// Fetches the pin's inputs. what: any of 'dmg', 'electron', 'npm'. dest: one
// directory for everything (as a package build's source directory), else the DMG
// goes to the download cache and the rest to the build cache, where `build` finds them.
async function fetchPin(config, pin, { what = ['dmg'], dest = null, fetch: fetchImpl, log = console.log } = {}) {
  const source = pinSource(config, pin);
  const results = {};
  const missing = [];
  const into = (fallback, file) => path.join(dest ? path.resolve(dest) : fallback, file);
  if (what.includes('electron')) {
    const { file, url, sha256 } = source.electron;
    results.electron = (await fetchFile(url, into(cacheRoot(), file), { sha256, fetch: fetchImpl, log })).path;
  }
  if (what.includes('npm')) {
    results.npm = [];
    for (const { file, url, sha256 } of source.npm) {
      results.npm.push((await fetchFile(url, into(path.join(cacheRoot(), 'npm'), file), { sha256, fetch: fetchImpl, log })).path);
    }
  }
  if (what.includes('dmg')) {
    const { file, url, sha256, versioned } = source.dmg;
    if (!url) {
      missing.push(`${config.name} ${pin.version}${pin.note ? ` (${pin.note})` : ''} has no download URL: get the macOS DMG from ${config.source?.page ?? 'the vendor'} (sha256 ${sha256})`);
    } else {
      const mismatch = versioned
        ? 'The vendor may have replaced the file at this URL; check the release before re-pinning.'
        : 'This URL serves the latest release, so the vendor has probably shipped a newer version: it needs pinning (CONTRIBUTING.md).';
      results.dmg = (await fetchFile(url, into(path.join(downloadsDir(config.id), sha256), file), { sha256, hosts: config.source.hosts, mismatch, fetch: fetchImpl, log })).path;
    }
  }
  return { results, missing };
}

// DMGs fetched into the download cache for an app (verified when they were fetched).
function cachedDmgs(appId) {
  const dir = downloadsDir(appId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((sha) => /^[0-9a-f]{64}$/.test(sha)).flatMap((sha) => (
    fs.readdirSync(path.join(dir, sha)).filter((name) => name.endsWith('.dmg')).map((name) => path.join(dir, sha, name))
  ));
}

module.exports = { fetchFile, fetchPin, cachedDmgs, downloadsDir, checkUrl };
