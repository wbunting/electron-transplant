// Survey a macOS Electron app for porting: what the build would have to deal with
// and how much of it the app's config already covers.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, hashFile, run, walk } = require('./util.cjs');
const dmgTools = require('./dmg.cjs');
const { findDmg } = require('./build.cjs');
const { foreignBinaries } = require('./natives.cjs');

const CHROME_APIS = ['titleBarStyle', 'trafficLightPosition', 'titleBarOverlay', 'setWindowButtonPosition', 'setWindowButtonVisibility', 'vibrancy', 'visualEffectState'];
const LOADERS = {
  "require('electron')": /require\(\s*["'`]electron["'`]\s*\)/g,
  "require('electron/main')": /require\(\s*["'`]electron\/main["'`]\s*\)/g,
  "import from 'electron'": /\bfrom\s*["'`]electron(\/main)?["'`]/g,
};

function count(text, pattern) {
  return pattern instanceof RegExp ? (text.match(pattern) ?? []).length : text.split(pattern).length - 1;
}

async function inspect({ config, configDir, dmg: explicit, workRoot, log = console.log }) {
  const dmg = findDmg(config, explicit);
  const sha = await hashFile(dmg);
  fs.mkdirSync(workRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(workRoot, `inspect-${config.id}.`));
  try {
    const sevenZip = dmgTools.find7zip();
    const contents = dmgTools.extractApp(sevenZip, dmg, path.join(work, 'dmg'), dmgTools.findApp(dmgTools.listPaths(sevenZip, dmg), config.dmg.app));
    const info = JSON.parse(run('python3', ['-I', path.join(ROOT, 'lib/macos-bundle.py'), 'info', contents]));
    const pin = (config.pins ?? []).find((p) => p.sha256 === sha);
    log(`${path.basename(dmg)}  sha256 ${sha}  ${pin ? `pinned (${pin.note ?? pin.version})` : 'NOT PINNED'}`);
    log(`${info.name} ${info.version}  bundle ${info.bundleId}  Electron ${info.electron}  URL schemes: ${info.urlSchemes.join(', ') || 'none'}`);

    const appDir = path.join(work, 'app');
    require(require.resolve('@electron/asar', { paths: [ROOT] })).extractAll(path.join(contents, 'Resources/app.asar'), appDir);

    log('\nNative code in the app:');
    const byModule = new Map();
    for (const { file, kind } of foreignBinaries(appDir)) {
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
      const name = match ? match[1] : '(outside node_modules)';
      byModule.set(name, [...(byModule.get(name) ?? []), `${kind} ${file}`]);
    }
    if (!byModule.size) log('  none');
    for (const [name, files] of byModule) {
      const handled = config.natives?.[name]?.action;
      log(`  ${handled ? `[${handled}]` : '[UNHANDLED]'} ${name}`);
      for (const file of files) log(`      ${file}`);
    }
    const resourceBinaries = foreignBinaries(path.join(contents, 'Resources')).filter((f) => !f.file.startsWith('app.asar'));
    log('\nNative code in Resources/:');
    if (!resourceBinaries.length) log('  none');
    for (const { file, kind } of resourceBinaries) {
      const dropped = (config.resources?.drop ?? []).includes(file.split('/')[0]);
      log(`  ${dropped ? '[drop]' : '[UNHANDLED]'} ${kind} ${file}`);
    }

    // App code: everything outside node_modules, plus bundled main files.
    const sources = [];
    walk(appDir, (file) => {
      const rel = path.relative(appDir, file);
      if (/\.(c|m)?js$/.test(file) && !rel.startsWith('node_modules/')) sources.push([rel, fs.readFileSync(file, 'utf8')]);
    });
    const tally = (pattern) => sources.reduce((n, [, text]) => n + count(text, pattern), 0);
    log('\nHow the app loads Electron:');
    for (const [label, pattern] of Object.entries(LOADERS)) log(`  ${label.padEnd(26)} ${tally(pattern)}`);
    log('\nmacOS window chrome (occurrences):');
    for (const api of CHROME_APIS) log(`  ${api.padEnd(26)} ${tally(api)}`);
    log('\nPlatform checks:');
    for (const platform of ['darwin', 'win32', 'linux']) {
      log(`  ${platform.padEnd(26)} ${tally(new RegExp(`process\\.platform\\s*[!=]==?\\s*["'\`]${platform}["'\`]|["'\`]${platform}["'\`]\\s*[!=]==?\\s*process\\.platform`, 'g'))}`);
    }
    if (config.patches?.length) {
      log('\nConfigured patches against this bundle:');
      for (const patch of config.patches) {
        const file = path.join(appDir, patch.file);
        const found = fs.existsSync(file) ? count(fs.readFileSync(file, 'utf8'), patch.from) : 0;
        log(`  ${found === (patch.count ?? 1) ? 'ok  ' : 'FAIL'} ${patch.name} (${found}/${patch.count ?? 1})`);
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { inspect };
