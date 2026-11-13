// Variable-font metadata from an OpenType/TrueType file (or one face of a
// collection): the fvar axes and named instances, with names from the name table.
// fontconfig reports a variable font's ranges but not its axes, axis names or
// instance coordinates, which Figma's font list carries. Reads only the two
// tables, with every offset bounds-checked: font files are untrusted input.
'use strict';
const fs = require('node:fs');

const MAX_TABLE = 4 * 1024 * 1024;

function readAt(fd, position, length, size) {
  if (position < 0 || length < 0 || position + length > size) throw Error('sfnt: out of bounds');
  const buffer = Buffer.alloc(length);
  if (fs.readSync(fd, buffer, 0, length, position) !== length) throw Error('sfnt: short read');
  return buffer;
}

// Table directory of face `face` -> Map(tag -> {offset, length}).
function tables(fd, size, face) {
  let base = 0;
  const head = readAt(fd, 0, 12, size);
  if (head.toString('latin1', 0, 4) === 'ttcf') {
    const count = head.readUInt32BE(8);
    if (face >= count || count > 4096) throw Error('sfnt: no such face');
    base = readAt(fd, 12 + 4 * face, 4, size).readUInt32BE(0);
  } else if (face !== 0) {
    throw Error('sfnt: no such face');
  }
  const offsetTable = readAt(fd, base, 12, size);
  const count = offsetTable.readUInt16BE(4);
  const records = readAt(fd, base + 12, 16 * count, size);
  const found = new Map();
  for (let i = 0; i < count; i++) {
    const at = 16 * i;
    found.set(records.toString('latin1', at, at + 4), { offset: records.readUInt32BE(at + 8), length: records.readUInt32BE(at + 12) });
  }
  return found;
}

function readTable(fd, size, record) {
  if (!record || record.length > MAX_TABLE) return null;
  return readAt(fd, record.offset, record.length, size);
}

const utf16be = (bytes) => {
  const swapped = Buffer.from(bytes.subarray(0, bytes.length & ~1));
  swapped.swap16();
  return swapped.toString('utf16le');
};

// nameID -> string, preferring Windows/Unicode English, then Unicode, then Mac Roman.
function names(table) {
  const out = new Map();
  if (!table || table.length < 6) return out;
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  const rank = new Map();
  for (let i = 0; i < count && 6 + 12 * (i + 1) <= table.length; i++) {
    const at = 6 + 12 * i;
    const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => table.readUInt16BE(at + o));
    const start = storage + offset;
    if (start + length > table.length) continue;
    let score;
    let decode;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      score = language === 0x409 ? 3 : 1;
      decode = utf16be;
    } else if (platform === 0) {
      score = 2;
      decode = utf16be;
    } else if (platform === 1 && encoding === 0 && language === 0) {
      score = 0.5;
      decode = (bytes) => bytes.toString('latin1');
    } else {
      continue;
    }
    if ((rank.get(id) ?? -1) >= score) continue;
    rank.set(id, score);
    out.set(id, decode(table.subarray(start, start + length)).replace(/\0/g, '').trim());
  }
  return out;
}

const fixed = (buffer, at) => Math.round((buffer.readInt32BE(at) / 65536) * 1000) / 1000;

// { axes: [{tag, name, min, default, max, hidden}], instances: [{name, postscript, coords}] }
// or null when the face has no fvar table.
function readVariationInfo(file, face = 0) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const found = tables(fd, size, face);
    const fvar = readTable(fd, size, found.get('fvar'));
    if (!fvar || fvar.length < 16) return null;
    const nameTable = names(readTable(fd, size, found.get('name')));
    const axesOffset = fvar.readUInt16BE(4);
    const axisCount = fvar.readUInt16BE(8);
    const axisSize = fvar.readUInt16BE(10);
    const instanceCount = fvar.readUInt16BE(12);
    const instanceSize = fvar.readUInt16BE(14);
    if (axisSize < 20 || instanceSize < 4 + 4 * axisCount || axesOffset + axisCount * axisSize + instanceCount * instanceSize > fvar.length) {
      throw Error('sfnt: malformed fvar');
    }
    const axes = [];
    for (let i = 0; i < axisCount; i++) {
      const at = axesOffset + i * axisSize;
      const tag = fvar.toString('latin1', at, at + 4);
      const nameId = fvar.readUInt16BE(at + 18);
      axes.push({
        tag,
        name: nameTable.get(nameId) || tag,
        min: fixed(fvar, at + 4),
        default: fixed(fvar, at + 8),
        max: fixed(fvar, at + 12),
        hidden: (fvar.readUInt16BE(at + 16) & 1) === 1,
      });
    }
    const instances = [];
    const instancesOffset = axesOffset + axisCount * axisSize;
    for (let i = 0; i < instanceCount; i++) {
      const at = instancesOffset + i * instanceSize;
      const coords = {};
      axes.forEach((axis, j) => { coords[axis.tag] = fixed(fvar, at + 4 + 4 * j); });
      const postscriptId = instanceSize >= 6 + 4 * axisCount ? fvar.readUInt16BE(at + 4 + 4 * axisCount) : 0xffff;
      instances.push({
        name: nameTable.get(fvar.readUInt16BE(at)) ?? null,
        postscript: postscriptId !== 0xffff ? nameTable.get(postscriptId) ?? null : null,
        coords,
      });
    }
    return { axes, instances };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readVariationInfo, names };
