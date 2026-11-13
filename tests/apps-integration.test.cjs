// The real pipeline on every app whose pinned DMG is in ~/Downloads: extract,
// verify, patch, assemble. Offline once Electron is cached. ET_SMOKE=1 also launches
// each build headless (network: the apps load their web clients) and checks that
// the main window gets traffic lights and nothing crashes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listApps, loadApp } = require('../lib/apps.cjs');
const { build, dmgDir, dmgPattern } = require('../lib/build.cjs');
const { hashFile } = require('../lib/util.cjs');
const { readEvents } = require('./support/probe-app.cjs');

async function pinnedDmg(config) {
  const dir = dmgDir(config);
  if (!fs.existsSync(dir)) return null;
  const pattern = dmgPattern(config);
  for (const name of fs.readdirSync(dir).filter((n) => pattern.test(n))) {
    const file = path.join(dir, name);
    const sha = await hashFile(file);
    if (config.pins.some((pin) => pin.sha256 === sha)) return file;
  }
  return null;
}

for (const id of listApps()) {
  test(`${id}: pinned DMG builds into a Linux runtime`, async (t) => {
    const { config, dir } = loadApp(id);
    const dmg = await pinnedDmg(config);
    if (!dmg) return t.skip(`no pinned ${config.dmg.glob} in ${dmgDir(config)}`);
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `et-build-${id}-`));
    try {
      const lines = [];
      const result = await build({ config, configDir: dir, dmg, workRoot, log: (line) => lines.push(line) });
      for (const patch of config.patches ?? []) assert.ok(lines.includes(`  patch ${patch.name}: applied`), `${patch.name} not applied`);
      const transplant = JSON.parse(fs.readFileSync(path.join(result.runtime, 'TRANSPLANT.json'), 'utf8'));
      assert.equal(transplant.app, id);
      assert.equal(transplant.dmg.pinned, true);
      assert.ok(fs.existsSync(path.join(result.runtime, 'electron')));
      assert.ok(!fs.existsSync(path.join(result.runtime, 'resources/default_app.asar')));
      for (const name of config.resources?.drop ?? []) assert.ok(!fs.existsSync(path.join(result.runtime, 'resources', name)), name);
      for (const file of Object.keys(config.nativeFiles ?? {})) assert.ok(!fs.existsSync(path.join(result.appDir, file)), file);
      for (const file of Object.keys(config.addFiles ?? {})) assert.ok(fs.existsSync(path.join(result.appDir, file)), file);
      for (const { to } of config.resources?.derive ?? []) assert.ok(fs.existsSync(path.join(result.runtime, 'resources', to)), to);
      assert.deepEqual(fs.readdirSync(path.join(result.runtime, 'resources')).filter((n) => n.includes(':')), []);

      if (process.env.ET_SMOKE !== '1') return;
      const out = path.join(workRoot, 'smoke');
      const script = path.join(workRoot, 'smoke.json');
      fs.writeFileSync(script, JSON.stringify([{ wait: 1000, bounds: [1280, 800] }, { wait: 15000, state: true }]));
      execFileSync('node', [path.join(__dirname, '../scripts/dev-snapshot.cjs'), result.runtime, out, script], { stdio: 'ignore', timeout: 180000 });
      const harness = fs.readFileSync(path.join(out, 'harness.log'), 'utf8');
      // Apps that keep their own window buttons (Figma's non-macOS tab bar) get none.
      if (config.smoke?.trafficLights !== false) assert.match(harness, /"lights",\{"x":\d+,"y":\d+,"width":54,"height":16\}/);
      else assert.doesNotMatch(harness, /"lights"/);
      const events = readEvents(path.join(out, 'events.jsonl'));
      assert.equal(events[0].kind, 'session');
      assert.deepEqual(events.filter((e) => e.kind === 'uncaught' || e.kind === 'native-load-failed'), []);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });
}
