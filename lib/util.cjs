'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = path.resolve(__dirname, '..');

function cacheDir(...parts) {
  const dir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-transplant', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function hashFile(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = crypto.createHash(algorithm);
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest(encoding);
}

// Downloads to dest via a .partial file; an existing dest is reused as is (callers verify).
async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw Error(`Download failed (${response.status}): ${url}`);
  const partial = `${dest}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  fs.renameSync(partial, dest);
  return dest;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw Error(`Fetch failed (${response.status}): ${url}`);
  return response.text();
}

// Verifies file against a hex sha256 or an npm-style "sha512-<base64>" integrity.
async function verify(file, expected) {
  const [algorithm, encoding, value] = expected.startsWith('sha512-')
    ? ['sha512', 'base64', expected.slice(7)]
    : ['sha256', 'hex', expected];
  const actual = await hashFile(file, algorithm, encoding);
  if (actual !== value) {
    throw Error(`Checksum mismatch for ${file}: expected ${expected}, got ${algorithm === 'sha512' ? 'sha512-' : ''}${actual}. Delete it and retry.`);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

// Clears group and other write permission under dir (dir included). Archives can
// store any mode: Electron 45.1.0's official zip has 0666 and 0777 files, which
// unzip restores as they are. Symlinks are left alone (their mode is unused).
function dropSharedWrite(dir) {
  const fix = (file, stat) => { if (stat.mode & 0o022) fs.chmodSync(file, stat.mode & 0o7755); };
  fix(dir, fs.lstatSync(dir));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) dropSharedWrite(full);
    else if (!entry.isSymbolicLink()) fix(full, fs.lstatSync(full));
  }
}

module.exports = { ROOT, cacheDir, hashFile, download, fetchText, verify, run, walk, dropSharedWrite };
