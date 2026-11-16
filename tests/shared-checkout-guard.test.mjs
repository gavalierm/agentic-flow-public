// keep: core
// D-0038: topic work writes only in the topic's worktree; the shared checkout of a code repo (its branch collects
// done --topic merges and releases) is denied to Write, Edit, shell writes and direct git changes of a thread.
// done --topic settles the own thread only when it holds no other open topic, and names the previous holder's thread
// after a takeover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision;
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';

function domainFx({ worktrees = true } = {}) {
  const fx = setup();
  fs.writeFileSync(path.join(fx.root, '.agentic-domain'), '{"brain":"brain"}');
  if (worktrees) {
    fs.mkdirSync(path.join(fx.root, '.worktrees', 'project'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { shared_checkouts: ['project'] } }));
  }
  fs.writeFileSync(path.join(fx.project, 'tracked.txt'), 'a\n');
  return fx;
}

test('shared checkout: Write, Edit, shell writes and git changes are denied with the way to a new code topic', () => {
  const fx = domainFx();
  try {
    const file = path.join(fx.project, 'tracked.txt');
    const calls = [
      { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'new.txt'), content: 'x' } },
      { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } },
      { tool_name: 'Bash', tool_input: { command: 'echo x > new.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ tracked.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'cp tracked.txt copy.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'mv tracked.txt moved.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'rm tracked.txt' } },
      { tool_name: 'Bash', tool_input: { command: 'git commit -qm x' } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} merge topic/x` } },
      { tool_name: 'Bash', tool_input: { command: `cd ${fx.project} && git checkout -b y` } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} reset --soft HEAD~1` } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} rebase main` } },
      { tool_name: 'Bash', tool_input: { command: `git -C ${fx.project} stash` } },
    ];
    // One thread per call: a target refused earlier in a turn stays closed with another reason (P-054).
    for (const [i, call] of calls.entries()) {
      const r = fx.hook('pre-tool-use.mjs', { ...call, session_id: `s-${i}` }, { env: { WORKFLOW_THREAD_ID: `t${i}` }, cwd: call.tool_name === 'Bash' && /^git -C/.test(call.tool_input.command) ? fx.root : fx.project });
      assert.equal(decision(r), 'deny', `${call.tool_name} ${JSON.stringify(call.tool_input)}: ${r.stderr}`);
      assert.match(reason(r), /shared checkout .*D-0038/);
      assert.match(reason(r), /topic\.mjs create <id> --class code --project project --task "\.\.\."/);
    }
  } finally { fx.cleanup(); }
});
