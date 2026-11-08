// docs/principles/: one file per principle (P-NNN.md) + README index; rules/ are the short working text, the reasons are read
// one principle at a time, never by searching the whole directory (operator 2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { principlesBulkRead } from '../hooks/pre-tool-use.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'docs', 'principles');
const files = fs.readdirSync(dir).filter((f) => /^P-\d{3}\.md$/.test(f));

test('principles: every file starts with its own heading, the README indexes all of them, the single big file is gone', () => {
  assert.ok(files.length >= 60);
  assert.equal(fs.existsSync(path.join(root, 'docs', 'PRINCIPLES.md')), false);
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const f of files) {
    const id = f.replace('.md', '');
    assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), new RegExp(`^### ${id}: `), `${f} heading`);
    assert.ok(readme.includes(`[${id}](${f})`), `README lists ${id}`);
  }
});

test('principles: every rule P-NNN in rules/ has its principle file', () => {
  for (const f of fs.readdirSync(path.join(root, 'rules')).filter((n) => /^\d.*\.md$/.test(n))) {
    for (const m of fs.readFileSync(path.join(root, 'rules', f), 'utf8').matchAll(/^### (P-\d{3}):/gm)) {
      assert.ok(files.includes(`${m[1]}.md`), `${m[1]} (rules/${f}) has docs/principles/${m[1]}.md`);
    }
  }
});

test('principles hook: one principle file or the index passes; searching or listing the directory is denied', () => {
  const p = dir;
  assert.equal(principlesBulkRead('Bash', { command: `cat ${p}/P-020.md` }, root), null);
  assert.equal(principlesBulkRead('Bash', { command: `cat ${p}/README.md` }), null);
  assert.equal(principlesBulkRead('Read', { file_path: `${p}/P-020.md` }), null);
  assert.equal(principlesBulkRead('Bash', { command: 'ls docs' }), null);
  // a project's own docs/principles (no P-001.md in it) is not ours
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  fs.mkdirSync(path.join(other, 'docs', 'principles'), { recursive: true });
  assert.equal(principlesBulkRead('Bash', { command: 'grep -r x docs/principles' }, other), null);
  fs.rmSync(other, { recursive: true, force: true });
  for (const command of [`grep -r timeout ${p}`, `cat ${p}/*`, `cat ${p}/P-0*.md`, `ls ${p}/`, `rg x docs/principles`, `cd ${root} && ls docs/principles`, `cat ${p}/P-0201.md`]) {
    assert.match(principlesBulkRead('Bash', { command }, root) || '', /one principle at a time/, command);
  }
  // searching the parent docs/ reaches principles/ too, so it is the same bulk read (git grep x -- docs was a bypass)
  for (const command of ['git grep foo -- docs', 'grep -rn foo docs', 'grep -r foo docs/', `rg foo ${path.join(root, 'docs')}`, 'find docs -name "*.md"']) {
    assert.match(principlesBulkRead('Bash', { command }, root) || '', /one principle at a time/, command);
  }
  assert.match(principlesBulkRead('Grep', { pattern: 'x', path: path.join(root, 'docs') }, root) || '', /one principle/);
  assert.equal(principlesBulkRead('Bash', { command: 'git grep foo -- hooks' }, root), null);
  assert.equal(principlesBulkRead('Bash', { command: 'cat docs/t3-workarounds.json' }, root), null);
  assert.match(principlesBulkRead('Grep', { pattern: 'x', path: p }) || '', /one principle/);
  assert.match(principlesBulkRead('Glob', { pattern: 'docs/principles/*.md' }) || '', /one principle/);
  // text that only names the path (mail body in a heredoc, echo) is not a read; a listing piped to grep searches the listing
  for (const command of [`cat > scratch/m.md <<'EOF'\nhook denied ls ${p}/ and grep -r x ${p}\nEOF\nnode comms.mjs send --file scratch/m.md`, `echo "see ${p}" >> scratch/n.md`, `ls ${path.join(root, 'docs')}/*.md | grep -c md`, `comms.mjs send --text - <<EOF\nrg x ${p}\nEOF`]) {
    assert.equal(principlesBulkRead('Bash', { command }, root), null, command);
  }
  // a heredoc a shell or an interpreter runs still reads
  for (const command of [`sh <<'EOF'\nls ${p}\nEOF`, `node <<'EOF'\nrequire('fs').readdirSync('${p}')\nEOF`, `echo x && ls ${p}`]) {
    assert.match(principlesBulkRead('Bash', { command }, root) || '', /one principle at a time/, command);
  }
});
