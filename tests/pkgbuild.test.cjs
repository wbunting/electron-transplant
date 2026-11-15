// PKGBUILDs (pacman): generated from sources.json, every source hash-pinned, the
// committed packaging/arch/ in step, and .SRCINFO what makepkg would write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { listApps, loadApp } = require('../lib/apps.cjs');
const { SOURCES_FILE } = require('../lib/sources.cjs');
const { ARCH_DIR, NPM_HASHES, generate, committed, npmModules, toolVersion, localTarball, checkToolRef } = require('../lib/pkgbuild.cjs');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin/electron-transplant');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `et-${name}-`));
const doc = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
const has = (command) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;

// The PKGBUILD's variables as bash sees them.
function evaluate(dir) {
  const script = `source ./PKGBUILD
for name in pkgname pkgver pkgrel pkgdesc url; do printf '%s\\t%s\\n' "$name" "\${!name}"; done
for name in arch license depends optdepends makedepends conflicts options source noextract sha256sums; do
  declare -n values=$name; for value in "\${values[@]}"; do printf '%s\\t%s\\n' "$name" "$value"; done; unset -n values
done
declare -F | cut -d' ' -f3`;
  const out = execFileSync('bash', ['-euc', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp('home') } });
  const vars = {};
  const functions = [];
  for (const line of out.trimEnd().split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) functions.push(line);
    else (vars[line.slice(0, tab)] ??= []).push(line.slice(tab + 1));
  }
  return { vars, functions };
}

// .SRCINFO's pkgbase section as key -> values.
function parseSrcinfo(text) {
  const vars = {};
  for (const line of text.split('\n\n')[0].split('\n').slice(1)) {
    const [key, ...rest] = line.trim().split(' = ');
    (vars[key] ??= []).push(rest.join(' = '));
  }
  return vars;
}

test('packaging/arch/ is generated from sources.json (electron-transplant pkgbuild --write)', () => {
  const generated = committed();
  assert.deepEqual(fs.readdirSync(ARCH_DIR).filter((n) => fs.statSync(path.join(ARCH_DIR, n)).isDirectory()).sort(), listApps());
  for (const [id, { pkgbuild, srcinfo }] of Object.entries(generated)) {
    const stale = `packaging/arch/${id} is stale: run \`electron-transplant pkgbuild --write\` and commit it`;
    assert.equal(fs.readFileSync(path.join(ARCH_DIR, id, 'PKGBUILD'), 'utf8'), pkgbuild, stale);
    assert.equal(fs.readFileSync(path.join(ARCH_DIR, id, '.SRCINFO'), 'utf8'), srcinfo, stale);
  }
  // The npm hashes cover exactly package-lock.json's tarballs.
  const hashes = JSON.parse(fs.readFileSync(NPM_HASHES, 'utf8'));
  assert.deepEqual(Object.keys(hashes).sort(), npmModules().map((m) => `${m.name}@${m.version}`).sort());
  for (const module of npmModules()) assert.equal(hashes[`${module.name}@${module.version}`].integrity, module.integrity);
});

test('each app\'s PKGBUILD pins every source to sources.json, builds offline and stages under /usr', () => {
  const names = { figma: 'figma-transplant', linear: 'linear-transplant', notion: 'notion-transplant', superhuman: 'superhuman-transplant' };
  for (const id of listApps()) {
    const { config } = loadApp(id);
    const app = doc.apps[id];
    const pin = app.pins[0];
    const dir = path.join(ARCH_DIR, id);
    const { vars, functions } = evaluate(dir);
    const one = (name) => vars[name]?.[0];
    assert.equal(one('pkgname'), names[id]);
    assert.equal(one('pkgver'), pin.version);
    assert.equal(one('pkgrel'), '1');
    assert.equal(one('pkgdesc'), app.comment);
    assert.equal(one('url'), app.downloadPage);
    assert.deepEqual(vars.arch, ['x86_64']);
    assert.deepEqual(vars.options, ['!strip', '!debug']);
    assert.deepEqual(vars.license, ['LicenseRef-proprietary', 'MIT', 'BSD-3-Clause']);
    assert.deepEqual(vars.conflicts, config.install.conflicts);
    assert.ok(vars.makedepends.includes('7zip') && vars.makedepends.includes('nodejs>=22.15'));
    assert.ok(vars.depends.includes('gtk3') && vars.depends.includes('nss') && vars.depends.includes('hicolor-icon-theme'));
    assert.deepEqual(functions, ['build', 'package', 'prepare']);

    // Sources and hashes, entry by entry.
    const sums = Object.fromEntries(vars.source.map((entry, i) => [entry, vars.sha256sums[i]]));
    assert.equal(vars.source.length, vars.sha256sums.length);
    assert.equal(sums[`${pin.dmg.file}::${pin.dmg.url}`], pin.dmg.sha256);
    assert.equal(sums[`${pin.electron.file}::${pin.electron.url}`], pin.electron.sha256);
    for (const npm of pin.npm) assert.equal(sums[`${npm.file}::${npm.url}`], npm.sha256);
    assert.equal(sums[`electron-transplant::git+https://github.com/wbunting/electron-transplant.git#tag=v${toolVersion()}`], 'SKIP');
    for (const module of npmModules()) assert.match(sums[`${module.file}::${module.url}`], /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.entries(sums).filter(([, sum]) => sum === 'SKIP').map(([entry]) => entry.split('::')[0]), ['electron-transplant']);
    for (const entry of vars.source) assert.match(entry, /^[\w@.+-]+::(https:\/\/|git\+https:\/\/github\.com\/)/);
    // makepkg leaves archives alone; the build reads them by name.
    assert.deepEqual(vars.noextract, vars.source.map((e) => e.split('::')[0]).filter((name) => name !== 'electron-transplant'));

    const text = fs.readFileSync(path.join(dir, 'PKGBUILD'), 'utf8');
    assert.ok(text.includes(`node bin/electron-transplant build ${id} --offline --out "$srcdir/build" \\\n    --inputs "$srcdir" --dmg "$srcdir"/'${pin.dmg.file}' --sevenzip /usr/lib/7zip/7z\n`), text);
    assert.ok(text.includes(`node bin/electron-transplant install ${id} --from "$srcdir/build" \\\n    --layout package --prefix /usr --destdir "$pkgdir"\n`), text);
    assert.match(text, /distributes nothing from/);
    if (pin.dmg.retention === 'current-and-previous') assert.match(text, /keeps only its current and previous release downloadable/);
    // No paths, users or hosts from the machine that generated it.
    for (const personal of [os.homedir(), ROOT, '/home/', '/Users/', '/tmp/']) {
      for (const file of ['PKGBUILD', '.SRCINFO']) assert.ok(!fs.readFileSync(path.join(dir, file), 'utf8').includes(personal), `${id}/${file} mentions ${personal}`);
    }

    // .SRCINFO says what the PKGBUILD says.
    const info = parseSrcinfo(fs.readFileSync(path.join(dir, '.SRCINFO'), 'utf8'));
    for (const key of ['pkgver', 'pkgrel', 'pkgdesc', 'url', 'arch', 'license', 'depends', 'optdepends', 'makedepends', 'options', 'source', 'noextract', 'sha256sums']) assert.deepEqual(info[key], vars[key], `${id} .SRCINFO ${key}`);
    assert.deepEqual(info.conflicts, vars.conflicts?.length ? vars.conflicts : undefined);
  }
});

test('.SRCINFO is exactly what makepkg --printsrcinfo writes', { skip: !has('makepkg') && 'no makepkg (Arch only; CI runs it in an archlinux container)' }, () => {
  for (const id of listApps()) {
    const dir = path.join(ARCH_DIR, id);
    assert.equal(execFileSync('makepkg', ['--printsrcinfo'], { cwd: dir, encoding: 'utf8' }), fs.readFileSync(path.join(dir, '.SRCINFO'), 'utf8'), id);
  }
});

test('pins, variants, commits and pkgrel; pacman-safe versions', () => {
  const notion = generate('notion', { variant: 'x86_64', tool: { commit: 'a'.repeat(40) }, pkgrel: 3 });
  assert.equal(notion.fields.pkgrel, '3');
  assert.match(notion.pkgbuild, /^# Generated by `electron-transplant pkgbuild notion --variant x86_64`/);
  assert.ok(notion.fields.sources.some((s) => s.entry === `electron-transplant::git+https://github.com/wbunting/electron-transplant.git#commit=${'a'.repeat(40)}`));
  assert.ok(notion.fields.sources.some((s) => s.entry.startsWith('Notion-7.43.0.dmg::') && s.sha256 === doc.apps.notion.pins[1].dmg.sha256));
  assert.ok(notion.fields.sources.some((s) => s.entry.startsWith('better-sqlite3-13.0.1.tgz::')));
  assert.throws(() => generate('notion', { tool: { commit: 'abc123' } }), /full commit hash/);
  assert.throws(() => generate('notion', { pkgrel: 0 }), /pkgrel/);
  assert.throws(() => generate('linear', { version: '0.0.1' }), /no pin for 0\.0\.1/);
  assert.equal(require('../lib/pkgbuild.cjs').pkgver('1.2.3-beta 1'), '1.2.3_beta_1');
});

const isGit = spawnSync('git', ['-C', ROOT, 'rev-parse', '--git-dir']).status === 0;

test('--local packs this checkout beside the PKGBUILD; refs must pin the same DMG', { skip: !isGit && 'not a git checkout' }, async () => {
  const out = tmp('pkgbuild-local');
  const r = spawnSync(process.execPath, [CLI, 'pkgbuild', 'linear', '--local', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const tarball = fs.readdirSync(out).find((n) => n.endsWith('.tar.gz'));
  assert.match(tarball, /^electron-transplant-local-[0-9a-f]{12}\.tar\.gz$/);
  const listing = execFileSync('tar', ['-tzf', path.join(out, tarball)], { encoding: 'utf8' }).split('\n');
  assert.ok(listing.includes('electron-transplant/bin/electron-transplant'));
  assert.ok(!listing.some((n) => n.includes('node_modules/')));
  const { vars } = evaluate(out);
  const i = vars.source.indexOf(tarball);
  assert.notEqual(i, -1);
  assert.match(vars.sha256sums[i], /^[0-9a-f]{64}$/);
  assert.ok(!vars.noextract.includes(tarball));
  assert.equal(parseSrcinfo(fs.readFileSync(path.join(out, '.SRCINFO'), 'utf8')).source.join('\n'), vars.source.join('\n'));
  // A second run replaces the tarball rather than adding one.
  assert.equal((await localTarball(out)).file, tarball);
  assert.deepEqual(fs.readdirSync(out).filter((n) => n.endsWith('.tar.gz')), [tarball]);

  assert.match(spawnSync(process.execPath, [CLI, 'pkgbuild', 'linear', '--local'], { encoding: 'utf8' }).stderr, /pass --out DIR/);
  assert.match(spawnSync(process.execPath, [CLI, 'pkgbuild', 'linear', '--commit', 'HEAD', '--local'], { encoding: 'utf8' }).stderr, /Usage/);
  const pin = generate('linear').fields.pin;
  assert.throws(() => checkToolRef('linear', pin, { commit: 'f'.repeat(40) }), /is not in this checkout/);
  assert.deepEqual(checkToolRef('linear', pin, { tag: 'v0.0.0-none' }), ['tag v0.0.0-none is not in this checkout (git fetch --tags); the PKGBUILD needs it on GitHub']);
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.ok(Array.isArray(checkToolRef('linear', pin, { commit: head })));
});

test('the CLI prints a PKGBUILD, or writes it with .SRCINFO', () => {
  const printed = execFileSync(process.execPath, [CLI, 'pkgbuild', 'figma'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(printed, generate('figma').pkgbuild);
  const out = tmp('pkgbuild-out');
  execFileSync(process.execPath, [CLI, 'pkgbuild', 'superhuman', '--out', out], { stdio: 'ignore' });
  assert.deepEqual(fs.readdirSync(out).sort(), ['.SRCINFO', 'PKGBUILD']);
  assert.equal(execFileSync('bash', ['-n', path.join(out, 'PKGBUILD')], { encoding: 'utf8' }), '');
  assert.match(spawnSync(process.execPath, [CLI, 'pkgbuild', '--write', 'linear'], { encoding: 'utf8' }).stderr, /Usage: electron-transplant pkgbuild --write/);
});
