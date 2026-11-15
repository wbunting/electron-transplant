// Downloads with a fake fetch: HTTPS and host allowlist on every hop, verify before
// rename, never overwrite, and the download cache that build/inspect read.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchFile, fetchPin, cachedDmgs } = require('../lib/fetch.cjs');
const { findDmg } = require('../lib/build.cjs');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `et-${name}-`));
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const BODY = Buffer.from('not really a dmg');

// routes: { url: body | { redirect } | status }; records requested URLs.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    const route = routes[url];
    if (route === undefined) return new Response('missing', { status: 404 });
    if (typeof route === 'number') return new Response('', { status: route });
    if (route.redirect) return new Response(null, { status: 302, headers: { location: route.redirect } });
    return new Response(route);
  };
  return { fetch, calls };
}

test('a download is verified before it gets its name; mismatches leave nothing behind', async () => {
  const dir = tmp('fetch');
  const dest = path.join(dir, 'sub/X-1.dmg');
  const { fetch } = fakeFetch({ 'https://dl.example/X-1.dmg': BODY });
  const result = await fetchFile('https://dl.example/X-1.dmg', dest, { sha256: sha(BODY), hosts: ['dl.example'], fetch });
  assert.deepEqual(result, { path: dest, downloaded: true });
  assert.deepEqual(fs.readFileSync(dest), BODY);
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['X-1.dmg']);

  const other = path.join(dir, 'Y.dmg');
  await assert.rejects(fetchFile('https://dl.example/X-1.dmg', other, { sha256: 'b'.repeat(64), hosts: ['dl.example'], mismatch: 'Hint.', fetch }), /but the pin is b{64}; deleted it\. Hint\./);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sub']);
});

test('HTTPS only, and every redirect must stay on the allowed hosts', async () => {
  const dest = path.join(tmp('redirect'), 'X.dmg');
  const opts = (routes) => ({ sha256: sha(BODY), hosts: ['dl.example', 'cdn.example'], ...fakeFetch(routes) });
  await assert.rejects(fetchFile('http://dl.example/X.dmg', dest, opts({})), /non-HTTPS/);
  await assert.rejects(fetchFile('https://evil.example/X.dmg', dest, opts({})), /evil\.example: not one of/);
  await assert.rejects(fetchFile('https://dl.example/X.dmg', dest, opts({ 'https://dl.example/X.dmg': { redirect: 'https://evil.example/X.dmg' } })), /evil\.example/);
  await assert.rejects(fetchFile('https://dl.example/X.dmg', dest, opts({ 'https://dl.example/X.dmg': { redirect: 'http://cdn.example/X.dmg' } })), /non-HTTPS/);
  await assert.rejects(fetchFile('https://dl.example/X.dmg', dest, opts({ 'https://dl.example/X.dmg': 403 })), /Download failed \(403\)/);
  assert.equal(fs.existsSync(dest), false);
  const { fetch, calls } = fakeFetch({ 'https://dl.example/X.dmg': { redirect: '/v/X.dmg' }, 'https://dl.example/v/X.dmg': { redirect: 'https://cdn.example/X.dmg' }, 'https://cdn.example/X.dmg': BODY });
  await fetchFile('https://dl.example/X.dmg', dest, { sha256: sha(BODY), hosts: ['dl.example', 'cdn.example'], fetch });
  assert.deepEqual(calls, ['https://dl.example/X.dmg', 'https://dl.example/v/X.dmg', 'https://cdn.example/X.dmg']);
  // Hash-pinned public archives (Electron, npm) may be on any HTTPS host.
  const any = fakeFetch({ 'https://github.example/z.zip': { redirect: 'https://objects.example/z.zip' }, 'https://objects.example/z.zip': BODY });
  await fetchFile('https://github.example/z.zip', path.join(tmp('any'), 'z.zip'), { sha256: sha(BODY), fetch: any.fetch });
});

test('an existing verified file is kept; a different one is never overwritten', async () => {
  const dir = tmp('existing');
  const dest = path.join(dir, 'X.dmg');
  fs.writeFileSync(dest, BODY);
  const { fetch, calls } = fakeFetch({});
  assert.deepEqual(await fetchFile('https://dl.example/X.dmg', dest, { sha256: sha(BODY), hosts: ['dl.example'], fetch }), { path: dest, downloaded: false });
  fs.writeFileSync(dest, 'user file');
  await assert.rejects(fetchFile('https://dl.example/X.dmg', dest, { sha256: sha(BODY), hosts: ['dl.example'], fetch }), /exists but is not the pinned file \(sha256 [0-9a-f]{64}\); not overwriting it/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'user file');
  assert.deepEqual(calls, []);
});

test('fetch puts the DMG in the download cache, where build finds it; --dest takes every input', async () => {
  const cache = tmp('cache');
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    const pin = { sha256: sha(BODY), version: '1.2.3', electron: '44.9.1', note: 'universal' };
    const config = {
      id: 'demo', name: 'Demo', dmg: { glob: 'Demo-*.dmg', app: 'Demo.app' }, pins: [pin],
      source: { page: 'https://demo.example/download', dmg: 'https://dl.demo.example/Demo-{version}-universal.dmg', hosts: ['dl.demo.example'], retention: 'all' },
    };
    const { fetch } = fakeFetch({ 'https://dl.demo.example/Demo-1.2.3-universal.dmg': BODY });
    const { results, missing } = await fetchPin(config, pin, { fetch, log: () => {} });
    const expected = path.join(cache, 'electron-transplant/downloads/demo', pin.sha256, 'Demo-1.2.3-universal.dmg');
    assert.deepEqual([results, missing], [{ dmg: expected }, []]);
    assert.deepEqual(cachedDmgs('demo'), [expected]);
    // findDmg looks there too (with ~/Downloads); HOME points at an empty directory.
    const savedHome = process.env.HOME;
    process.env.HOME = tmp('home');
    try {
      assert.equal(findDmg(config), expected);
    } finally {
      process.env.HOME = savedHome;
    }

    // No URL: say where to get it.
    const noUrl = { ...config, source: { page: 'https://demo.example/download' } };
    const none = await fetchPin(noUrl, pin, { fetch, dest: tmp('dest'), log: () => {} });
    assert.match(none.missing[0], /Demo 1\.2\.3 \(universal\) has no download URL: get the macOS DMG from https:\/\/demo\.example\/download \(sha256 [0-9a-f]{64}\)/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
  }
});
