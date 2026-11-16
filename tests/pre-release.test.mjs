// ttl: 2026-12-15
// Flow v2 spec 11.4, 11.5, plan B19, O22: the readiness check before the release (overview.mjs --pre-release) goes over
// every brain of every domain of the machine and finds a live topic without a step or a question in its handover, topic
// work not on origin (a local topic or task branch origin lacks, uncommitted changes in its worktree), an open fix question
// (P-075) of the mail and a brain in data layout 1; it lists each domain not in layout 3 with its repos and the migrate
// commands. A mail that cannot be asked is a finding. Settled, the check reports ready and exits 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, cleanEnv } from './helpers.mjs';

const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const HANDOVER = (next, question = '-') => `## Zadanie\n- úloha\n## Hotové\n-\n## Ďalší krok\n${next}\n## Súbory\n-\n## Otvorené otázky\n${question}\n## Úlohy pre operátora\n-\n`;

function domain(root, name, layout) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentic-domain'), JSON.stringify({ brain: 'brain' }));
  const brain = path.join(dir, 'brain');
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'brain-init.mjs'), brain, '--layout', String(layout)], { env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return brain;
}

function topic(brain, id, fields, handover) {
  const dir = path.join(brain, 'temy', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.tema.json'), `${JSON.stringify({ id, subject: `Téma ${id}`, class: 'ops', kind: 'discussion', state: 'working', mode: 'off', holder: { thread: `t-${id}` }, ...fields }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'handover.md'), handover);
}

/** Domain Alfa (layout 2, repo app with origin), Beta (layout 1), Gamma (layout 3); topics with each finding. */
function machine(base) {
  const root = path.join(base, 'machine');
  const a = domain(root, 'Alfa', 2);
  fs.writeFileSync(path.join(a, '.brain', 'policy.json'), `${JSON.stringify({ data_layout: 2, topics: { auto: { projects: { '../app': ['app'] } } } }, null, 2)}\n`);
  const app = path.join(root, 'Alfa', 'app');
  const origin = path.join(base, 'app.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(path.join(app, '.brain'), { recursive: true });
  git(app, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, '.workflow.json'), JSON.stringify({ brain: '../brain' }));
  fs.writeFileSync(path.join(app, '.brain', 'policy.json'), JSON.stringify({ data_layout: 2 }));
  fs.writeFileSync(path.join(app, 'a.txt'), 'a\n');
  git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'app');
  git(app, 'remote', 'add', 'origin', origin);
  git(app, 'push', '-q', 'origin', 'main');
  // a-ok: code, pushed; a-unpushed: a worktree with a commit origin lacks and an uncommitted file.
  git(app, 'branch', 'topic/a-ok'); git(app, 'push', '-q', 'origin', 'topic/a-ok');
  const wt = path.join(root, 'Alfa', '.worktrees', 'app', 'a-unpushed');
  git(app, 'worktree', 'add', '-q', '-b', 'topic/a-unpushed', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'work');
  fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n');
  topic(a, 'a-ok', { kind: 'code', class: 'code', repo: 'app' }, HANDOVER('- krok'));
  topic(a, 'a-unpushed', { kind: 'code', class: 'code', repo: 'app' }, HANDOVER('- krok'));
  topic(a, 'a-empty', {}, HANDOVER('-'));
  topic(a, 'a-fix', { project: 'alfa', fix_gate: true, orchestrator: { topic: 'orch', project: 'alfa' } }, HANDOVER('-', '- smiem opraviť?'));
  topic(a, 'a-closed', { state: 'closed' }, HANDOVER('-'));
  git(a, 'add', '-A'); git(a, 'commit', '-q', '-m', 'topics');
  const b = domain(root, 'Beta', 1);
  const g = domain(root, 'Gamma', 3);
  return { root, a, b, g, app, wt };
}

test('pre-release: each finding, the domains to migrate, a mail down; settled it reports ready', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pre-'));
  try {
    const m = machine(base);
    const state = path.join(base, 'stub.json');
    fs.writeFileSync(state, JSON.stringify({ awaiting: [{ id: 'm-fix', level: 'blocker', to: 'alfa/orch', status: 'pending' }] }));
    const env = cleanEnv({ WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: state });
    const run = (...extra) => spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'overview.mjs'), '--pre-release', '--root', m.root, ...extra], { env, encoding: 'utf8', cwd: base });
    let r = run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = r.stdout;
    assert.match(out, /^pre-release: 5 finding\(s\) in 4 live topic\(s\) of 3 brain\(s\)/m, out);
    assert.match(out, /^- brain .*Beta\/brain is in data 1: 2\.0 needs data 2\.0 \(O22\): node .*bin\/migrate\.mjs .*Beta\/brain \(preview\)/m);
    assert.match(out, /^- Alfa\/brain\/a-empty: the handover has neither a step .* nor a question/m);
    assert.match(out, /^- Alfa\/brain\/a-unpushed: app: topic\/a-unpushed \(\w{7}\) not on origin: git -C .*Alfa\/app push origin topic\/a-unpushed$/m);
    assert.match(out, /^- Alfa\/brain\/a-unpushed: app: worktree .*a-unpushed \(topic\/a-unpushed\) has uncommitted changes \(c\.txt\)/m);
    assert.match(out, /^- Alfa\/brain\/a-fix: open message m-fix \(blocker, awaiting to alfa\/orch\): P-075 fix question, which 2\.0 does not process: withdraw it \(comms withdraw --id m-fix\)/m);
    assert.doesNotMatch(out, /a-ok|a-closed/, 'a pushed topic and a closed one give no finding');
    assert.match(out, /Alfa\/brain: shared checkouts .*"shared_checkouts": \["app"\]/);
    assert.match(out, /^- .*Alfa\/brain \(data 2\.0\), repos app \(data 2\.0\): node .*migrate\.mjs .*Alfa\/brain --to 2\.1 --write-triage .*Alfa\/migrate-2-3\.tsv; .*--to 2\.1 --apply --confirmed .*; .*--to 2\.1 --check$/m);
    assert.match(out, /^- .*Beta\/brain \(data 1\): first 1 -> 2\.0 for brain/m);
    assert.doesNotMatch(out, /Gamma\/brain \(data/, 'a domain in data 2.1 is not listed');

    // The mail does not answer: a finding, not a pass.
    fs.writeFileSync(state, JSON.stringify({ down: true }));
    r = run();
    assert.match(r.stdout, /^- Alfa\/brain: comms obligations not readable .*not checked/m);

    // Settled: step written, work committed and pushed, fix question withdrawn, Beta migrated (removed here).
    fs.writeFileSync(state, JSON.stringify({ awaiting: [] }));
    fs.writeFileSync(path.join(m.a, 'temy', 'a-empty', 'handover.md'), HANDOVER('- pokračovať'));
    git(m.wt, 'add', '-A'); git(m.wt, 'commit', '-q', '-m', 'rest'); git(m.wt, 'push', '-q', 'origin', 'topic/a-unpushed');
    fs.rmSync(path.join(m.root, 'Beta'), { recursive: true, force: true });
    r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^pre-release: ready, no finding \(4 live topic\(s\) of 2 brain\(s\)\)$/m);
    // --no-mail skips the mail and still checks the rest.
    r = run('--no-mail');
    assert.equal(r.status, 0, r.stdout);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
