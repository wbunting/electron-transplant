// Raw asar headers, for archives @electron/asar refuses to read. Figma's app.asar
// carries a placeholder entry ("/.codesign", size -1000) that Electron never reads
// but @electron/asar's header validation rejects. The integrity check hashes the
// original header string; extraction then uses a copy whose header drops only the
// invalid entries an app config names. Nothing in the archive is executed.
//
// Layout: UInt32 4 | UInt32 headerPickleSize | pickle(UInt32 payloadSize,
// UInt32 jsonLength, json, padding) | file data (offsets relative to its start).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_HEADER = 64 * 1024 * 1024;

function readRawHeader(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const { size: archiveSize } = fs.fstatSync(fd);
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw Error('asar: truncated header');
    const [four, pickleSize, payloadSize, jsonLength] = [0, 4, 8, 12].map((at) => prefix.readUInt32LE(at));
    if (four !== 4 || pickleSize > MAX_HEADER || pickleSize + 8 > archiveSize || payloadSize + 4 > pickleSize || jsonLength + 4 > payloadSize) {
      throw Error('asar: malformed header sizes');
    }
    const json = Buffer.alloc(jsonLength);
    if (fs.readSync(fd, json, 0, jsonLength, 16) !== jsonLength) throw Error('asar: truncated header');
    const headerString = json.toString('utf8');
    return { headerString, header: JSON.parse(headerString), dataOffset: 8 + pickleSize };
  } finally {
    fs.closeSync(fd);
  }
}

// A file entry @electron/asar (and Electron's own reader, if it were read) would reject.
function invalidEntry(entry) {
  if (!entry || typeof entry !== 'object' || 'files' in entry || 'link' in entry) return false;
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) return true;
  return !entry.unpacked && !(typeof entry.offset === 'string' && /^\d+$/.test(entry.offset));
}

// Copies `archive` to `out` without the named invalid entries ('/'-separated paths).
// Refuses to drop anything that is valid, missing, or not named.
function withoutInvalidEntries(archive, out, names) {
  const { header, dataOffset } = readRawHeader(archive);
  const dropped = [];
  for (const name of names) {
    const parts = name.split('/');
    if (!parts.every((part) => part && part !== '.' && part !== '..')) throw Error(`asar: bad entry name ${name}`);
    let dir = header;
    for (const part of parts.slice(0, -1)) dir = dir?.files?.[part];
    const leaf = parts.at(-1);
    const entry = dir?.files && Object.hasOwn(dir.files, leaf) ? dir.files[leaf] : undefined;
    if (entry === undefined) continue;
    if (!invalidEntry(entry)) throw Error(`asar: ${name} is a valid entry; refusing to drop it`);
    delete dir.files[leaf];
    dropped.push(name);
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  const payload = Buffer.concat([u32(json.length), json, Buffer.alloc(padding)]);
  const pickle = Buffer.concat([u32(payload.length), payload]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, 'w');
  try {
    fs.writeSync(fd, Buffer.concat([u32(4), u32(pickle.length), pickle]));
    const input = fs.openSync(archive, 'r');
    try {
      const chunk = Buffer.alloc(1 << 20);
      for (let position = dataOffset; ;) {
        const read = fs.readSync(input, chunk, 0, chunk.length, position);
        if (!read) break;
        fs.writeSync(fd, chunk, 0, read);
        position += read;
      }
    } finally {
      fs.closeSync(input);
    }
  } finally {
    fs.closeSync(fd);
  }
  // Unpacked files are read from "<archive>.unpacked" next to the archive.
  if (fs.existsSync(`${archive}.unpacked`)) fs.symlinkSync(path.resolve(`${archive}.unpacked`), `${out}.unpacked`);
  return dropped;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

module.exports = { readRawHeader, withoutInvalidEntries, invalidEntry };
