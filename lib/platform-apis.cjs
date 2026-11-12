// Generates the table of macOS/Windows-only main-process Electron APIs for one
// Electron version from its electron.d.ts: every class member whose declarations
// are all `@platform`-tagged without linux, plus the main-process exports. The
// compat recorder uses it to know which APIs an app could reach for.
'use strict';

// Event registration overloads are tagged per event, not per method.
const EVENT_METHODS = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'prependListener', 'prependOnceListener', 'emit']);

function parse(source) {
  const lines = source.split('\n');
  const decls = new Map(); // "Class.member" or "Class.static member" -> [platforms[] | null per declaration]
  const mainExports = [];
  let owner = null;
  let inMain = false;
  let doc = null;
  let pendingPlatforms = null;
  for (const line of lines) {
    const type = /^ {2}(?:class|interface) ([A-Z]\w*)\b/.exec(line);
    if (type) { owner = type[1]; continue; }
    if (/^ {2}namespace Main \{/.test(line)) { inMain = true; owner = null; continue; }
    if (inMain) {
      if (/^ {2}\}/.test(line)) { inMain = false; continue; }
      const exp = /^ {4}(?:const (\w+): (typeof )?(\w+);|class (\w+) extends)/.exec(line);
      if (exp) {
        mainExports.push(exp[1]
          ? { name: exp[1], type: exp[3], kind: exp[2] ? 'constructor' : 'instance' }
          : { name: exp[4], type: exp[4], kind: 'class' });
      }
      continue;
    }
    if (/^ {2}\S/.test(line)) { owner = null; continue; }
    if (!owner) continue;
    if (/^ {4}\/\*\*/.test(line)) { doc = []; }
    if (doc) {
      doc.push(line);
      if (line.includes('*/')) {
        const tag = doc.join('\n').match(/@platform ([\w,]+)/);
        pendingPlatforms = tag ? tag[1].split(',') : null;
        doc = null;
      }
      continue;
    }
    const member = /^ {4}(static )?(?:readonly )?([A-Za-z_$][\w$]*)\??(?:<|\(|:)/.exec(line);
    if (member && !EVENT_METHODS.has(member[2])) {
      const key = `${owner}.${member[1] ? 'static ' : ''}${member[2]}`;
      if (!decls.has(key)) decls.set(key, []);
      decls.get(key).push(pendingPlatforms);
    }
    if (/^ {4}\S/.test(line)) pendingPlatforms = null;
  }
  const members = {};
  for (const [key, platformsList] of decls) {
    // Present on Linux if any overload is untagged or includes linux.
    if (platformsList.some((p) => p === null || p.includes('linux'))) continue;
    const [cls, rest] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    const isStatic = rest.startsWith('static ');
    const name = isStatic ? rest.slice(7) : rest;
    (members[cls] ??= {})[name] = { platforms: [...new Set(platformsList.flat())].sort(), ...(isStatic && { static: true }) };
  }
  return { members, mainExports };
}

function generateTable(source, version) {
  const { members, mainExports } = parse(source);
  return { electron: version, generatedFrom: 'electron.d.ts', mainExports, members };
}

function tableStats(table) {
  return {
    members: Object.values(table.members).reduce((n, m) => n + Object.keys(m).length, 0),
    types: Object.keys(table.members).length,
    exports: table.mainExports.length,
  };
}

module.exports = { parse, generateTable, tableStats };
