// Cleaning up after yourself never asks the operator (operator 2026-11-03: two approvals broke an autonomous night run):
// work files under any repo's ignored scratch/, and restoring a file whose uncommitted changes are the thread's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { bashEdits } from '../hooks/pre-tool-use.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || null;
const askOf = (fx) => (command) => decision(fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }));

function repo(fx, name, ignoreScratch = true) {
  const dir = path.join(fx.root, name);
  fs.mkdirSync(dir);
  fx.git(dir, 'init', '-q', '-b', 'dev');
  fs.writeFileSync(path.join(dir, '.gitignore'), ignoreScratch ? 'scratch/\n' : '');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fx.git(dir, 'add', '-A');
  fx.git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}

test('work files under the ignored scratch/ of any repo the thread works in are removed without asking', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}'); // sibling repos of one domain (v3, D-0002)
    const flow = repo(fx, 'flow');
    fs.mkdirSync(path.join(flow, 'scratch', 'dbg-EbdivC'), { recursive: true });
    fs.writeFileSync(path.join(flow, 'scratch', 'dbg-EbdivC', 'x.json'), '{}');
    let r = fx.hook('pre-tool-use.mjs', { cwd: fx.project, tool_name: 'Bash', tool_input: { command: `cd ${flow} && rm -rf scratch/dbg-EbdivC && npm test` } });
    assert.equal(decision(r), null, 'a leftover made by a script in ../flow/scratch/ is the thread\'s work file');
    fs.mkdirSync(path.join(flow, 'notes'));
    fs.writeFileSync(path.join(flow, 'notes', 'n.md'), 'x');
    r = fx.hook('pre-tool-use.mjs', { cwd: fx.project, tool_name: 'Bash', tool_input: { command: `rm -rf ${path.join(flow, 'notes')}` } });
    assert.equal(decision(r), 'ask', 'untracked data outside scratch/ still asks');
    const plain = repo(fx, 'plain', false);
    fs.mkdirSync(path.join(plain, 'scratch'));
    fs.writeFileSync(path.join(plain, 'scratch', 'keep.md'), 'x');
    r = fx.hook('pre-tool-use.mjs', { cwd: fx.project, tool_name: 'Bash', tool_input: { command: `rm -rf ${path.join(plain, 'scratch', 'keep.md')}` } });
    assert.equal(decision(r), 'ask', 'a scratch/ the repo does not ignore is not a work dir');
  } finally { fx.cleanup(); }
});

test('restoring a file whose uncommitted changes are the thread\'s own does not ask; someone else\'s change does', () => {
  const fx = setup();
  try {
    const f = path.join(fx.project, 'hook.mjs');
    fs.writeFileSync(f, 'v1\n');
    fx.git(fx.project, 'add', 'hook.mjs');
    fx.git(fx.project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'hook');
    const edit = { tool_name: 'Edit', tool_input: { file_path: f, old_string: 'v1', new_string: 'v2' } };
    fx.hook('pre-tool-use.mjs', edit);
    fs.writeFileSync(f, 'v2\n');
    fx.hook('post-tool-use.mjs', edit);
    const restore = { tool_name: 'Bash', tool_input: { command: `cp scratch/hook.bak hook.mjs && rm scratch/hook.bak` } };
    let r = fx.hook('pre-tool-use.mjs', restore);
    assert.equal(decision(r), null, 'the uncommitted change is the thread\'s own edit');
    // sed -i in the same command: the change is recorded after the call, the next restore still passes
    const sed = { tool_name: 'Bash', tool_input: { command: `sed -i 's/v2/v3/' hook.mjs` } };
    fx.hook('pre-tool-use.mjs', sed);
    fs.writeFileSync(f, 'v3\n');
    fx.hook('post-tool-use.mjs', sed);
    r = fx.hook('pre-tool-use.mjs', restore);
    assert.equal(decision(r), null, 'after sed -i by the thread');
    fs.appendFileSync(f, 'other thread\n');
    r = fx.hook('pre-tool-use.mjs', restore);
    assert.equal(decision(r), 'ask', 'content changed by someone else after the thread is not the thread\'s');
    r = fx.hook('pre-tool-use.mjs', restore, { env: { WORKFLOW_THREAD_ID: 'b2' } });
    assert.equal(decision(r), 'ask', 'another thread does not inherit the edit');
  } finally { fx.cleanup(); }
});

test('a file that was already dirty before the thread touched it stays protected', () => {
  const fx = setup();
  try {
    const f = path.join(fx.project, 'g.txt');
    fs.writeFileSync(f, 'g\n');
    fx.git(fx.project, 'add', 'g.txt');
    fx.git(fx.project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'g');
    fs.writeFileSync(f, 'g\nwork of someone\n');
    const edit = { tool_name: 'Edit', tool_input: { file_path: f, old_string: 'g', new_string: 'h' } };
    fx.hook('pre-tool-use.mjs', edit);
    fs.writeFileSync(f, 'h\nwork of someone\n');
    fx.hook('post-tool-use.mjs', edit);
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'rm g.txt' } });
    assert.equal(decision(r), 'ask');
  } finally { fx.cleanup(); }
});

test('bashEdits: in-place edits are targets (also for topic_owned), plain sed is not', () => {
  assert.deepEqual(bashEdits(`cd /r && sed -i "s/a b/c/" x.txt`, '/w'), ['/r/x.txt']);
  assert.deepEqual(bashEdits(`perl -pi -e 's/a/b/' y.txt z.txt`, '/w'), ['/w/y.txt', '/w/z.txt']);
  assert.deepEqual(bashEdits(`sed -i.bak -e 's/a/b/' -e 's/c/d/' q.txt`, '/w'), ['/w/q.txt']);
  assert.deepEqual(bashEdits(`sed 's/a/b/' x.txt > y.txt`, '/w'), []);
  assert.deepEqual(bashEdits(`grep x f | sed -n 1p`, '/w'), []);
});

test('git restore / checkout -- of the thread\'s own edits does not ask; other dirty files or other history ops do', () => {
  const fx = setup();
  try {
    const ask = askOf(fx);
    const f = path.join(fx.project, 'own.txt');
    const g = path.join(fx.project, 'other.txt');
    fs.writeFileSync(f, '1\n');
    fs.writeFileSync(g, '1\n');
    fx.git(fx.project, 'add', 'own.txt', 'other.txt');
    fx.git(fx.project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'files');
    const edit = { tool_name: 'Write', tool_input: { file_path: f, content: '2\n' } };
    fx.hook('pre-tool-use.mjs', edit);
    fs.writeFileSync(f, '2\n');
    fx.hook('post-tool-use.mjs', edit);
    assert.equal(ask('git restore own.txt'), null);
    assert.equal(ask(`git -C ${fx.project} checkout -- own.txt`), null);
    assert.equal(ask('git restore .'), null, 'only own edits are dirty');
    fs.writeFileSync(g, 'someone\n');
    assert.equal(ask('git restore .'), 'ask', 'another dirty file under the path');
    assert.equal(ask('git restore other.txt'), 'ask');
    assert.equal(ask('git restore own.txt && git reset --hard'), 'ask', 'another history op in the same command');
    assert.equal(ask('git restore --source HEAD~1 own.txt'), 'ask');
  } finally { fx.cleanup(); }
});

test('a file a script changed from clean (python heredoc in another repo) is own: git restore does not ask', () => {
  const fx = setup();
  try {
    const flow = repo(fx, 'flow');
    const a = path.join(flow, 'a.txt');
    fs.writeFileSync(path.join(flow, 'b.txt'), 'b\n');
    fx.git(flow, 'add', 'b.txt');
    fx.git(flow, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'b');
    fs.writeFileSync(path.join(flow, 'b.txt'), 'someone\n');
    const py = { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: `cd ${flow} && python3 - <<'X'\nopen('a.txt','w').write('x')\nX` } };
    fx.hook('pre-tool-use.mjs', py);
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(path.join(flow, 'b.txt'), 'someone\nmore\n');
    fx.hook('post-tool-use.mjs', py);
    const ask = (command, id) => decision(fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_use_id: id, tool_input: { command } }));
    assert.equal(ask(`cd ${flow} && git restore a.txt`, 'tu2'), null, 'clean before, changed by the command');
    assert.equal(ask(`cd ${flow} && git restore b.txt`, 'tu3'), 'ask', 'dirty before the command: not the thread\'s');
    fs.appendFileSync(a, 'other\n');
    assert.equal(ask(`cd ${flow} && git restore a.txt`, 'tu4'), 'ask', 'changed after the thread by someone else');
  } finally { fx.cleanup(); }
});

test('git history text inside a heredoc written to a file does not ask; a heredoc run by a shell does', () => {
  const fx = setup();
  try {
    const ask = askOf(fx);
    assert.equal(ask(`mkdir -p scratch && cat > scratch/release.sh <<'EOF'\ngit checkout -- package.json\ngit reset --hard\nEOF\nsh -n scratch/release.sh`), null, 'script text is data');
    assert.equal(ask(`python3 - <<'EOF'\nprint("git reset --hard")\nEOF`), null);
    assert.equal(ask(`bash <<'EOF'\ngit reset --hard\nEOF`), 'ask', 'a shell runs the body');
    assert.equal(ask(`cat > f <<'EOF'\nx\nEOF\ngit reset --hard`), 'ask', 'a history op after the heredoc still asks');
  } finally { fx.cleanup(); }
});

test('git history text in quoted arguments (commit message, topic subject) does not ask; quoted text run by a shell does', () => {
  const fx = setup();
  try {
    const ask = askOf(fx);
    assert.equal(ask(`git commit -qam "a later git restore of x\n\ngit checkout -- y" --allow-empty`), null, 'commit message');
    assert.equal(ask(`node topic.mjs create t --subject "git restore bez potvrdenia"`), null, 'topic subject');
    assert.equal(ask(`echo 'git reset --hard' && ls`), null);
    assert.equal(ask(`python3 - <<'PYEOF'\nrep(P, "git checkout -- x", "y")\nPYEOF`), null, 'python heredoc editing hook code');
    assert.equal(ask(`bash -c "git reset --hard"`), 'ask', 'bash -c runs its argument');
    assert.equal(ask(`ssh h "git clean -fd"`), 'ask');
    assert.equal(ask(`echo "x" && git reset --hard`), 'ask', 'the executed part still asks');
  } finally { fx.cleanup(); }
});

test('a path set in a variable earlier in the command is resolved (T=~/repo; cd $T && cat > f is not a write into the session dir)', async () => {
  const { bashTargets, expandAssigned } = await import('../hooks/pre-tool-use.mjs');
  assert.equal(expandAssigned('T=/r/x; cd $T && cat > ${T}/a'), 'T=/r/x; cd /r/x && cat > /r/x/a');
  assert.equal(expandAssigned('D=$(mktemp -d); cd $D'), 'D=$(mktemp -d); cd $D', 'substitution stays');
  assert.deepEqual(bashTargets(`T=/r/tool; mkdir -p $T && cd $T && cat > gen.mjs <<'EOF'\nx\nEOF`, '/w'), ['/r/tool/gen.mjs']);
});

test('P-030: a recurring task runs a script: schedule_task / recurring CronCreate without a script in the prompt are denied', () => {
  const fx = setup();
  try {
    const d = (tool, input) => decision(fx.hook('pre-tool-use.mjs', { tool_name: tool, tool_input: input }));
    assert.equal(d('mcp__t3-code__schedule_task', { prompt: 'Read scratch/ai-news/brief.md and fetch the sources', schedule: { type: 'fixed_time', timeOfDay: '06:00' } }), 'deny');
    assert.equal(d('mcp__t3-code__schedule_task', { prompt: 'Run node /h/.claude/skills/ai-news/collect.mjs and evaluate its output', schedule: { type: 'fixed_time', timeOfDay: '06:00' } }), null);
    assert.equal(d('mcp__t3-code__schedule_task', { scheduledTaskId: 'x', schedule: { type: 'fixed_time', timeOfDay: '07:00' } }), null, 'changing the time only');
    assert.equal(d('CronCreate', { cron: '7 6 * * *', prompt: 'check the news' }), 'deny');
    assert.equal(d('CronCreate', { cron: '30 14 3 11 *', prompt: 'remind me', recurring: false }), null, 'one-shot reminder');
  } finally { fx.cleanup(); }
});
