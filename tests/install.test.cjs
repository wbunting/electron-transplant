const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { install, launcherSource, desktopEntry } = require('../lib/install.cjs');
const { loadApp } = require('../lib/apps.cjs');

const { config: linear } = loadApp('linear');
const { config: notion } = loadApp('notion');

// A fake runtime whose "electron" records argv and the relevant environment.
function fakeRuntime(dir, transplant, asarText = 'asar') {
  const runtime = path.join(dir, 'runtime');
  fs.mkdirSync(path.join(runtime, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'electron'), `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/argv"
echo "RUN_AS_NODE=\${ELECTRON_RUN_AS_NODE-unset}" >> "$HOME/argv"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(runtime, 'resources/app.asar'), asarText);
  fs.writeFileSync(path.join(runtime, 'app-icon.png'), 'png');
  fs.writeFileSync(path.join(runtime, 'TRANSPLANT.json'), JSON.stringify({ version: '1.2.3', urlSchemes: [], iconSize: 512, ...transplant }));
  return runtime;
}

function launch(prefix, command, env, args = []) {
  execFileSync('bash', [path.join(prefix, 'bin', command), ...args], {
    env: { PATH: process.env.PATH, HOME: prefix, XDG_CACHE_HOME: path.join(prefix, 'cache'), ELECTRON_RUN_AS_NODE: '1', ...env },
  });
  return fs.readFileSync(path.join(prefix, 'argv'), 'utf8').trim().split('\n');
}

test('install lays out a versioned runtime, launcher, icon and desktop entry with the app\'s schemes', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'et-install-'));
  const runtime = fakeRuntime(prefix, { urlSchemes: ['notion', 'notion-agents'] });
  const first = install({ config: notion, runtime, prefix, log: () => {} });
  assert.match(first.id, /^1\.2\.3-local-[0-9a-f]{12}$/);
  assert.deepEqual(first.schemes, ['notion', 'notion-agents']);
  const base = path.join(prefix, 'opt/notion-desktop');
  assert.equal(fs.readlinkSync(path.join(base, 'current')), first.id);
  assert.ok(fs.statSync(path.join(base, first.id, 'electron')).mode & 0o100);
  assert.ok(fs.existsSync(path.join(prefix, 'share/icons/hicolor/512x512/apps/notion-desktop.png')));
  const desktop = fs.readFileSync(path.join(prefix, 'share/applications/notion-desktop.desktop'), 'utf8');
  assert.match(desktop, /^StartupWMClass=notion-desktop$/m);
  assert.match(desktop, new RegExp(`^Icon=${path.join(prefix, 'share/icons/hicolor/512x512/apps/notion-desktop.png').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(desktop, /^MimeType=x-scheme-handler\/notion;x-scheme-handler\/notion-agents;$/m);
  assert.match(desktop, new RegExp(`^Exec="${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/notion-desktop" -- %u$`, 'm'));

  // A new build becomes current; the old runtime stays for rollback.
  fs.writeFileSync(path.join(runtime, 'resources/app.asar'), 'asar v2');
  const second = install({ config: notion, runtime, prefix, log: () => {} });
  assert.notEqual(second.id, first.id);
  assert.equal(fs.readlinkSync(path.join(base, 'current')), second.id);
  assert.ok(fs.existsSync(path.join(base, first.id)));
});

test('the launcher uses Wayland when available, forwards the URL last and passes no sandbox switches', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'et-launcher-'));
  install({ config: linear, runtime: fakeRuntime(prefix, {}), prefix, log: () => {} });
  const argv = launch(prefix, 'linear-desktop', { WAYLAND_DISPLAY: 'wayland-1' }, ['--', 'linear://linear.app/auth/desktop-redirect']);
  assert.deepEqual(argv.slice(0, 2), ['--ozone-platform=wayland', '--enable-wayland-ime']);
  assert.equal(argv.at(-2), 'linear://linear.app/auth/desktop-redirect');
  assert.equal(argv.at(-1), 'RUN_AS_NODE=unset');
  // Linear exits on these (findDangerousSwitch); no app should need them.
  assert.deepEqual(argv.filter((a) => /^--(no-sandbox|disable-(setuid|namespace|gpu)-sandbox|remote-debugging|inspect|js-flags|proxy-)/.test(a)), []);
  assert.ok(launch(prefix, 'linear-desktop', { WAYLAND_DISPLAY: 'wayland-1', LINEAR_USE_WAYLAND: '0' }).includes('--ozone-platform=x11'));
  // The other app's prefix doesn't leak in.
  assert.match(launcherSource(notion), /NOTION_USE_WAYLAND/);
  assert.doesNotMatch(launcherSource(notion), /LINEAR_/);
});

test('desktop entries quote Exec per the spec and stay on one line per key', () => {
  const entry = desktopEntry({ ...notion, name: 'No\ntion', install: { ...notion.install, comment: 'a\nb' } }, '/home/a "b"/$x', []);
  assert.match(entry, /^Exec="\/home\/a \\"b\\"\/\\\$x\/bin\/notion-desktop" -- %u$/m);
  assert.match(entry, /^Name=No tion$/m);
  assert.doesNotMatch(entry, /MimeType/);
});

test('an existing icon cache is regenerated so launchers that trust it see the new icon', (t) => {
  try { execFileSync('gtk-update-icon-cache', ['--help'], { stdio: 'ignore' }); } catch (error) {
    if (error.code === 'ENOENT') return t.skip('gtk-update-icon-cache not installed');
  }
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'et-iconcache-'));
  const theme = path.join(prefix, 'share/icons/hicolor');
  fs.mkdirSync(path.join(theme, '256x256/apps'), { recursive: true });
  fs.writeFileSync(path.join(theme, '256x256/apps/other.png'), 'png');
  execFileSync('gtk-update-icon-cache', ['-f', '-q', '-t', theme]);
  assert.doesNotMatch(fs.readFileSync(path.join(theme, 'icon-theme.cache'), 'latin1'), /notion-desktop/);
  install({ config: notion, runtime: fakeRuntime(prefix, {}), prefix, log: () => {} });
  const cache = fs.readFileSync(path.join(theme, 'icon-theme.cache'), 'latin1');
  assert.match(cache, /notion-desktop/);
  assert.match(cache, /other/);

  // No cache: none is created.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'et-nocache-'));
  install({ config: notion, runtime: fakeRuntime(bare, {}), prefix: bare, log: () => {} });
  assert.equal(fs.existsSync(path.join(bare, 'share/icons/hicolor/icon-theme.cache')), false);
});
