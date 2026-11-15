// Every input a build needs, per app and pin, as data: the vendor DMG (URL and
// pinned SHA-256), the Linux Electron zip and any npm prebuild tarballs. Derived
// from apps/*/app.cjs (pins, source) and pins/electron.json; sources.json at the
// repository root is this, committed, for packagers that read JSON without Node
// (Nix: builtins.fromJSON). npm test fails when it drifts; `npm run sources`
// regenerates it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./util.cjs');
const { listApps, loadApp } = require('./apps.cjs');
const { pins: electronPins, RELEASES } = require('./electron.cjs');

const SCHEMA = 1;
const SOURCES_FILE = path.join(ROOT, 'sources.json');

// source.dmg is a URL template, or one per pin note (e.g. universal, x86_64).
function dmgTemplate(config, pin) {
  const dmg = config.source?.dmg;
  return (typeof dmg === 'string' ? dmg : dmg?.[pin.note]) ?? null;
}

// The pin's DMG URL, or null (then source.page says where to get it).
function dmgUrl(config, pin) {
  return dmgTemplate(config, pin)?.replaceAll('{version}', pin.version) ?? null;
}

const fileName = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop());

function electronSource(version) {
  const file = `electron-v${version}-linux-x64.zip`;
  const sha256 = electronPins()[version]?.[file];
  if (!sha256) throw Error(`Electron ${version} ${file} is not in pins/electron.json`);
  return { version, file, url: `${RELEASES}/v${version}/${file}`, sha256 };
}

function npmSources(config) {
  return Object.values(config.natives ?? {}).filter((spec) => spec.action === 'npm-prebuild').map((spec) => {
    const base = spec.package.replace(/^@[^/]+\//, '');
    return {
      package: spec.package,
      version: spec.version,
      // As natives.cjs caches it.
      file: `${spec.package.replace('/', '+')}-${spec.version}.tgz`,
      url: `https://registry.npmjs.org/${spec.package}/-/${base}-${spec.version}.tgz`,
      sha256: spec.sha256,
      integrity: spec.integrity,
    };
  });
}

function pinSource(config, pin) {
  const url = dmgUrl(config, pin);
  return {
    version: pin.version,
    variant: pin.note ?? null,
    dmg: {
      file: url ? fileName(url) : null,
      sha256: pin.sha256,
      url,
      // false: the URL serves whatever is latest, so a hash mismatch means a new release.
      versioned: url ? dmgTemplate(config, pin).includes('{version}') : null,
      retention: url ? config.source.retention : null,
    },
    electron: electronSource(pin.electron),
    npm: npmSources(config),
  };
}

function appSource(config) {
  const { install } = config;
  return {
    name: config.name,
    bundleId: config.bundleId,
    installId: install.id,
    command: install.command,
    displayName: install.name ?? config.name,
    comment: install.comment ?? `${config.name} — unofficial Linux port of the macOS app`,
    helpers: (install.helpers ?? []).map((helper) => helper.command),
    downloadPage: config.source?.page ?? null,
    feed: config.source?.feed ?? null,
    pins: (config.pins ?? []).map((pin) => pinSource(config, pin)),
  };
}

function sources(ids = listApps()) {
  return {
    schema: SCHEMA,
    generated: 'by `electron-transplant sources --write` from apps/*/app.cjs and pins/electron.json; do not edit',
    apps: Object.fromEntries(ids.map((id) => [id, appSource(loadApp(id).config)])),
  };
}

const render = (value) => JSON.stringify(value, null, 2) + '\n';

// The pin to fetch or build: the first listed for the version (default: the first pin).
function selectPin(config, { version, variant } = {}) {
  const pins = (config.pins ?? []).filter((p) => (!version || p.version === version) && (!variant || p.note === variant));
  if (!pins.length) {
    const known = (config.pins ?? []).map((p) => `${p.version}${p.note ? ` (${p.note})` : ''}`).join(', ');
    throw Error(`${config.name}: no pin for ${[version, variant].filter(Boolean).join(' ') || 'any version'}; pinned: ${known || 'none'}`);
  }
  return pins[0];
}

// A package build's inputs found by their pinned file names in one directory (a
// PKGBUILD's $srcdir, a Nix linkFarm): the first pin whose DMG is there.
function inputsIn(config, dir) {
  const has = (file) => file && fs.existsSync(path.join(dir, file));
  const pin = (config.pins ?? []).map((p) => pinSource(config, p)).find((p) => has(p.dmg.file));
  if (!pin) return {};
  return {
    dmg: path.join(dir, pin.dmg.file),
    electronZip: has(pin.electron.file) ? path.join(dir, pin.electron.file) : undefined,
    npmTarballs: pin.npm.filter((n) => has(n.file)).map((n) => path.join(dir, n.file)),
  };
}

module.exports = { SCHEMA, inputsIn, SOURCES_FILE, sources, appSource, pinSource, electronSource, npmSources, dmgUrl, selectPin, render };
