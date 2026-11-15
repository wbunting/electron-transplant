// sources.json (what packagers read) and the recipe `source` blocks it comes from.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sources, render, inputsIn, selectPin, SOURCES_FILE } = require('../lib/sources.cjs');
const { listApps, loadApp, validate } = require('../lib/apps.cjs');
const { pins: electronPins } = require('../lib/electron.cjs');

const CLI = path.join(__dirname, '../bin/electron-transplant');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `et-${name}-`));
const SHA = /^[0-9a-f]{64}$/;

test('sources.json is generated from the app configs and pins (npm run sources)', () => {
  assert.equal(fs.readFileSync(SOURCES_FILE, 'utf8'), render(sources()), 'sources.json is stale: run `npm run sources` and commit it');
});

test('every pin lists a verifiable HTTPS DMG, a pinned Linux Electron zip and its npm tarballs', () => {
  const doc = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  assert.equal(doc.schema, 1);
  assert.deepEqual(Object.keys(doc.apps), listApps());
  for (const [id, app] of Object.entries(doc.apps)) {
    const { config } = loadApp(id);
    assert.deepEqual([app.installId, app.command], [config.install.id, config.install.command]);
    assert.ok(app.pins.length, id);
    for (const pin of app.pins) {
      assert.match(pin.dmg.sha256, SHA);
      assert.ok(config.pins.some((p) => p.sha256 === pin.dmg.sha256));
      assert.match(pin.dmg.url, /^https:\/\/[^/]+\/.+\.dmg$/);
      assert.ok(config.source.hosts.includes(new URL(pin.dmg.url).hostname));
      assert.equal(pin.dmg.file, pin.dmg.url.split('/').pop());
      assert.ok(pin.dmg.url.includes(pin.version), `${id}: versioned URL`);
      assert.equal(pin.electron.sha256, electronPins()[pin.electron.version][pin.electron.file]);
      assert.equal(pin.electron.url, `https://github.com/electron/electron/releases/download/v${pin.electron.version}/${pin.electron.file}`);
      for (const npm of pin.npm) {
        assert.match(npm.sha256, SHA);
        assert.match(npm.integrity, /^sha512-/);
        assert.match(npm.url, /^https:\/\/registry\.npmjs\.org\//);
      }
    }
  }
  // Figma keeps only the current and previous release downloadable.
  assert.equal(doc.apps.figma.pins[0].dmg.retention, 'current-and-previous');
  assert.equal(doc.apps.linear.pins[0].dmg.url, 'https://releases.linear.app/Linear-1.32.8-universal.dmg');
  // Notion: one URL per variant.
  assert.deepEqual(doc.apps.notion.pins.map((p) => [p.variant, p.dmg.file]), [['universal', 'Notion-7.43.0-universal.dmg'], ['x86_64', 'Notion-7.43.0.dmg']]);
  assert.equal(doc.apps.notion.pins[0].npm[0].file, 'better-sqlite3-13.0.1.tgz');
  assert.deepEqual(doc.apps.superhuman.helpers, ['superhuman-desktop-finish-login']);
});

// The Nix packages (nix/app.nix) read sources.json at evaluation time, without Node.
test('sources.json has every field the Nix packages read, with the types they expect', () => {
  const doc = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  const str = (value, what) => assert.equal(typeof value, 'string', what);
  const strOrNull = (value, what) => assert.ok(value === null || typeof value === 'string', what);
  const fetchable = (input, what) => {
    str(input.url, `${what}.url`);
    assert.match(input.sha256, SHA, `${what}.sha256`);
    // fetchurl's name: a store path name.
    assert.match(input.file, /^[A-Za-z0-9+_?=-][A-Za-z0-9+._?=-]*$/, `${what}.file`);
  };
  for (const [id, app] of Object.entries(doc.apps)) {
    for (const key of ['name', 'envPrefix', 'installId', 'command', 'displayName', 'comment']) str(app[key], `${id}.${key}`);
    strOrNull(app.downloadPage, `${id}.downloadPage`);
    assert.ok(Array.isArray(app.helpers), `${id}.helpers`);
    for (const pin of app.pins) {
      const at = `${id} ${pin.version}`;
      str(pin.version, `${at}.version`);
      strOrNull(pin.variant, `${at}.variant`);
      assert.match(pin.dmg.sha256, SHA, `${at}.dmg.sha256`);
      if (pin.dmg.url === null) assert.equal(pin.dmg.file, null, `${at}.dmg.file`);
      else fetchable(pin.dmg, `${at}.dmg`);
      str(pin.electron.version, `${at}.electron.version`);
      fetchable(pin.electron, `${at}.electron`);
      for (const npm of pin.npm) fetchable(npm, `${at}.npm`);
    }
  }
});

test('`sources --json` prints the file, or one app\'s entry', () => {
  assert.equal(execFileSync(CLI, ['sources', '--json'], { encoding: 'utf8' }), fs.readFileSync(SOURCES_FILE, 'utf8'));
  const linear = JSON.parse(execFileSync(CLI, ['sources', 'linear', '--json'], { encoding: 'utf8' }));
  assert.deepEqual(linear, JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')).apps.linear);
  assert.match(execFileSync(CLI, ['sources', 'figma'], { encoding: 'utf8' }), /^figma 126\.11\.9 \(x86_64\) -> figma-desktop$/m);
});

test('source blocks are validated: HTTPS, allowed hosts, a URL per pin variant', () => {
  const dir = path.join(tmp('source'), 'x');
  fs.mkdirSync(dir);
  const pin = { sha256: 'a'.repeat(64), version: '1.0.0', electron: '44.9.1', note: 'universal' };
  const source = { page: 'https://x.example/download', dmg: 'https://dl.x.example/X-{version}.dmg', hosts: ['dl.x.example'], retention: 'all' };
  const base = { id: 'x', name: 'X', bundleId: 'x', envPrefix: 'X', dmg: { glob: 'X-*.dmg', app: 'X.app' }, install: { id: 'x-desktop', command: 'x-desktop' }, pins: [pin], source };
  assert.doesNotThrow(() => validate(base, dir));
  const bad = (change) => () => validate({ ...base, source: { ...source, ...change } }, dir);
  assert.throws(bad({ dmg: 'http://dl.x.example/X-{version}.dmg' }), /https \.dmg URL on one of source\.hosts/);
  assert.throws(bad({ dmg: 'https://elsewhere.example/X-{version}.dmg' }), /source\.hosts/);
  assert.throws(bad({ hosts: [] }), /source\.hosts must list/);
  assert.throws(bad({ retention: 'forever' }), /source\.retention/);
  assert.throws(bad({ dmg: { x86_64: 'https://dl.x.example/X-{version}.dmg' } }), /no URL for pins with note universal/);
  assert.throws(bad({ feed: { type: 'rss', url: 'https://x.example/feed' } }), /source\.feed/);
  assert.throws(() => validate({ ...base, pins: [{ ...pin, note: 'a b' }] }, dir), /pin\.note/);
  // No source.dmg: the pin has no URL and the page says where to get it.
  const { pinSource } = require('../lib/sources.cjs');
  assert.deepEqual(pinSource({ ...base, source: { page: source.page } }, pin).dmg, { file: null, sha256: pin.sha256, url: null, versioned: null, retention: null });
  // npm prebuilds carry a sha256 too (for PKGBUILD sha256sums).
  assert.throws(() => validate({ ...base, natives: { m: { action: 'npm-prebuild', package: 'm', version: '1.0.0', integrity: 'sha512-x', files: {} } } }, dir), /sha256/);
});

test('pins are selected by version and variant; inputs are found by their pinned names', () => {
  const { config } = loadApp('notion');
  assert.equal(selectPin(config).note, 'universal');
  assert.equal(selectPin(config, { variant: 'x86_64' }).sha256, '86651bcc1b70d1c18c5c64531bcaefa309eb8e7a23b63744bc560e162c61961b');
  assert.throws(() => selectPin(config, { version: '1.0.0' }), /no pin for 1\.0\.0; pinned: 7\.43\.0 \(universal\), 7\.43\.0 \(x86_64\)/);
  const dir = tmp('inputs');
  assert.deepEqual(inputsIn(config, dir), {});
  for (const name of ['Notion-7.43.0.dmg', 'electron-v45.1.0-linux-x64.zip', 'better-sqlite3-13.0.1.tgz', 'unrelated.dmg']) fs.writeFileSync(path.join(dir, name), '');
  assert.deepEqual(inputsIn(config, dir), {
    dmg: path.join(dir, 'Notion-7.43.0.dmg'),
    electronZip: path.join(dir, 'electron-v45.1.0-linux-x64.zip'),
    npmTarballs: [path.join(dir, 'better-sqlite3-13.0.1.tgz')],
  });
});
