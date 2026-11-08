// PDF profile through pdfinfo (page count, producer) and pdftotext (is there a text layer); both optional.
import { spawnSync } from 'node:child_process';
import { hasTool } from './tools.mjs';

/** { pages, producer?, text } or null without pdfinfo. `text`: true/false from pdftotext on the first 2 pages, null when unknown. */
export function profilePdf(file, { timeoutMs = 5000 } = {}) {
  const info = hasTool('pdfinfo');
  if (!info) return null;
  const r = spawnSync(info, [file], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20 });
  if (r.status !== 0) return null;
  const pages = Number(/^Pages:\s+(\d+)/m.exec(r.stdout)?.[1]);
  if (!Number.isFinite(pages)) return null;
  const out = { pages };
  const producer = /^Producer:\s+(.+)$/m.exec(r.stdout)?.[1];
  if (producer) out.producer = producer.trim().slice(0, 80);
  out.text = null;
  const ptt = hasTool('pdftotext');
  if (ptt) {
    const t = spawnSync(ptt, ['-l', '2', file, '-'], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 << 20 });
    if (t.status === 0) out.text = t.stdout.replace(/\s+/g, '').length >= 200 * Math.min(2, pages);
  }
  return out;
}
