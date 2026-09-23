// Builds dist/downhere-<version>.zip from the extension folder plus the license,
// ready to upload to the Chrome Web Store or attach to a release. Uses only
// Node's standard library, and the output only changes when the files change.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const output = join(root, 'dist', `downhere-${version}.zip`);

// Skip system files such as .DS_Store and Thumbs.db.
function listFiles(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && name !== 'Thumbs.db')
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A fixed timestamp (1 January 2020, 00:00) keeps builds reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

const localParts = [];
const centralParts = [];
let offset = 0;

const entries = [
  ...listFiles(source).map((path) => [relative(source, path).split(sep).join('/'), path]),
  ['LICENSE', join(root, 'LICENSE')],
];

for (const [entryName, path] of entries) {
  const name = Buffer.from(entryName, 'utf8');
  const data = readFileSync(path);
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const stored = useDeflate ? deflated : data;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_NAMES, 6);
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_NAMES, 8);
  central.writeUInt16LE(useDeflate ? 8 : 0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(stored.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  // Extra field length, comment length, disk number, internal and external
  // attributes stay 0.
  central.writeUInt32LE(offset, 42);

  localParts.push(local, name, stored);
  centralParts.push(central, name);
  offset += local.length + name.length + stored.length;
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centralParts.length / 2, 8);
end.writeUInt16LE(centralParts.length / 2, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([...localParts, centralDirectory, end]));
console.log(`Created ${relative(root, output)} (${centralParts.length / 2} files)`);
