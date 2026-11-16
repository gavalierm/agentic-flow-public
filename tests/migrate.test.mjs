// keep: core
// Phase 3 of the data mechanics (D-0048): migrate.mjs moves one repository from data layout 1 to layout 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup2, gitq } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';
import { dataLayoutVersion } from '../scripts/layout.mjs';

const HANDOVER = (task) => `## Zadanie\n${task}\n## Hotové\n-\n## Ďalší krok\n-\n## Súbory\n-\n## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n`;

/** Write files into a repo and commit them as the brain script does. */
function commitFiles(dir, files, message = 'fixture', { noVerify = false } = {}) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
  for (const args of [['add', '-A'], ['commit', '-q', ...(noVerify ? ['--no-verify'] : []), '-m', `${BRAIN_COMMIT_TAG} ${message}`]]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
}

/** A brain in layout 1 with an open topic, an archived topic, decisions with sources and paths in the body, docs and materialy. */
function brainV1() {
  const fx = setup2({ brainLayout: 1, thread: 'm1' });
  commitFiles(fx.brain, {
    'topics/alpha/topic.json': JSON.stringify({ id: 'alpha', subject: 'Alpha', state: 'working', class: 'discussion' }, null, 2) + '\n',
    'topics/alpha/holder.json': JSON.stringify({ thread: 'm1', machine: 'x' }, null, 2) + '\n',
    'topics/alpha/handover.md': HANDOVER('Alpha; podklad materialy/alpha/plan.md'),
    'topics/alpha/results.md': '# Výsledky\n- záver v docs/guide.md\n',
    'topics/archive/beta/topic.json': JSON.stringify({ id: 'beta', subject: 'Beta', state: 'closed', closed: '2026-11-01T00:00:00Z' }, null, 2) + '\n',
    'topics/archive/beta/holder.json': '{}\n',
    'topics/archive/beta/handover.md': HANDOVER('Beta'),
    'decisions/d-0001-first.md': '---\nkey: D-0001\nid: D-0001\ntitle: "First"\nstatus: valid\nrelates_to: [materialy/alpha/plan.md, docs/guide.md]\nsources: [docs/guide.md]\naliases: []\ncreated: 2026-11-01\n---\n**Rozhodnuté:** podľa topics/archive/beta/handover.md a decisions/d-0002-second.md; plugin rules/ ostáva.\n',
    'decisions/d-0002-second.md': '---\nkey: D-0002\nid: D-0002\ntitle: "Second"\nstatus: valid\nrelates_to: [D-0001]\naliases: []\ncreated: 2026-11-02\n---\n**Rozhodnuté:** pokračuje v [téme](topics/alpha/) a [handoveri](topics/alpha/handover.md).\n',
    'memory/project-demo.md': '---\nkey: project-demo\nname: Demo\ndescription: Demo projekt\ntype: project\norigin: operator\nrelates_to: [decisions/d-0001-first.md]\n---\nDemo; návod v docs/guide.md.\n',
    'docs/guide.md': '# Návod\nPozri decisions/d-0001-first.md.\n',
    'materialy/alpha/plan.md': '# Plán\n',
    'docs/.env': 'TOKEN=x\n',
  });
  gitq(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
  return fx;
}

const status = (dir) => gitq(dir, 'status', '--porcelain');
const head = (dir) => gitq(dir, 'rev-parse', 'HEAD');

test('preview: every tracked file from -> to by the two layouts, triage without proposal, nothing changes', () => {
  const fx = brainV1();
  try {
    const before = head(fx.brain);
    const r = fx.run('migrate.mjs', [fx.brain]);
    assert.equal(r.status, 0, r.out);
    for (const line of [
      'decisions/d-0001-first.md -> vystupy/rozhodnutia/d-0001-first.md',
      'memory/project-demo.md -> .brain/memory/project-demo.md',
      'policy.json -> .brain/policy.json',
      'topics/alpha/topic.json -> temy/alpha/.tema.json (merged into one topic file)',
      'topics/alpha/holder.json -> temy/alpha/.tema.json (merged into one topic file)',
      'topics/alpha/handover.md -> temy/alpha/handover.md',
      'topics/alpha/results.md -> temy/alpha/results.md',
      'topics/archive/beta/handover.md -> temy/beta/handover.md',
      'docs/guide.md -> vystupy/dokumenty/guide.md',
    ]) assert.ok(r.stdout.includes(line), `${line}\n${r.out}`);
    assert.match(r.stdout, /closed topics \(state closed, stay in temy\/<id>\/\): beta/);
    assert.match(r.stdout, /materialy\/alpha\/\tbez navrhu\t/);
    assert.match(r.stdout, /preview only, nothing changed/);
    assert.match(r.stdout, /^  docs\/\.env: credentials file$/m);
    // A proposal from a triage file is shown, still nothing moves.
    const tsv = path.join(fx.root, 'triage.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\nmaterialy/alpha/\tstav\talpha\tvýsledky témy\n');
    const p = fx.run('migrate.mjs', [fx.brain, '--triage', tsv]);
    assert.match(p.stdout, /materialy\/alpha\/\tstav\talpha\tvýsledky témy\tstays/);
    assert.equal(head(fx.brain), before);
    assert.equal(status(fx.brain), '');
    assert.equal(dataLayoutVersion(fx.brain), 1);
  } finally { fx.cleanup(); }
});

test('apply: layout 2 in one commit, merged .tema.json, closed topic in place, paths rewritten, check passes, workflow v2 works', () => {
  const fx = brainV1();
  try {
    const r = fx.run('migrate.mjs', [fx.brain, '--apply']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /check: ok/);
    assert.equal(dataLayoutVersion(fx.brain), 2);
    assert.equal(gitq(fx.brain, 'rev-list', '--count', 'origin/main..HEAD'), '0', 'pushed');
    assert.match(gitq(fx.brain, 'log', '-1', '--format=%s'), /migrate data layout 1 -> 2/);
    // History of a moved file stays (a rename in the one commit).
    assert.match(gitq(fx.brain, 'log', '--follow', '--format=%s', '--', 'temy/beta/handover.md'), /fixture/);
    assert.match(gitq(fx.brain, 'show', '--format=', '--name-status', 'HEAD'), /^R100\ttopics\/archive\/beta\/handover\.md\ttemy\/beta\/handover\.md$/m);
    const alpha = fx.json('temy/alpha/.tema.json');
    assert.equal(alpha.subject, 'Alpha');
    assert.deepEqual(alpha.holder, { thread: 'm1', machine: 'x' });
    const beta = fx.json('temy/beta/.tema.json');
    assert.equal(beta.state, 'closed');
    assert.deepEqual(beta.holder, {});
    assert.ok(!fx.exists('topics/alpha/holder.json') && !fx.exists('topics/archive'));
    const d1 = fx.read('vystupy/rozhodnutia/d-0001-first.md');
    assert.match(d1, /relates_to: \[materialy\/alpha\/plan\.md, vystupy\/dokumenty\/guide\.md\]/, 'triage item without confirmation keeps its path');
    assert.match(d1, /sources: \[vystupy\/dokumenty\/guide\.md\]/);
    assert.match(d1, /podľa temy\/beta\/handover\.md a vystupy\/rozhodnutia\/d-0002-second\.md; plugin rules\/ ostáva/);
    assert.match(fx.read('vystupy/rozhodnutia/d-0002-second.md'), /\[téme\]\(temy\/alpha\/\) a \[handoveri\]\(temy\/alpha\/handover\.md\)/);
    assert.match(fx.read('.brain/memory/project-demo.md'), /relates_to: \[vystupy\/rozhodnutia\/d-0001-first\.md\]\n[\s\S]*návod v vystupy\/dokumenty\/guide\.md/);
    assert.match(fx.read('temy/alpha/results.md'), /vystupy\/dokumenty\/guide\.md/);
    assert.ok(fx.exists('materialy/alpha/plan.md'), 'triage item stays without a confirmed list');
    assert.ok(fx.exists('docs/.env') && !fx.exists('vystupy/dokumenty/.env'), 'a credentials file is never moved');
    assert.match(fx.read('.gitignore'), /^temy\/\*\/tmp\/$/m);
    assert.match(fx.read('.brain/migrate-1-2.tsv'), /^topics\/alpha\/holder\.json\ttemy\/alpha\/\.tema\.json\tzlucene$/m);
    assert.match(fx.read('.brain/migrate-1-2.tsv'), /^materialy\/alpha\/plan\.md\tmaterialy\/alpha\/plan\.md\ttriaz-ostava$/m);
    // The check on its own.
    const c = fx.run('migrate.mjs', [fx.brain, '--check']);
    assert.equal(c.status, 0, c.out);
    // Workflow of layout 2 over the moved brain.
    let w = fx.run('save.mjs', ['memory', 'tool', 'example', '--content', 'name: Example']);
    assert.equal(w.status, 0, w.out);
    assert.ok(fx.exists('.brain/memory/tool-example.md'));
    w = fx.run('topic.mjs', ['create', 'gamma', '--subject', 'Gamma', '--class', 'discussion']);
    assert.equal(w.status, 0, w.out);
    assert.ok(fx.exists('temy/gamma/.tema.json'));
    assert.match(fx.run('find.mjs', ['project-demo']).stdout, /\.brain\/memory\/project-demo\.md/);
    assert.match(fx.run('find.mjs', ['--relates-to', 'vystupy/dokumenty/guide.md']).stdout, /vystupy\/rozhodnutia\/d-0001-first\.md/);
  } finally { fx.cleanup(); }
});

test('apply with a confirmed triage list moves the item and rewrites the paths to it; a second run does nothing; git revert brings layout 1 back', () => {
  const fx = brainV1();
  try {
    const tsv = path.join(fx.root, 'confirmed.tsv');
    fs.writeFileSync(tsv, 'cesta\tnavrh\ttema\tdovod\nmaterialy/alpha/\tstav\talpha\tvýsledky témy\n');
    const before = head(fx.brain);
    const r = fx.run('migrate.mjs', [fx.brain, '--apply', '--confirmed', tsv]);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('temy/alpha/plan.md') && !fx.exists('materialy/alpha/plan.md'));
    assert.match(fx.read('vystupy/rozhodnutia/d-0001-first.md'), /relates_to: \[temy\/alpha\/plan\.md, vystupy\/dokumenty\/guide\.md\]/);
    assert.match(fx.read('temy/alpha/handover.md'), /podklad temy\/alpha\/plan\.md/);
    const sha = head(fx.brain);
    const again = fx.run('migrate.mjs', [fx.brain, '--apply']);
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /already in data layout 2: nothing to move/);
    assert.equal(head(fx.brain), sha);
    assert.match(fx.run('migrate.mjs', [fx.brain]).stdout, /already in data layout 2: nothing to move/);
    // Revert of the one commit: layout 1 as before.
    const rv = spawnSync('git', ['revert', '--no-edit', sha], { cwd: fx.brain, env: { ...process.env, [BRAIN_SCRIPT_ENV]: '1' }, encoding: 'utf8' });
    assert.equal(rv.status, 0, rv.stderr);
    assert.equal(dataLayoutVersion(fx.brain), 1);
    assert.equal(gitq(fx.brain, 'diff', '--stat', before, 'HEAD'), '');
  } finally { fx.cleanup(); }
});

test('apply refuses a dirty tree, a divergence from origin and a layout above 2; untracked work files stay without confirmation', () => {
  const fx = brainV1();
  try {
    fs.writeFileSync(path.join(fx.brain, 'notes.md'), 'x\n');
    let r = fx.run('migrate.mjs', [fx.brain, '--apply']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /working tree is not clean \(notes\.md\)/);
    fs.rmSync(path.join(fx.brain, 'notes.md'));
    // Divergence: origin got a commit from another clone, this clone one of its own.
    const other = path.join(fx.root, 'other');
    gitq(fx.root, 'clone', '-q', fx.origin, other);
    gitq(other, 'config', 'user.name', 't'); gitq(other, 'config', 'user.email', 't@t');
    commitFiles(other, { 'memory/other-x.md': '---\nkey: other-x\norigin: operator\n---\nx\n' });
    gitq(other, 'push', '-q', 'origin', 'HEAD:main');
    commitFiles(fx.brain, { 'memory/local-y.md': '---\nkey: local-y\norigin: operator\n---\ny\n' });
    const before = head(fx.brain);
    r = fx.run('migrate.mjs', [fx.brain, '--apply']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /diverged/);
    assert.equal(head(fx.brain), before);
    assert.equal(dataLayoutVersion(fx.brain), 1);
    gitq(fx.brain, 'reset', '-q', '--hard', 'origin/main');
    // Untracked scratch/ (outside git) is triage: without a confirmed list it stays where it is; nested repos never move.
    fs.mkdirSync(path.join(fx.brain, 'scratch', 'clone', '.git'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'scratch', 'note.md'), 'n\n');
    fs.writeFileSync(path.join(fx.brain, '.git', 'info', 'exclude'), 'scratch/\n');
    const p = fx.run('migrate.mjs', [fx.brain]);
    assert.match(p.stdout, /scratch\/\ttemy\/main\/tmp\/\t.*\[outside git\]\tstays/);
    assert.match(p.stdout, /scratch\/clone\/: nested git repository \(state unreadable\)/);
    // A real clone with its state: origin, uncommitted changes and commits on no remote.
    const clone = path.join(fx.brain, 'scratch', 'work');
    gitq(fx.root, 'clone', '-q', fx.origin, clone);
    gitq(clone, 'config', 'user.name', 't'); gitq(clone, 'config', 'user.email', 't@t');
    gitq(clone, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'local only');
    fs.writeFileSync(path.join(clone, 'wip.md'), 'w\n');
    fs.writeFileSync(path.join(clone, 'README.md'), 'changed\n');
    const state = fx.run('migrate.mjs', [fx.brain]).stdout;
    assert.ok(state.includes(`scratch/work/: nested git repository (origin ${fx.origin}, uncommitted 2, unpushed 1)`), state);
    r = fx.run('migrate.mjs', [fx.brain, '--apply']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(fx.brain, 'scratch', 'note.md')));
    // A layout above 2 is refused.
    commitFiles(fx.brain, { '.brain/policy.json': JSON.stringify({ data_layout: 3 }) + '\n' }, 'layout 3', { noVerify: true });
    r = fx.run('migrate.mjs', [fx.brain]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /data layout 3; this tool moves only layout 1 to 2, refused/);
  } finally { fx.cleanup(); }
});

test('project repo: agentic/ goes to .brain/ and vystupy/rozhodnutia, docs/ waits in triage, code stays', () => {
  const fx = setup2({ thread: 'm2' });
  try {
    const srv = path.join(fx.root, 'srv');
    initProject(srv);
    commitFiles(srv, {
      'agentic/memory/service-api.md': '---\nkey: service-api\norigin: operator\n---\nAPI; postup v agentic/runbooks/deploy.md a runbooks/deploy.md.\n',
      'agentic/decisions/d-0001-api.md': '---\nkey: D-0001\nid: D-0001\nrelates_to: [src/app.js]\n---\nPodľa agentic/memory/service-api.md.\n',
      'agentic/runbooks/deploy.md': '# Deploy\n',
      'agentic/HANDOVER.md': '# Stav\nPozri agentic/decisions/d-0001-api.md.\n',
      'docs/usage.md': '# Použitie\n',
    });
    const r = fx.run('migrate.mjs', [srv]);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.stdout.includes('agentic/memory/service-api.md -> .brain/memory/service-api.md'), r.out);
    assert.ok(r.stdout.includes('agentic/HANDOVER.md -> .brain/HANDOVER.md'));
    assert.ok(r.stdout.includes('agentic/decisions/d-0001-api.md -> vystupy/rozhodnutia/d-0001-api.md'));
    assert.match(r.stdout, /docs\/usage\.md\tbez navrhu/);
    const a = fx.run('migrate.mjs', [srv, '--apply']);
    assert.equal(a.status, 0, a.out);
    assert.equal(dataLayoutVersion(srv), 2);
    const read = (rel) => fs.readFileSync(path.join(srv, rel), 'utf8');
    assert.match(read('.brain/memory/service-api.md'), /postup v \.brain\/runbooks\/deploy\.md a \.brain\/runbooks\/deploy\.md/);
    assert.match(read('vystupy/rozhodnutia/d-0001-api.md'), /Podľa \.brain\/memory\/service-api\.md/);
    assert.match(read('.brain/HANDOVER.md'), /vystupy\/rozhodnutia\/d-0001-api\.md/);
    assert.ok(fs.existsSync(path.join(srv, 'docs', 'usage.md')) && fs.existsSync(path.join(srv, 'src', 'app.js')));
    assert.ok(!fs.existsSync(path.join(srv, 'agentic')));
    assert.match(a.stdout, /undo: WORKFLOW_BRAIN_SCRIPT=1 git -C \S+ revert \w+, then cd \S+ && node \S+adapter\.mjs claude-code --brain \S+/);
    const ok = fx.run('migrate.mjs', [srv, '--check']).stdout;
    assert.match(ok, /check: ok/);
    assert.match(ok, /note: after git revert of the move run the adapter again: cd \S+ && node \S+adapter\.mjs claude-code --brain/);
    // A record that names an old path fails the check.
    commitFiles(srv, { '.brain/memory/later.md': '---\nkey: later\norigin: operator\n---\nPozri agentic/runbooks/deploy.md.\n' });
    const c = fx.run('migrate.mjs', [srv, '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.stdout, /\.brain\/memory\/later\.md: old path agentic\/runbooks\/deploy\.md \(now \.brain\/runbooks\/deploy\.md\)/);
  } finally { fx.cleanup(); }
});

// A handover over the line limit from before the limit (pilot 2026-11-14): the move keeps it; a changed one is refused.
const LONG_HANDOVER = (task, extra = '') => HANDOVER(task).replace('## Hotové\n-\n', `## Hotové\n${Array.from({ length: 13 }, (_, i) => `- krok ${i + 1}${extra}`).join('\n')}\n`);
