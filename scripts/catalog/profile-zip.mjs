// Zip listing from the central directory (no unpacking, no decompression).
import fs from 'node:fs';
import { readAt } from './hash.mjs';
import { extOf } from './kinds.mjs';

function name(buf, utf8) {
  if (utf8) return buf.toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1250').decode(buf); }
}

/** { entries, total_size, listing, ext_counts, truncated } or null when the file is not a readable zip. */
export function profileZip(file, size, { maxEntries = 200 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (e < 0) return null;
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) { // zip64
      const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), e);
      if (loc < 0) return null;
      const z64 = Number(tail.readBigUInt64LE(loc + 8));
      const rec = readAt(fd, z64, 56);
      if (rec.readUInt32LE(0) !== 0x06064b50) return null;
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdSize > 256 * 1024 * 1024 || cdOffset + cdSize > size) return null;
    const cd = readAt(fd, cdOffset, cdSize);
    const listing = [];
    const extCounts = {};
    let entries = 0;
    let total = 0;
    let pos = 0;
    while (pos + 46 <= cd.length && cd.readUInt32LE(pos) === 0x02014b50) {
      const flags = cd.readUInt16LE(pos + 8);
      let usize = cd.readUInt32LE(pos + 24);
      const nlen = cd.readUInt16LE(pos + 28);
      const xlen = cd.readUInt16LE(pos + 30);
      const clen = cd.readUInt16LE(pos + 32);
      const entry = name(cd.subarray(pos + 46, pos + 46 + nlen), !!(flags & 0x800));
      if (usize === 0xffffffff) { // zip64 extra field 0x0001 holds the real uncompressed size first
        const extra = cd.subarray(pos + 46 + nlen, pos + 46 + nlen + xlen);
        for (let x = 0; x + 4 <= extra.length;) {
          const id = extra.readUInt16LE(x);
          const len = extra.readUInt16LE(x + 2);
          if (id === 1 && len >= 8) { usize = Number(extra.readBigUInt64LE(x + 4)); break; }
          x += 4 + len;
        }
      }
      pos += 46 + nlen + xlen + clen;
      if (entry.endsWith('/')) continue; // directory entry
      entries++;
      total += usize === 0xffffffff ? 0 : usize;
      const ext = extOf(entry.split('/').pop()) || '-';
      extCounts[ext] = (extCounts[ext] || 0) + 1;
      if (listing.length < maxEntries) listing.push(entry);
    }
    return { entries: Math.max(entries, 0), declared_entries: count, total_size: total, listing, ext_counts: extCounts, truncated: entries > listing.length };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}
