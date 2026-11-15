// keep: core
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
    assert.equal(decision(r), 'deny', 'content changed by someone else after the thread is not the thread\'s');
    r = fx.hook('pre-tool-use.mjs', restore, { env: { WORKFLOW_THREAD_ID: 'b2' } });
    assert.equal(decision(r), 'deny', 'another thread does not inherit the edit');
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
    assert.equal(decision(r), 'deny');
  } finally { fx.cleanup(); }
});
