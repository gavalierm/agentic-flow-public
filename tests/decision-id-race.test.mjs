// Two threads saving a decision at once both got D-0033 in one brain (decision-id-race, 2026-11-13). A repo decision
// takes its ID under the repo lock like a brain decision under the brain lock, and consolidate reports an ID two
// decisions of one store share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, initProject } from './helpers.mjs';
import { brainLockPath } from '../scripts/brain.mjs';

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const decision = (id, title) => `---\nkey: ${id}\nid: ${id}\ntitle: ${title}\nstatus: valid\nrelates_to:\n  - P-008\ncreated: 2026-11-13\n---\n**Rozhodnuté:** x\n\n**Zamietnuté alternatívy:** -\n\n**Dôvod:** x\n`;

test('decision id: consolidate reports two decisions of one brain with one ID', () => {
  const fx = setup({ remote: false });
  try {
    const dir = path.join(fx.brain, 'decisions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'd-0001-sources.md'), decision('D-0001', 'Sources'));
    fs.writeFileSync(path.join(dir, 'd-0001-vault.md'), decision('D-0001', 'Vault'));
    fs.writeFileSync(path.join(dir, 'd-0002-other.md'), decision('D-0002', 'Other'));
    git(fx.brain, 'add', '-A');
    git(fx.brain, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
    const r = fx.run('consolidate.mjs', ['report']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /decision IDs used twice in one store \(renumber one[^)]*\): D-0001 \([^)]+\): \S*decisions\/d-0001-sources\.md \+ \S*decisions\/d-0001-vault\.md\n/, r.out);
    assert.doesNotMatch(r.out, /D-0002 \(/);
    const json = JSON.parse(fx.run('consolidate.mjs', ['report', '--json']).stdout);
    assert.equal(json.identity.ids.length, 1);
  } finally { fx.cleanup(); }
});

test('decision id: --remove of an ID two decisions share needs --path and removes only that file', () => {
  const fx = setup({ remote: false });
  try {
    const dir = path.join(fx.brain, 'decisions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'd-0001-sources.md'), decision('D-0001', 'Sources'));
    fs.writeFileSync(path.join(dir, 'd-0001-vault.md'), decision('D-0001', 'Vault'));
    git(fx.brain, 'add', '-A');
    git(fx.brain, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
    const reason = 'operator 2026-11-13: renumbered';
    let r = fx.run('save.mjs', ['decision', '--remove', 'D-0001', '--reason', reason]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /D-0001 has 2 files .*--path <file>: decisions\/d-0001-sources\.md, decisions\/d-0001-vault\.md/, r.out);
    assert.ok(fs.existsSync(path.join(dir, 'd-0001-sources.md')) && fs.existsSync(path.join(dir, 'd-0001-vault.md')), 'nothing removed');
    r = fx.run('save.mjs', ['decision', '--remove', 'D-0001', '--path', 'decisions/d-0001-nope.md', '--reason', reason]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /has no file decisions\/d-0001-nope\.md/);
    r = fx.run('save.mjs', ['decision', '--remove', 'D-0001', '--path', 'decisions/d-0001-sources.md', '--reason', reason]);
    assert.equal(r.status, 0, r.out);
    assert.ok(!fs.existsSync(path.join(dir, 'd-0001-sources.md')), 'the named file is removed');
    assert.ok(fs.existsSync(path.join(dir, 'd-0001-vault.md')), 'the other decision with the ID stays');
  } finally { fx.cleanup(); }
});

test('decision id: a repo decision committed while save --repo waits for the repo lock is not given the same ID', async () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
    const srv = path.join(fx.root, 'srv');
    initProject(srv);
    fs.writeFileSync(path.join(srv, '.workflow.json'), JSON.stringify({ brain: '../brain', knowledge_branch: 'main' }) + '\n');
    git(srv, 'commit', '-qam', 'knowledge branch');
    const lock = brainLockPath(srv);
    fs.mkdirSync(lock);
    const pending = fx.runAsync('save.mjs', ['decision', 'Logs to journald', '--what', 'journald', '--reason', 'x', '--relates-to', 'srv/README.md', '--repo', 'srv']);
    // Another thread holds the repo lock and commits srv/D-0001 meanwhile.
    await new Promise((r) => setTimeout(r, 2500));
    fs.mkdirSync(path.join(srv, 'agentic', 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(srv, 'agentic', 'decisions', 'd-0001-caddy.md'), decision('D-0001', 'Caddy'));
    git(srv, 'add', '-A');
    git(srv, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', '[brain-script] save decision D-0001 caddy');
    fs.rmSync(lock, { recursive: true, force: true });
    const r = await pending;
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /decision srv\/D-0002/, r.out);
    assert.ok(fs.existsSync(path.join(srv, 'agentic', 'decisions', 'd-0002-logs-to-journald.md')), 'the waiting writer took the next free ID');
  } finally { fx.cleanup(); }
});
