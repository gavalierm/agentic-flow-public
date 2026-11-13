// One subject of knowledge, one record in one place (D-0028): save, find, move and consolidate see every knowledge store
// of the machine (the brains the projects point to, each domain brain, <repo>/agentic/ of the domain repos); a folder
// with memory/ that no project points to is no store. Decision IDs stay per store; another store's is <store>/D-NNNN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, initProject, PLUGIN_ROOT, memoryRecord } from './helpers.mjs';

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
const MAIL = `t${'@'}t`;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const decision = (id, title, body = 'Rozhodnuté: x.') => `---\nkey: ${id}\nid: ${id}\ntitle: ${title}\nstatus: valid\nrelates_to: [P-008]\n---\n${body}\n`;

function brain(fx, dir) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), dir], { env: fx.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'user.email', MAIL);
}

/** Commit files written straight into a fixture store (the brain hooks are for agents, not for the fixture). */
function commit(dir, files) {
  for (const [rel, text] of Object.entries(files)) put(path.join(dir, rel), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'fixture');
}

/**
 * Two domains, alpha and beta, under one root. Each: a persona (brain "."), a domain brain, a repo with agentic/
 * pointing to the domain brain, and a copy folder with memory/ and no .workflow.json (not a store).
 */
function machine() {
  const fx = setup({ remote: false });
  const d = {};
  for (const [dom, persona, repo] of [['alpha', 'agent-one', 'web-a'], ['beta', 'agent-two', 'web-b']]) {
    const root = path.join(fx.root, dom);
    fs.mkdirSync(root);
    put(path.join(root, '.agentic-domain'), JSON.stringify({ brain: `${dom}-brain` }));
    brain(fx, path.join(root, `${dom}-brain`));
    const p = path.join(root, persona);
    brain(fx, p);
    put(path.join(p, '.workflow.json'), JSON.stringify({ brain: '.' }) + '\n');
    commit(p, {});
    const r = path.join(root, repo);
    initProject(r, { brainRel: `../${dom}-brain` });
    put(path.join(r, '.workflow.json'), JSON.stringify({ brain: `../${dom}-brain`, knowledge_branch: 'main' }) + '\n');
    commit(r, { 'agentic/HANDOVER.md': `# ${repo}\n` });
    const copy = path.join(root, `${dom}-copy`);
    fs.mkdirSync(path.join(copy, 'topics'), { recursive: true });
    git(copy, 'init', '-q', '-b', 'main');
    put(path.join(copy, 'memory', 'project-ghost.md'), memoryRecord('project-ghost', 'A copy kept for reading.'));
    d[dom] = { root, brain: path.join(root, `${dom}-brain`), persona: p, repo: r };
  }
  commit(d.beta.brain, {
    'memory/project-shop.md': memoryRecord('project-shop', 'The shop of beta.', 'aliases: [storefront]\n'),
    'decisions/d-0001-beta-choice.md': decision('D-0001', 'Beta choice'),
  });
  commit(d.beta.repo, {
    'agentic/memory/service-cache.md': memoryRecord('service-cache', 'Cache of web-b.', 'aliases: [redis box]\n'),
    'agentic/decisions/d-0001-web-b-choice.md': decision('D-0001', 'Web-b choice'),
  });
  commit(d.beta.persona, {
    'memory/operator-pat.md': memoryRecord('operator-pat', 'Pat, the operator of beta.', 'aliases: [patty]\n'),
    'memory/environment-lab.md': memoryRecord('environment-lab', 'Lab machine.'),
  });
  const run = (bin, args, opts = {}) => fx.run(bin, args, { cwd: d.alpha.persona, ...opts });
  return { fx, d, run, cleanup: () => fx.cleanup() };
}

const posix = (p) => p.split(path.sep).join('/');

test('identity: a project key of another domain is refused with its path, store and the way to write into it', () => {
  const m = machine();
  try {
    const r = m.run('save.mjs', ['memory', 'project', 'shop', '--content', 'Our shop.']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /project-shop: this subject already has a record in store beta-brain \(same key\)/);
    assert.ok(r.out.includes(posix(path.join(m.d.beta.brain, 'memory', 'project-shop.md'))), r.out);
    assert.match(r.out, /write into that record \(save\.mjs memory project shop --project \S*beta\/web-b --content \.\.\.\), or pass --new/);
    assert.equal(fs.existsSync(path.join(m.d.alpha.persona, 'memory', 'project-shop.md')), false);
    const n = m.run('save.mjs', ['memory', 'project', 'shop', '--content', 'Another shop.', '--new']);
    assert.equal(n.status, 0, n.out);
    assert.ok(fs.existsSync(path.join(m.d.alpha.persona, 'memory', 'project-shop.md')), '--new passes: another subject');
  } finally { m.cleanup(); }
});

test('identity: a name or alias of a project, service, person or tool record elsewhere is refused', () => {
  const m = machine();
  try {
    let r = m.run('save.mjs', ['memory', 'project', 'storefront', '--content', 'x']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /this subject already has a record in store beta-brain \(alias "storefront"\)/);
    r = m.run('save.mjs', ['memory', 'tool', 'redis', '--aliases', 'Cache', '--content', 'x']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /store web-b \(name "cache"\).*web-b\/agentic\/memory\/service-cache\.md.*--repo web-b --project \S*beta\/web-b/);
  } finally { m.cleanup(); }
});

test('identity: --aliases naming another record of any store is refused, also on an overwrite and with --new', () => {
  const m = machine();
  try {
    let r = m.run('save.mjs', ['memory', 'environment', 'rack', '--aliases', 'Redis Box', '--content', 'x']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /--aliases Redis Box: already the key, name or alias of service-cache in store web-b: \S*web-b\/agentic\/memory\/service-cache\.md/);
    assert.equal(m.run('save.mjs', ['memory', 'tool', 'drill', '--content', 'x']).status, 0);
    r = m.run('save.mjs', ['memory', 'tool', 'drill', '--aliases', 'project-shop', '--content', 'y']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /--aliases project-shop: already the key, name or alias of project-shop in store beta-brain/);
    assert.equal(m.run('save.mjs', ['memory', 'tool', 'hammer', '--content', 'x']).status, 0);
    r = m.run('save.mjs', ['memory', 'tool', 'saw', '--aliases', 'hammer', '--new', '--content', 'x']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /--aliases hammer: already the key, name or alias of tool-hammer in store agent-one/, 'the own store counts too');
    assert.equal(m.run('save.mjs', ['memory', 'tool', 'drill', '--aliases', 'bore', '--content', 'z']).status, 0, 'a free alias passes');
  } finally { m.cleanup(); }
});

test('identity: operator and environment records of the same key live in each persona; the copy folder is no store', () => {
  const m = machine();
  try {
    let r = m.run('save.mjs', ['memory', 'operator', 'pat', '--aliases', 'patty', '--content', 'Pat as alpha knows them.']);
    assert.equal(r.status, 0, r.out);
    r = m.run('save.mjs', ['memory', 'environment', 'lab', '--content', 'Lab as alpha sees it.']);
    assert.equal(r.status, 0, r.out);
    r = m.run('save.mjs', ['memory', 'project', 'ghost', '--content', 'Ghost of alpha.']);
    assert.equal(r.status, 0, r.out);
    r = m.run('find.mjs', ['project-ghost']);
    assert.doesNotMatch(r.out, /alpha-copy|beta-copy/);
  } finally { m.cleanup(); }
});

test('identity: brainGuard compares the normalized repo name with the key', () => {
  const m = machine();
  try {
    const repo = path.join(m.d.alpha.root, 'Web_C');
    initProject(repo, { brainRel: '../alpha-brain' });
    const r = m.run('save.mjs', ['memory', 'project', 'web c', '--content', 'x']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /project-web-c describes repo Web_C: its knowledge belongs to Web_C\/agentic\//);
  } finally { m.cleanup(); }
});

test('identity: the next decision number never reuses a removed one, in brain and in a repo', () => {
  const m = machine();
  try {
    const dec = (title, extra = []) => m.run('save.mjs', ['decision', title, '--what', 'w', '--reason', 'r', '--relates-to', 'P-008', ...extra]);
    assert.match(dec('First').out, /decision D-0001/);
    assert.match(dec('Second').out, /decision D-0002/);
    let r = m.run('save.mjs', ['decision', '--remove', 'D-0002', '--reason', 'operator 2026-11-13: test']);
    assert.equal(r.status, 0, r.out);
    assert.match(dec('Third').out, /decision D-0003/);
    assert.match(dec('Repo first', ['--repo', 'web-a']).out, /decision web-a\/D-0001/);
    r = m.run('save.mjs', ['decision', '--remove', 'D-0001', '--repo', 'web-a', '--reason', 'operator 2026-11-13: test']);
    assert.equal(r.status, 0, r.out);
    assert.match(dec('Repo second', ['--repo', 'web-a']).out, /decision web-a\/D-0002/);
  } finally { m.cleanup(); }
});

test('identity: a bare D-NNNN the target store lacks is refused, a qualified one resolves or is refused', () => {
  const m = machine();
  try {
    let r = m.run('save.mjs', ['memory', 'tool', 'hammer', '--content', 'Chosen in D-0001.']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /D-0001: agent-one has no D-0001 \(a bare D-NNNN means the own store, another store's decision is written <store>\/D-NNNN\); it is beta-brain\/D-0001 or web-b\/D-0001; nothing saved/);
    r = m.run('save.mjs', ['memory', 'tool', 'hammer', '--content', 'Chosen in beta-brain/D-0001.']);
    assert.equal(r.status, 0, r.out);
    r = m.run('save.mjs', ['memory', 'tool', 'saw', '--content', 'Chosen in beta-brain/D-0007.']);
    assert.match(r.out, /beta-brain\/D-0007: beta-brain has no D-0007; no store has D-0007/);
    r = m.run('save.mjs', ['memory', 'tool', 'saw', '--content', 'Chosen in nowhere/D-0001.']);
    assert.match(r.out, /nowhere\/D-0001: no store nowhere; it is beta-brain\/D-0001 or web-b\/D-0001/);
    const dec = (extra) => m.run('save.mjs', ['decision', 'Pick', '--what', 'w', '--reason', 'r', ...extra]);
    r = dec(['--relates-to', 'D-0001']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /agent-one has no D-0001/);
    r = dec(['--relates-to', 'P-008', '--supersedes', 'D-0001']);
    assert.match(r.out, /agent-one has no D-0001/);
    assert.equal(dec(['--relates-to', 'beta-brain/D-0001']).status, 0);
    r = m.run('save.mjs', ['rule', 'pick', '--content', 'Follow D-0009.', '--unenforced', 'a judgement the code cannot make']);
    assert.match(r.out, /D-0009: agent-one has no D-0009/);
    r = m.run('save.mjs', ['handover', '--repo', 'web-a', '--content', '# web-a\n\nPer D-0001.']);
    assert.match(r.out, /D-0001: web-a has no D-0001 .*it is agent-one\/D-0001/);
    assert.equal(m.run('save.mjs', ['handover', '--repo', 'web-a', '--content', '# web-a\n\nPer agent-one/D-0001.']).status, 0);
    assert.equal(fs.readdirSync(path.join(m.d.alpha.persona, 'memory')).filter((f) => f.startsWith('tool-saw')).length, 0, 'nothing saved');
  } finally { m.cleanup(); }
});

test('identity: find names the store of a match outside the session brain, also for D-NNNN', () => {
  const m = machine();
  try {
    assert.equal(m.run('save.mjs', ['decision', 'Own', '--what', 'w', '--reason', 'r', '--relates-to', 'P-008']).status, 0);
    let r = m.run('find.mjs', ['project-shop']);
    assert.match(r.stdout, /project-shop\.md: The shop of beta\. \[store beta-brain\]/);
    r = m.run('find.mjs', ['D-0001']);
    const lines = r.stdout.trim().split('\n');
    assert.match(lines[0], /^decisions\/d-0001-own\.md: Own$/, 'the session brain first, as before');
    assert.ok(lines.some((l) => /\[store beta-brain\]$/.test(l)) && lines.some((l) => /\[store web-b\]$/.test(l)), r.stdout);
    r = m.run('find.mjs', ['web-b/D-0001']);
    assert.equal(r.stdout.trim().split('\n').length, 1, r.stdout);
    assert.match(r.stdout, /d-0001-web-b-choice\.md: Web-b choice \[store web-b\]/);
  } finally { m.cleanup(); }
});

test('identity: moving a decision rewrites its references in brain and repo, lists the other stores', () => {
  const m = machine();
  try {
    assert.equal(m.run('save.mjs', ['decision', 'Use x', '--what', 'w', '--reason', 'r', '--relates-to', 'P-008']).status, 0);
    assert.equal(m.run('save.mjs', ['decision', 'Use y', '--what', 'w after D-0001', '--reason', 'r', '--relates-to', 'P-008']).status, 0);
    assert.equal(m.run('save.mjs', ['memory', 'tool', 'hammer', '--content', 'Per D-0001.']).status, 0);
    let r = m.run('save.mjs', ['memory', 'tool', 'saw', '--repo', 'web-a', '--content', 'Per agent-one/D-0001.']);
    assert.equal(r.status, 0, r.out);
    commit(m.d.beta.repo, { 'agentic/memory/tool-file.md': memoryRecord('tool-file', 'Like agent-one/D-0001.') });
    r = m.run('save.mjs', ['move', 'decisions/d-0001-use-x.md', '--repo', 'web-a', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /would rewrite references in: .*agent-one\/memory\/tool-hammer\.md.*web-a\/agentic\/memory\/tool-saw\.md/);
    assert.match(fs.readFileSync(path.join(m.d.alpha.persona, 'memory', 'tool-hammer.md'), 'utf8'), /Per D-0001\./, 'dry run changes nothing');
    r = m.run('save.mjs', ['move', 'decisions/d-0001-use-x.md', '--repo', 'web-a']);
    assert.equal(r.status, 0, r.out);
    assert.match(fs.readFileSync(path.join(m.d.alpha.persona, 'memory', 'tool-hammer.md'), 'utf8'), /Per web-a\/D-0001\./);
    assert.match(fs.readFileSync(path.join(m.d.alpha.persona, 'decisions', 'd-0002-use-y.md'), 'utf8'), /w after web-a\/D-0001/);
    assert.match(fs.readFileSync(path.join(m.d.alpha.repo, 'agentic', 'memory', 'tool-saw.md'), 'utf8'), /Per web-a\/D-0001\./);
    assert.match(fs.readFileSync(path.join(m.d.alpha.repo, 'agentic', 'decisions', 'd-0001-use-x.md'), 'utf8'), /moved_from: agent-one\/D-0001/);
    assert.match(fs.readFileSync(path.join(m.d.beta.repo, 'agentic', 'memory', 'tool-file.md'), 'utf8'), /Like agent-one\/D-0001\./, 'another store is not changed');
    assert.match(r.out, /references elsewhere, not changed:\n\S*beta\/web-b\/agentic\/memory\/tool-file\.md:\d+/);
    assert.match(r.out, /decision agent-one\/D-0001 is now web-a\/D-0001/);
    assert.deepEqual(git(m.d.alpha.repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['agentic/decisions/d-0001-use-x.md', 'agentic/memory/tool-saw.md']);
    assert.deepEqual(git(m.d.alpha.persona, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter((f) => /^(memory|decisions)\//.test(f)).sort(), ['decisions/d-0001-use-x.md', 'decisions/d-0002-use-y.md', 'memory/tool-hammer.md']);
  } finally { m.cleanup(); }
});

test('identity: moving a memory record renews the source path and fingerprint of a derived record', () => {
  const m = machine();
  try {
    assert.equal(m.run('save.mjs', ['memory', 'tool', 'anvil', '--content', 'Anvil of web-a.']).status, 0);
    assert.equal(m.run('save.mjs', ['memory', 'tool', 'forge', '--origin', 'derived', '--sources', 'memory/tool-anvil.md', '--content', 'Forge uses the anvil.']).status, 0);
    const r = m.run('save.mjs', ['move', 'memory/tool-anvil.md', '--repo', 'web-a']);
    assert.equal(r.status, 0, r.out);
    const forge = fs.readFileSync(path.join(m.d.alpha.persona, 'memory', 'tool-forge.md'), 'utf8');
    assert.match(forge, /\.\.\/web-a\/agentic\/memory\/tool-anvil\.md/);
    const c = m.run('consolidate.mjs', ['report']);
    assert.match(c.out, /stale derived \(fingerprint changed, re-derive or delete\): none/, c.out);
  } finally { m.cleanup(); }
});

test('identity: consolidate reports a subject in two stores, a tombstone and a bare reference that does not resolve', () => {
  const m = machine();
  try {
    assert.equal(m.run('save.mjs', ['memory', 'project', 'shop', '--new', '--content', 'Our shop.']).status, 0);
    assert.equal(m.run('save.mjs', ['memory', 'tool', 'old', '--content', 'Presunuté do web-a.']).status, 0);
    commit(m.d.alpha.persona, { 'memory/tool-legacy.md': memoryRecord('tool-legacy', 'Line one.\nSee D-0042 for the reason.') });
    const r = m.run('consolidate.mjs', ['report']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /same subject in another store .*project-shop \(same key, agent-one \+ beta-brain\): \S*alpha\/agent-one\/memory\/project-shop\.md \+ \S*beta\/beta-brain\/memory\/project-shop\.md/);
    assert.match(r.out, /tombstones .*: \S*alpha\/agent-one\/memory\/tool-old\.md/);
    assert.match(r.out, /decision references that do not resolve .*: \S*alpha\/agent-one\/memory\/tool-legacy\.md:\d+ D-0042: agent-one has no D-0042/);
    const json = JSON.parse(m.run('consolidate.mjs', ['report', '--json']).stdout);
    assert.equal(json.identity.duplicates.length, 1);
  } finally { m.cleanup(); }
});
