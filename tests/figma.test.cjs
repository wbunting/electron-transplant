// Figma's Linux modules (apps/figma/linux): the fontconfig font list in the shape
// of Figma's macOS addon, the variable-font reader, MCP port-conflict reporting
// and the clipboard sign-in handoff. No Figma download or network needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fonts = require('../apps/figma/linux/fonts.cjs');
const { readVariationInfo } = require('../apps/figma/linux/sfnt.cjs');
const hooks = require('../apps/figma/linux/hooks.cjs');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `et-figma-${name}-`));

// --- sfnt ---------------------------------------------------------------------

function nameTable(entries) {
  const records = [];
  const strings = [];
  let offset = 0;
  for (const [id, text] of entries) {
    const bytes = Buffer.from(text, 'utf16le').swap16();
    records.push([3, 1, 0x409, id, bytes.length, offset]);
    strings.push(bytes);
    offset += bytes.length;
  }
  const head = Buffer.alloc(6 + 12 * records.length);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  records.forEach((r, i) => r.forEach((v, j) => head.writeUInt16BE(v, 6 + 12 * i + 2 * j)));
  return Buffer.concat([head, ...strings]);
}

function fvarTable(axes, instances) {
  const axisSize = 20;
  const instanceSize = 6 + 4 * axes.length;
  const out = Buffer.alloc(16 + axes.length * axisSize + instances.length * instanceSize);
  [1, 0, 16, 2, axes.length, axisSize, instances.length, instanceSize].forEach((v, i) => out.writeUInt16BE(v, 2 * i));
  axes.forEach((a, i) => {
    const at = 16 + i * axisSize;
    out.write(a.tag, at, 'latin1');
    [a.min, a.def, a.max].forEach((v, j) => out.writeInt32BE(Math.round(v * 65536), at + 4 + 4 * j));
    out.writeUInt16BE(a.hidden ? 1 : 0, at + 16);
    out.writeUInt16BE(a.nameId, at + 18);
  });
  instances.forEach((inst, i) => {
    const at = 16 + axes.length * axisSize + i * instanceSize;
    out.writeUInt16BE(inst.nameId, at);
    inst.coords.forEach((v, j) => out.writeInt32BE(Math.round(v * 65536), at + 4 + 4 * j));
    out.writeUInt16BE(inst.psId ?? 0xffff, at + 4 + 4 * axes.length);
  });
  return out;
}

function sfnt(tables) {
  const tags = Object.keys(tables).sort();
  const head = Buffer.alloc(12 + 16 * tags.length);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(tags.length, 4);
  let offset = head.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const body = tables[tag];
    head.write(tag, 12 + 16 * i, 'latin1');
    head.writeUInt32BE(offset, 12 + 16 * i + 8);
    head.writeUInt32BE(body.length, 12 + 16 * i + 12);
    const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([head, ...bodies]);
}

function variableFont(file) {
  fs.writeFileSync(file, sfnt({
    name: nameTable([[256, 'Weight'], [257, 'Optical size'], [258, 'Bold'], [259, 'Probe-Bold']]),
    fvar: fvarTable(
      [{ tag: 'wght', min: 100, def: 400, max: 900, nameId: 256 }, { tag: 'opsz', min: 8, def: 14, max: 32, nameId: 257, hidden: true }],
      [{ nameId: 258, coords: [700, 14], psId: 259 }],
    ),
  }));
}

test('the sfnt reader returns fvar axes and named instances with their names', () => {
  const file = path.join(tmp('sfnt'), 'Probe.ttf');
  variableFont(file);
  assert.deepEqual(readVariationInfo(file), {
    axes: [
      { tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900, hidden: false },
      { tag: 'opsz', name: 'Optical size', min: 8, default: 14, max: 32, hidden: true },
    ],
    instances: [{ name: 'Bold', postscript: 'Probe-Bold', coords: { wght: 700, opsz: 14 } }],
  });
  const plain = path.join(path.dirname(file), 'Static.ttf');
  fs.writeFileSync(plain, sfnt({ name: nameTable([[1, 'Static']]) }));
  assert.equal(readVariationInfo(plain), null);
  // Truncated or hostile files fail cleanly.
  const bad = path.join(path.dirname(file), 'Bad.ttf');
  fs.writeFileSync(bad, fs.readFileSync(file).subarray(0, 40));
  assert.throws(() => readVariationInfo(bad), /sfnt:/);
  assert.throws(() => readVariationInfo(file, 1), /no such face/);
});

// --- fonts ----------------------------------------------------------------------

test('fontconfig rows become Figma font entries: weights, widths, italics, user fonts, outline formats only', () => {
  const home = '/home/u';
  const rows = fonts.parseFcList([
    '/usr/share/fonts/A-Regular.ttf\t0\tAlpha\tRegular\tAlpha-Regular\t80\t0\t100\tFalse\tTrueType',
    '/usr/share/fonts/A-BoldItalic.otf\t0\tAlpha\tBold Italic\tAlpha-BoldItalic\t200\t100\t75\tFalse\tCFF',
    '/home/u/.local/share/fonts/Mine.ttf\t0\tMine\t\t\t50\t0\t100\tFalse\tTrueType',
    '/usr/share/fonts/misc/fixed.pcf.gz\t0\tFixed\tRegular\t\t80\t0\t100\tFalse\tPCF',
    'relative.ttf\t0\tNope\tRegular\tNope\t80\t0\t100\tFalse\tTrueType',
    'garbage',
  ].join('\n'));
  assert.equal(rows.length, 3);
  const map = fonts.buildFontMap(rows, { userDirs: fonts.userFontDirs({}, home), stat: () => ({ mtimeMs: 1_700_000_000_500 }), variationOf: () => null });
  assert.deepEqual(map['/usr/share/fonts/A-BoldItalic.otf'], [{
    family: 'Alpha', style: 'Bold Italic', postscript: 'Alpha-BoldItalic', weight: 700, stretch: 3, italic: true,
    variationAxes: [], modified_at: 1_700_000_000, user_installed: false,
  }]);
  assert.equal(map['/usr/share/fonts/A-Regular.ttf'][0].weight, 400);
  assert.deepEqual(
    (({ style, postscript, weight, user_installed }) => ({ style, postscript, weight, user_installed }))(map['/home/u/.local/share/fonts/Mine.ttf'][0]),
    { style: 'Regular', postscript: 'Mine-Regular', weight: 300, user_installed: true },
  );
  assert.deepEqual(Object.keys(map).sort(), ['/home/u/.local/share/fonts/Mine.ttf', '/usr/share/fonts/A-BoldItalic.otf', '/usr/share/fonts/A-Regular.ttf']);
  // fontconfig's weight scale maps onto OpenType's, including between stops.
  assert.deepEqual([0, 40, 50, 80, 100, 180, 200, 210, 215, 90].map(fonts.openTypeWeight), [100, 200, 300, 400, 500, 600, 700, 900, 1000, 450]);
});

test('variable fonts: one entry per named instance with its axis values; range-only fonts get a default entry', () => {
  const dir = tmp('var');
  const file = path.join(dir, 'Probe.ttf');
  variableFont(file);
  const text = [
    `${file}\t0\tProbe\t\t\t[0 210]\t0\t100\tTrue\tTrueType`,
    `${file}\t65536\tProbe\tBold\tProbe-Bold\t200\t0\t100\tFalse\tTrueType`,
  ].join('\n');
  const map = fonts.buildFontMap(fonts.parseFcList(text), { userDirs: [] });
  assert.equal(map[file].length, 1);
  assert.deepEqual(map[file][0].variationAxes, [
    { tag: 'wght', name: 'Weight', value: 700, min: 100, max: 900, default: 400, hidden: false },
    { tag: 'opsz', name: 'Optical size', value: 14, min: 8, max: 32, default: 14, hidden: true },
  ]);
  const rangeOnly = fonts.buildFontMap(fonts.parseFcList(text.split('\n')[0]), { userDirs: [] });
  assert.equal(rangeOnly[file][0].style, 'Regular');
  assert.deepEqual(rangeOnly[file][0].variationAxes.map((a) => a.value), [400, 14]);
});

test('the module has the addon interface and lists real fonts when fontconfig is present', (t) => {
  for (const name of ['getFonts', 'getFontsModifiedAt', 'getModifiedFonts', 'getFontPreview']) assert.equal(typeof fonts[name], 'function');
  assert.equal(fonts.getFontPreview('/x', 12), '');
  try { require('node:child_process').execFileSync('fc-list', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('no fc-list'); }
  const list = JSON.parse(fonts.getFonts());
  for (const [file, entries] of Object.entries(list)) {
    assert.ok(path.isAbsolute(file));
    for (const e of entries) assert.deepEqual(Object.keys(e), ['family', 'style', 'postscript', 'weight', 'stretch', 'italic', 'variationAxes', 'modified_at', 'user_installed']);
  }
  // Stable while nothing changes, so Figma's polling doesn't rescan in a loop.
  assert.equal(fonts.getFontsModifiedAt(), fonts.getFontsModifiedAt());
});

// --- MCP port ---------------------------------------------------------------------

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0F05 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0F05 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0000000000000000 20 4 30 10 -1
   2: 0A000001:0F05 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6666 1 0000000000000000 100 0 0 10 0
   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0000000000000000 100 0 0 10 0
`;

test('the MCP port owner is found from /proc: listening loopback sockets, then the holding process', () => {
  assert.deepEqual([...hooks.listeningInodes([TCP], 3845)], ['4242']);
  const proc = tmp('proc');
  for (const [pid, socket, exe] of [['100', '4242', '/opt/figma-linux-next/figma-linux-next'], ['200', '9999', '/usr/bin/other']]) {
    fs.mkdirSync(path.join(proc, pid, 'fd'), { recursive: true });
    fs.symlinkSync(`socket:[${socket}]`, path.join(proc, pid, 'fd', '7'));
    fs.symlinkSync(exe, path.join(proc, pid, 'exe'));
  }
  fs.mkdirSync(path.join(proc, 'self'));
  assert.deepEqual(hooks.socketOwners(new Set(['4242']), proc), [{ pid: 100, name: 'figma-linux-next' }]);
  const { message, detail } = hooks.mcpConflictMessage(3845, [{ pid: 100, name: 'figma-linux-next' }], 'FIGMA_DESKTOP_MCP_PORT');
  assert.match(message, /127\.0\.0\.1:3845 is in use by figma-linux-next \(PID 100\)/);
  assert.match(detail, /FIGMA_DESKTOP_MCP_PORT=<port>/);
});

test('setEnableMCP: EADDRINUSE is recorded, explained once and still rejected; a port override is applied', async () => {
  function setup(envValues) {
    const handlers = new Map();
    const dialogs = [];
    const events = [];
    const seen = [];
    const electron = {
      ipcMain: { handle(channel, fn) { handlers.set(channel, fn); } },
      dialog: { showMessageBox: async (...args) => { dialogs.push(args.at(-1)); return { response: 0 }; } },
      BrowserWindow: { getFocusedWindow: () => null },
    };
    hooks.installMcpPortHandling({ electron, env: (n) => envValues[n], envPrefix: 'FIGMA_DESKTOP', record: (e) => events.push(e) });
    // Figma's handler: port 3845 is taken (as by figma-linux-next).
    electron.ipcMain.handle('web:setEnableMCP', async (_event, enabled, port) => {
      seen.push(port);
      if (port === 3845) throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:3845');
      return { didStart: enabled, port };
    });
    electron.ipcMain.handle('web:other', async () => 'untouched');
    const call = (...args) => handlers.get('web:setEnableMCP')({}, ...args);
    return { call, handlers, dialogs, events, seen };
  }
  const plain = setup({});
  await assert.rejects(plain.call(true, 3845), /EADDRINUSE/);
  await assert.rejects(plain.call(true, 3845), /EADDRINUSE/);
  assert.equal(plain.dialogs.length, 1);
  assert.match(plain.dialogs[0].message, /could not start: 127\.0\.0\.1:3845 is in use/);
  assert.deepEqual(plain.events.map((e) => [e.kind, e.api]), [['mcp-port-in-use', '127.0.0.1:3845'], ['mcp-port-in-use', '127.0.0.1:3845']]);
  assert.equal(await plain.handlers.get('web:other')(), 'untouched');

  const override = setup({ MCP_PORT: '38450' });
  assert.deepEqual(await override.call(true, 3845), { didStart: true, port: 38450 });
  // Disabling passes the original port through.
  await override.call(false, 3845).catch(() => {});
  assert.deepEqual(override.seen, [38450, 3845]);

  const invalid = setup({ MCP_PORT: '80' });
  await assert.rejects(invalid.call(true, 3845), /EADDRINUSE/);
  assert.deepEqual(invalid.seen, [3845]);
});

// --- sign-in --------------------------------------------------------------------

test('only a single-secret Figma app_auth redeem link is accepted from the clipboard', () => {
  const secret = 'AbC123_-.~xyz9';
  for (const ok of [`figma://app_auth/redeem?g_secret=${secret}`, `https://www.figma.com/app_auth/redeem?g_secret=${secret}`, `  figma://app_auth/redeem?g_secret=${secret}\n`]) {
    assert.equal(hooks.signInRedeemUrl(ok), ok.trim(), ok);
  }
  for (const bad of [
    '', 'hello', `figma://file/abc?g_secret=${secret}`, `https://evil.example/app_auth/redeem?g_secret=${secret}`,
    `https://www.figma.com.evil.example/app_auth/redeem?g_secret=${secret}`, `http://www.figma.com/app_auth/redeem?g_secret=${secret}`,
    `figma://app_auth/redeem?g_secret=${secret}&g_secret=x1234567`, 'figma://app_auth/redeem?g_secret=short', `figma://app_auth/redeem?g_secret=${secret}#x`,
    `figma://app_auth/redeem?g_secret=${secret} --inspect`, `figma://u:p@app_auth/redeem?g_secret=${secret}`, `figma://app_auth/redeem?g_secret=${'a'.repeat(9000)}`,
  ]) {
    assert.equal(hooks.signInRedeemUrl(bad), null, bad.slice(0, 80));
  }
});

test('--finish-sign-in forwards the link after "--" only to a running instance, and never echoes it', () => {
  const url = 'figma://app_auth/redeem?g_secret=AbC123_-.~xyz9';
  const run = ({ clipboard, running = 1234 }) => {
    const said = [];
    const exits = [];
    const cleared = [];
    const argv = ['/opt/electron', '--ozone-platform=wayland', '--enable-wayland-ime', '--finish-sign-in'];
    const outcome = hooks.finishSignIn({
      electron: { app: { getPath: () => '/tmp/appData', exit: (code) => exits.push(code) } },
      argv, read: () => clipboard, running: () => running, say: (m) => said.push(m), clear: (v) => cleared.push(v),
    });
    return { outcome, argv, said, exits, cleared };
  };
  const ok = run({ clipboard: `${url}\n` });
  assert.equal(ok.outcome, 'forwarded');
  assert.deepEqual(ok.argv, ['/opt/electron', '--ozone-platform=wayland', '--enable-wayland-ime', '--', url]);
  assert.deepEqual(ok.cleared, [url]);
  assert.deepEqual(ok.exits, []);

  const notRunning = run({ clipboard: url, running: null });
  assert.equal(notRunning.outcome, 'failed');
  assert.deepEqual(notRunning.exits, [1]);
  assert.ok(!notRunning.argv.includes(url));

  const wrong = run({ clipboard: 'my bank password' });
  assert.equal(wrong.outcome, 'failed');
  assert.ok(wrong.said.every((m) => !m.includes('password')));
  assert.deepEqual(wrong.cleared, []);

  assert.equal(hooks.finishSignIn({ electron: {}, argv: ['/opt/electron'] }), 'not-requested');
});

test('the running-instance check reads Chromium\'s singleton lock in Figma\'s lock directory', () => {
  const appData = tmp('appdata');
  assert.equal(hooks.runningInstancePid(appData), null);
  fs.mkdirSync(path.join(appData, 'Figma/Desktop'), { recursive: true });
  fs.symlinkSync(`host-${process.pid}`, path.join(appData, 'Figma/Desktop/SingletonLock'));
  assert.equal(hooks.runningInstancePid(appData), process.pid);
});
