// D-0042 (operator 2026-11-14): the workflow hook never holds the thread with a confirmation window. A step that needs the
// operator's consent (P-018: data git cannot restore) is refused with its reason and the way; leftovers of workflow tests
// (a wf-test-* fixture dir, an orphaned git worktree) are removed without consent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NO_ASK_WAY, testLeftover } from '../hooks/pre-tool-use.mjs';

const bash = (fx, command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command }, cwd: fx.project }).json?.hookSpecificOutput || {};

test('D-0042: rm of a target git cannot restore is a deny with the reason and the way, never an ask', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const data = path.join(fx.project, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'export.csv'), 'x\n');
    const out = bash(fx, `rm -rf ${data}`);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /targets not recoverable from git: .*data.*\(P-018\)\. this step needs the operator's consent/);
    assert.ok(out.permissionDecisionReason.endsWith(NO_ASK_WAY), out.permissionDecisionReason);
    assert.ok(fs.existsSync(data), 'the data stays');
    // the deny locks nothing: a later call on the same path is checked by P-018 again, not refused as a bypass (P-054)
    assert.doesNotMatch(bash(fx, `rm -rf ${data}`).permissionDecisionReason || '', /P-054/);
  } finally { fx.cleanup(); }
});

test('D-0042: the operator\'s yes in a dialog naming the target lets the same call pass once; "Nie" keeps it refused', () => {
  for (const [answer, expected] of [['Áno, zmaž', 'allow'], ['Nie', 'deny']]) {
    const fx = setup();
    try {
      fx.hook('user-prompt-submit.mjs', { prompt: 'uprac' });
      const data = path.join(fx.project, 'data');
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, 'export.csv'), 'x\n');
      assert.equal(bash(fx, `rm -rf ${data}`).permissionDecision, 'deny');
      const question = 'Mám zmazať priečinok data (nesledovaný gitom)?';
      fx.hook('post-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, options: [{ label: 'Áno, zmaž' }, { label: 'Nie' }] }] }, tool_response: { answers: { [question]: answer } } });
      const out = bash(fx, `rm -rf ${data}`);
      assert.equal(out.permissionDecision, expected, `${answer}: ${out.permissionDecisionReason}`);
      if (expected === 'allow') assert.equal(bash(fx, `rm -rf ${data}`).permissionDecision, 'deny', 'once');
    } finally { fx.cleanup(); }
  }
});

test('D-0042: a subagent gets the deny too and no consent path', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.project, 'notes.txt'), 'x\n');
    const out = fx.hook('pre-tool-use.mjs', { agent_id: 'sub-1', tool_name: 'Bash', tool_input: { command: `rm ${path.join(fx.project, 'notes.txt')}` }, cwd: fx.project }).json?.hookSpecificOutput || {};
    assert.equal(out.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('D-0042: an orphaned git worktree and a wf-test-* fixture dir are leftovers of a test: rm passes', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const orphan = path.join(fx.project, 'wt', 'feat');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${path.join(fx.root, 'gone', '.git', 'worktrees', 'feat')}\n`);
    fs.writeFileSync(path.join(orphan, 'a.txt'), 'x\n');
    const fixture = path.join(fx.project, 'tmp', 'wf-test-EmBRx5');
    fs.mkdirSync(fixture, { recursive: true });
    for (const f of 'abcdefg') fs.writeFileSync(path.join(fixture, f), 'x\n');
    assert.equal(testLeftover(orphan), true);
    assert.equal(testLeftover(fixture), true);
    assert.notEqual(bash(fx, `rm -rf ${orphan}`).permissionDecision, 'deny');
    assert.notEqual(bash(fx, `rm -rf ${fixture}`).permissionDecision, 'deny');
    // a live worktree (its gitdir exists) and a file inside a leftover are no leftovers
    const live = path.join(fx.project, 'wt', 'live');
    fs.mkdirSync(path.join(fx.root, 'there'), { recursive: true });
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, '.git'), `gitdir: ${path.join(fx.root, 'there')}\n`);
    fs.writeFileSync(path.join(live, 'b.txt'), 'x\n');
    assert.equal(testLeftover(live), false);
    assert.equal(bash(fx, `rm -rf ${live}`).permissionDecision, 'deny');
    assert.equal(bash(fx, `rm ${path.join(orphan, 'a.txt')}`).permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});
