/**
 * A picture for an agent that has none, written by hand so the acceptance run does
 * not need an image editor or a network fetch.
 *
 * A flat colour square, encoded as a PNG from first principles: this exists only to
 * give the disposable acceptance agent something that is genuinely its own, rather
 * than borrowing the site's logo for a market that will sit on mainnet forever.
 *
 *   node scripts/p3/avatar.mjs > /tmp/agen-p3/avatar.png
 */

import { deflateSync } from "node:zlib";

const SIZE = 512;
const RGB = [0x1c, 0x1c, 0x1e];

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 2; // truecolour
const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(SIZE * 3)]);
for (let x = 0; x < SIZE; x += 1) {
  row[1 + x * 3] = RGB[0];
  row[2 + x * 3] = RGB[1];
  row[3 + x * 3] = RGB[2];
}

const raw = Buffer.concat(Array.from({ length: SIZE }, () => row));

process.stdout.write(
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
