// App configs live in apps/<id>/app.cjs; shims and notes sit beside them.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./util.cjs');

const APPS = path.join(ROOT, 'apps');
const ID = /^[a-z][a-z0-9-]*$/;

function listApps() {
  return fs.readdirSync(APPS).filter((id) => fs.existsSync(path.join(APPS, id, 'app.cjs'))).sort();
}

function validate(config, dir) {
  const fail = (message) => { throw Error(`apps/${path.basename(dir)}/app.cjs: ${message}`); };
  if (!ID.test(config.id ?? '')) fail('id must be lowercase letters, digits and dashes');
  if (config.id !== path.basename(dir)) fail(`id ${config.id} must match its directory`);
  for (const key of ['name', 'bundleId', 'envPrefix']) if (typeof config[key] !== 'string' || !config[key]) fail(`missing ${key}`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(config.envPrefix)) fail('envPrefix must be UPPER_SNAKE');
  if (!config.dmg?.glob || !config.dmg?.app?.endsWith('.app')) fail('dmg.glob and dmg.app (e.g. "Linear.app") are required');
  if (config.dmg.dir !== undefined && !/^[\w.-]+$/.test(config.dmg.dir) || config.dmg.dir === '..' || config.dmg.dir === '.') fail('dmg.dir must be one plain directory name under ~/Downloads');
  const install = config.install ?? fail('missing install');
  for (const key of ['id', 'command']) if (!ID.test(install[key] ?? '')) fail(`install.${key} must be lowercase letters, digits and dashes`);
  for (const pin of config.pins ?? []) {
    if (!/^[0-9a-f]{64}$/.test(pin.sha256) || !pin.version || !pin.electron) fail('each pin needs sha256, version and electron');
  }
  for (const [name, spec] of Object.entries(config.natives ?? {})) {
    if (spec.action === 'shim' && !fs.existsSync(path.join(dir, spec.shim ?? ''))) fail(`natives.${name}: shim file not found`);
    if (spec.action === 'npm-prebuild' && !(spec.package && spec.version && spec.integrity?.startsWith('sha512-') && spec.files)) {
      fail(`natives.${name}: npm-prebuild needs package, version, sha512 integrity and files`);
    }
    if (spec.action === 'remove' && !Array.isArray(spec.paths)) fail(`natives.${name}: remove needs paths`);
  }
  const relative = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@.+\/-]+$/;
  for (const [file, spec] of Object.entries(config.nativeFiles ?? {})) {
    if (!relative.test(file) || spec.action !== 'remove' || !spec.reason) fail(`nativeFiles.${file}: needs a relative path, action "remove" and a reason`);
  }
  for (const name of config.asar?.dropInvalidEntries ?? []) if (!relative.test(name)) fail(`asar.dropInvalidEntries: bad name ${name}`);
  for (const [to, from] of Object.entries(config.addFiles ?? {})) {
    if (!relative.test(to) || !relative.test(from) || !fs.existsSync(path.join(dir, from))) fail(`addFiles.${to}: needs relative paths and an existing source`);
  }
  for (const hook of config.compat?.hooks ?? []) if (!Object.hasOwn(config.addFiles ?? {}, hook)) fail(`compat.hooks: ${hook} must be one of addFiles`);
  if (config.compat?.defaultProtocolClient !== undefined && typeof config.compat.defaultProtocolClient !== 'boolean') fail('compat.defaultProtocolClient must be a boolean');
  const scheme = /^[a-z][a-z0-9+.-]*$/;
  for (const key of ['schemes', 'defaultSchemes']) {
    const list = config.install[key];
    if (list !== undefined && !(Array.isArray(list) && list.every((s) => scheme.test(s)))) fail(`install.${key} must be a list of URL schemes`);
  }
  // install.share: a directory of the app's config installed to <prefix>/share/<install.id>.
  if (install.share !== undefined && !(relative.test(install.share) && fs.statSync(path.join(dir, install.share), { throwIfNoEntry: false })?.isDirectory())) {
    fail('install.share must be a relative directory of the app config');
  }
  // install.helpers: commands that run a script from install.share with the app's Electron.
  for (const helper of install.helpers ?? []) {
    if (!install.share) fail('install.helpers need install.share');
    if (!ID.test(helper.command ?? '') || helper.command === install.command) fail('install.helpers: each command must be a new lowercase id');
    if (!relative.test(helper.script ?? '') || !fs.existsSync(path.join(dir, install.share, helper.script))) fail(`install.helpers.${helper.command}: script not found in install.share`);
    if (typeof helper.name !== 'string' || !helper.name) fail(`install.helpers.${helper.command}: missing name`);
    if (!(helper.args ?? []).every((arg) => /^[\w=.-]+$/.test(arg))) fail(`install.helpers.${helper.command}: args must be plain words`);
  }
  for (const patch of config.patches ?? []) {
    if (!patch.name || !patch.file || typeof patch.from !== 'string' || typeof patch.to !== 'string' || patch.from === patch.to) {
      fail(`patch ${patch.name ?? '?'} needs name, file, from and a different to`);
    }
  }
  const plainName = /^[\w@.+-]+$/;
  for (const name of config.resources?.drop ?? []) if (!plainName.test(name)) fail(`resources.drop: bad name ${name}`);
  for (const derived of config.resources?.derive ?? []) {
    if (!plainName.test(derived.to ?? '') || !plainName.test(derived.from ?? '') || !/^[0-9a-f]{6}$/i.test(derived.recolor ?? '')) {
      fail('resources.derive entries need plain to/from file names and a RRGGBB recolor');
    }
  }
  if (config.compat?.pageAdapter && !config.compat.pageAdapter.origins?.every((o) => /^https:\/\/[^/]+$/.test(o))) {
    fail('compat.pageAdapter.origins must be https origins');
  }
  return config;
}

function loadApp(id) {
  if (!ID.test(id)) throw Error(`Invalid app id: ${id}`);
  const dir = path.join(APPS, id);
  if (!fs.existsSync(path.join(dir, 'app.cjs'))) throw Error(`Unknown app ${id}; known: ${listApps().join(', ')}`);
  return { config: validate(require(path.join(dir, 'app.cjs')), dir), dir };
}

module.exports = { listApps, loadApp, validate };
