// keep: guarded
// Spec 6, 4 (REPO OPERÁTORA), 11.8; plan B9, O9, O10: persons in osoby/ of the operator repo, found by alias within a
// domain, INDEX.md generated on every write, collection of the people records of every brain of the machine without loss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, initProject, cleanEnv, PLUGIN_ROOT } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';

function gitq(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * An operator repo under root with its origin (save writes through the own clone of the workflow: pull, write, push,
 * spec 4.1) and the configuration of the installation naming it (never ~/.config).
 */
function operatorRepo(root, { profile = null } = {}) {
  const dir = path.join(root, 'operator');
  const origin = path.join(root, 'operator.git');
  gitq(root, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(dir, { recursive: true });
  gitq(dir, 'init', '-q', '-b', 'main');
  gitq(dir, 'config', 'user.name', 't'); gitq(dir, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(dir, 'README.md'), 'operator\n');
  if (profile) fs.writeFileSync(path.join(dir, 'profile.md'), profile);
  gitq(dir, 'add', '-A'); gitq(dir, 'commit', '-q', '-m', 'init');
  gitq(dir, 'remote', 'add', 'origin', origin);
  gitq(dir, 'push', '-q', '-u', 'origin', 'main');
  const config = path.join(root, 'install-config.json');
  fs.writeFileSync(config, JSON.stringify({ operator_repo: dir, profile: 'profile.md' }) + '\n');
  return { dir, env: { WORKFLOW_INSTALL_CONFIG: config } };
}

const people = (fx, op, args) => fx.run('people.mjs', args, { env: op.env });

test('find by id, name or alias within the domain: 0, 1 and 2+ matches; new and change refuse then; INDEX.md alias -> person', () => {
  const fx = setup();
  try {
    const op = operatorRepo(fx.root);
    // The id is meno-priezvisko when the surname is known (operator 2026-11-16).
    let r = people(fx, op, ['new', 'alice', '--name', 'Alice Example', '--content', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /id "alice" is the first name only, while the full name "Alice Example" is known: the id of a person is meno-priezvisko, alice-example/);
    r = people(fx, op, ['new', 'alice-example', '--name', 'Alice Example', '--aliases', 'ali,boss', '--content', 'Customer of the shop; prefers short mails.']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /committed: \w+ people: new alice-example/);
    assert.match(r.stdout, /^pushed$/m);
    assert.equal(gitq(path.join(fx.root, 'operator.git'), 'log', '-1', '--format=%s', 'main'), 'people: new alice-example', 'pushed from the own clone');
    const rec = parseFrontmatter(fs.readFileSync(path.join(op.dir, 'osoby/alice-example.md'), 'utf8'));
    assert.equal(rec.data.name, 'Alice Example'); assert.deepEqual(rec.data.aliases, ['ali', 'boss']); assert.deepEqual(rec.data.domains, []);
    assert.equal(people(fx, op, ['new', 'alex', '--name', 'Alex', '--aliases', 'ali', '--domains', 'Shop', '--content', 'Developer.']).status, 1, 'alias of another person refused without --new');
    r = people(fx, op, ['new', 'alex', '--name', 'Alex', '--aliases', 'ali', '--domains', 'Shop', '--content', 'Developer.', '--new']);
    assert.equal(r.status, 0, r.out);
    assert.equal(people(fx, op, ['new', 'bob', '--name', 'Bob', '--domains', 'Farm', '--content', 'Neighbour.']).status, 0);
    assert.equal(gitq(op.dir, 'status', '--porcelain'), '', 'every write is committed');
    assert.equal(gitq(op.dir, 'rev-list', '--count', 'HEAD'), '4', 'one commit per write');

    // 1 match (case-insensitive, by alias), the record shown.
    r = people(fx, op, ['find', 'BOSS']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^osoby\/alice-example\.md: Alice Example/);
    assert.match(r.stdout, /prefers short mails/);
    // Domain filter: Bob is a person of Farm only; a person without domains is in every domain.
    assert.match(people(fx, op, ['find', 'bob', '--domain', 'Shop']).stdout, /no person "bob" in domain Shop/);
    assert.match(people(fx, op, ['find', 'bob', '--domain', 'farm']).stdout, /^osoby\/bob\.md: Bob/);
    assert.match(people(fx, op, ['find', 'boss', '--domain', 'Farm']).stdout, /^osoby\/alice-example\.md/);
    // 2+ matches: reported, nothing chosen; out of Shop only Alice has the alias.
    r = people(fx, op, ['find', 'ali']);
    assert.match(r.stdout, /2 persons "ali": osoby\/alex\.md.*osoby\/alice-example\.md.*ask the operator which one/s);
    assert.match(people(fx, op, ['find', 'ali', '--domain', 'Farm']).stdout, /^osoby\/alice-example\.md/);
    // 0 matches: only a note.
    r = people(fx, op, ['find', 'nobody']);
    assert.equal(r.status, 0); assert.match(r.stdout, /no person "nobody"/);

    // Writing a fact needs exactly one person.
    r = people(fx, op, ['change', 'ali', '--content', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /2 persons "ali".*ask the operator which one.*nothing written/);
    r = people(fx, op, ['change', 'nobody', '--content', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /no person "nobody".*ask the operator/);
    r = people(fx, op, ['change', 'ali', '--domain', 'Farm', '--content', 'Customer; prefers phone calls.']);
    assert.equal(r.status, 0, r.out);
    const changed = parseFrontmatter(fs.readFileSync(path.join(op.dir, 'osoby/alice-example.md'), 'utf8'));
    assert.equal(changed.body.trim(), 'Customer; prefers phone calls.');
    assert.deepEqual(changed.data.aliases, ['ali', 'boss'], 'fields not given stay');
    assert.equal(changed.data.created, rec.data.created);

    // INDEX.md: every name of every person, a shared alias marked as a collision.
    const index = fs.readFileSync(path.join(op.dir, 'INDEX.md'), 'utf8');
    assert.match(index, /^- boss → osoby\/alice-example\.md$/m);
    assert.match(index, /^- alice example → osoby\/alice-example\.md$/m);
    assert.match(index, /^- bob → osoby\/bob\.md \(Farm\)$/m);
    assert.match(index, /^- ali → osoby\/alex\.md \(Shop\), osoby\/alice-example\.md \(kolízia/m);
    assert.equal(gitq(op.dir, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').sort().join(' '), 'INDEX.md osoby/bob.md', 'INDEX in the commit of the write (new bob)');
    assert.equal(gitq(op.dir, 'show', '--name-only', '--format=', 'HEAD'), 'osoby/alice-example.md', 'a body change leaves INDEX as it is');

    // consolidate (spec 6.5): the alias collision and a duplicate name, with both paths.
    assert.equal(people(fx, op, ['new', 'alice-example-2', '--name', 'alice example', '--content', 'Same name.', '--new']).status, 0);
    r = fx.run('consolidate.mjs', ['report'], { env: op.env });
    assert.equal(r.status, 0, r.out);
    const line = r.stdout.split('\n').find((l) => l.startsWith('people ('));
    assert.ok(line, r.stdout);
    assert.match(line, /duplicates [^;]*alice example[^;]*osoby\/alice-example-2\.md \+ osoby\/alice-example\.md|duplicates [^;]*alice example[^;]*osoby\/alice-example\.md \+ osoby\/alice-example-2\.md/);
    assert.match(line, /alias collisions ali: osoby\/alex\.md \+ osoby\/alice-example\.md/);
    assert.doesNotMatch(line, /osoby\/bob\.md/, 'Bob shares no name');
    assert.match(fx.run('consolidate.mjs', ['report']).stdout, /^people \(osoby\/ of the operator repo\): operator repo not configured/m);
  } finally { fx.cleanup(); }
});

/** Two domains on one machine (root/Alpha, root/Beta), each with a brain and a project; memory records written as given. */
function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-people-'));
  const env = cleanEnv({ WORKFLOW_THREAD_ID: 'a1' });
  const domains = {};
  for (const d of ['Alpha', 'Beta']) {
    const dir = path.join(root, d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.agentic-domain'), JSON.stringify({ brain: `${d.toLowerCase()}-brain` }));
    const project = path.join(dir, 'proj');
    const brain = path.join(dir, `${d.toLowerCase()}-brain`);
    initProject(project, { brainRel: `../${d.toLowerCase()}-brain` });
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), brain, '--project', project], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`brain-init failed: ${r.stderr}`);
    domains[d] = { project, brain };
  }
  const record = (d, file, text, author = null) => {
    const b = domains[d].brain;
    fs.writeFileSync(path.join(b, 'memory', file), text);
    if (!author) return;
    // The author of an operator record is the author of the commit that added it (scripts/authors.mjs); the brain's
    // pre-commit (one writer, P-040) is left out for this fixture commit.
    const email = `${author.toLowerCase().replace(/\s+/g, '.')}@example.test`;
    gitq(b, 'add', `memory/${file}`);
    const r = spawnSync('git', ['-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-m', 'record', '--', `memory/${file}`], { cwd: b, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email } });
    if (r.status !== 0) throw new Error(`fixture commit failed: ${r.stderr}`);
  };
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'people.mjs'), ...args], { cwd: domains.Alpha.project, env: { ...env, ...extra }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
  };
  return { root, domains, record, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const mem = (key, name, body, aliases = []) => `---\nkey: ${key}\ntype: ${key.split('-')[0]}\nname: ${name}\norigin: operator\naliases: [${aliases.join(', ')}]\n---\n${body}\n`;

test('collect: operator-*.md and person records of every brain of the machine -> a list to approve -> one commit, no record lost', () => {
  const m = machine();
  try {
    m.record('Alpha', 'operator-operator.md', mem('operator-operator', 'operator', 'Writes in Slovak.'), 'Op One');
    m.record('Beta', 'operator-limits.md', mem('operator-limits', 'limits', 'Usage limit 30 percent.'), 'Op One');
    m.record('Alpha', 'person-bob.md', mem('person-bob', 'Bob', 'Supplier of wood.', ['bobby']));
    m.record('Beta', 'person-robert.md', mem('person-robert', 'Robert', 'Pays late.', ['bobby']));
    m.record('Beta', 'person-carol.md', mem('person-carol', 'Carol', 'Accountant.'));
    m.record('Beta', 'tool-saw.md', mem('tool-saw', 'saw', 'Not a person.'));
    const op = operatorRepo(m.root);
    const plan = path.join(m.root, 'plan.json');
    let r = m.run(['collect', '--out', plan], op.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /- osoby\/op-one\.md: Op One \(operator\), all domains; from alpha-brain:memory\/operator-operator\.md, beta-brain:memory\/operator-limits\.md/);
    assert.match(r.stdout, /- osoby\/bob\.md \(surname unknown: ask the operator, the id is meno-priezvisko\): Bob, aliases bobby, Robert, domains Alpha, Beta; from alpha-brain:memory\/person-bob\.md, beta-brain:memory\/person-robert\.md/);
    assert.match(r.stdout, /- osoby\/carol\.md \(surname unknown: ask the operator, the id is meno-priezvisko\): Carol, domains Beta; from beta-brain:memory\/person-carol\.md/);
    assert.doesNotMatch(r.stdout, /saw/);
    assert.match(r.stdout, /show this list to the operator/);
    assert.equal(gitq(op.dir, 'rev-list', '--count', 'HEAD'), '1', 'the list alone writes nothing');

    // One domain at a time (mojprojekt 2026-11-16): --domain lists only its brains, its plan covers only them.
    const planBeta = path.join(m.root, 'plan-beta.json');
    r = m.run(['collect', '--domain', 'Beta', '--out', planBeta], op.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /carol/);
    assert.doesNotMatch(r.stdout, /alpha-brain/);
    assert.match(r.stdout, /domain Beta only: the people of the other domains are collected when their domain migrates/);
    assert.equal(JSON.parse(fs.readFileSync(planBeta, 'utf8')).domain, 'Beta');

    // The operator drops Carol from the list without a reason: refused, nothing written.
    const approved = JSON.parse(fs.readFileSync(plan, 'utf8'));
    const carol = approved.people.find((p) => p.id === 'carol');
    fs.writeFileSync(plan, JSON.stringify({ ...approved, people: approved.people.filter((p) => p !== carol) }));
    r = m.run(['collect', '--apply', plan], op.env);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /in no entry of the list.*beta-brain:memory\/person-carol\.md; nothing written/);
    assert.ok(!fs.existsSync(path.join(op.dir, 'osoby')));

    // Approved with Carol: one commit with every person, every body kept, profile.md naming the operator.
    fs.writeFileSync(plan, JSON.stringify(approved));
    r = m.run(['collect', '--apply', plan], op.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /committed: \w+ people: collect 3 person\(s\)/);
    assert.equal(gitq(op.dir, 'rev-list', '--count', 'HEAD'), '2', 'one commit');
    assert.equal(gitq(op.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort().join(' '), 'INDEX.md osoby/bob.md osoby/carol.md osoby/op-one.md profile.md');
    const bob = fs.readFileSync(path.join(op.dir, 'osoby/bob.md'), 'utf8');
    assert.match(bob, /Supplier of wood\./); assert.match(bob, /Pays late\./);
    const opOne = fs.readFileSync(path.join(op.dir, 'osoby/op-one.md'), 'utf8');
    assert.match(opOne, /## operator\n\nWrites in Slovak\./); assert.match(opOne, /## limits\n\nUsage limit 30 percent\./);
    assert.match(fs.readFileSync(path.join(op.dir, 'osoby/carol.md'), 'utf8'), /Accountant\./);
    assert.match(fs.readFileSync(path.join(op.dir, 'profile.md'), 'utf8'), /\(osoby\/op-one\.md\)/);
    assert.match(fs.readFileSync(path.join(op.dir, 'INDEX.md'), 'utf8'), /^- bobby → osoby\/bob\.md \(Alpha, Beta\)$/m);
    // The brains keep their records (removed only by the domain migration).
    assert.ok(fs.existsSync(path.join(m.domains.Beta.brain, 'memory', 'person-carol.md')));
    assert.match(m.run(['find', 'robert', '--domain'], op.env).stdout, /^osoby\/bob\.md: Bob/, 'bare --domain is the session domain (Alpha)');
    // A second apply of the same list would overwrite: refused.
    r = m.run(['collect', '--apply', plan], op.env);
    assert.equal(r.status, 1); assert.match(r.stderr, /osoby\/op-one\.md exists already/);
  } finally { m.cleanup(); }
});

test('collect: the operator is who wrote the records, not the agent that later moved them (migration); an existing profile.md gets the line', () => {
  const m = machine();
  try {
    m.record('Alpha', 'operator-old-name.md', mem('operator-old-name', 'limits', 'Usage limit 30 percent.'), 'Ana Writer');
    // Another machine's agent moves and rewrites the record in one commit (a migration of the data layout).
    const b = m.domains.Alpha.brain;
    gitq(b, 'mv', 'memory/operator-old-name.md', 'memory/operator-limits.md');
    fs.appendFileSync(path.join(b, 'memory', 'operator-limits.md'), 'Odkaz prepísaný migráciou.\n');
    gitq(b, 'add', '-A');
    const agent = { GIT_AUTHOR_NAME: 'Migrating Agent', GIT_AUTHOR_EMAIL: 'agent@example.test', GIT_COMMITTER_NAME: 'Migrating Agent', GIT_COMMITTER_EMAIL: 'agent@example.test' };
    const c = spawnSync('git', ['-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-m', 'migrate'], { cwd: b, encoding: 'utf8', env: { ...process.env, ...agent } });
    assert.equal(c.status, 0, c.stderr);
    const op = operatorRepo(m.root, { profile: '# Profil\n\nMoje nastavenia.\n' });
    const plan = path.join(m.root, 'plan.json');
    let r = m.run(['collect', '--out', plan], op.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /- osoby\/ana-writer\.md: Ana Writer \(operator\)/);
    assert.doesNotMatch(r.stdout, /Migrating Agent|migrating-agent/);
    r = m.run(['collect', '--apply', plan], op.env);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(op.dir, 'profile.md'), 'utf8'), '# Profil\n\nMoje nastavenia.\n\nOperátor tejto inštalácie: [Ana Writer](osoby/ana-writer.md)\n');
  } finally { m.cleanup(); }
});

test('collect: a person the operator repo has already (by alias) is merged into with migrated_from, not proposed again', () => {
  const m = machine();
  try {
    const op = operatorRepo(m.root, { profile: '# Profil\n\nOperátor tejto inštalácie: [Ana](osoby/ana.md)\n' });
    fs.mkdirSync(path.join(op.dir, 'osoby'), { recursive: true });
    fs.writeFileSync(path.join(op.dir, 'osoby', 'ana.md'), '---\nname: Ana\naliases: [Ana Writer]\ndomains: []\ncreated: 2026-11-01\nmigrated_from: [old:memory/operator-x.md]\n---\n## x\n\nPíše po slovensky.\n');
    gitq(op.dir, 'add', '-A'); gitq(op.dir, 'commit', '-q', '-m', 'ana'); gitq(op.dir, 'push', '-q');
    m.record('Alpha', 'operator-limits.md', mem('operator-limits', 'limits', 'Usage limit 30 percent.'), 'Ana Writer');
    m.record('Beta', 'person-ana.md', mem('person-ana', 'Ana', 'Owner of the shop.'));
    const plan = path.join(m.root, 'plan.json');
    let r = m.run(['collect', '--out', plan], op.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /- osoby\/ana\.md \(exists: merged into it\): Ana Writer \(operator\), aliases Ana, all domains; from alpha-brain:memory\/operator-limits\.md, beta-brain:memory\/person-ana\.md/);
    assert.equal((r.stdout.match(/osoby\/ana\.md/g) || []).length, 1, 'one entry for the one person');
    assert.doesNotMatch(r.stdout, /ana-writer|ana-2/);
    r = m.run(['collect', '--apply', plan], op.env);
    assert.equal(r.status, 0, r.out);
    const ana = parseFrontmatter(fs.readFileSync(path.join(op.dir, 'osoby', 'ana.md'), 'utf8'));
    assert.equal(ana.data.name, 'Ana');
    assert.deepEqual(ana.data.aliases, ['Ana Writer']);
    assert.deepEqual(ana.data.domains, [], 'a person of every domain stays so');
    assert.deepEqual(ana.data.migrated_from, ['old:memory/operator-x.md', 'alpha-brain:memory/operator-limits.md', 'beta-brain:memory/person-ana.md']);
    assert.match(ana.body, /Píše po slovensky\.[\s\S]*## limits\n\nUsage limit 30 percent\.[\s\S]*Owner of the shop\./);
    assert.equal(fs.readdirSync(path.join(op.dir, 'osoby')).filter((f) => f !== 'INDEX.md').join(' '), 'ana.md');
  } finally { m.cleanup(); }
});

test('the id of a person is meno-priezvisko when the surname is known (operator 2026-11-16)', async () => {
  const { fullNameOf, shortIdProblem } = await import('../scripts/people.mjs');
  assert.equal(fullNameOf(['Mira', 'Mira Kováčová', 'Mirka']), 'Mira Kováčová');
  assert.match(shortIdProblem('mira', ['Mira', 'Mira Kováčová']), /meno-priezvisko, mira-kovacova/);
  assert.equal(shortIdProblem('mira', ['Mira']), null, 'surname unknown: the first name stays');
  assert.equal(shortIdProblem('mira-kovacova', ['Mira Kováčová']), null);
});

test('collect marks an entry whose body repeats a section (records of several machines merged word for word)', async () => {
  const { planLines, repeatedSections } = await import('../scripts/people.mjs');
  const body = '## operator\n\nWrites in Slovak.\n\n## operator\n\nWrites in Slovak; X is the maintainer.\n\n## limits\n\n30 %.';
  assert.deepEqual(repeatedSections(body), [{ head: '## operator', n: 2 }]);
  const lines = planLines({ people: [{ id: 'op-one', name: 'Op One', operator: true, aliases: [], domains: [], sources: [{ label: 'a:memory/operator-operator.md' }], body }] });
  assert.match(lines.join('\n'), /! repeated sections "## operator" \(2×\): merge them into one in the body of the plan and check each fact with the operator/);
});

test('change with the full name moves a first-name record to meno-priezvisko (the old id stays an alias); a local commit not on origin refuses the write', () => {
  const fx = setup();
  try {
    const op = operatorRepo(fx.root);
    assert.equal(people(fx, op, ['new', 'mira', '--name', 'mira', '--aliases', 'klientka', '--domains', 'Shop', '--content', 'Klientka obchodu.']).status, 0);
    let r = people(fx, op, ['change', 'mira', '--name', 'Mira Kováčová']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /renamed osoby\/mira\.md -> osoby\/mira-kovacova\.md/);
    assert.ok(!fs.existsSync(path.join(op.dir, 'osoby/mira.md')), 'no old record beside the new one');
    const rec = parseFrontmatter(fs.readFileSync(path.join(op.dir, 'osoby/mira-kovacova.md'), 'utf8'));
    assert.equal(rec.data.name, 'Mira Kováčová');
    assert.deepEqual(rec.data.aliases, ['mira', 'klientka']);
    assert.equal(rec.body.trim(), 'Klientka obchodu.');
    const index = fs.readFileSync(path.join(op.dir, 'INDEX.md'), 'utf8');
    assert.doesNotMatch(index, /osoby\/mira\.md/);
    // A commit by hand that origin does not have: the write refuses instead of writing beside it.
    fs.writeFileSync(path.join(op.dir, 'README.md'), 'changed\n');
    gitq(op.dir, 'commit', '-qam', 'local');
    r = people(fx, op, ['change', 'mira-kovacova', '--content', 'x']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /1 local commit\(s\) not on origin\/main; push or drop it first/);
  } finally { fx.cleanup(); }
});
