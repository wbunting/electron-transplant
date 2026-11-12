// DMG -> verified macOS app -> patched app.asar on the matching Linux Electron.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, hashFile, run } = require('./util.cjs');
const dmgTools = require('./dmg.cjs');
const { electronZip, platformApis } = require('./electron.cjs');
const { handleNatives, foreignBinaries } = require('./natives.cjs');
const { applyPatches } = require('./patch.cjs');

const COMPAT_DIR = 'linux-compat';
const COMPAT_FILES = ['entry.cjs', 'runtime.cjs', 'facade.cjs', 'window-chrome.cjs', 'traffic-lights.html', 'traffic-lights-preload.cjs', 'title-bar-page-adapter.cjs'];
// Mac-only or superseded by the Linux Electron build; never copied into resources/.
const SKIP_RESOURCES = [/:com\.apple\./, /^app\.asar(\.unpacked)?$/, /\.lproj$/, /^Assets\.car$/, /\.icns$/, /^LICENSES?\.(chromium\.html|electron\.txt)$/i, /^app-update\.yml$/];

function asarModule() {
  return require(require.resolve('@electron/asar', { paths: [ROOT] }));
}

// Newest matching DMG in ~/Downloads unless one is given.
function findDmg(config, explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw Error(`DMG not found: ${explicit}`);
    return path.resolve(explicit);
  }
  const downloads = path.join(os.homedir(), 'Downloads');
  const pattern = new RegExp(`^${config.dmg.glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const candidates = fs.existsSync(downloads) ? fs.readdirSync(downloads).filter((name) => pattern.test(name)) : [];
  if (!candidates.length) throw Error(`No ~/Downloads/${config.dmg.glob}; pass --dmg PATH`);
  return candidates.map((name) => path.join(downloads, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function bundleInfo(contents) {
  return JSON.parse(run('python3', ['-I', path.join(ROOT, 'lib/macos-bundle.py'), 'info', contents]));
}

function verifyAsarIntegrity(asarPath, expected) {
  const header = asarModule().getRawHeader(asarPath).headerString;
  const actual = crypto.createHash('sha256').update(header).digest('hex');
  if (actual !== expected) throw Error('app.asar does not match the bundle\'s ElectronAsarIntegrity hash');
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
async function build({ config, configDir, dmg: explicitDmg, acceptUnpinned = false, workRoot, log = console.log }) {
  const dmg = findDmg(config, explicitDmg);
  log(`DMG: ${dmg}`);
  const dmgSha = await hashFile(dmg);
  const pin = (config.pins ?? []).find((p) => p.sha256 === dmgSha);
  if (!pin && !acceptUnpinned) {
    throw Error(`${path.basename(dmg)} (sha256 ${dmgSha}) is not pinned in apps/${config.id}/app.cjs; re-run with --accept-unpinned`);
  }
  fs.mkdirSync(workRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(workRoot, `${config.id}.`));
  log(`Work directory: ${work}`);

  // 1. Extract only what is needed; nothing from the DMG is executed.
  const sevenZip = dmgTools.find7zip();
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
  const zip = await electronZip(info.electron, { acceptUnpinned, log });
  const table = await platformApis(info.electron, { acceptUnpinned, log });
  log('Verified DMG, app.asar integrity and Electron archive.');

  // 3. Patch: native modules, source patches, compat entry.
  const appDir = path.join(work, 'app');
  asarModule().extractAll(path.join(contents, 'Resources/app.asar'), appDir);
  for (const [name, action] of await handleNatives(appDir, config.natives, configDir)) log(`  native ${name}: ${action}`);
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
    dmg: { name: path.basename(dmg), sha256: dmgSha, pinned: Boolean(pin) },
    natives: Object.fromEntries(Object.entries(config.natives ?? {}).map(([name, spec]) => [name, spec.action])),
    patches: (config.patches ?? []).map((p) => p.name),
    resources,
    iconSize,
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n');
  log(`Built runtime: ${runtime}`);
  return { work, runtime, appDir, info, dmgSha };
}

module.exports = { build, findDmg, installCompat, copyResources, COMPAT_FILES, COMPAT_DIR, SKIP_RESOURCES };
