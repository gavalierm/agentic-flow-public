// Fixtures of the catalog tests: a project fixture (tests/helpers.mjs) with a data source next to it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { setup } from './helpers.mjs';
import { catalogConfig } from '../scripts/catalog/config.mjs';

export function catalogFixture({ mode = 'ro', extra = {}, files = true } = {}) {
  const fx = setup({ remote: false });
  const data = path.join(fx.root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const config = (catalog) => {
    fs.mkdirSync(path.join(fx.project, 'local'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', 'workflow.json'), JSON.stringify({ catalog }) + '\n');
  };
  fx.data = data;
  fx.config = config;
  fx.write = (rel, content) => {
    const f = path.join(data, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
  };
  fx.cfg = () => catalogConfig(fx.project);
  fx.catalog = (args, opts = {}) => fx.run('catalog.mjs', args, opts);
  fx.indexRows = (source = 'data') => {
    const f = path.join(fx.project, 'local', 'catalog', 'index', `${source}.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  config({ sources: { data: { path: data, mode } }, ...extra });
  if (files) {
    fx.write('export/objednavky.csv', `id;zakaznik;email;suma;stav\n1;Acme;a${'@'}acme.example;12,5;novy\n2;Beta;b${'@'}beta.example;7;hotovy\n3;Acme;a${'@'}acme.example;99;novy\n`); // address composed: the release leak scan
    fx.write('notes/readme.txt', 'poznamky\n');
  }
  return fx;
}

/** A valid PNG of w x h pixels (no external tool). */
export function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A stored (uncompressed) zip with the given entry names; enough for a central directory listing. */
export function zip(names) {
  const parts = []; const central = []; let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, n); central.push(cd, n); offset += 30 + n.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

/** Fake executable in a directory that goes first in PATH (duckdb, pdfinfo); returns the PATH value. */
export function fakeTool(dir, name, script) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(f, 0o755);
  return `${dir}${path.delimiter}${process.env.PATH}`;
}
