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
    '.brain/memory/tool-x.md': '---\nkey: tool-x\ntype: tool\norigin: operator\n---\nNástroj; rozhodnutie vystupy/rozhodnutia/d-0001-first.md, API ../srv/vystupy/rozhodnutia/d-0001-api.md.\n',
    '.brain/memory/person-jana.md': '---\nkey: person-jana\ntype: person\nname: Jana\norigin: operator\n---\nJana.\n',
    'vystupy/rozhodnutia/d-0001-first.md': '---\nkey: D-0001\nid: D-0001\ntitle: "First"\nstatus: valid\nrelates_to: [temy/alpha/handover.md]\naliases: []\ncreated: 2026-11-01\n---\n**Rozhodnuté:** podľa temy/alpha/handover.md.\n',
    'vystupy/dokumenty/spec.md': '# Spec\nPlán v temy/alpha/handover.md.\n',
    'zdroje/alpha/data.md': '# Dáta\n',
    '.brain/sources.json': JSON.stringify({ 'zdroje/alpha/data.md': { from: 'web' } }, null, 2) + '\n',
    '.brain/skills/agentic/old-gate/SKILL.md': '---\nname: old-gate\ndescription: "Použi pri fixe (P-075)."\norigin: routine\n---\nOrchestrátor schváli fix (P-075).\n',
  });
  gitq(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
  commitFiles(fx.srv, {
    '.brain/memory/service-a.md': '---\nkey: service-a\norigin: operator\n---\nStav v ../brain/temy/alpha/handover.md, API podľa vystupy/rozhodnutia/d-0001-api.md.\n',
    'vystupy/rozhodnutia/d-0001-api.md': '---\nkey: D-0001\nid: D-0001\ntitle: "Api"\nstatus: valid\nrelates_to: []\naliases: []\ncreated: 2026-11-01\n---\n**Rozhodnuté:** REST.\n',
  });
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
    assert.match(S('.brain/memory/service-a.md'), /Stav v \.\.\/brain\/topics\/alpha\/handover\.md, API podľa \.brain\/decisions\/d-0001-api\.md/);
    // The decisions of the repo: knowledge in .brain/decisions/, not an output; the brain's reference follows them.
    assert.ok(fs.existsSync(path.join(fx.srv, '.brain', 'decisions', 'd-0001-api.md')) && !fs.existsSync(path.join(fx.srv, 'vystupy', 'rozhodnutia')));
    assert.match(S('.brain/migrate-2-3.tsv'), /^vystupy\/rozhodnutia\/d-0001-api\.md\t\.brain\/decisions\/d-0001-api\.md\tpresun$/m);
    assert.match(B('memory/tool-x.md'), /rozhodnutie decisions\/d-0001-first\.md, API \.\.\/srv\/\.brain\/decisions\/d-0001-api\.md/);
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

test('repos two brains share (each machine its own brain): the second brain moves alone, its repos already in data 2.1 stay', () => {
  const fx = domainV2();
  try {
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\t', 'zdroje/alpha/\tpomocne\t\t']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat', '.brain/memory/person-jana.md\tzmazat']);
    const first = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', confirmed, '--approve', approve]);
    assert.equal(first.status, 0, first.out);
    // The other machine's brain of the same repos is still in data 2.0: here the brain's commit undone, the repos stay 2.1.
    gitq(fx.brain, 'reset', '-q', '--hard', 'HEAD~1');
    assert.equal(dataLayoutVersion(fx.brain), 2);
    const srvHead = head(fx.srv);
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1']);
    assert.equal(p.status, 0, p.out);
    assert.match(p.stdout, /note: repo \S*srv is in data 2\.1 already \(moved with another brain of these repos\): it stays, only the brain moves/);
    assert.doesNotMatch(p.stdout, /refused: |its brain has 2\.0/);
    const second = tsvFile(fx, 'second.tsv', ['vystupy/dokumenty/spec.md\tpomocne\t\t', 'zdroje/alpha/\tpomocne\t\t']);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', second, '--approve', approve]);
    assert.equal(a.status, 0, a.out);
    assert.equal(dataLayoutVersion(fx.brain), 3);
    assert.equal(head(fx.srv), srvHead, 'a repo already in data 2.1 gets no commit');
    const c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check']);
    assert.equal(c.status, 0, c.out);
  } finally { fx.cleanup(); }
});

test('preview names an unclean working tree (a file outside git) as what refuses --apply, before the apply', () => {
  const fx = domainV2();
  try {
    fs.mkdirSync(path.join(fx.srv, 'tools', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(fx.srv, 'tools', '__pycache__', 'x.pyc'), 'bytecode');
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1']);
    assert.equal(p.status, 0, p.out);
    assert.match(p.stdout, /--apply is refused until these are settled[\s\S]*srv: the working tree is not clean \(tools\/\): commit it, add it to \.gitignore or remove it/);
  } finally { fx.cleanup(); }
});

test('a domain folder without .agentic-domain: the preview finds the repos that name the brain and asks for the marker', () => {
  const fx = domainV2();
  try {
    const marker = path.join(path.dirname(fx.brain), '.agentic-domain');
    assert.ok(fs.existsSync(marker), 'the fixture has a marker');
    fs.rmSync(marker);
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1']);
    assert.equal(p.status, 0, p.out);
    assert.match(p.stdout, /domain: brain \S+ \(data 2\.0\), repos project, srv/);
    assert.match(p.stdout, /has no \.agentic-domain, though project, srv name this brain: write \S+\.agentic-domain with \{"brain": "brain"\}/);
  } finally { fx.cleanup(); }
});

test('work files outside git of a project repo (temy/<id>/tmp/) go to the brain, merged into a work folder that exists', () => {
  const fx = domainV2();
  try {
    commitFiles(fx.srv, { '.gitignore': 'temy/*/tmp/\n' });
    for (const [rel, text] of [['temy/main/tmp/a.md', 'a\n'], ['temy/main/tmp/both.md', 'srv\n'], ['temy/old/tmp/o.md', 'o\n']]) {
      fs.mkdirSync(path.dirname(path.join(fx.srv, rel)), { recursive: true });
      fs.writeFileSync(path.join(fx.srv, rel), text);
    }
    // The brain has a work folder of main already, with a file of the same name.
    fs.mkdirSync(path.join(fx.brain, 'temy', 'main', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'temy', 'main', 'tmp', 'both.md'), 'brain\n');
    fs.writeFileSync(path.join(fx.brain, '.git', 'info', 'exclude'), 'temy/*/tmp/\n');
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\t', 'zdroje/alpha/\tpomocne\t\t']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat', '.brain/memory/person-jana.md\tzmazat']);
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1']);
    assert.match(p.stdout, /outside git: \S*srv\/temy\/main\/tmp\/ -> topics\/main\/tmp\//);
    assert.match(p.stdout, /outside git: \S*srv\/temy\/old\/tmp\/ -> topics\/main\/tmp\/srv-old\//);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', confirmed, '--approve', approve]);
    // The clash stays in the temy/ of the repo: the check names it, no pass with a leftover (doma-pc 2026-11-16).
    assert.equal(a.status, 1, a.out);
    assert.match(a.out, /srv: 1 problem\(s\)\n\s+temy\/main\/ \(1 file\(s\), 4 B\): outside git in a folder of an older data layout/);
    const T = (rel) => fs.readFileSync(path.join(fx.brain, 'topics', 'main', 'tmp', rel), 'utf8');
    assert.equal(T('a.md'), 'a\n');
    assert.equal(T('both.md'), 'brain\n', 'nothing overwritten');
    assert.equal(T('srv-old/o.md'), 'o\n');
    assert.match(a.out, /srv\/temy\/main\/tmp\/both\.md: not moved, topics\/main\/tmp\/both\.md exists/);
    assert.ok(fs.existsSync(path.join(fx.srv, 'temy', 'main', 'tmp', 'both.md')), 'the clash stays where it was');
    assert.ok(!fs.existsSync(path.join(fx.srv, 'temy', 'old')), 'emptied folders of temy/ are removed');
  } finally { fx.cleanup(); }
});

test('leftovers outside git (doma-pc 2026-11-16): data 1 work files wait for triage, junk goes with --apply, a large work folder moves only approved', () => {
  const fx = domainV2();
  try {
    // A machine that pulled the move of 2.0: scratch/ and materialy/ of data 1 left outside git, materialy/ with only .pyc.
    fs.writeFileSync(path.join(fx.srv, '.git', 'info', 'exclude'), 'scratch/\nmaterialy/\ntemy/*/tmp/\n');
    fs.mkdirSync(path.join(fx.srv, 'scratch', 'exports'), { recursive: true });
    fs.writeFileSync(path.join(fx.srv, 'scratch', 'exports', 'export.csv'), 'x'.repeat(2048));
    fs.mkdirSync(path.join(fx.srv, 'materialy', 'audit', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(fx.srv, 'materialy', 'audit', '__pycache__', 'a.cpython-312.pyc'), 'c');
    fs.writeFileSync(path.join(fx.srv, 'materialy', 'tool.pyc'), 'c');
    // A work folder of 600 files.
    fs.mkdirSync(path.join(fx.srv, 'temy', 'main', 'tmp'), { recursive: true });
    for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(fx.srv, 'temy', 'main', 'tmp', `p${i}.csv`), 'y\n');
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\t', 'zdroje/alpha/\tpomocne\t\t']);
    const rows = ['.brain/skills/agentic/old-gate/\tzmazat', '.brain/memory/person-jana.md\tzmazat'];
    let p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--confirmed', confirmed, '--approve', approveFile(fx, rows)]);
    assert.match(p.stdout, /srv:scratch\/exports\/ \(1 file\(s\), 2\.0 kB\): outside git in a folder of an older data layout, the move does not take it/);
    assert.match(p.stdout, /note: 2 generated file\(s\) or folder\(s\) \(__pycache__, \*\.pyc, \.DS_Store …\) in materialy\/: generated, removed by --apply/);
    assert.match(p.stdout, /srv:temy\/main\/tmp\/: 600 file\(s\), \S+ \S+ of work files outside git, too many to move without triage .*--approve "srv:temy\/main\/tmp\/<TAB>presunut"/);
    assert.match(p.stdout, /outside git: \S*srv\/temy\/main\/tmp\/ -> topics\/main\/tmp\/ \(600 file\(s\)/);
    // The operator triaged scratch/ (removed the export) and approved the work folder as it is.
    fs.rmSync(path.join(fx.srv, 'scratch'), { recursive: true });
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', confirmed, '--approve', approveFile(fx, [...rows, 'srv:temy/main/tmp/\tpresunut'])]);
    assert.equal(a.status, 0, a.out);
    assert.match(a.out, /check \(data 2\.1\): ok/);
    assert.ok(!fs.existsSync(path.join(fx.srv, 'materialy')), 'materialy/ of only junk is gone');
    assert.ok(fs.existsSync(path.join(fx.brain, 'topics', 'main', 'tmp', 'p599.csv')));
    // A later leftover: --check names it, --check --fix removes junk only.
    fs.mkdirSync(path.join(fx.srv, 'temy', 'x'), { recursive: true });
    fs.writeFileSync(path.join(fx.srv, 'temy', 'x', '.DS_Store'), 'd');
    fs.writeFileSync(path.join(fx.srv, 'temy', 'x', 'keep.md'), 'k\n');
    let c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.out, /1 generated file\(s\) or folder\(s\) .* in temy\/: left outside git in folders of an older data layout; remove them: migrate\.mjs \S+ --to 2\.1 --check --fix/);
    assert.match(c.out, /temy\/x\/ \(1 file\(s\), 2 B\): outside git/);
    c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check', '--fix']);
    assert.match(c.out, /srv: removed generated files outside git: temy\/x\/\.DS_Store/);
    assert.ok(fs.existsSync(path.join(fx.srv, 'temy', 'x', 'keep.md')), 'work is never deleted by code');
  } finally { fx.cleanup(); }
});

test('the default proposal of a folder output keeps its name: <repo>:vystupy/dokumenty/<folder>/ (mojprojekt 2026-11-16)', () => {
  const fx = domainV2();
  try {
    const pol = JSON.parse(fs.readFileSync(path.join(fx.brain, '.brain', 'policy.json'), 'utf8'));
    commitFiles(fx.brain, { '.brain/policy.json': JSON.stringify({ ...pol, default_repo: 'srv' }, null, 2) + '\n', 'vystupy/dokumenty/dizajn/web-v1/x.md': '# X\n' });
    const tsv = path.join(fx.root, 'triage.tsv');
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--write-triage', tsv]);
    assert.equal(p.status, 0, p.out);
    const text = fs.readFileSync(tsv, 'utf8');
    assert.match(text, /^vystupy\/dokumenty\/dizajn\/\tsrv:vystupy\/dokumenty\/dizajn\/\t/m, text);
    assert.match(text, /^vystupy\/dokumenty\/spec\.md\tsrv:vystupy\/dokumenty\/\t/m, 'a loose file keeps its folder');
  } finally { fx.cleanup(); }
});

test('a deployed web repo: the preview names the deploy ignore entries, --apply adds every workflow path in the move commit; --check reports a gap, --fix fills it (gma 2026-11-16)', () => {
  const fx = domainV2();
  try {
    // An allowlist .assetsignore that takes zdroje back, and wrangler deploying the root.
    commitFiles(fx.srv, { 'wrangler.jsonc': '{\n  // site\n  "assets": { "directory": "./" }\n}\n', '.assetsignore': '*\n!index.html\n!zdroje\n', 'index.html': '<p>x</p>\n' });
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\tšpecifikácia', 'zdroje/alpha/\tsrv:zdroje/alpha/\t\tpodklady']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat']);
    const env = operatorRepoWith(fx, `${path.basename(fx.brain)}:.brain/memory/person-jana.md`);
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--confirmed', confirmed, '--approve', approve], { env });
    assert.match(p.stdout, /deploy ignore: \.assetsignore \+= zdroje, added by --apply/, p.out);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', confirmed, '--approve', approve], { env });
    assert.equal(a.status, 0, a.out);
    const lines = gitq(fx.srv, 'show', 'HEAD:.assetsignore').split('\n');
    assert.ok(lines.indexOf('zdroje') > lines.indexOf('!zdroje'), 'appended after the negation, so it wins');
    assert.match(a.stdout, /srv: deploy ignore: \.assetsignore \+= /);
    // A later edit takes local/ back in: the check reports it, --fix excludes it again.
    commitFiles(fx.srv, { '.assetsignore': '*\n!index.html\n!local/\n' });
    const c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.stdout, /\.assetsignore: it does not exclude local \(files of the workflow/);
    const f = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check', '--fix']);
    assert.match(f.stdout, /srv: deploy ignore: \.assetsignore \+= local/, f.out);
    assert.doesNotMatch(f.stdout, /does not exclude/, f.out);
  } finally { fx.cleanup(); }
});

test('only the brain moves (its repo is in data 2.1 already): the repo\'s work files and a scratch/<topic>/ go with the topic, references to them are rewritten (a shop repo 2026-11-16)', () => {
  const fx = domainV2();
  try {
    // srv moved with another brain: data 2.1, its decisions in .brain/decisions/, work files outside git left behind.
    const pol = JSON.parse(fs.readFileSync(path.join(fx.srv, '.brain', 'policy.json'), 'utf8'));
    fs.mkdirSync(path.join(fx.srv, '.brain', 'decisions'), { recursive: true });
    gitq(fx.srv, 'mv', 'vystupy/rozhodnutia/d-0001-api.md', '.brain/decisions/d-0001-api.md');
    commitFiles(fx.srv, { '.brain/policy.json': JSON.stringify({ ...pol, data_layout: '2.1' }, null, 2) + '\n', '.gitignore': 'scratch/\ntemy/\n', '.brain/memory/service-a.md': '---\nkey: service-a\norigin: operator\n---\nSlužba A.\n' });
    assert.equal(dataLayoutVersion(fx.srv), 3);
    for (const [rel, text] of [['scratch/alpha/audit.csv', 'a\n'], ['temy/main/tmp/n.txt', 'n\n'], ['scratch/other/x.txt', 'x\n']]) {
      fs.mkdirSync(path.dirname(path.join(fx.srv, rel)), { recursive: true });
      fs.writeFileSync(path.join(fx.srv, rel), text);
    }
    const abs = path.join(fx.srv, 'scratch', 'alpha', 'audit.csv').split(path.sep).join('/');
    commitFiles(fx.brain, { 'temy/alpha/results.md': `# Výsledky\nAudit: ${abs}, kópia ../srv/scratch/alpha/audit.csv.\n` });
    gitq(fx.brain, 'push', '-q', 'origin', 'HEAD:main');
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\tšpecifikácia', 'zdroje/alpha/\tsrv:zdroje/alpha/\t\tpodklady']);
    const env = operatorRepoWith(fx, `${path.basename(fx.brain)}:.brain/memory/person-jana.md`);
    let approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat']);
    const p = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--confirmed', confirmed, '--approve', approve], { env });
    assert.match(p.stdout, /srv\/scratch\/alpha\/ -> topics\/alpha\/tmp\/srv-alpha/, p.out);
    assert.match(p.stdout, /srv\/temy\/main\/tmp\/ -> topics\/main\/tmp/, p.out);
    assert.match(p.stdout, /srv:scratch\/other\/ \(.*triage it with the operator.*presunut<TAB><topic>/, 'a scratch entry of no topic waits for the triage');
    approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat', 'srv:scratch/other/\tpresunut\tmain']);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', confirmed, '--approve', approve], { env });
    assert.equal(a.status, 0, a.out);
    assert.equal(fs.readFileSync(path.join(fx.brain, 'topics', 'alpha', 'tmp', 'srv-alpha', 'audit.csv'), 'utf8'), 'a\n');
    assert.ok(fs.existsSync(path.join(fx.brain, 'topics', 'main', 'tmp', 'n.txt')));
    assert.ok(fs.existsSync(path.join(fx.brain, 'topics', 'main', 'tmp', 'srv-other', 'x.txt')));
    assert.ok(!fs.existsSync(path.join(fx.srv, 'scratch')) && !fs.existsSync(path.join(fx.srv, 'temy')), 'nothing left in the repo');
    const results = gitq(fx.brain, 'show', 'HEAD:topics/alpha/results.md');
    const now = path.join(fx.brain, 'topics', 'alpha', 'tmp', 'srv-alpha', 'audit.csv').split(path.sep).join('/');
    assert.ok(results.includes(`Audit: ${now},`), results);
    assert.ok(results.includes('kópia topics/alpha/tmp/srv-alpha/audit.csv.'), results);
    assert.match(a.stdout, /check \(data 2\.1\): ok/, a.out);
    assert.match(a.stdout, /srv: ok\n\s+note: born in data 2\.1/, 'the commit of the files it took is no move of its own');
  } finally { fx.cleanup(); }
});

test('--check: a record a brain script removed after the move is a note, a file lost otherwise a problem (alice 2026-11-16)', () => {
  const fx = domainV2();
  try {
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\tšpecifikácia', 'zdroje/alpha/\tsrv:zdroje/alpha/\t\tpodklady']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat']);
    const env = operatorRepoWith(fx, `${path.basename(fx.brain)}:.brain/memory/person-jana.md`);
    const a = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', confirmed, '--approve', approve], { env });
    assert.equal(a.status, 0, a.out);
    const benv = { ...process.env, [BRAIN_SCRIPT_ENV]: '1' };
    const rm = (rel, msg) => { for (const args of [['rm', '-q', rel], ['commit', '-q', '--no-verify', '-m', msg]]) assert.equal(spawnSync('git', args, { cwd: fx.brain, env: benv }).status, 0); };
    rm('memory/tool-x.md', `${BRAIN_COMMIT_TAG} remove memory tool-x`);
    let c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check']);
    assert.equal(c.status, 0, c.out);
    assert.match(c.stdout, /note: memory\/tool-x\.md: removed after the move by \w+ \(\[brain-script\] remove memory tool-x\)/);
    // A topic closed after the move (done --topic removes topics/<id>/ through the brain writer): one note for its files.
    for (const args of [['rm', '-rq', 'topics/alpha'], ['commit', '-q', '--no-verify', '-m', `${BRAIN_COMMIT_TAG} done --topic alpha: closed, topic removed`]]) assert.equal(spawnSync('git', args, { cwd: fx.brain, env: benv }).status, 0);
    c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check', '--fix']);
    assert.equal(c.status, 0, c.out);
    assert.match(c.stdout, /note: \d+ file\(s\) \(topics\/alpha\/[^)]*\): removed after the move by \w+ \(\[brain-script\] done --topic alpha: closed, topic removed\)/);
    rm('decisions/d-0001-first.md', 'by hand');
    c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.stdout, /vystupy\/rozhodnutia\/d-0001-first\.md: new place decisions\/d-0001-first\.md, not tracked/);
  } finally { fx.cleanup(); }
});

test('a topic branch adding files on paths of an older layout: --check names it, done refuses the merge (a shop repo 2026-11-16)', async () => {
  const { mergeRefusal, mergeTarget } = await import('../scripts/topic-branches.mjs');
  const fx = domainV2();
  try {
    const confirmed = tsvFile(fx, 'confirmed.tsv', ['vystupy/dokumenty/spec.md\tsrv:vystupy/specifikacie/\talpha\tšpecifikácia', 'zdroje/alpha/\tsrv:zdroje/alpha/\t\tpodklady']);
    const approve = approveFile(fx, ['.brain/skills/agentic/old-gate/\tzmazat']);
    const env = operatorRepoWith(fx, `${path.basename(fx.brain)}:.brain/memory/person-jana.md`);
    assert.equal(fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--apply', '--confirmed', confirmed, '--approve', approve], { env }).status, 0);
    gitq(fx.srv, 'checkout', '-q', '-b', 'topic/alpha');
    commitFiles(fx.srv, { 'materialy/alpha/shoptet/a.md': '# A\n', 'materialy/alpha/b.md': '# B\n', 'src/app.js': 'x\n' }, 'work');
    gitq(fx.srv, 'checkout', '-q', '-');
    const c = fx.run('migrate.mjs', [fx.brain, '--to', '2.1', '--check']);
    assert.equal(c.status, 1, c.out);
    assert.match(c.stdout, /branch topic\/alpha \(1 commit\(s\) not in \S+\): work on paths of an older data layout, materialy\/alpha\/ \(2 file\(s\)\); done --topic refuses/);
    const into = mergeTarget(fx.srv);
    assert.match(mergeRefusal(fx.srv, 'topic/alpha', into), /adds files on paths of an older data layout, materialy\/alpha\/ \(2 file\(s\)\); nothing merged/);
    // Moved on the branch: nothing to refuse.
    gitq(fx.srv, 'checkout', '-q', 'topic/alpha');
    fs.mkdirSync(path.join(fx.srv, 'zdroje'), { recursive: true });
    gitq(fx.srv, 'mv', 'materialy/alpha', 'zdroje/alpha-shop');
    gitq(fx.srv, 'commit', '-qm', 'move');
    gitq(fx.srv, 'checkout', '-q', '-');
    assert.equal(mergeRefusal(fx.srv, 'topic/alpha', into), null);
  } finally { fx.cleanup(); }
});
