// sha256 of file contents, read synchronously in 1 MB blocks (a hook is synchronous); big files get a partial hash.
import crypto from 'node:crypto';
import fs from 'node:fs';

const BLOCK = 1024 * 1024;
const MB = 1024 * 1024;

function readAt(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/**
 * { hash: 'sha256:<hex>', mode: 'full'|'partial' }. `partial` (size above partialMb): sha256 of the first 4 MB, the last
 * 4 MB and the size. Returns null when the file cannot be read (vanished, permissions).
 */
export function hashFile(file, size, { partialMb = 64 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = crypto.createHash('sha256');
    if (size > partialMb * MB) {
      h.update(readAt(fd, 0, 4 * MB));
      h.update(readAt(fd, Math.max(0, size - 4 * MB), 4 * MB));
      h.update(String(size));
      return { hash: `sha256:${h.digest('hex')}`, mode: 'partial' };
    }
    const buf = Buffer.allocUnsafe(BLOCK);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, BLOCK, pos);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      pos += n;
    }
    return { hash: `sha256:${h.digest('hex')}`, mode: 'full' };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/** sha256 of the first 64 kB (the append-only test of a CSV compares it with the stored one). */
export function headHash(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    return `sha256:${crypto.createHash('sha256').update(readAt(fd, 0, bytes)).digest('hex')}`;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

export { readAt };
