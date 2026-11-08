// Materials of a topic in the project repo: `materialy/<téma>/` (git). The only code here is what is simple to enforce:
// the size limit (a file over materialy_max_mb never goes to git, only a record of it) and the check of that limit.
// Everything else (what is saved, where, shared materials) is the rule P-062 and the skill `materialy`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './util.mjs';

export const MATERIALY_DIR = 'materialy';
export const DEFAULT_MAX_MB = 50;
const MB = 1024 * 1024;
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const maxBytes = (policy) => (Number.isFinite(policy?.limits?.materialy_max_mb) && policy.limits.materialy_max_mb > 0 ? policy.limits.materialy_max_mb : DEFAULT_MAX_MB) * MB;
export const validTopic = (t) => typeof t === 'string' && TOPIC_RE.test(t) && t !== '.' && t !== '..';

/** Deny reason for a Write of `bytes` into materialy/ of the project over the limit, else null. */
export function bigWriteDeny(projectDir, policy, absTarget, bytes) {
  if (!projectDir || !absTarget || !isInside(path.join(projectDir, MATERIALY_DIR), absTarget)) return null;
  const max = maxBytes(policy);
  if (bytes <= max) return null;
  return `súbor ${(bytes / MB).toFixed(0)} MB je nad limitom ${max / MB} MB pre materialy/ (nejde do gitu): nechaj ho tam, odkiaľ prišiel, stiahnutý v scratch/, a v materialy/ nechaj iba záznam: node <plugin>/bin/materialy.mjs record <súbor> --from <odkiaľ>`;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(MB);
    for (let n; (n = fs.readSync(fd, buf, 0, MB, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * Record of a big file: materialy/<topic>/<name>.zaznam.json with from, date, size, sha256 and where the file lies.
 * The file itself is not touched or copied. Returns { file, record }.
 */
export function recordBigFile(projectDir, topic, file, { from, now = new Date() } = {}) {
  if (!validTopic(topic)) throw new Error(`neplatná téma: ${topic}`);
  const abs = path.resolve(file);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`nie je súbor: ${file}`);
  if (isInside(path.join(projectDir, MATERIALY_DIR), abs)) throw new Error('súbor je už v materialy/: presuň ho mimo (stiahnutý do scratch/) a zaznamenaj až potom');
  const name = path.basename(abs);
  const record = {
    name,
    from: from || null,
    date: now.toISOString().slice(0, 10),
    size: st.size,
    sha256: sha256(abs),
    stored_at: path.relative(projectDir, abs).startsWith('..') ? abs : path.relative(projectDir, abs).split(path.sep).join('/'),
  };
  const out = path.join(projectDir, MATERIALY_DIR, topic, `${name}.zaznam.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  return { file: out, record };
}

/** Files in materialy/ over the limit: [{ path (relative to the project), size }]. Symlinks and .git are skipped. */
export function oversized(projectDir, policy) {
  const root = path.join(projectDir, MATERIALY_DIR);
  const max = maxBytes(policy);
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') walk(p); } else if (e.isFile()) {
        const size = fs.statSync(p).size;
        if (size > max) found.push({ path: path.relative(projectDir, p).split(path.sep).join('/'), size });
      }
    }
  };
  walk(root);
  return found;
}
