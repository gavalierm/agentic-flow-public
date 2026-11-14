// report-143e7cdb: one topic removed its scratch/ work dir with rm -rf while another topic had put its drafts into the
// same dir; scratch/ files are disposable only for the thread that wrote them (P-018).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || null;

test('rm -rf of a scratch dir holding files another thread wrote asks; the thread\'s own files go without asking', () => {
  const fx = setup();
  try {
    const dir = path.join(fx.project, 'scratch', 'skill-drafts');
    fs.mkdirSync(dir, { recursive: true });
    const mine = path.join(dir, 'mine.md');
    const theirs = path.join(dir, 'theirs.sh');
    const write = (file, thread) => {
      const input = { tool_name: 'Write', tool_input: { file_path: file, content: 'x\n' } };
      const env = { ...fx.env, WORKFLOW_THREAD_ID: thread };
      fx.hook('pre-tool-use.mjs', input, { env });
      fs.writeFileSync(file, 'x\n');
      fx.hook('post-tool-use.mjs', input, { env });
    };
    write(mine, fx.thread);
    write(theirs, 'other-thread');
    const rm = (command) => decision(fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command } }));
    assert.equal(rm(`rm -rf ${dir}`), 'deny', 'the dir holds a draft of another thread');
    assert.equal(rm(`rm -f ${theirs}`), 'deny', 'another thread\'s scratch file');
    assert.equal(rm(`rm -f ${mine}`), null, 'own scratch file is removed without asking');
    fs.rmSync(theirs);
    assert.equal(rm(`rm -rf ${dir}`), null, 'once the other thread\'s file is gone the dir is disposable again');
  } finally { fx.cleanup(); }
});
