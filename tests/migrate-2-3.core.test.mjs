// keep: core
// migrate.mjs --to 3 (flow v2, spec 11, plan B17): a domain moves from data layout 2 to 3 at once, one commit in each
// repository; a revert of these commits brings layout 2 back; --check of layout 3 finds what is left; outputs and sources
// of the brain go to a project repo only by a confirmed row; facts about people leave memory only after people.mjs
// collect (or the operator's approval); rules and skills naming a principle 2.0 does not adopt wait for --approve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { domain2, gitq } from './layout-2-helpers.mjs';
import { BRAIN_COMMIT_TAG, BRAIN_SCRIPT_ENV } from '../scripts/config.mjs';
import { dataLayoutVersion } from '../scripts/layout.mjs';
import { checkHandover } from '../scripts/brain-checks.mjs';

// A handover of 1.8.0: five sections (2.0 refuses it without "## Úlohy pre operátora").
const HANDOVER5 = (task, next = '-') => `## Zadanie\n${task}\n## Hotové\n-\n## Ďalší krok\n${next}\n## Súbory\n-\n## Otvorené otázky\n-\n`;

function commitFiles(dir, files, message = 'fixture') {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const env = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
  for (const args of [['add', '-A'], ['commit', '-q', '--no-verify', '-m', `${BRAIN_COMMIT_TAG} ${message}`]]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
}

/** A domain in layout 2: brain (topics with zavery/, a closed one, archive, outputs, sources, people, policy of 1.8.0), project and srv. */
function domainV2() {
  const fx = domain2({ brainLayout: 2, thread: 'm23' });
  commitFiles(fx.brain, {
    '.brain/policy.json': JSON.stringify({ data_layout: 2, topics: { auto: { projects: {} }, stall_check_minutes: 30, default_holder_mode: 'operator' }, limits: { worker_result_chars: 3000 } }, null, 2) + '\n',
    'temy/alpha/.tema.json': JSON.stringify({ id: 'alpha', subject: 'Alpha', class: 'code', kind: 'code', state: 'working', repo: 'srv', orchestrator: { topic: 'dev' }, fix_gate: { at: 'x' } }, null, 2) + '\n',
    'temy/alpha/handover.md': HANDOVER5('Alpha; špecifikácia vystupy/dokumenty/spec.md, podklady zdroje/alpha/data.md', '- pokračovať podľa temy/alpha/zavery/w1.md'),
    'temy/alpha/zavery/w1.md': '# Záver\nPozri .brain/memory/tool-x.md.\n',
    'temy/alpha/consents.json': '[]\n',
    'temy/beta/.tema.json': JSON.stringify({ id: 'beta', subject: 'Beta', class: 'ops', state: 'closed' }, null, 2) + '\n',
    'temy/beta/handover.md': HANDOVER5('Beta'),
    '.brain/archive/topics/gamma/handover.md': HANDOVER5('Gamma'),
    '.brain/memory/tool-x.md': '---\nkey: tool-x\ntype: tool\norigin: operator\n---\nNástroj; rozhodnutie vystupy/rozhodnutia/d-0001-first.md.\n',
    '.brain/memory/person-jana.md': '---\nkey: person-jana\ntype: person\nname: Jana\norigin: operator\n---\nJana.\n',
    'vystupy/rozhodnutia/d-0001-first.md': '---\nkey: D-0001\nid: D-0001\ntitle: "First"\nstatus: valid\nrelates_to: [temy/alpha/handover.md]\naliases: []\ncreated: 2026-11-01\n---\n**Rozhodnuté:** podľa temy/alpha/handover.md.\n',
    'vystupy/dokumenty/spec.md': '# Spec\nPlán v temy/alpha/handover.md.\n',
    'zdroje/alpha/data.md': '# Dáta\n',
    '.brain/sources.json': JSON.stringify({ 'zdroje/alpha/data.md': { from: 'web' } }, null, 2) + '\n',
    '.brain/skills/agentic/old-gate/SKILL.md': '---\nname: old-gate\ndescription: "Použi pri fixe (P-075)."\norigin: routine\n---\nOrchestrátor schváli fix (P-075).\n',
  });
  gitq(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
  commitFiles(fx.srv, { '.brain/memory/service-a.md': '---\nkey: service-a\norigin: operator\n---\nStav v ../brain/temy/alpha/handover.md.\n' });
  return fx;
}

const head = (dir) => gitq(dir, 'rev-parse', 'HEAD');
const tsvFile = (fx, name, rows) => { const f = path.join(fx.root, name); fs.writeFileSync(f, `cesta\tnavrh\ttema\tdovod\n${rows.join('\n')}\n`); return f; };
const approveFile = (fx, rows) => { const f = path.join(fx.root, 'approve.tsv'); fs.writeFileSync(f, `cesta\takcia\tsubor\n${rows.join('\n')}\n`); return f; };
/** The operator repo with osoby/<id>.md that people.mjs collect --apply wrote (migrated_from of a memory record). */
function operatorRepoWith(fx, label) {
  const dir = path.join(fx.root, 'operator');
  fs.mkdirSync(path.join(dir, 'osoby'), { recursive: true });
  gitq(fx.root, 'init', '-q', dir);
  fs.writeFileSync(path.join(dir, 'osoby', 'jana.md'), `---\nname: Jana\naliases: []\ndomains: []\nmigrated_from: [${label}]\n---\nJana.\n`);
  const cfg = path.join(fx.root, 'install.json');
  fs.writeFileSync(cfg, JSON.stringify({ operator_repo: dir }) + '\n');
  return { WORKFLOW_INSTALL_CONFIG: cfg };
}

test('preview lists the moves and what waits; --apply is refused until outputs, people and lessons are settled; nothing changes', () => {
  const fx = domainV2();
  try {
    const before = [fx.brain, fx.project, fx.srv].map(head);
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '3']);
    assert.equal(p.status, 0, p.out);
    assert.match(p.stdout, /\.brain\/memory\/ -> memory\/ \(3 files\)|\.brain\/memory\/tool-x\.md -> memory\/tool-x\.md/);
    assert.match(p.stdout, /temy\/alpha\/zavery\/w1\.md -> topics\/alpha\/w1\.md/);
    assert.match(p.stdout, /vystupy\/rozhodnutia\/ -> decisions\/ \(2 files\)/);
    assert.match(p.stdout, /removed, uzavreta-zmazana \(2\)/);
    assert.match(p.stdout, /removed, archiv-zmazany \(1\)/);
    assert.match(p.stdout, /vystupy\/dokumenty\/spec\.md\tbez navrhu|vystupy\/dokumenty\/spec\.md\t\S+:vystupy\/dokumenty\//);
    assert.match(p.stdout, /\.brain\/skills\/agentic\/old-gate\/SKILL\.md: lines 3 \(P-075\), 6 \(P-075\)/);
    assert.match(p.stdout, /person-jana\.md \(person\): not in osoby\//);
    assert.match(p.stdout, /preview only, nothing changed/);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--apply']);
    assert.notEqual(a.status, 0);
    assert.match(a.out, /refused, nothing changed/);
    assert.match(a.out, /vystupy\/dokumenty\/spec\.md: output or source of the brain without a confirmed row/);
    assert.match(a.out, /person-jana\.md: a fact about a person/);
    assert.match(a.out, /old-gate\/SKILL\.md: names P-075/);
    assert.deepEqual([fx.brain, fx.project, fx.srv].map(head), before);
    assert.equal(dataLayoutVersion(fx.brain), 2);
    // Layout 1 goes 1 -> 2 first.
    const v1 = domain2({ brainLayout: 1, thread: 'm1' });
    try {
      const r = v1.run('migrate.mjs', [v1.brain, '--to', '3']);
      assert.notEqual(r.status, 0);
      assert.match(r.out, /data 1; move it to data 2\.0 first: migrate\.mjs \S+ --apply \(then --to 2\.1\)/);
    } finally { v1.cleanup(); }
  } finally { fx.cleanup(); }
});

test('apply: one commit per repo, topics, records, outputs into the project repo, people after collect; --check ok; revert brings layout 2 back', () => {
  const fx = domainV2();
  try {
    const env = operatorRepoWith(fx, `${path.basename(fx.brain)}:.brain/memory/person-jana.md`);
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\tšpecifikácia', 'zdroje/alpha/\tsrv:zdroje/alpha/\t\tpodklady']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat']);
    // A work file of the topic outside git (temy/<id>/tmp/) follows its topic.
    fs.mkdirSync(path.join(fx.brain, 'temy', 'alpha', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'temy', 'alpha', 'tmp', 'note.md'), 'n\n');
    const before = [fx.brain, fx.project, fx.srv].map(head);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--apply', '--confirmed', confirmed, '--approve', approve], { env });
    assert.equal(a.status, 0, a.out);
    for (const d of [fx.brain, fx.project, fx.srv]) {
      assert.equal(dataLayoutVersion(d), 3, d);
      assert.equal(gitq(d, 'rev-list', '--count', `${before[[fx.brain, fx.project, fx.srv].indexOf(d)]}..HEAD`), '1', `one commit in ${d}`);
    }
    const B = (rel) => fs.readFileSync(path.join(fx.brain, rel), 'utf8');
    const S = (rel) => fs.readFileSync(path.join(fx.srv, rel), 'utf8');
    // The brain: records in the root, topics/ with zavery/ flattened, six sections, the record of 2.0.
    assert.ok(fs.existsSync(path.join(fx.brain, 'memory', 'tool-x.md')) && !fs.existsSync(path.join(fx.brain, '.brain', 'memory')));
    assert.ok(fs.existsSync(path.join(fx.brain, 'decisions', 'd-0001-first.md')));
    assert.ok(fs.existsSync(path.join(fx.brain, 'topics', 'alpha', 'w1.md')) && !fs.existsSync(path.join(fx.brain, 'topics', 'alpha', 'zavery')));
    assert.ok(!fs.existsSync(path.join(fx.brain, 'temy')) && !fs.existsSync(path.join(fx.brain, 'vystupy')) && !fs.existsSync(path.join(fx.brain, 'zdroje')));
    const handover = B('topics/alpha/handover.md');
    assert.deepEqual(checkHandover(handover), []);
    assert.match(handover, /## Otvorené otázky\n-\n## Úlohy pre operátora\n-\n/);
    assert.match(handover, /špecifikácia \.\.\/srv\/vystupy\/specifikacie\/spec\.md, podklady \.\.\/srv\/zdroje\/alpha\/data\.md/);
    assert.match(handover, /pokračovať podľa topics\/alpha\/w1\.md/);
    assert.match(B('topics/alpha/w1.md'), /Pozri memory\/tool-x\.md/);
    assert.match(B('decisions/d-0001-first.md'), /relates_to: \[topics\/alpha\/handover\.md\]/);
    const tema = JSON.parse(B('topics/alpha/.tema.json'));
    assert.equal(tema.orchestrator, undefined);
    assert.equal(tema.fix_gate, undefined);
    assert.equal(tema.mode, 'off');
    assert.deepEqual(tema.repos, { main: 'srv', list: ['srv'] });
    assert.equal(tema.turn.state, 'čakám');
    assert.ok(!fs.existsSync(path.join(fx.brain, 'topics', 'alpha', 'consents.json')));
    assert.ok(!fs.existsSync(path.join(fx.brain, 'topics', 'beta')), 'a closed topic ends');
    assert.ok(!fs.existsSync(path.join(fx.brain, 'memory', 'person-jana.md')), 'a fact about a person leaves memory after collect');
    assert.ok(!fs.existsSync(path.join(fx.brain, 'skills', 'agentic', 'old-gate')), 'the approved lesson is removed');
    const policy = JSON.parse(B('policy.json'));
    assert.equal(policy.data_layout, '2.1');
    assert.deepEqual(policy.topics, { default_holder_mode: 'operator' });
    assert.equal(policy.limits, undefined);
    assert.match(B('INDEX.md'), /topics\/alpha\/handover\.md/);
    assert.ok(fs.existsSync(path.join(fx.brain, 'topics', 'alpha', 'tmp', 'note.md')), 'work files outside git follow the topic');
    assert.match(B('.gitignore'), /^topics\/\*\/tmp\/$/m);
    assert.equal(gitq(fx.brain, 'status', '--porcelain'), '');
    assert.match(B('migrate-2-3.tsv'), /vystupy\/dokumenty\/spec\.md\t\.\.\/srv:vystupy\/specifikacie\/spec\.md\tdo-repa/);
    // The project repo: the output with its topic, the source with its data, target_branch, references to the brain.
    assert.match(S('vystupy/specifikacie/spec.md'), /^---\ntopic: alpha\n---\n# Spec\nPlán v \.\.\/brain\/topics\/alpha\/handover\.md\./);
    assert.ok(fs.existsSync(path.join(fx.srv, 'zdroje', 'alpha', 'data.md')));
    assert.deepEqual(JSON.parse(S('.brain/sources.json')), { 'zdroje/alpha/data.md': { from: 'web' } });
    const cfg = JSON.parse(S('.workflow.json'));
    assert.equal(cfg.target_branch, 'main');
    assert.equal(cfg.knowledge_branch, undefined);
    assert.match(S('.brain/memory/service-a.md'), /Stav v \.\.\/brain\/topics\/alpha\/handover\.md/);
    assert.match(S('INDEX.md'), /vystupy\/specifikacie\/spec\.md/);
    // The check of layout 3 over the domain.
    const c = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--check']);
    assert.equal(c.status, 0, c.out);
    assert.match(c.stdout, /check \(data 2\.1\): ok/);
    // The revert list names every commit; reverting them brings each repository back to layout 2.
    const rl = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--revert-list']);
    assert.equal(rl.status, 0, rl.out);
    for (const d of [fx.brain, fx.project, fx.srv]) {
      const m = new RegExp(`git -C ${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} revert --no-edit (\\w+)`).exec(rl.stdout);
      assert.ok(m, `revert command for ${d}: ${rl.stdout}`);
      const rv = spawnSync('git', ['revert', '--no-edit', m[1]], { cwd: d, env: { ...process.env, [BRAIN_SCRIPT_ENV]: '1', WORKFLOW_PLUGIN_ROOT: path.resolve('.') }, encoding: 'utf8' });
      assert.equal(rv.status, 0, rv.stderr);
      assert.equal(dataLayoutVersion(d), 2);
      assert.equal(gitq(d, 'diff', '--stat', before[[fx.brain, fx.project, fx.srv].indexOf(d)], 'HEAD'), '', d);
    }
  } finally { fx.cleanup(); }
});

test('--check of layout 3 finds a missing INDEX.md and a zavery/ that was not moved; --fix regenerates the index', () => {
  const fx = domainV2();
  try {
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\t\t', 'zdroje/alpha/\tpomocne\t\t']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat', '.brain/memory/person-jana.md\tzmazat']);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--apply', '--confirmed', confirmed, '--approve', approve]);
    assert.equal(a.status, 0, a.out);
    assert.ok(!fs.existsSync(path.join(fx.srv, 'zdroje')), 'pomocne is removed, not moved');
    // A later write by hand: a conclusion in zavery/ and no INDEX.md.
    fs.rmSync(path.join(fx.brain, 'INDEX.md'));
    commitFiles(fx.brain, { 'topics/alpha/zavery/w2.md': '# Záver 2\n' }, 'by hand');
    const c = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.stdout, /topics\/alpha\/zavery\/w2\.md: zavery\/ not moved into topics\/alpha\//);
    assert.match(c.stdout, /INDEX\.md: missing in HEAD/);
    const f = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--check', '--fix']);
    assert.match(f.stdout, /brain: INDEX\.md regenerated, committed/);
    assert.doesNotMatch(f.stdout, /INDEX\.md: missing/);
  } finally { fx.cleanup(); }
});

test('spec 11.12: a topic and a skill move into the brain of a new domain in layout 3 (its own commit, in the revert list)', () => {
  const fx = domainV2();
  try {
    const wf = path.join(fx.root, 'wf-brain');
    const init = fx.run('brain-init.mjs', [wf, '--layout', '3'], { cwd: fx.root });
    assert.equal(init.status, 0, init.out);
    gitq(wf, 'config', 'user.name', 't'); gitq(wf, 'config', 'user.email', 't@t');
    commitFiles(fx.brain, { '.brain/skills/agentic/kept/SKILL.md': '---\nname: kept\ndescription: "Použi pri vývoji."\norigin: routine\n---\nPostup v temy/alpha/handover.md.\n' }, 'skill');
    gitq(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\t', 'zdroje/alpha/\tsrv:zdroje/alpha/\t\t', 'temy/alpha/\twf-brain:topics/alpha/\t\tvývoj workflow', '.brain/skills/agentic/kept/\twf-brain:skills/agentic/kept/\t\t']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat', '.brain/memory/person-jana.md\tzmazat']);
    const wfHead = head(wf);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--apply', '--confirmed', confirmed, '--approve', approve]);
    assert.equal(a.status, 0, a.out);
    assert.equal(gitq(wf, 'rev-list', '--count', `${wfHead}..HEAD`), '1');
    const W = (rel) => fs.readFileSync(path.join(wf, rel), 'utf8');
    assert.deepEqual(checkHandover(W('topics/alpha/handover.md')), []);
    assert.match(W('topics/alpha/handover.md'), /pokračovať podľa topics\/alpha\/w1\.md/);
    assert.equal(JSON.parse(W('topics/alpha/.tema.json')).mode, 'off');
    assert.match(W('skills/agentic/kept/SKILL.md'), /Postup v topics\/alpha\/handover\.md/);
    assert.match(W('INDEX.md'), /topics\/alpha\/handover\.md/);
    assert.ok(!fs.existsSync(path.join(fx.brain, 'topics', 'alpha')) && !fs.existsSync(path.join(fx.brain, 'skills', 'agentic', 'kept')));
    assert.match(fs.readFileSync(path.join(fx.brain, 'decisions', 'd-0001-first.md'), 'utf8'), /relates_to: \[\.\.\/wf-brain\/topics\/alpha\/handover\.md\]/);
    const rl = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--revert-list']);
    assert.ok(rl.stdout.includes(`git -C ${wf} revert --no-edit`), rl.stdout);
  } finally { fx.cleanup(); }
});

test('spec 11.12, O18, D-0038: a moved topic gets its copy path in the new domain; the brain policy keeps shared checkouts and default_repo as target.mjs reads it', () => {
  const fx = domainV2();
  try {
    const wfDomain = path.join(fx.root, 'workflow');
    fs.mkdirSync(wfDomain);
    fs.writeFileSync(path.join(wfDomain, '.agentic-domain'), '{"brain":"brain"}');
    const wf = path.join(wfDomain, 'brain');
    const init = fx.run('brain-init.mjs', [wf, '--layout', '3'], { cwd: fx.root });
    assert.equal(init.status, 0, init.out);
    gitq(wf, 'config', 'user.name', 't'); gitq(wf, 'config', 'user.email', 't@t');
    const alpha = JSON.parse(fs.readFileSync(path.join(fx.brain, 'temy', 'alpha', '.tema.json'), 'utf8'));
    commitFiles(fx.brain, {
      'temy/alpha/.tema.json': JSON.stringify({ ...alpha, copy: '../.worktrees/srv/alpha' }, null, 2) + '\n',
      '.brain/policy.json': JSON.stringify({ data_layout: 2, default_repo: '../srv', topics: { auto: { projects: { '../srv': ['srv'] } } } }, null, 2) + '\n',
    }, 'copy and policy');
    gitq(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\t\t', 'zdroje/alpha/\tpomocne\t\t', 'temy/alpha/\tworkflow/brain:topics/alpha/\t\t']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat', '.brain/memory/person-jana.md\tzmazat']);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '3', '--apply', '--confirmed', confirmed, '--approve', approve]);
    assert.equal(a.status, 0, a.out);
    const moved = JSON.parse(fs.readFileSync(path.join(wf, 'topics', 'alpha', '.tema.json'), 'utf8'));
    // copy is relative to the brain of the record: the worktree of the old domain's .worktrees/ goes to the new domain's.
    assert.equal(moved.copy, '../.worktrees/srv/alpha');
    assert.equal(path.resolve(wf, moved.copy), path.join(wfDomain, '.worktrees', 'srv', 'alpha'));
    const policy = JSON.parse(fs.readFileSync(path.join(fx.brain, 'policy.json'), 'utf8'));
    assert.equal(policy.default_repo, 'srv', 'the name form of target.mjs (defaultRepoName)');
    assert.deepEqual(policy.topics, { shared_checkouts: ['srv'] }, 'topics.auto gone, its repos kept as shared checkouts relative to the domain');
  } finally { fx.cleanup(); }
});

test('movedCopy: a copy outside .worktrees/ keeps its place, relative to the new brain', async () => {
  const { movedCopy } = await import('../scripts/migrate-3.mjs');
  const dom = { brain: '/r/Alice/agent-alice', domainDir: '/r/Alice' };
  assert.equal(movedCopy('../agent-alice-topics/x', dom, '/r/workflow/brain'), '../../Alice/agent-alice-topics/x');
  assert.equal(movedCopy('../.worktrees/agentic-flow/x', dom, '/r/workflow/brain'), '../.worktrees/agentic-flow/x');
});
