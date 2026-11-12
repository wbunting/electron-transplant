// Exact-match source patches for minified app bundles. A patch must match exactly
// `count` times (default 1), so a changed bundle fails the build instead of
// shipping half-patched; already-patched text is reported, not patched twice.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const occurrences = (text, needle) => text.split(needle).length - 1;

function applyPatch(appDir, { name, file, from, to, count = 1 }) {
  const target = path.resolve(appDir, file);
  if (!target.startsWith(path.resolve(appDir) + path.sep)) throw Error(`Patch ${name}: file outside app: ${file}`);
  const source = fs.readFileSync(target, 'utf8');
  if (!to.includes(from) && occurrences(source, to) === count && occurrences(source, from) === 0) return 'already';
  const found = occurrences(source, from);
  if (found !== count) throw Error(`Patch ${name}: expected ${count} match(es) in ${file}, found ${found}`);
  fs.writeFileSync(target, source.split(from).join(to));
  return 'applied';
}

function applyPatches(appDir, patches = []) {
  return patches.map((patch) => [patch.name, applyPatch(appDir, patch)]);
}

module.exports = { applyPatch, applyPatches };
