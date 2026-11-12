// P-005, P-006, P-011, P-020, P-036: done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, startComms, commsClient } from './helpers.mjs';
import { readLog } from '../scripts/logs.mjs';
const logView = (fx, name) => { const l = readLog(fx.brain, name, { rotationDays: 30 }); return l.length ? l.join('\n') + '\n' : ''; };

// Commits what the test wrote into the topic's code copy (a separate clone next to the project).
const commitCopy = (copy, message) => {
  for (const args of [['config', 'user.name', 't'], ['config', 'user.email', 't@t'], ['add', '-A'], ['commit', '-q', '-m', message]]) spawnSync('git', args, { cwd: copy });
};

test('unit of work: verification required, logs written, handover free, repeats proposed, log lines cleared by save skill', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd1', '--subject', 'Discussion']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'd1', '--task', 'T', '--done', 'x', '--next', 'y']).status, 0);
    let r = fx.run('done.mjs', ['--procedures', 'deploy-web-docker']);
    assert.equal(r.status, 1); assert.match(r.stderr, /verified/);
    for (let i = 0; i < 3; i++) {
      r = fx.run('done.mjs', ['--verified', 'saw output', '--procedures', 'deploy-web-docker', '--derivations', 'deploy-flow']);
      assert.equal(r.status, 0, r.out);
    }
    assert.match(r.stdout, /procedure deploy-web-docker 3x: create the skill yourself, no operator approval/);
    assert.match(r.stdout, /derivation deploy-flow 3x: save the conclusion/);
    assert.equal(logView(fx, 'procedures.log').trim().split('\n').length, 3);
    assert.match(fx.read('topics/d1/handover.md'), /\(voľná\)/);
    assert.notEqual(JSON.parse(fx.read('topics/d1/topic.json')).state, 'free', 'the topic stays held by the thread (D-0011)');
    assert.match(r.stdout, /topic d1 stays held by a1/);
    assert.match(fx.run('done.mjs', ['--list']).stdout, /procedures: deploy-web-docker 3x/);
    // sessions started before the rename still call finish.mjs
    assert.match(fx.run('finish.mjs', ['--list']).stdout, /procedures: deploy-web-docker 3x/);
    // rejected proposal is not proposed again
    assert.equal(fx.run('save.mjs', ['decision', 'skill pre deploy-web-docker zamietnutý', '--what', 'no skill', '--reason', 'rare', '--relates-to', 'deploy-web-docker']).status, 0);
    r = fx.run('done.mjs', ['--verified', 'x', '--procedures', 'deploy-web-docker']);
    assert.match(r.stdout, /rejected earlier, no new proposal/);
    // approval: save skill removes the log lines
    r = fx.run('save.mjs', ['skill', 'deploy-web', '--description', 'Použi pri nasadení webu', '--content', 'kroky', '--origin', 'routine', '--from-procedure', 'deploy-web-docker']);
    assert.equal(r.status, 0, r.out);
    assert.equal(logView(fx, 'procedures.log').trim(), '');
    // without a held topic: no hint to claim one (bob 2026-11-01 claimed main just to close it)
    assert.equal(fx.run('topic.mjs', ['release', 'd1']).status, 0);
    // a unit done in a thread without a topic is closed, not bounced back (operator 2026-11-02)
    r = fx.run('done.mjs', ['--verified', 'x', '--procedures', 'deploy-web-docker']);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /unit closed: this thread held no topic/);
    assert.match(logView(fx, 'procedures.log'), /deploy-web-docker/);
    // empty thread (after /clear): done closes it without --verified
    r = fx.run('done.mjs', []);
    assert.equal(r.status, 0, r.out); assert.match(r.stdout, /thread closed: no topic and no recorded work/);
    r = fx.run('done.mjs', ['--verified', 'x', '--topic']);
    assert.equal(r.status, 1); assert.match(r.stderr, /nothing to close with done --topic\. Do not claim a topic/);
  } finally { fx.cleanup(); }
});

test('done --topic merges the code copy into the main branch, archives the topic, removes the copy', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--kind', 'code']).status, 0);
    const copy = path.join(fx.root, 'project-topics', 'feat');
    fs.writeFileSync(path.join(copy, 'feature.txt'), 'feature\n');
    commitCopy(copy, 'feat');
    // main moves on in parallel; no conflict
    fs.writeFileSync(path.join(fx.project, 'other.txt'), 'other\n');
    fx.git(fx.project, 'add', '-A'); fx.git(fx.project, 'commit', '-q', '-m', 'other');
    let r = fx.run('done.mjs', ['--topic']);
    assert.equal(r.status, 1); assert.match(r.stderr, /verified/);
    r = fx.run('done.mjs', ['--topic', '--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(path.join(fx.project, 'feature.txt')));
    assert.ok(fs.existsSync(path.join(fx.project, 'other.txt')));
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/feat/);
    assert.ok(!fs.existsSync(copy));
    assert.ok(!fx.exists('topics/feat'));
    assert.ok(fx.exists('topics/archive/feat/topic.json'));
    assert.equal(JSON.parse(fx.read('topics/archive/feat/topic.json')).state, 'closed');
    assert.equal(fx.run('topic.mjs', ['list']).stdout.trim(), 'no open topics');
    assert.ok(fx.git(fx.origin, 'ls-tree', '-r', '--name-only', 'main').includes('topics/archive/feat/topic.json'));
  } finally { fx.cleanup(); }
});

test('done (unit) of a code topic merges the verified copy into the main branch, keeps the copy and the topic held (D-0011)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'feat', '--subject', 'Feature', '--kind', 'code']).status, 0);
    const copy = path.join(fx.root, 'project-topics', 'feat');
    fs.writeFileSync(path.join(copy, 'feature.txt'), 'feature\n');
    commitCopy(copy, 'feat');
    fs.writeFileSync(path.join(copy, 'feature.txt'), 'not verified yet\n');
    let r = fx.run('done.mjs', ['--verified', 'feature.txt present']);
    assert.equal(r.status, 1, r.out); assert.match(r.stderr, /uncommitted changes/);
    assert.ok(!fs.existsSync(path.join(fx.project, 'feature.txt')), 'a refused unit merges nothing');
    spawnSync('git', ['checkout', '--', 'feature.txt'], { cwd: copy });
    r = fx.run('done.mjs', ['--verified', 'feature.txt present']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(fx.project, 'feature.txt'), 'utf8'), 'feature\n');
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/feat \(done feat\)/);
    assert.ok(fs.existsSync(copy), 'the copy stays for the next unit');
    assert.match(r.stdout, /topic feat stays held by a1/);
    assert.equal(JSON.parse(fx.read('topics/feat/holder.json')).thread, 'a1');
  } finally { fx.cleanup(); }
});

test('done --topic: uncommitted files of the main checkout equal to the topic branch do not block the merge (adopt, Windows instance 2026-11-07)', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.project, 'settings.txt'), 'v1\n');
    fs.writeFileSync(path.join(fx.project, 'mine.txt'), 'a\n');
    fx.git(fx.project, 'add', '-A'); fx.git(fx.project, 'commit', '-q', '-m', 'base');
    assert.equal(fx.run('topic.mjs', ['create', 'tidy', '--subject', 'Tidy', '--kind', 'code']).status, 0);
    const copy = path.join(fx.root, 'project-topics', 'tidy');
    fs.writeFileSync(path.join(copy, 'settings.txt'), 'v2\n');
    fs.writeFileSync(path.join(copy, 'gen.json'), '{}\n');
    commitCopy(copy, 'tidy');
    // connect generated the same files in the main checkout, uncommitted; one other change is the operator's own
    fs.writeFileSync(path.join(fx.project, 'settings.txt'), 'v2\n');
    fs.writeFileSync(path.join(fx.project, 'gen.json'), '{}\n');
    fs.writeFileSync(path.join(fx.project, 'mine.txt'), 'b\n');
    let r = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /uncommitted changes; commit or stash them before merging topic\/tidy: mine\.txt$/m);
    assert.equal(fs.readFileSync(path.join(fx.project, 'mine.txt'), 'utf8'), 'b\n', 'a different change is kept');
    fx.git(fx.project, 'checkout', '--', 'mine.txt');
    r = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(fx.project, 'settings.txt'), 'utf8'), 'v2\n');
    assert.equal(fs.readFileSync(path.join(fx.project, 'gen.json'), 'utf8'), '{}\n');
    assert.match(fx.git(fx.project, 'log', '-1', '--format=%s'), /Merge topic\/tidy/);
    assert.equal(fx.git(fx.project, 'status', '--porcelain'), '');
  } finally { fx.cleanup(); }
});

test('done --topic in T3 tells the agent to settle its thread, not archive it (P-036, flow-public#6), outside T3 not', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd2', '--subject', 'D2']).status, 0);
    let r = fx.run('done.mjs', ['--topic', '--verified', 'x'], { env: { T3CODE_THREAD_ID: 'a1' } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /settle this thread \(tool t3_thread_organize, action settle, no threadId\)/);
    assert.doesNotMatch(r.stdout, /action archive/);
    assert.equal(fx.run('topic.mjs', ['create', 'd3', '--subject', 'D3']).status, 0);
    r = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /t3_thread_organize/);
  } finally { fx.cleanup(); }
});

test('done --topic is refused in a wake turn and for a non-holder', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd', '--subject', 'D']).status, 0);
    let r = fx.runB('done.mjs', ['--topic', '--topic-id', 'd', '--verified', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /held by a1/);
    fs.mkdirSync(path.join(fx.brain, 'local', 'threads'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), JSON.stringify({ turn_source: 'wake' }));
    r = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(r.status, 1); assert.match(r.stderr, /P-047/); assert.match(r.stderr, /AskUserQuestion/);
    assert.ok(fx.exists('topics/d/topic.json'));
    // An answer of the operator in a dialog of this turn is the instruction (D-0011); an answer from an earlier turn is not.
    const state = (s) => fs.writeFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), JSON.stringify({ turn_source: 'wake', ...s }));
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    state({ turn_started_at: iso(now), dialog_answered_at: iso(now - 60_000) });
    r = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(r.status, 1, 'a dialog answered before this turn'); assert.match(r.stderr, /P-047/);
    state({ turn_started_at: iso(now - 60_000), dialog_answered_at: iso(now) });
    r = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(r.status, 0, r.out);
    assert.ok(fx.exists('topics/archive/d/topic.json'));
  } finally { fx.cleanup(); }
});

test('done reminds of files changed in scratch/ since the claim or the last done, clones skipped (P-062, operator 2026-11-08)', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd2', '--subject', 'Discussion']).status, 0);
    const scratch = path.join(fx.project, 'scratch');
    fs.mkdirSync(path.join(scratch, 'clone', '.git'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'clone', 'code.js'), 'x\n');
    fs.writeFileSync(path.join(scratch, 'analyza.md'), '# výsledok\n');
    let r = fx.run('done.mjs', ['--verified', 'saw output']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /scratch: 1 file\(s\) changed since .* only in scratch\/ \(not in git\): scratch\/analyza\.md\. .*materialy\/d2\//);
    assert.doesNotMatch(r.stdout, /code\.js/);
    assert.ok(JSON.parse(fx.read('topics/d2/topic.json')).last_done);
    // nothing new since the last done: no line
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(scratch, 'analyza.md'), past, past);
    assert.equal(fx.run('topic.mjs', ['claim', 'd2']).status, 0);
    r = fx.run('done.mjs', ['--verified', 'saw output']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /scratch:/);
  } finally { fx.cleanup(); }
});

// alice 2026-11-02: done --topic closes the topic in the mail service (new mail 410, waiting mail bounces to the sender);
// a thread that also holds main is not archived; archived topics from before are closed at the next session start.
const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';

test('done --topic closes the topic in the mail: waiting mail bounces, new mail is refused at once with the closing time', { skip }, async () => {
  const fx = setup({ second: true });
  const comms = await startComms(fx, { senders: ['alice', 'bob'], brains: [[fx.project, fx.brain, 'alice'], [fx.projectB, fx.brainB, 'bob']] });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'gamma', '--subject', 'Gamma']).status, 0);
    assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta']).status, 0);
    const send = fx.runB('comms.mjs', ['send', '--level', 'assist', '--to', 'project/gamma', '--text', 'units?']);
    assert.equal(send.status, 0, send.out);
    const id = /sent (\S+) \(assist\)/.exec(send.stdout)?.[1];
    // The closing thread also holds main: the topic is closed, the thread is not archived (P-045).
    const main = path.join(fx.brain, 'topics', 'main');
    fs.mkdirSync(main, { recursive: true });
    fs.writeFileSync(path.join(main, 'topic.json'), JSON.stringify({ id: 'main', subject: 'Main', kind: 'main', state: 'working' }) + '\n');
    fs.writeFileSync(path.join(main, 'holder.json'), JSON.stringify({ thread: 'a1', mode: 'operator' }) + '\n');
    fx.git(fx.brain, 'add', '-A'); fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'main held by a1 (test)');
    const fin = fx.run('done.mjs', ['--topic', '--topic-id', 'gamma', '--verified', 'done'], { env: { T3CODE_THREAD_ID: 'a1' } });
    assert.equal(fin.status, 0, fin.out);
    assert.match(fin.stdout, /mail: topic gamma closed in the mail service/);
    assert.match(fin.stdout, /holds the persona main topic, so it stays open: do not settle or archive it/);
    assert.doesNotMatch(fin.stdout, /t3_thread_organize/);
    assert.equal(comms.topic('project', 'gamma').state, 'closed');
    assert.equal(comms.topic('project', 'gamma').holder, null);
    assert.equal(JSON.parse(comms.cli(['message', '--id', id]).out).outcome, 'undelivered');
    const late = fx.runB('comms.mjs', ['send', '--level', 'blocker', '--to', 'project/gamma', '--text', 'still?']);
    assert.notEqual(late.status, 0, late.out);
    assert.match(late.out, /uzavretá/);

    // A topic archived before the mail knew `close`: the next session start closes it once.
    assert.equal(fx.run('topic.mjs', ['create', 'delta', '--subject', 'Delta']).status, 0);
    const arch = path.join(fx.brain, 'topics', 'archive', 'delta');
    fs.mkdirSync(path.dirname(arch), { recursive: true });
    fs.renameSync(path.join(fx.brain, 'topics', 'delta'), arch);
    assert.equal(comms.topic('project', 'delta').state ?? 'open', 'open');
    fx.hook('session-start.mjs', { source: 'startup' });
    assert.equal(comms.topic('project', 'delta').state, 'closed');
    assert.ok(JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'comms-closed.json'), 'utf8')).includes('delta'));
  } finally {
    await comms.stop();
    fx.cleanup();
  }
});
