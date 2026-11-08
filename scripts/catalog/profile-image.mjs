// Image size from the file header (png, jpeg, gif, webp, bmp, tiff); no library, nothing is decoded.
import fs from 'node:fs';
import { readAt } from './hash.mjs';

export function profileImage(file, size) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, Math.min(size, 64));
    if (head.length >= 24 && head.subarray(1, 4).toString('latin1') === 'PNG') return { format: 'png', width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    if (head.length >= 10 && /^GIF8[79]a/.test(head.subarray(0, 6).toString('latin1'))) return { format: 'gif', width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    if (head.length >= 30 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return webp(head);
    if (head.length >= 26 && head[0] === 0x42 && head[1] === 0x4d) return { format: 'bmp', width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) };
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) return jpeg(fd, size);
    if (head.length >= 8 && ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 42) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 42))) return tiff(fd, size, head[0] === 0x49);
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

function webp(h) {
  const kind = h.subarray(12, 16).toString('latin1');
  if (kind === 'VP8X') return { format: 'webp', width: 1 + h.readUIntLE(24, 3), height: 1 + h.readUIntLE(27, 3) };
  if (kind === 'VP8L') { const b = h.readUInt32LE(21); return { format: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
  if (kind === 'VP8 ') return { format: 'webp', width: h.readUInt16LE(26) & 0x3fff, height: h.readUInt16LE(28) & 0x3fff };
  return null;
}

function jpeg(fd, size) {
  let pos = 2;
  for (let guard = 0; guard < 4096 && pos + 4 <= size; guard++) {
    const m = readAt(fd, pos, 4);
    if (m.length < 4 || m[0] !== 0xff) return null;
    const marker = m[1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    const len = m.readUInt16BE(2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const sof = readAt(fd, pos + 4, 5);
      return { format: 'jpeg', width: sof.readUInt16BE(3), height: sof.readUInt16BE(1) };
    }
    pos += 2 + len;
  }
  return null;
}

function tiff(fd, size, le) {
  const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = u32(readAt(fd, 0, 8), 4);
  if (ifd + 2 > size) return null;
  const n = u16(readAt(fd, ifd, 2), 0);
  const entries = readAt(fd, ifd + 2, Math.min(n, 200) * 12);
  let width = null;
  let height = null;
  for (let i = 0; i + 12 <= entries.length; i += 12) {
    const tag = u16(entries, i);
    const type = u16(entries, i + 2);
    const val = type === 3 ? u16(entries, i + 8) : u32(entries, i + 8);
    if (tag === 256) width = val;
    if (tag === 257) height = val;
  }
  return width && height ? { format: 'tiff', width, height } : null;
}
