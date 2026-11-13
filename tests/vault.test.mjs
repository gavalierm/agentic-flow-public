// vault.mjs: a read-only vault of the knowledge stores of the machine (wikilinks, README, Bases file, idempotent rebuild).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, initProject, PLUGIN_ROOT } from './helpers.mjs';

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, 'utf8');
const decision = (id, title, extra = '', body = 'Rozhodnuté: x.') => `---\nkey: ${id}\nid: ${id}\ntitle: ${title}\nstatus: valid\n${extra}---\n${body}\n`;
const memory = (key, body, extra = '') => `---\nkey: ${key}\ntype: ${key.split('-')[0]}\nname: ${key.split('-').slice(1).join(' ')}\norigin: operator\n${extra}---\n${body}\n`;

function brain(fx, dir) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), dir], { env: fx.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}

/**
 * Two domains, alpha and beta; each has a domain brain with the same name (core-brain) and decision D-0001. Alpha also
 * has a repo web-a with agentic/ (D-0002, HANDOVER.md). The session runs in web-a.
 */
function machine() {
  const fx = setup({ remote: false });
  const d = {};
  for (const dom of ['alpha', 'beta']) {
    const root = path.join(fx.root, dom);
    fs.mkdirSync(root);
    put(path.join(root, '.agentic-domain'), JSON.stringify({ brain: 'core-brain' }));
    brain(fx, path.join(root, 'core-brain'));
    d[dom] = { root, brain: path.join(root, 'core-brain') };
  }
  const repo = path.join(d.alpha.root, 'web-a');
  initProject(repo, { brainRel: '../core-brain' });
  put(path.join(repo, 'agentic', 'HANDOVER.md'), '# web-a\nNext: D-0002.\n');
  put(path.join(repo, 'agentic', 'decisions', 'd-0002-repo-choice.md'), decision('D-0002', 'Repo choice'));
  d.alpha.repo = repo;
  const a = d.alpha.brain;
  put(path.join(a, 'memory', 'project-shop.md'), memory('project-shop', 'Bare D-0001, repo web-a/D-0002, other beta-core-brain/D-0001, key service-cache, principle P-008, unknown D-0099.\n\n`D-0001 in code` stays.', 'relates_to: [D-0001]\n'));
  put(path.join(a, 'decisions', 'd-0001-alpha-choice.md'), decision('D-0001', 'Alpha choice', 'relates_to: [project-shop, P-008, nothing-here]\nsupersedes: beta-core-brain/D-0001\n', 'Rozhodnuté: see project-shop.'));
  put(path.join(a, 'memory', 'tool-old.md'), memory('tool-old', 'Soon gone.'));
  put(path.join(a, 'logs', '2026-11.md'), 'log line D-0001\n');
  put(path.join(a, 'local', 'secret.md'), 'local\n');
  put(path.join(a, 'topics', 't1', 'topic.json'), '{}\n');
  put(path.join(a, 'topics', 't1', 'handover.md'), '# t1\nD-0001\n');
  put(path.join(a, 'topics', 'archive', 'old', 'handover.md'), '# archived\n');
  put(path.join(a, 'skills', 'agentic', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: "Demo skill."\n---\nBody.\n');
  const b = d.beta.brain;
  put(path.join(b, 'decisions', 'd-0001-beta-choice.md'), decision('D-0001', 'Beta choice'));
  put(path.join(b, 'memory', 'service-cache.md'), memory('service-cache', 'Cache of beta, bare D-0001.'));
  const run = (args) => fx.run('vault.mjs', args, { cwd: repo });
  return { fx, d, run, cleanup: () => fx.cleanup() };
}

const files = (dir) => {
  const out = [];
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) { if (e.name !== '.git') walk(f); } else out.push(path.relative(dir, f).split(path.sep).join('/')); } };
  walk(dir);
  return out.sort();
};

test('vault build: stores of both domains, same names told apart, links as wikilinks, sources untouched', () => {
  const m = machine();
  try {
    const src = read(path.join(m.d.alpha.brain, 'memory', 'project-shop.md'));
    const out = path.join(m.fx.root, 'vault');
    const r = m.run(['build', '--out', out]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^vault .*vault: stores 3, files \d+, links [1-9]\d*, unresolved [1-9]\d*\n$/);
    const all = files(out);
    assert.ok(all.includes('alpha-core-brain/decisions/d-0001-alpha-choice.md'), all.join('\n'));
    assert.ok(all.includes('beta-core-brain/decisions/d-0001-beta-choice.md'));
    assert.ok(all.includes('web-a/decisions/d-0002-repo-choice.md'));
    assert.ok(all.includes('web-a/handovers/web-a.md'));
    assert.ok(all.includes('alpha-core-brain/handovers/t1.md'));
    assert.ok(all.includes('alpha-core-brain/skills/demo.md'));
    // logs, local, topic.json, archived topics never come in
    assert.deepEqual(all.filter((f) => /(^|\/)(logs|local|scratch|\.claude)\/|topic\.json|archive\/|\/old\//.test(f)), []);
    const shop = read(path.join(out, 'alpha-core-brain/memory/project-shop.md'));
    assert.match(shop, /Bare \[\[alpha-core-brain\/decisions\/d-0001-alpha-choice\|D-0001\]\]/, 'a bare D-NNNN is the own store');
    assert.match(shop, /\[\[web-a\/decisions\/d-0002-repo-choice\|web-a\/D-0002\]\]/, 'a qualified one is the named store');
    assert.match(shop, /\[\[beta-core-brain\/decisions\/d-0001-beta-choice\|beta-core-brain\/D-0001\]\]/, 'a qualified one by the vault name of a clashing store');
    assert.match(shop, /key \[\[beta-core-brain\/memory\/service-cache\|service-cache\]\]/, 'a record key of another store');
    assert.match(shop, /principle P-008, unknown D-0099\./, 'P-NNN without a file and an unknown decision stay text');
    assert.match(shop, /`D-0001 in code` stays/, 'inline code is not rewritten');
    assert.match(shop, /key: project-shop\n/, 'key: line unchanged');
    assert.match(shop, /relates_to:\n  - "\[\[alpha-core-brain\/decisions\/d-0001-alpha-choice\|D-0001\]\]"\n/);
    const dec = read(path.join(out, 'alpha-core-brain/decisions/d-0001-alpha-choice.md'));
    assert.match(dec, /key: D-0001\nid: D-0001\n/);
    assert.match(dec, /relates_to:\n  - "\[\[alpha-core-brain\/memory\/project-shop\|project-shop\]\]"\n  - P-008\n  - nothing-here\n/);
    assert.match(dec, /supersedes:\n  - "\[\[beta-core-brain\/decisions\/d-0001-beta-choice\|beta-core-brain\/D-0001\]\]"\n/);
    const cache = read(path.join(out, 'beta-core-brain/memory/service-cache.md'));
    assert.match(cache, /bare \[\[beta-core-brain\/decisions\/d-0001-beta-choice\|D-0001\]\]/, 'a bare D-NNNN in beta is beta\'s');
    assert.equal(read(path.join(m.d.alpha.brain, 'memory', 'project-shop.md')), src, 'the source is not changed');
    const readme = read(path.join(out, 'README.md'));
    assert.match(readme, /\[\[alpha-core-brain\/decisions\/d-0001-alpha-choice\|D-0001\]\] – Alpha choice \(valid\)/);
    assert.match(readme, /\[\[web-a\/handovers\/web-a\|web-a\]\]/);
    const base = read(path.join(out, 'vedomosti.base'));
    assert.match(base, /views:\n {2}- type: table/);
    assert.match(base, /\/memory\//);
    assert.match(base, /\/decisions\//);
    assert.equal(read(path.join(out, '.obsidian', 'app.json')).trim(), '{"defaultViewMode":"preview"}');
    assert.match(read(path.join(out, '.gitignore')), /\.obsidian\/workspace\*\.json/);
  } finally { m.cleanup(); }
});

test('vault build: a rebuild is identical, a file without a source is deleted, .obsidian and foreign files stay', () => {
  const m = machine();
  try {
    const out = path.join(m.fx.root, 'vault');
    assert.equal(m.run(['build', '--out', out]).status, 0);
    const before = Object.fromEntries(files(out).map((f) => [f, read(path.join(out, f))]));
    assert.ok(before['alpha-core-brain/memory/tool-old.md']);
    put(path.join(out, '.obsidian', 'app.json'), '{"defaultViewMode":"source"}\n');
    put(path.join(out, '.obsidian', 'workspace.json'), '{}\n');
    put(path.join(out, 'my-note.md'), 'mine\n');
    const again = m.run(['build', '--out', out]);
    assert.equal(again.status, 0, again.out);
    for (const [f, text] of Object.entries(before)) if (f !== '.obsidian/app.json') assert.equal(read(path.join(out, f)), text, `${f} differs on rebuild`);
    assert.equal(read(path.join(out, '.obsidian', 'app.json')), '{"defaultViewMode":"source"}\n', 'an existing app.json stays');
    fs.rmSync(path.join(m.d.alpha.brain, 'memory', 'tool-old.md'));
    fs.rmSync(path.join(m.d.beta.brain, 'decisions'), { recursive: true });
    const third = m.run(['build', '--out', out]);
    assert.equal(third.status, 0, third.out);
    const after = files(out);
    assert.ok(!after.includes('alpha-core-brain/memory/tool-old.md'), 'the stale file is deleted');
    assert.ok(!after.includes('beta-core-brain/decisions/d-0001-beta-choice.md'));
    assert.ok(!fs.existsSync(path.join(out, 'beta-core-brain', 'decisions')), 'its empty folder too');
    for (const keep of ['.obsidian/workspace.json', 'my-note.md', '.obsidian/app.json', '.gitignore']) assert.ok(after.includes(keep), `${keep} must stay`);
    assert.match(read(path.join(out, 'beta-core-brain/memory/service-cache.md')), /bare D-0001/, 'the link to a deleted decision is text again');
  } finally { m.cleanup(); }
});

test('vault build: refuses a folder that holds a store or lies in what it reads', () => {
  const m = machine();
  try {
    let r = m.run(['build', '--out', m.d.alpha.root]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /overlaps the store/);
    r = m.run(['build', '--out', path.join(m.d.alpha.brain, 'memory', 'vault')]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /overlaps the store/);
    assert.equal(m.run(['build']).status, 1, 'no --out');
  } finally { m.cleanup(); }
});

test('vault publish: refuses a folder that is no git repo; commits and pushes a change once, then says unchanged', () => {
  const m = machine();
  try {
    const plain = path.join(m.fx.root, 'plain');
    const refused = m.run(['publish', '--out', plain]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /is not a git repo/);
    assert.ok(!fs.existsSync(plain), 'nothing is written');
    const origin = path.join(m.fx.root, 'vault-origin.git');
    git(m.fx.root, 'init', '-q', '--bare', '-b', 'main', origin);
    const out = path.join(m.fx.root, 'vault');
    fs.mkdirSync(out);
    git(out, 'init', '-q', '-b', 'main');
    git(out, 'config', 'user.name', 't'); git(out, 'config', 'user.email', `t${'@'}t`);
    git(out, 'remote', 'add', 'origin', origin);
    const first = m.run(['publish', '--out', out]);
    assert.equal(first.status, 0, first.out);
    assert.match(first.stdout, /vault .*: stores 3, files \d+, links \d+, unresolved \d+\nchanged\n/);
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'vault: rebuild');
    assert.match(git(origin, 'ls-tree', '-r', '--name-only', 'main'), /alpha-core-brain\/decisions\/d-0001-alpha-choice\.md/);
    const second = m.run(['publish', '--out', out]);
    assert.equal(second.status, 0, second.out);
    assert.match(second.stdout, /\nunchanged\n$/);
    put(path.join(m.d.beta.brain, 'memory', 'tool-new.md'), memory('tool-new', 'New.'));
    const third = m.run(['publish', '--out', out]);
    assert.match(third.stdout, /\nchanged\n$/, third.out);
    assert.equal(git(origin, 'rev-list', '--count', 'main'), '2');
  } finally { m.cleanup(); }
});
