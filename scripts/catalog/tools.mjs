// External tools found in PATH (checked, never assumed): duckdb, pdfinfo, pdftotext. Cached per process.
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

export function hasTool(name, env = process.env) {
  const key = `${env.PATH}\u0000${name}`;
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) { found = file; break; }
    } catch { /* not here */ }
  }
  cache.set(key, found);
  return found;
}

export function detectTools(env = process.env) {
  return Object.fromEntries(['duckdb', 'pdfinfo', 'pdftotext'].map((t) => [t, !!hasTool(t, env)]));
}
