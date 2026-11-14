// Superhuman's Linux sign-in hand-off (browser extension and clipboard helper) and
// the installer's share/helpers support it uses. Fixtures are synthetic: never put
// a real callback URL here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadApp, validate } = require('../lib/apps.cjs');
const { install } = require('../lib/install.cjs');

const { config, dir } = loadApp('superhuman');
const SIGNIN = path.join(dir, config.install.share);
const { nativeCallback } = require(path.join(SIGNIN, 'browser-extension/callback.js'));
const helper = require(path.join(SIGNIN, 'finish-login.cjs'));
const fixtures = require('./fixtures/superhuman-login-callbacks.json');
const VALID = fixtures.find((f) => f.valid).url;
const expected = (url) => 'superhuman://~login/' + url.split('#').slice(1).join('#').replace(/#app$/, '');

for (const fixture of fixtures) {
  test(`superhuman callback: ${fixture.name}`, () => {
    assert.equal(nativeCallback(fixture.url), fixture.valid ? expected(fixture.url) : null);
  });
}

test('the extension has no permissions, background or broad page access', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SIGNIN, 'browser-extension/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  for (const key of ['permissions', 'host_permissions', 'optional_permissions', 'background', 'web_accessible_resources', 'externally_connectable']) {
    assert.equal(manifest[key], undefined, key);
  }
  assert.deepEqual(manifest.content_scripts.map((c) => c.matches), [['https://mail.superhuman.com/~login*']]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
});

// A fake exec for clipboard and notify-send calls; records every call.
function fakeExec(clipboard, { tools = ['wl-paste', 'wl-copy', 'notify-send'] } = {}) {
  const calls = [];
  const state = { clipboard };
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (!tools.includes(cmd)) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
    if (cmd === 'wl-paste' || cmd === 'xclip') return state.clipboard;
    if (cmd === 'wl-copy') state.clipboard = '';
    return '';
  };
  return { exec, calls, state };
}

function runHelper(clipboard, options = {}) {
  const fake = fakeExec(clipboard, options);
  const spawned = [];
  const logged = [];
  const launcher = options.launcher ?? process.execPath; // any executable file
  const code = helper.main(options.argv ?? [], {
    exec: fake.exec, log: (m) => logged.push(m), launcher,
    run: (cmd, args) => { spawned.push([cmd, ...args]); return { unref() {} }; },
  });
  return { code, spawned, logged, ...fake };
}

test('the helper forwards a valid callback to the app launcher and clears the clipboard', () => {
  const r = runHelper(VALID);
  assert.equal(r.code, 0);
  assert.deepEqual(r.spawned, [[process.execPath, '--', expected(VALID)]]);
  assert.equal(r.state.clipboard, '');
  assert.match(r.logged.join('\n'), /forwarded/);
});

test('the helper forwards nothing for anything but a native callback and never echoes the clipboard', () => {
  for (const fixture of fixtures.filter((f) => !f.valid)) {
    const r = runHelper(fixture.url, { argv: ['--notify'] });
    assert.equal(r.code, 1, fixture.name);
    assert.deepEqual(r.spawned, [], fixture.name);
    assert.equal(r.state.clipboard, fixture.url, `${fixture.name}: clipboard kept`);
    const said = JSON.stringify(r.calls.filter(([cmd]) => cmd === 'notify-send'));
    assert.ok(!said.includes('mail.superhuman.com') && !said.includes('SYNTHETIC'), `${fixture.name}: no URL in notification`);
  }
});

test('the helper keeps a newer clipboard and uses the system handler without a launcher', () => {
  const fake = fakeExec(VALID);
  const spawned = [];
  const exec = (cmd, args) => {
    const out = fake.exec(cmd, args);
    if (cmd === 'wl-paste' && fake.calls.filter(([c]) => c === 'wl-paste').length === 1) fake.state.clipboard = 'something new';
    return out;
  };
  const code = helper.main([], { exec, log: () => {}, launcher: '/nonexistent/launcher', run: (cmd, args) => { spawned.push([cmd, ...args]); return {}; } });
  assert.equal(code, 0);
  assert.deepEqual(spawned, [['gio', 'open', expected(VALID)]]);
  assert.equal(fake.state.clipboard, 'something new');
  assert.ok(!fake.calls.some(([cmd]) => cmd === 'wl-copy'));
});

test('the helper reports a missing clipboard tool', () => {
  const r = runHelper(VALID, { tools: [] });
  assert.equal(r.code, 1);
  assert.deepEqual(r.spawned, []);
  assert.match(r.logged.join('\n'), /wl-clipboard, xclip or xsel/);
});

test('install puts install.share at a fixed path and helpers run it with the app\'s Electron as Node', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'et-sh-install-'));
  try {
    const runtime = path.join(prefix, 'runtime');
    fs.mkdirSync(path.join(runtime, 'resources'), { recursive: true });
    // Records argv and the environment the helper gets.
    fs.writeFileSync(path.join(runtime, 'electron'), `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/argv"
echo "RUN_AS_NODE=\${ELECTRON_RUN_AS_NODE-unset}" >> "$HOME/argv"
echo "LAUNCHER=\${ET_APP_LAUNCHER-unset}" >> "$HOME/argv"
echo "ICON=\${ET_APP_ICON-unset}" >> "$HOME/argv"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(runtime, 'resources/app.asar'), 'asar');
    fs.writeFileSync(path.join(runtime, 'app-icon.png'), 'png');
    fs.writeFileSync(path.join(runtime, 'TRANSPLANT.json'), JSON.stringify({ version: '1045.0.0', urlSchemes: ['mailto', 'superhuman'], iconSize: 1024 }));

    assert.throws(() => install({ config, runtime, prefix, log: () => {} }), /config directory/);
    const result = install({ config, configDir: dir, runtime, prefix, log: () => {} });
    assert.deepEqual(result.schemes, ['mailto', 'superhuman']);
    assert.deepEqual(result.defaults, ['superhuman']);

    const share = path.join(prefix, 'share/superhuman-desktop');
    for (const file of ['finish-login.cjs', 'browser-extension/manifest.json', 'browser-extension/callback.js', 'browser-extension/content.js']) {
      assert.ok(fs.existsSync(path.join(share, file)), file);
    }
    // A reinstall replaces the directory: stale files go.
    fs.writeFileSync(path.join(share, 'stale'), '');
    install({ config, configDir: dir, runtime, prefix, log: () => {} });
    assert.ok(!fs.existsSync(path.join(share, 'stale')));
    assert.deepEqual(fs.readdirSync(path.join(prefix, 'share')).filter((n) => n.includes('staging')), []);

    const command = path.join(prefix, 'bin/superhuman-desktop-finish-login');
    execFileSync('bash', [command, '--notify'], { env: { PATH: process.env.PATH, HOME: prefix } });
    const argv = fs.readFileSync(path.join(prefix, 'argv'), 'utf8').trim().split('\n');
    assert.deepEqual(argv, [
      path.join(share, 'finish-login.cjs'), '--notify', 'RUN_AS_NODE=1',
      `LAUNCHER=${path.join(prefix, 'bin/superhuman-desktop')}`,
      `ICON=${path.join(prefix, 'share/icons/hicolor/1024x1024/apps/superhuman-desktop.png')}`,
    ]);

    const entry = fs.readFileSync(path.join(prefix, 'share/applications/superhuman-desktop-finish-login.desktop'), 'utf8');
    assert.match(entry, /^Name=Superhuman Desktop — Finish browser sign-in$/m);
    assert.ok(entry.split('\n').includes(`Exec=${command} --notify`), entry);
    assert.doesNotMatch(entry, /MimeType/);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test('install.share and install.helpers are validated', () => {
  const bad = (install) => () => validate({ ...config, install: { ...config.install, ...install } }, dir);
  assert.throws(bad({ share: '../linear' }), /install.share/);
  assert.throws(bad({ share: 'missing' }), /install.share/);
  assert.throws(bad({ share: undefined }), /need install.share/);
  assert.throws(bad({ helpers: [{ ...config.install.helpers[0], script: 'nope.cjs' }] }), /script not found/);
  assert.throws(bad({ helpers: [{ ...config.install.helpers[0], command: 'superhuman-desktop' }] }), /new lowercase id/);
  assert.throws(bad({ helpers: [{ ...config.install.helpers[0], args: ['$(rm)'] }] }), /plain words/);
});
