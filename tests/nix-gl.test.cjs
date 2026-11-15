// The Nix launchers' GPU driver setup outside NixOS (nix/gl-setup.sh, run by the
// wrapper nix/app.nix puts around each app's launcher) and the xdg-open that gives
// opened programs the host's setup back (nix/host-xdg-open.sh).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NIX = path.join(__dirname, '../nix');
const SETUP = fs.readFileSync(path.join(NIX, 'gl-setup.sh'), 'utf8');
const VARS = ['GBM_BACKENDS_PATH', 'LIBGL_DRIVERS_PATH', '__EGL_VENDOR_LIBRARY_FILENAMES', 'VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'ET_NIX_GL_VARS'];

// A fake Mesa, render nodes and log directory; the snippet with them substituted.
function fixture({ driverLink = false, gpus = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-nix-gl-'));
  const mesa = path.join(dir, 'mesa');
  for (const sub of ['lib/gbm', 'lib/dri', 'share/glvnd/egl_vendor.d', 'share/vulkan/icd.d']) fs.mkdirSync(path.join(mesa, sub), { recursive: true });
  for (const icd of ['intel_icd.x86_64.json', 'radeon_icd.x86_64.json']) fs.writeFileSync(path.join(mesa, 'share/vulkan/icd.d', icd), '{}');
  const drm = path.join(dir, 'drm');
  gpus.forEach((driver, i) => {
    fs.mkdirSync(path.join(dir, 'drivers', driver), { recursive: true });
    fs.mkdirSync(path.join(drm, `renderD${128 + i}`, 'device'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'drivers', driver), path.join(drm, `renderD${128 + i}`, 'device', 'driver'));
  });
  fs.mkdirSync(drm, { recursive: true });
  if (driverLink) fs.mkdirSync(path.join(dir, 'opengl-driver'));
  const values = {
    envPrefix: 'DEMO', installId: 'demo-desktop', command: 'demo-desktop',
    driverLink: path.join(dir, 'opengl-driver'), drmClass: drm, mesa, hostEnv: path.join(dir, 'host-env'),
  };
  const script = SETUP.replace(/@(\w+)@/g, (_, name) => {
    assert.ok(name in values, `gl-setup.sh: unknown @${name}@`);
    return values[name];
  });
  fs.writeFileSync(path.join(dir, 'gl-setup.sh'), script);
  return { dir, mesa, values };
}

// Runs the snippet as the wrapper does (bash -e, then exec with "$@").
function setup(fx, env = {}, args = ['--', 'demo://x']) {
  const print = `${VARS.map((v) => `printf '%s=%s\\n' ${v} "\${${v}-<unset>}"`).join('\n')}
printf 'PATH=%s\\n' "$PATH"
printf 'BEFORE=%s\\n' "$before"
printf 'ARGS=%s\\n' "$*"`;
  const result = spawnSync('bash', ['-e', '-c', `before=$PATH\n. "$0"\n${print}`, path.join(fx.dir, 'gl-setup.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fx.dir, XDG_CACHE_HOME: path.join(fx.dir, 'cache'), ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  const out = Object.fromEntries(result.stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const logFile = path.join(fx.dir, 'cache/demo-desktop/launcher.log');
  // PATH as bash started (a profile script may add to it), for comparisons.
  const before = out.BEFORE;
  delete out.BEFORE;
  return { out, before, stderr: result.stderr, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
}

const untouched = ({ out, before }) => {
  for (const v of VARS) assert.equal(out[v], '<unset>', v);
  assert.equal(out.PATH, before);
  assert.equal(out.ARGS, '-- demo://x');
};

test('outside NixOS the launcher uses nixpkgs\' Mesa and says so in launcher.log', () => {
  for (const gpus of [[], ['amdgpu'], ['i915', 'nvidia']]) {
    const fx = fixture({ gpus });
    const { out, before, stderr, log } = setup(fx);
    assert.equal(out.GBM_BACKENDS_PATH, `${fx.mesa}/lib/gbm`);
    assert.equal(out.LIBGL_DRIVERS_PATH, `${fx.mesa}/lib/dri`);
    assert.equal(out.__EGL_VENDOR_LIBRARY_FILENAMES, `${fx.mesa}/share/glvnd/egl_vendor.d/50_mesa.json`);
    assert.equal(out.VK_DRIVER_FILES, ['intel', 'radeon'].map((n) => `${fx.mesa}/share/vulkan/icd.d/${n}_icd.x86_64.json`).join(':'));
    assert.equal(out.ET_NIX_GL_VARS, 'GBM_BACKENDS_PATH LIBGL_DRIVERS_PATH __EGL_VENDOR_LIBRARY_FILENAMES VK_DRIVER_FILES');
    assert.equal(out.PATH, `${fx.values.hostEnv}:${before}`);
    assert.equal(out.ARGS, '-- demo://x');
    assert.equal(stderr, '', gpus.join());
    assert.equal(log, `demo-desktop: graphics: nixpkgs' Mesa (${fx.mesa}); DEMO_NIX_GL=host|software overrides\n`);
  }
});

test('NixOS (the driver link exists) and a GL setup of the user\'s own (nixGL) are left alone', () => {
  for (const [fx, env] of [
    [fixture({ driverLink: true }), {}],
    [fixture(), { __EGL_VENDOR_LIBRARY_FILENAMES: '/nixgl/50_mesa.json' }],
    [fixture(), { GBM_BACKENDS_PATH: '/nixgl/gbm' }],
    [fixture({ driverLink: false }), { DEMO_NIX_GL: 'host' }],
  ]) {
    const { out, before, stderr, log } = setup(fx, env);
    for (const v of VARS) assert.equal(out[v], env[v] ?? '<unset>', v);
    assert.equal(out.PATH, before);
    assert.equal(out.ARGS, '-- demo://x');
    assert.equal(stderr + log, '');
  }
});

test('with only NVIDIA\'s driver it renders in software and points at nixGLNvidia, once', () => {
  const fx = fixture({ gpus: ['nvidia'] });
  const { out, stderr, log } = setup(fx);
  for (const v of VARS) assert.equal(out[v], '<unset>', v);
  assert.equal(out.ARGS, '--use-angle=swiftshader --disable-gpu-compositing -- demo://x');
  assert.match(stderr, /^demo-desktop: .*software.* nix run --impure github:nix-community\/nixGL#nixGLNvidia -- demo-desktop .*DEMO_NIX_GL=software/);
  assert.equal(stderr.trim().split('\n').length, 1);
  assert.equal(log, stderr);
  // Asked for explicitly: no message.
  const quiet = setup(fixture({ gpus: ['nvidia'] }), { DEMO_NIX_GL: 'software' });
  assert.equal(quiet.out.ARGS, '--use-angle=swiftshader --disable-gpu-compositing -- demo://x');
  assert.equal(quiet.stderr + quiet.log, '');
});

test('DEMO_NIX_GL=mesa overrides the driver link; Vulkan settings of the user\'s own stay; unknown values warn', () => {
  const forced = setup(fixture({ driverLink: true }), { DEMO_NIX_GL: 'mesa', VK_ICD_FILENAMES: '/etc/my_icd.json' });
  assert.match(forced.out.GBM_BACKENDS_PATH, /\/mesa\/lib\/gbm$/);
  assert.equal(forced.out.VK_DRIVER_FILES, '<unset>');
  assert.equal(forced.out.VK_ICD_FILENAMES, '/etc/my_icd.json');
  assert.equal(forced.out.ET_NIX_GL_VARS, 'GBM_BACKENDS_PATH LIBGL_DRIVERS_PATH __EGL_VENDOR_LIBRARY_FILENAMES');

  const typo = setup(fixture({ driverLink: true }), { DEMO_NIX_GL: 'nvidia' });
  untouched(typo);
  assert.equal(typo.stderr, 'demo-desktop: unknown DEMO_NIX_GL=nvidia (auto, host, mesa or software); using auto\n');
});

test('host-env/xdg-open drops the Mesa setup and itself from PATH, then runs the next xdg-open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-nix-xdg-'));
  const hostEnv = path.join(dir, 'host-env');
  const next = path.join(dir, 'bin');
  fs.mkdirSync(hostEnv);
  fs.mkdirSync(next);
  fs.copyFileSync(path.join(NIX, 'host-xdg-open.sh'), path.join(hostEnv, 'xdg-open'));
  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(next, 'xdg-open'), `#!${bash}
printf 'args=%s\\n' "$*"
printf 'PATH=%s\\n' "$PATH"
for v in ${VARS.join(' ')} OTHER; do printf '%s=%s\\n' "$v" "\${!v-<unset>}"; done
`, { mode: 0o755 });
  const result = spawnSync('bash', [path.join(hostEnv, 'xdg-open'), 'https://example.com/a b'], {
    encoding: 'utf8',
    env: {
      PATH: `${hostEnv}:${next}:${process.env.PATH}`,
      GBM_BACKENDS_PATH: '/m/gbm', LIBGL_DRIVERS_PATH: '/m/dri', __EGL_VENDOR_LIBRARY_FILENAMES: '/m/50_mesa.json',
      VK_DRIVER_FILES: '/m/icd.json', VK_ICD_FILENAMES: '/users/own.json', OTHER: 'kept',
      ET_NIX_GL_VARS: 'GBM_BACKENDS_PATH LIBGL_DRIVERS_PATH __EGL_VENDOR_LIBRARY_FILENAMES VK_DRIVER_FILES',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.deepEqual(lines, [
    'args=https://example.com/a b',
    `PATH=${next}:${process.env.PATH}`,
    ...VARS.map((v) => `${v}=${v === 'VK_ICD_FILENAMES' ? '/users/own.json' : '<unset>'}`),
    'OTHER=kept',
  ]);
});

test('nix/app.nix runs gl-setup.sh in the app launcher\'s wrapper with every placeholder filled', () => {
  const appNix = fs.readFileSync(path.join(NIX, 'app.nix'), 'utf8');
  const placeholders = new Set([...SETUP.matchAll(/@(\w+)@/g)].map((m) => m[1]));
  const substituted = new Set([...appNix.matchAll(/--subst-var-by (\w+) /g)].map((m) => m[1]));
  assert.deepEqual([...substituted].sort(), [...placeholders].sort());
  assert.match(appNix, /substitute \$\{\.\/gl-setup\.sh\} "\$NIX_BUILD_TOP\/gl-setup\.sh"/);
  assert.match(appNix, /--subst-var-by hostEnv "\$out\/libexec\/\$\{installId\}\/host-env"/);
  assert.match(appNix, /install -D -m 755 \$\{\.\/host-xdg-open\.sh\} "\$out\/libexec\/\$\{installId\}\/host-env\/xdg-open"/);
  // Only the app's own launcher: helpers run Electron as Node.
  assert.match(appNix, /if \[\[ "\$program" == "\$out\/bin\/\$\{command\}" \]\]; then\n\s+glSetup=\(--run "\$\(< "\$NIX_BUILD_TOP\/gl-setup\.sh"\)"\)/);
  assert.match(appNix, /wrapProgramShell "\$program" [^\n]*\n[^\n]*\n\s+"''\$\{glSetup\[@\]\}"/);
  assert.match(appNix, /--subst-var-by driverLink \$\{addDriverRunpath\.driverLink\}/);
  assert.match(appNix, /--subst-var-by mesa \$\{mesa\}/);
});
