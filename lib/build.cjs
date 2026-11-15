// DMG -> verified macOS app -> patched app.asar on the matching Linux Electron.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, hashFile, run, dropSharedWrite } = require('./util.cjs');
const dmgTools = require('./dmg.cjs');
const { electronZip, platformApis } = require('./electron.cjs');
const { handleNatives, handleNativeFiles, foreignBinaries } = require('./natives.cjs');
const { readRawHeader, withoutInvalidEntries } = require('./asar-header.cjs');
const { applyPatches } = require('./patch.cjs');
const { cachedDmgs } = require('./fetch.cjs');
const { pinSource } = require('./sources.cjs');

const COMPAT_DIR = 'linux-compat';
const COMPAT_FILES = ['entry.cjs', 'runtime.cjs', 'facade.cjs', 'window-chrome.cjs', 'traffic-lights.html', 'traffic-lights-preload.cjs', 'title-bar-page-adapter.cjs'];
// Mac-only or superseded by the Linux Electron build; never copied into resources/.
const SKIP_RESOURCES = [/:com\.apple\./, /^app\.asar(\.unpacked)?$/, /\.lproj$/, /^Assets\.car$/, /\.icns$/, /^LICENSES?\.(chromium\.html|electron\.txt)$/i, /^app-update\.yml$/];

function asarModule() {
  return require(require.resolve('@electron/asar', { paths: [ROOT] }));
}

// Where an app's DMGs are looked for: ~/Downloads, or its own subdirectory of it
// (dmg.dir) for downloads kept apart as untrusted data.
function dmgDir(config) {
  return path.join(os.homedir(), 'Downloads', config.dmg.dir ?? '');
}

function dmgPattern(config) {
  return new RegExp(`^${config.dmg.glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

// The given DMG, else the newest match in dmgDir() or the download cache (`fetch`).
function findDmg(config, explicit, { offline = false } = {}) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw Error(`DMG not found: ${explicit}`);
    return path.resolve(explicit);
  }
  if (offline) throw Error(`Offline build: pass --dmg PATH (${config.dmg.glob}; \`electron-transplant sources ${config.id}\` lists the pinned files)`);
  const dir = dmgDir(config);
  const pattern = dmgPattern(config);
  const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => pattern.test(name)).map((name) => path.join(dir, name)) : [];
  candidates.push(...cachedDmgs(config.id));
  if (!candidates.length) throw Error(`No ${path.join(dir, config.dmg.glob).replace(os.homedir(), '~')}; run \`electron-transplant fetch ${config.id}\` or pass --dmg PATH`);
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

// A new or empty directory for the build (--out), or a new one under workRoot.
function workDir(config, out, workRoot) {
  if (!out) {
    fs.mkdirSync(workRoot, { recursive: true });
    return fs.mkdtempSync(path.join(workRoot, `${config.id}.`));
  }
  const dir = path.resolve(out);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw Error(`--out ${dir} is not empty`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// SOURCE_DATE_EPOCH (reproducible builds) when set.
function buildTime(env = process.env) {
  if (env.SOURCE_DATE_EPOCH === undefined) return new Date().toISOString();
  if (!/^\d+$/.test(env.SOURCE_DATE_EPOCH)) throw Error(`SOURCE_DATE_EPOCH must be whole seconds: ${env.SOURCE_DATE_EPOCH}`);
  return new Date(Number(env.SOURCE_DATE_EPOCH) * 1000).toISOString();
}

function bundleInfo(contents) {
  return JSON.parse(run('python3', ['-I', path.join(ROOT, 'lib/macos-bundle.py'), 'info', contents]));
}

// Hashes the header exactly as stored (readRawHeader does not reject entries
// @electron/asar would; see extractAsar).
function verifyAsarIntegrity(asarPath, expected) {
  const header = readRawHeader(asarPath).headerString;
  const actual = crypto.createHash('sha256').update(header).digest('hex');
  if (actual !== expected) throw Error('app.asar does not match the bundle\'s ElectronAsarIntegrity hash');
}

// Extracts the (verified) app.asar. Placeholder entries an app config names in
// asar.dropInvalidEntries are left out first, via a sanitised copy of the archive.
function extractAsar(asarPath, appDir, config, scratch, log = () => {}) {
  let source = asarPath;
  const names = config.asar?.dropInvalidEntries ?? [];
  if (names.length) {
    source = path.join(scratch, 'app.asar');
    for (const name of withoutInvalidEntries(asarPath, source, names)) log(`  asar: left out invalid placeholder entry ${name}`);
  }
  asarModule().extractAll(source, appDir);
  if (source !== asarPath) asarModule().uncache(source);
}

// Files an app config adds to the app (Linux implementations its patches load).
function addFiles(appDir, configDir, files = {}) {
  for (const [to, from] of Object.entries(files)) {
    const target = path.resolve(appDir, to);
    if (!target.startsWith(path.resolve(appDir) + path.sep)) throw Error(`addFiles: target outside app: ${to}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(configDir, from), target);
  }
  return Object.keys(files);
}

function copyResources(from, to, drop, log) {
  const copied = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_RESOURCES.some((re) => re.test(entry.name))) continue;
    if (drop.includes(entry.name)) {
      log(`  dropped resource: ${entry.name}`);
      continue;
    }
    fs.cpSync(path.join(from, entry.name), path.join(to, entry.name), { recursive: true });
    copied.push(entry.name);
  }
  return copied;
}

function installCompat(appDir, config, tablePath, electronVersion) {
  const target = path.join(appDir, COMPAT_DIR);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target);
  for (const name of COMPAT_FILES) fs.copyFileSync(path.join(ROOT, 'compat', name), path.join(target, name));
  const tableName = `electron-${electronVersion}-platform-apis.json`;
  fs.copyFileSync(tablePath, path.join(target, tableName));
  fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({
    appId: config.id,
    envPrefix: config.envPrefix,
    platformApis: tableName,
    pageAdapter: config.compat?.pageAdapter ?? null,
    // App files (added with addFiles) the entry loads before the app's main.
    hooks: config.compat?.hooks ?? [],
    // false: app.setAsDefaultProtocolClient records and declines unless
    // <PREFIX>_DEFAULT_PROTOCOL_CLIENT=1 (another app owns the scheme here).
    defaultProtocolClient: config.compat?.defaultProtocolClient ?? true,
  }, null, 2) + '\n');
  const pkgPath = path.join(appDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const entry = `./${COMPAT_DIR}/entry.cjs`;
  pkg.originalMain ??= pkg.main ?? 'index.js';
  if (pkg.originalMain === entry) throw Error('Cannot determine the app\'s original main');
  pkg.main = entry;
  // Electron's Linux setAsDefaultProtocolClient and Wayland app_id use this.
  pkg.desktopName = `${config.install.id}.desktop`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// Extract, verify and patch; returns the work directory with app/ and runtime/.
// Inputs found by default (DMG, Electron zip, 7-Zip, npm tarballs) can be given
// instead: dmg, electronZip, sevenZip, npmTarballs. offline: only given inputs and
// 7-Zip on PATH; never the network, ~/Downloads, the caches or $HOME. out: the work
// directory (new or empty) instead of a new one under workRoot.
async function build({ config, configDir, dmg: explicitDmg, electronZip: explicitZip, sevenZip: explicitSevenZip, npmTarballs = [],
  offline = false, out, acceptUnpinned = false, workRoot, log = console.log }) {
  if (offline && !out) throw Error('Offline build: pass --out DIR');
  const dmg = findDmg(config, explicitDmg, { offline });
  log(`DMG: ${dmg}`);
  const dmgSha = await hashFile(dmg);
  const pin = (config.pins ?? []).find((p) => p.sha256 === dmgSha);
  if (!pin && !acceptUnpinned) {
    throw Error(`${path.basename(dmg)} (sha256 ${dmgSha}) is not pinned in apps/${config.id}/app.cjs; re-run with --accept-unpinned`);
  }
  for (const file of npmTarballs) if (!fs.existsSync(file)) throw Error(`npm tarball not found: ${file}`);
  if (offline) {
    // Fail before extracting anything; the inputs are verified where they are used.
    const electron = pin && pinSource(config, pin).electron;
    if (!explicitZip) throw Error(`Offline build: pass --electron-zip PATH${electron ? ` (${electron.file}, ${electron.url}, sha256 ${electron.sha256})` : ''}`);
    const npm = Object.values(config.natives ?? {}).filter((spec) => spec.action === 'npm-prebuild');
    if (npm.length > npmTarballs.length) throw Error(`Offline build: pass --npm-tarball PATH for ${npm.map((spec) => `${spec.package} ${spec.version}`).join(', ')} (\`electron-transplant sources ${config.id}\`)`);
  }
  const sevenZip = dmgTools.find7zip({ explicit: explicitSevenZip, offline });
  const work = workDir(config, out, workRoot);
  log(`Work directory: ${work}`);

  // 1. Extract only what is needed; nothing from the DMG is executed.
  const contentsPrefix = dmgTools.findApp(dmgTools.listPaths(sevenZip, dmg), config.dmg.app);
  const contents = dmgTools.extractApp(sevenZip, dmg, path.join(work, 'dmg'), contentsPrefix);
  const info = bundleInfo(contents);
  if (info.bundleId !== config.bundleId) throw Error(`Bundle id ${info.bundleId}, expected ${config.bundleId}`);
  for (const [key, value] of [['version', info.version], ['electron', info.electron]]) {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw Error(`Unexpected ${key}: ${value}`);
  }
  if (pin && (pin.version !== info.version || pin.electron !== info.electron)) {
    throw Error(`Pinned DMG is ${pin.version}/Electron ${pin.electron}, bundle says ${info.version}/${info.electron}`);
  }
  if (!pin) log(`UNPINNED: ${config.name} ${info.version} (Electron ${info.electron}) DMG sha256 ${dmgSha}; add it to apps/${config.id}/app.cjs after testing`);
  log(`${config.name} ${info.version} on Electron ${info.electron}`);

  // 2. app.asar must be the one the bundle's (signed) Info.plist describes.
  verifyAsarIntegrity(path.join(contents, 'Resources/app.asar'), info.asarHeaderSha256);
  const zip = await electronZip(info.electron, { acceptUnpinned, offline, zip: explicitZip, log });
  const table = await platformApis(info.electron, { acceptUnpinned, offline, log });
  log('Verified DMG, app.asar integrity and Electron archive.');

  // 3. Patch: native modules, source patches, compat entry.
  const appDir = path.join(work, 'app');
  extractAsar(path.join(contents, 'Resources/app.asar'), appDir, config, path.join(work, 'asar'), log);
  for (const [name, action] of await handleNatives(appDir, config.natives, configDir, { tarballs: npmTarballs, offline })) log(`  native ${name}: ${action}`);
  for (const [file, action] of handleNativeFiles(appDir, config.nativeFiles)) log(`  native file ${file}: ${action}`);
  for (const file of addFiles(appDir, configDir, config.addFiles)) log(`  added ${file}`);
  for (const [name, state] of applyPatches(appDir, config.patches)) log(`  patch ${name}: ${state}`);
  installCompat(appDir, config, table, info.electron);
  const foreign = foreignBinaries(appDir);
  if (foreign.length) {
    throw Error(`Unported native code in the app (add natives entries):\n${foreign.map((f) => `  ${f.kind}  ${f.file}`).join('\n')}`);
  }

  // 4. Assemble Linux Electron + repacked app (native addons unpacked beside it).
  const runtime = path.join(work, 'runtime');
  fs.mkdirSync(runtime);
  run('unzip', ['-q', zip, '-d', runtime]);
  fs.rmSync(path.join(runtime, 'resources/default_app.asar'), { force: true });
  await asarModule().createPackageWithOptions(appDir, path.join(runtime, 'resources/app.asar'), { unpack: '*.node' });
  const resources = copyResources(path.join(contents, 'Resources'), path.join(runtime, 'resources'), config.resources?.drop ?? [], log);
  // Linux-only resources the app expects, made from the Mac ones (e.g. tray icons).
  for (const { to, from, recolor } of config.resources?.derive ?? []) {
    run('python3', ['-I', path.join(ROOT, 'lib/macos-bundle.py'), 'recolor', path.join(runtime, 'resources', from), path.join(runtime, 'resources', to), recolor]);
    resources.push(to);
    log(`  derived resource: ${to} (${from}, #${recolor})`);
  }
  // Nothing in the runtime is writable by anyone but its owner, whatever the zip says.
  dropSharedWrite(runtime);
  const foreignRuntime = foreignBinaries(runtime);
  if (foreignRuntime.length) {
    throw Error(`Foreign binaries in resources (add them to resources.drop):\n${foreignRuntime.map((f) => `  ${f.kind}  ${f.file}`).join('\n')}`);
  }
  let iconSize = null;
  if (info.iconFile && fs.existsSync(path.join(contents, 'Resources', info.iconFile))) {
    iconSize = Number(run('python3', ['-I', path.join(ROOT, 'lib/macos-bundle.py'), 'icon', path.join(contents, 'Resources', info.iconFile), path.join(runtime, 'app-icon.png')]).trim());
  }
  fs.writeFileSync(path.join(runtime, 'TRANSPLANT.json'), JSON.stringify({
    app: config.id,
    version: info.version,
    electron: info.electron,
    bundleId: info.bundleId,
    urlSchemes: info.urlSchemes,
    // The vendor's file name when pinned, so the record doesn't depend on where the input was.
    dmg: { name: (pin && pinSource(config, pin).dmg.file) || path.basename(dmg), sha256: dmgSha, pinned: Boolean(pin) },
    natives: Object.fromEntries(Object.entries(config.natives ?? {}).map(([name, spec]) => [name, spec.action])),
    nativeFiles: Object.fromEntries(Object.entries(config.nativeFiles ?? {}).map(([file, spec]) => [file, spec.action])),
    addedFiles: Object.keys(config.addFiles ?? {}),
    patches: (config.patches ?? []).map((p) => p.name),
    resources,
    iconSize,
    builtAt: buildTime(),
  }, null, 2) + '\n');
  log(`Built runtime: ${runtime}`);
  return { work, runtime, appDir, info, dmgSha };
}

module.exports = { build, findDmg, buildTime, dmgDir, dmgPattern, extractAsar, addFiles, installCompat, copyResources, COMPAT_FILES, COMPAT_DIR, SKIP_RESOURCES };
