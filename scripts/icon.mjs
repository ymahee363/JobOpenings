// Draws the extension icon (a blue tile with three list rows) as PNG, without image libraries.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function iconPng(size) {
  const blue = [36, 87, 197, 255];
  const white = [255, 255, 255, 255];
  const clear = [0, 0, 0, 0];
  const r = size * 0.18;
  const pixel = (x, y) => {
    // Rounded square.
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return clear;
    // Three rows: a dot and a bar each.
    for (let i = 0; i < 3; i++) {
      const top = size * (0.25 + i * 0.2);
      const h = size * 0.1;
      if (y >= top && y < top + h) {
        if (x >= size * 0.2 && x < size * 0.3) return white;
        if (x >= size * 0.36 && x < size * (i === 0 ? 0.8 : 0.68)) return white;
      }
    }
    return blue;
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      Buffer.from(pixel(x, y)).copy(raw, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
