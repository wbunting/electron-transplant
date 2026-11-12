// Gives an app's own code a modified `electron` module. Electron's exports are
// read-only getters, so rather than changing them, requests for 'electron' and
// 'electron/main' made from the app's files are answered with a facade: CommonJS
// through Module._load, ES modules through module.registerHooks (Node >= 22.15).
// Everything not overridden is forwarded lazily to the real module.
'use strict';
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FACADE = Symbol.for('electron-transplant.facade');
const SPECIFIERS = new Set(['electron', 'electron/main']);
const ESM_URL = 'electron-transplant:electron';

function createFacade(electron, overrides) {
  const facade = {};
  for (const key of Object.getOwnPropertyNames(electron)) {
    if (Object.hasOwn(overrides, key)) {
      Object.defineProperty(facade, key, { enumerable: true, value: overrides[key] });
    } else {
      // Lazy, like Electron's own getters (some modules only load after ready).
      Object.defineProperty(facade, key, { enumerable: true, get: () => electron[key] });
    }
  }
  return facade;
}

// Star re-export keeps Electron's own ES bindings for everything else; local
// exports take precedence over star exports, so the overrides win.
function esmSource(overrides) {
  const lines = [
    "export * from 'electron';",
    `const facade = globalThis[Symbol.for(${JSON.stringify(FACADE.description)})];`,
  ];
  for (const name of Object.keys(overrides)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw Error(`Invalid export name: ${name}`);
    lines.push(`export const ${name} = facade.${name};`);
  }
  lines.push('export default facade;');
  return lines.join('\n');
}

function installFacade({ electron, appRoot, overrides, exclude = [] }) {
  if (globalThis[FACADE]) throw Error('electron facade already installed');
  const facade = createFacade(electron, overrides);
  globalThis[FACADE] = facade;
  const root = appRoot + path.sep;
  const fromApp = (file) => typeof file === 'string' && file.startsWith(root) && !exclude.some((dir) => file.startsWith(dir));

  const originalLoad = Module._load;
  Module._load = function load(request, parent, ...rest) {
    if (SPECIFIERS.has(request) && fromApp(parent?.filename)) return facade;
    return originalLoad.call(this, request, parent, ...rest);
  };

  let esm = false;
  if (typeof Module.registerHooks === 'function') {
    const rootUrl = pathToFileURL(root).href;
    const excludedUrls = exclude.map((dir) => pathToFileURL(dir).href);
    Module.registerHooks({
      resolve(specifier, context, next) {
        const parent = context.parentURL ?? '';
        // require() never gets here for these specifiers (Module._load answers first).
        if (SPECIFIERS.has(specifier) && context.conditions?.includes('import')
          && parent.startsWith(rootUrl) && !excludedUrls.some((url) => parent.startsWith(url))) {
          return { url: ESM_URL, format: 'module', shortCircuit: true };
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url !== ESM_URL) return next(url, context);
        return { format: 'module', shortCircuit: true, source: esmSource(overrides) };
      },
    });
    esm = true;
  }
  return { facade, esm };
}

module.exports = { installFacade, createFacade, esmSource, FACADE };
