// keep: guarded
// An agent does not change its own rights (operator 2026-11-22: with the home folder in domain.allow_outside an agent
// could rewrite its own policy.json through brain.mjs write, and one removed the entry itself and cut its own access).
// The guards: the brain writer refuses a change of the rights sections of the policy without the operator's yes in a
// dialog of this turn (both directions, measured against HEAD), and the hook keeps the brain and the marker of another
// domain and the machine files of the workflow closed where allow_outside would open them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('rights: brain.mjs write changes domain.allow_outside only after the operator\'s yes; allow_outside never opens another brain, a domain marker or the machine files', () => {
  const fx = setup();
  const home = fs.mkdtempSync(path.join(path.dirname(fx.root), 'wf-home-'));
  try {
    const pol = path.join(fx.brain, 'policy.json');
    const base = { ...JSON.parse(fs.readFileSync(pol, 'utf8')), domain: { allow_outside: ['~/'] } };
    fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
    fs.writeFileSync(pol, `${JSON.stringify(base, null, 2)}\n`);
    fx.git(fx.brain, 'add', '-A');
    fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'policy for test');
    fx.hook('user-prompt-submit.mjs', { prompt: 'uprav server' });
    assert.equal(fx.run('topic.mjs', ['create', 'server', '--subject', 'Server', '--class', 'ops']).status, 0);
    const head = () => JSON.parse(fx.git(fx.brain, 'show', 'HEAD:policy.json'));
    const write = (policy) => fx.run('brain.mjs', ['write', 'policy.json', '--message', 'policy', '--content', `${JSON.stringify(policy, null, 2)}\n`]);
    const more = { ...base, domain: { allow_outside: ['~/', 'sudo'] } };
    const less = { ...base, domain: { allow_outside: [] } };

    // Both directions are refused, also when the file on disk already holds the change (a hand edit hides nothing).
    for (const next of [more, less]) {
      const r = write(next);
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stdout + r.stderr, /domain\.allow_outside sets what the agent may do/);
    }
    fs.writeFileSync(pol, `${JSON.stringify(more, null, 2)}\n`);
    assert.notEqual(write(more).status, 0, 'a change already on disk is still a change against HEAD');
    fx.git(fx.brain, 'checkout', '--', 'policy.json');
    assert.deepEqual(head().domain, { allow_outside: ['~/'] });

    // A key that is no right is written as before.
    const other = write({ ...base, limits: { ...(base.limits || {}), rules_lines: 150 } });
    assert.equal(other.status, 0, other.stdout + other.stderr);

    // A refusing answer opens nothing; a yes to the dialog that names the key and the entry does.
    const now = { ...head() };
    const next = { ...now, domain: { allow_outside: ['~/', 'sudo'] } };
    const q = 'Zmeniť práva agenta v policy: domain.allow_outside pridať „sudo“?';
    const answer = (a) => fx.hook('post-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q, header: 'Práva', options: [{ label: 'Zmeniť' }, { label: 'Nie, nemeniť' }] }] }, tool_response: { answers: { [q]: a } } });
    answer('Nie, nemeniť');
    assert.notEqual(write(next).status, 0);
    answer('Zmeniť');
    const yes = write(next);
    assert.equal(yes.status, 0, yes.stdout + yes.stderr);
    assert.deepEqual(head().domain, { allow_outside: ['~/', 'sudo'] });

    // The hook: the home folder is allowed, the files that set rights stay closed, other files of the server are open.
    const otherBrain = path.join(home, 'agentic', 'Other', 'brain');
    fs.mkdirSync(path.join(otherBrain, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'agentic-flow'), { recursive: true });
    fs.writeFileSync(path.join(home, 'agentic', 'Other', '.agentic-domain'), '{"brain":"brain"}');
    for (const [file, text] of [[path.join(otherBrain, 'policy.json'), '{}\n'], [path.join(home, '.config', 'agentic-flow', 'pin.json'), '{}\n'], [path.join(home, '.bashrc'), 'export A=1\n']]) fs.writeFileSync(file, text);
    let n = 0;
    const edit = (file) => fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'A=1', new_string: 'A=2' }, cwd: fx.project, tool_use_id: `e${++n}` }, { env: { HOME: home } }).json?.hookSpecificOutput || {};
    for (const file of [path.join(otherBrain, 'policy.json'), path.join(home, 'agentic', 'Other', '.agentic-domain'), path.join(home, '.config', 'agentic-flow', 'pin.json')]) {
      const out = edit(file);
      assert.equal(out.permissionDecision, 'deny', file);
      assert.match(out.permissionDecisionReason, /domain\.allow_outside does not open it/);
    }
    const shell = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `sed -i 's/a/b/' ${path.join(otherBrain, 'memory', 'x.md')}` }, cwd: fx.project, tool_use_id: 's1' }, { env: { HOME: home } }).json?.hookSpecificOutput || {};
    assert.equal(shell.permissionDecision, 'deny');
    const open = edit(path.join(home, '.bashrc'));
    assert.notEqual(open.permissionDecision, 'deny', `a file of the server that sets no rights stays open: ${open.permissionDecisionReason}`);
  } finally {
    fx.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
