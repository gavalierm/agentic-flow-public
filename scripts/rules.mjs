// Assemble rules from layers: core (workflow) -> harness -> machine -> project -> local (P-035, P-022).
import path from 'node:path';
import { PLUGIN_ROOT, listFiles, readText } from './util.mjs';
import { normalizeKey } from './keys.mjs';
import { machineName } from './config.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { byTag } from './authors.mjs';

export const LAYERS = ['harness', 'machine', 'project', 'local'];

export function splitBlocks(text) {
  const parts = String(text).replace(/\r\n/g, '\n').split(/^(?=### )/m);
  const preamble = parts[0]?.startsWith('### ') ? '' : parts.shift() || '';
  return { preamble, blocks: parts.filter((b) => b.startsWith('### ')).map((b) => ({ id: /^###\s+(P-\d{3})/.exec(b)?.[1] || null, text: b.replace(/\s*$/, '\n') })) };
}

export function parseExceptions(text, file, immutable) {
  const entries = [];
  const errors = [];
  for (const block of splitBlocks(text).blocks) {
    const head = block.text.split('\n')[0];
    if (!block.id) {
      errors.push(`${file}: exception "${head.replace(/^###\s*/, '')}" has no principle ID; refused (P-035)`);
      continue;
    }
    const wording = /^Znenie:\s*(.+)$/m.exec(block.text)?.[1]?.trim();
    const reason = /^Dôvod:\s*(.+)$/m.exec(block.text)?.[1]?.trim();
    if (immutable.includes(block.id)) {
      errors.push(`${file}: ${block.id} is immutable; exception refused (P-035)`);
      continue;
    }
    if (!wording) { errors.push(`${file}: ${block.id} has no "Znenie:"; refused (P-035)`); continue; }
    if (!reason) { errors.push(`${file}: ${block.id} has no "Dôvod:"; refused (P-035)`); continue; }
    entries.push({ id: block.id, wording, reason, title: head.replace(/^###\s+P-\d{3}:?\s*/, '').trim() });
  }
  return { entries, errors };
}

export function layerFiles(brainDir, { harness = 'claude-code', machine = machineName() } = {}) {
  if (!brainDir) return [];
  return [
    { layer: 'harness', file: path.join(brainDir, 'exceptions', `harness-${normalizeKey(harness)}.md`) },
    { layer: 'machine', file: path.join(brainDir, 'exceptions', `machine-${normalizeKey(machine)}.md`) },
    { layer: 'project', file: path.join(brainDir, 'exceptions', 'project.md') },
    { layer: 'local', file: path.join(brainDir, 'local', 'exceptions.md') },
  ];
}

/**
 * `foreign(rel)`: name of the operator who added the project rule `rules/<file>` when it is another one (scripts/authors.mjs);
 * `shown` then carries `[by <name>]` on its heading. `text` stays without it: the hash, the sections and the limits are the
 * same on every machine.
 */
export function assembleRules({ brainDir = null, policy, harness = 'claude-code', machine = machineName(), coreDir = path.join(PLUGIN_ROOT, 'rules'), foreign = null } = {}) {
  const immutable = policy?.immutable_principles || [];
  const core = listFiles(coreDir, (f) => f.endsWith('.md') && path.basename(f) !== 'README.md', { recursive: false });
  const blocks = [];
  const preambles = [];
  for (const file of core) {
    const { preamble, blocks: b } = splitBlocks(readText(file, ''));
    if (preamble.trim()) preambles.push(preamble.trim());
    blocks.push(...b);
  }
  const applied = [];
  const errors = [];
  const extra = [];
  for (const { layer, file } of layerFiles(brainDir, { harness, machine })) {
    const text = readText(file, null);
    if (text === null) continue;
    const rel = path.relative(brainDir, file).split(path.sep).join('/');
    const { entries, errors: e } = parseExceptions(text, rel, immutable);
    errors.push(...e);
    for (const entry of entries) {
      const target = blocks.find((b) => b.id === entry.id);
      const text = `### ${entry.id}${entry.title ? `: ${entry.title}` : ''} (výnimka: ${layer})\n${entry.wording}\n`;
      const extraTarget = extra.find((b) => b.id === entry.id);
      if (target) target.text = text;
      else if (extraTarget) extraTarget.text = text;
      else extra.push({ id: entry.id, text });
      const prev = applied.find((a) => a.id === entry.id);
      if (prev) prev.layer = layer; else applied.push({ id: entry.id, layer });
    }
  }
  // Project rules: one record per file in <brain>/rules/ (written by `save rule`, P-024, P-039).
  const projectRules = brainDir
    ? listFiles(path.join(brainDir, 'rules'), (f) => f.endsWith('.md') && path.basename(f) !== 'README.md', { recursive: false })
      .map((file) => {
        const { data, body } = parseFrontmatter(readText(file, ''));
        const title = data.title || path.basename(file, '.md');
        const by = foreign ? foreign(path.relative(brainDir, file).split(path.sep).join('/')) : null;
        return body.trim() ? { text: `### ${title}\n${body.trim()}`, shown: `### ${title}${byTag(by)}\n${body.trim()}` } : null;
      })
      .filter(Boolean)
    : [];
  const compose = (which) => {
    const parts = [];
    if (preambles.length) parts.push(preambles.join('\n\n'));
    parts.push(...blocks.map((b) => b.text.trimEnd()));
    if (projectRules.length) parts.push('Pravidlá projektu (brain `rules/`):', ...projectRules.map((r) => r[which]));
    if (extra.length) parts.push('Výnimky z princípov mimo jadra:', ...extra.map((b) => b.text.trimEnd()));
    parts.push(applied.length ? `Výnimky: ${applied.map((a) => `${a.id} (${a.layer})`).join(', ')}` : 'Výnimky: žiadne');
    if (errors.length) parts.push(`Odmietnuté výnimky: ${errors.join('; ')}`);
    return parts.join('\n\n') + '\n';
  };
  const text = compose('text');
  const shown = compose('shown');
  const lines = text.split('\n').length - 1;
  const chars = text.length;
  const limits = policy?.limits || {};
  const overLimit = [];
  if (lines > (limits.rules_lines ?? 200)) overLimit.push(`rules ${lines} lines > ${limits.rules_lines ?? 200}`);
  if (chars > (limits.rules_chars ?? 10000)) overLimit.push(`rules ${chars} chars > ${limits.rules_chars ?? 10000}`);
  return { text, shown, applied, errors, lines, chars, overLimit };
}
