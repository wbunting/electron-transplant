// PKGBUILDs (pacman, Arch Linux) from sources.json. Every input is a hash-pinned
// source: the vendor's DMG from the vendor, the Linux Electron zip, npm prebuilds,
// electron-transplant itself (a git tag or commit, or a tarball of this checkout)
// and @electron/asar's tarballs from package-lock.json, so build() needs no network.
// packaging/arch/<app>/ holds them for each app's first pin, committed and pinned to
// the release tag of package.json's version; npm test fails when they drift
// (`electron-transplant pkgbuild --write`).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, download, hashFile, verify, run } = require('./util.cjs');
const { listApps, loadApp } = require('./apps.cjs');
const { pinSource, selectPin } = require('./sources.cjs');

const REPOSITORY = 'https://github.com/wbunting/electron-transplant';
const ARCH_DIR = path.join(ROOT, 'packaging/arch');
// sha256 of each package-lock.json tarball (makepkg wants one hash type for every
// source; the lockfile has sha512). Derived from tarballs verified against the
// lockfile's integrity: `electron-transplant pkgbuild --write --refresh-npm`.
const NPM_HASHES = path.join(ARCH_DIR, 'npm-sources.json');
const SEVENZIP = '/usr/lib/7zip/7z';
const TOOL_DIR = 'electron-transplant';

// What Electron's official Linux binary links against (docs/packaging.md), and bash
// for the launchers. hicolor-icon-theme owns the icon directories; the pacman hooks
// of desktop-file-utils and gtk-update-icon-cache refresh their caches.
const DEPENDS = ['alsa-lib', 'at-spi2-core', 'bash', 'cairo', 'dbus', 'expat', 'glib2', 'glibc', 'gtk3', 'hicolor-icon-theme',
  'libcups', 'libx11', 'libxcb', 'libxcomposite', 'libxdamage', 'libxext', 'libxfixes', 'libxkbcommon', 'libxrandr', 'libgcc', 'mesa', 'nspr', 'nss', 'pango', 'systemd-libs'];
// Loaded at runtime when present (dlopen) or run by the app.
const OPTDEPENDS = ['libnotify: desktop notifications', 'libsecret: keep sign-in secrets in the desktop keyring', 'xdg-utils: open links in the default browser'];
const MAKEDEPENDS = ['7zip', 'git', 'nodejs>=22.15', 'python', 'unzip'];

// pacman versions: no hyphens, colons, slashes or spaces.
const pkgver = (version) => version.replace(/[^\w.+]/g, '_');
const pkgName = (config) => `${config.id}-transplant`;
const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const isSha256 = (value) => /^[0-9a-f]{64}$/.test(value ?? '');

// @electron/asar and its dependencies as package-lock.json pins them: where each
// goes under the checkout (what `npm ci` installs) and its tarball.
function npmModules(lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))) {
  return Object.entries(lock.packages).filter(([key, spec]) => key.startsWith('node_modules/') && !spec.dev && !spec.link).map(([key, spec]) => {
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name) || !/^[\w.+-]+$/.test(spec.version ?? '') || !spec.integrity?.startsWith('sha512-') || !spec.resolved?.startsWith('https://registry.npmjs.org/')) {
      throw Error(`package-lock.json: unexpected entry ${key}`);
    }
    return { path: key, name, version: spec.version, url: spec.resolved, integrity: spec.integrity, file: `${name.replace('/', '+')}-${spec.version}.tgz` };
  });
}

function npmHashes() {
  return fs.existsSync(NPM_HASHES) ? JSON.parse(fs.readFileSync(NPM_HASHES, 'utf8')) : {};
}

function npmSourcesWithHashes(modules = npmModules(), hashes = npmHashes()) {
  return modules.map((module) => {
    const known = hashes[`${module.name}@${module.version}`];
    if (known?.integrity !== module.integrity || !isSha256(known?.sha256)) {
      throw Error(`${path.relative(ROOT, NPM_HASHES)} has no sha256 for ${module.name} ${module.version}: run \`electron-transplant pkgbuild --write --refresh-npm\``);
    }
    return { ...module, sha256: known.sha256 };
  });
}

// Downloads each lockfile tarball into a new directory, verifies it against the
// lockfile's integrity and records its sha256.
async function refreshNpmHashes({ log = console.log } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-npm-'));
  try {
    const hashes = {};
    for (const module of npmModules()) {
      const file = path.join(dir, module.file);
      await download(module.url, file);
      await verify(file, module.integrity);
      hashes[`${module.name}@${module.version}`] = { integrity: module.integrity, sha256: await hashFile(file) };
      log(`npm ${module.name} ${module.version}`);
    }
    fs.mkdirSync(ARCH_DIR, { recursive: true });
    fs.writeFileSync(NPM_HASHES, JSON.stringify(hashes, null, 2) + '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const toolVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// electron-transplant as a source: { tag } or { commit } of the public repository
// (git, so SKIP as Arch does for VCS sources), or { file, sha256 }: a tarball of a
// checkout beside the PKGBUILD (localTarball).
function toolSource(tool = { tag: `v${toolVersion()}` }) {
  if (tool.file) {
    if (!/^[\w.+-]+\.tar\.gz$/.test(tool.file) || !isSha256(tool.sha256)) throw Error(`Bad local source ${tool.file}`);
    return { entry: tool.file, sha256: tool.sha256, note: 'electron-transplant: a tarball of a local checkout', extract: true };
  }
  if (tool.commit) {
    if (!/^[0-9a-f]{40}$/.test(tool.commit)) throw Error(`--commit needs a full commit hash: ${tool.commit}`);
    return { entry: `${TOOL_DIR}::git+${REPOSITORY}.git#commit=${tool.commit}`, sha256: 'SKIP', note: `electron-transplant at commit ${tool.commit.slice(0, 12)}`, extract: true };
  }
  if (!/^v[\w.+-]+$/.test(tool.tag ?? '')) throw Error(`Bad tag ${tool.tag}`);
  return { entry: `${TOOL_DIR}::git+${REPOSITORY}.git#tag=${tool.tag}`, sha256: 'SKIP', note: `electron-transplant at tag ${tool.tag}`, extract: true };
}

function retentionNote(config, pin) {
  if (pin.dmg.retention === 'current-and-previous') {
    return `${config.name} keeps only its current and previous release downloadable: this DMG URL stops `
      + `working (403) once ${config.name} has shipped two releases after ${pin.version}. The hash still matches `
      + 'the same DMG obtained another way: put it beside this PKGBUILD (or in SRCDEST) under the name in source=.';
  }
  if (pin.dmg.retention === 'unknown') return `How long ${config.name} keeps old releases downloadable is unknown.`;
  return '';
}

// Words of text in lines of at most width characters.
function wrap(text, width) {
  const lines = [''];
  for (const word of text.split(' ')) {
    const line = lines[lines.length - 1];
    if (line && line.length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines;
}

// The PKGBUILD's fields, in .SRCINFO order. tool: see toolSource.
function packageFields(config, pinConfig, { tool, pkgrel = 1, maintainer } = {}) {
  if (!Number.isInteger(pkgrel) || pkgrel < 1) throw Error(`pkgrel must be a positive whole number: ${pkgrel}`);
  if (maintainer !== undefined && !/^[^\n<>]+ <[^\s<>]+>$/.test(maintainer)) throw Error(`--maintainer must be "Name <email>": ${maintainer}`);
  const pin = pinSource(config, pinConfig);
  if (!pin.dmg.url) throw Error(`${config.name} ${pin.version} has no download URL to put in a PKGBUILD`);
  const sources = [];
  const add = (entry, sha256, comment, extract = false) => {
    if (sha256 !== 'SKIP' && !isSha256(sha256)) throw Error(`No sha256 for ${entry}`);
    if (!sources.some((s) => s.entry === entry)) sources.push({ entry, sha256, comment, extract });
  };
  add(`${pin.dmg.file}::${pin.dmg.url}`, pin.dmg.sha256, `${config.name}'s macOS DMG, from ${new URL(pin.dmg.url).hostname}`);
  add(`${pin.electron.file}::${pin.electron.url}`, pin.electron.sha256, `Electron ${pin.electron.version} for Linux`);
  for (const npm of pin.npm) add(`${npm.file}::${npm.url}`, npm.sha256, `${npm.package} ${npm.version}: Linux prebuild`);
  const self = toolSource(tool);
  add(self.entry, self.sha256, self.note, self.extract);
  const modules = npmSourcesWithHashes();
  for (const module of modules) add(`${module.file}::${module.url}`, module.sha256, modules.indexOf(module) ? '' : 'package-lock.json: @electron/asar and its dependencies');
  return {
    pkgname: pkgName(config),
    pkgver: pkgver(pin.version),
    pkgrel: String(pkgrel),
    pkgdesc: config.install.comment ?? `${config.name} — unofficial Linux port of the macOS app`,
    url: config.source?.page ?? REPOSITORY,
    arch: ['x86_64'],
    // The vendor's app (its own terms), Electron and this tool (MIT), Chromium.
    license: ['LicenseRef-proprietary', 'MIT', 'BSD-3-Clause'],
    makedepends: MAKEDEPENDS,
    depends: DEPENDS,
    optdepends: OPTDEPENDS,
    conflicts: config.install.conflicts ?? [],
    noextract: sources.filter((s) => !s.extract).map((s) => s.entry.split('::')[0]),
    options: ['!strip', '!debug'],
    sources,
    pin,
    modules,
    retention: retentionNote(config, pin),
    maintainer,
  };
}

// name=(…) on one line, or wrapped; with comments, one value per line.
function array(name, values, { comments = [] } = {}) {
  if (!values.length) return '';
  const inline = `${name}=(${values.map(q).join(' ')})`;
  if (inline.length <= 80 && !comments.some(Boolean)) return inline + '\n';
  if (!comments.some(Boolean) && !values.some((v) => v.includes(' '))) return `${name}=(\n${wrap(values.map(q).join(' '), 78).map((l) => `  ${l}`).join('\n')}\n)\n`;
  const lines = values.map((value, i) => `${comments[i] ? `  # ${comments[i]}\n` : ''}  ${q(value)}`);
  return `${name}=(\n${lines.join('\n')}\n)\n`;
}

function render(config, fields, { generatedBy }) {
  const { pin, sources } = fields;
  const variant = pin.variant ? ` (${pin.variant} macOS build)` : '';
  const header = [
    ...(fields.maintainer ? [`Maintainer: ${fields.maintainer}`, ''] : []),
    ...wrap(`Generated by \`${generatedBy}\` from sources.json; regenerate it rather than editing it (docs/packaging.md, "Arch Linux").`, 78),
    '',
    ...wrap(`${config.name} ${pin.version}${variant} on the official Linux build of Electron ${pin.electron.version}, `
      + `assembled by electron-transplant on this machine. The package distributes nothing from ${config.name}: `
      + `makepkg downloads ${config.name}'s own macOS DMG from ${config.name} (source=), and the build verifies it `
      + 'against its pinned hash, patches it and installs it under /usr.', 78),
    ...(fields.retention ? ['', ...wrap(fields.retention, 78)] : []),
  ];
  const appDir = config.install.id;
  const dmgPath = `"$srcdir"/${q(pin.dmg.file)}`;
  return `${header.map((line) => (line ? `# ${line}` : '#')).join('\n')}

pkgname=${fields.pkgname}
pkgver=${fields.pkgver}
pkgrel=${fields.pkgrel}
pkgdesc=${q(fields.pkgdesc)}
arch=(${fields.arch.map(q).join(' ')})
url=${q(fields.url)}
license=(${fields.license.map(q).join(' ')})
${array('depends', fields.depends)}${array('optdepends', fields.optdepends)}${array('makedepends', fields.makedepends)}${array('conflicts', fields.conflicts)}# Electron's binaries must stay as built.
options=(${fields.options.map(q).join(' ')})
${array('source', sources.map((s) => s.entry), { comments: sources.map((s) => s.comment) })}${array('noextract', fields.noextract)}${array('sha256sums', sources.map((s) => s.sha256))}
prepare() {
  # @electron/asar and its dependencies where \`npm ci --ignore-scripts\` puts them.
  cd ${TOOL_DIR}
  rm -rf node_modules
  local module
  for module in \\
${fields.modules.map((m) => `    ${q(`${m.path}:${m.file}`)}`).join(' \\\n')}
  do
    mkdir -p "\${module%%:*}"
    tar -xzf "$srcdir/\${module#*:}" -C "\${module%%:*}" --strip-components 1
  done
}

build() {
  cd ${TOOL_DIR}
  # Offline: only the files above, nothing from the network or $HOME.
  rm -rf "$srcdir/build"
  node bin/electron-transplant build ${config.id} --offline --out "$srcdir/build" \\
    --inputs "$srcdir" --dmg ${dmgPath} --sevenzip ${SEVENZIP}
}

package() {
  cd ${TOOL_DIR}
  node bin/electron-transplant install ${config.id} --from "$srcdir/build" \\
    --layout package --prefix /usr --destdir "$pkgdir"
  # Licences (Electron, Chromium, electron-transplant) are in usr/share/licenses/${appDir}.
  ln -s ${appDir} "$pkgdir/usr/share/licenses/$pkgname"
}
`;
}

// .SRCINFO as \`makepkg --printsrcinfo\` writes it.
function srcinfo(fields) {
  const lines = [`pkgbase = ${fields.pkgname}`];
  const add = (key, values) => { for (const value of [values].flat()) lines.push(`\t${key} = ${value}`); };
  for (const key of ['pkgdesc', 'pkgver', 'pkgrel', 'url', 'arch', 'license', 'makedepends', 'depends', 'optdepends', 'conflicts', 'noextract', 'options']) add(key, fields[key]);
  add('source', fields.sources.map((s) => s.entry));
  add('sha256sums', fields.sources.map((s) => s.sha256));
  lines.push('', `pkgname = ${fields.pkgname}`);
  return lines.join('\n') + '\n';
}

// { pkgbuild, srcinfo, fields } for an app's pin (default: its first).
function generate(appId, { version, variant, tool, pkgrel, maintainer, generatedBy } = {}) {
  const { config } = loadApp(appId);
  const pin = selectPin(config, { version, variant });
  const fields = packageFields(config, pin, { tool, pkgrel, maintainer });
  const args = [version && `--version ${version}`, variant && `--variant ${variant}`].filter(Boolean).join(' ');
  return { fields, pkgbuild: render(config, fields, { generatedBy: generatedBy ?? `electron-transplant pkgbuild ${appId}${args ? ` ${args}` : ''}` }), srcinfo: srcinfo(fields) };
}

// The committed packaging/arch/<app>/: each app's first pin at the release tag.
function committed() {
  return Object.fromEntries(listApps().map((id) => [id, generate(id, { generatedBy: 'electron-transplant pkgbuild --write' })]));
}

function writeCommitted({ log = console.log } = {}) {
  for (const [id, { pkgbuild, srcinfo: info }] of Object.entries(committed())) {
    const dir = path.join(ARCH_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PKGBUILD'), pkgbuild);
    fs.writeFileSync(path.join(dir, '.SRCINFO'), info);
    log(`Wrote ${path.relative(ROOT, dir)}/PKGBUILD and .SRCINFO`);
  }
}

const git = (...args) => run('git', ['-C', ROOT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The app's sources.json entry at a commit, or null when the commit has none.
function sourcesAt(ref, appId) {
  try {
    return JSON.parse(git('show', `${ref}:sources.json`)).apps?.[appId] ?? null;
  } catch {
    return null;
  }
}

// Checks a tag or commit has this checkout's pin for the app (the build verifies
// the DMG against the pins of the electron-transplant it runs); returns warnings.
function checkToolRef(appId, pin, tool) {
  const ref = tool.commit ?? tool.tag;
  try {
    git('rev-parse', '--git-dir');
  } catch {
    return [`not a git checkout: cannot check that ${ref} pins ${pin.dmg.file}`];
  }
  let commit;
  try {
    commit = git('rev-parse', '-q', '--verify', `${tool.commit ? ref : `refs/tags/${ref}`}^{commit}`);
  } catch {
    if (tool.commit) throw Error(`Commit ${ref} is not in this checkout`);
    return [`tag ${ref} is not in this checkout (git fetch --tags); the PKGBUILD needs it on GitHub`];
  }
  const app = sourcesAt(commit, appId);
  if (!app?.pins?.some((p) => p.dmg.sha256 === pin.dmg.sha256 && p.electron.sha256 === pin.electron.sha256)) {
    throw Error(`${ref} does not pin ${pin.dmg.file} (sha256 ${pin.dmg.sha256.slice(0, 12)}…): a new pin needs a new release (package.json version), or --commit with a pushed commit that pins it, or --local`);
  }
  const warnings = [];
  if (tool.commit && !git('branch', '-r', '--contains', commit)) warnings.push(`commit ${commit.slice(0, 12)} is on no remote branch you have fetched: push it before building`);
  return warnings;
}

// A tarball of this checkout as it is (uncommitted and new files included, ignored
// ones not) for building before a commit is pushed: { file, sha256 }.
async function localTarball(dir) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'et-index-'));
  try {
    // A throwaway index, so the real one (what is staged) stays as it is.
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    const withIndex = (...args) => run('git', ['-C', ROOT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    withIndex('read-tree', 'HEAD');
    withIndex('add', '--all');
    const tree = withIndex('write-tree');
    const file = `${TOOL_DIR}-local-${tree.slice(0, 12)}.tar.gz`;
    for (const old of fs.readdirSync(dir)) if (/^electron-transplant-local-[0-9a-f]+\.tar\.gz$/.test(old) && old !== file) fs.rmSync(path.join(dir, old));
    // The tree's own mtime, so the same tree gives the same tarball.
    const mtime = git('log', '-1', '--format=%ct', 'HEAD');
    run('git', ['-C', ROOT, 'archive', '--format=tar.gz', `--prefix=${TOOL_DIR}/`, `--mtime=@${mtime}`, '-o', path.join(dir, file), tree], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { file, sha256: await hashFile(path.join(dir, file)) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Runs makepkg in dir (sources are downloaded there and reused); returns the package paths.
function makepkg(dir, { log = console.log } = {}) {
  try {
    run('sh', ['-c', 'command -v makepkg']);
  } catch {
    throw Error('makepkg not found: --build needs Arch Linux (pacman)');
  }
  // --syncdeps: pacman (sudo) installs missing makedepends and depends, asking first.
  run('makepkg', ['--cleanbuild', '--force', '--syncdeps'], { cwd: dir, stdio: ['inherit', 'inherit', 'inherit'] });
  const packages = run('makepkg', ['--packagelist'], { cwd: dir }).trim().split('\n').filter((file) => fs.existsSync(file));
  for (const file of packages) log(file);
  return packages;
}

module.exports = {
  ARCH_DIR, NPM_HASHES, REPOSITORY, generate, committed, writeCommitted, refreshNpmHashes, npmModules,
  toolSource, checkToolRef, localTarball, makepkg, pkgver, pkgName, toolVersion,
};
