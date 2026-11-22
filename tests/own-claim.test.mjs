// keep: guarded
// A file becomes the thread's own only when the call that claimed it has run (audit 2026-11-22: the claim of a call that
// never ran was settled by a later call, and somebody else's uncommitted work was then rewritten without consent, P-018).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || 'allow';

test('own files: claimed before the call, own after it; a call that never ran gives nothing', () => {
  const fx = setup({ thread: 'a1' });
  try {
    const app = path.join(fx.project, 'src', 'app.js');
    const made = path.join(fx.project, 'src', 'made.txt');
    const never = path.join(fx.project, 'src', 'never.txt');
    const call = (tool_use_id, file, write) => {
      const input = { tool_name: 'Write', tool_use_id, tool_input: { file_path: file, content: write } };
      const pre = fx.hook('pre-tool-use.mjs', input);
      if (write !== null) { fs.writeFileSync(file, write); fx.hook('post-tool-use.mjs', { ...input, tool_response: { filePath: file } }); }
      return decision(pre);
    };
    // the call ran: the new file and the changed tracked file are the thread's own (a second whole rewrite passes)
    assert.equal(call('t1', made, 'one\n'), 'allow');
    assert.equal(call('t2', made, 'two\n'), 'allow');
    const edit = { tool_name: 'Edit', tool_use_id: 't3', tool_input: { file_path: app, old_string: 'a', new_string: 'b' } };
    fx.hook('pre-tool-use.mjs', edit);
    fs.appendFileSync(app, '// the thread\n');
    fx.hook('post-tool-use.mjs', { ...edit, tool_response: { filePath: app } });
    assert.equal(call('t4', app, 'whole rewrite of its own edit\n'), 'allow');
    // a call that was claimed and never ran, then somebody else's work in those files
    fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_use_id: 't5', tool_input: { file_path: never, content: 'x' } });
    fx.hook('pre-tool-use.mjs', { ...edit, tool_use_id: 't6' });
    assert.equal(call('t7', app, null), 'allow', 'unchanged since the claim: still the thread\'s own');
    fs.writeFileSync(never, 'work of the operator\n');
    fs.appendFileSync(app, '// work of the operator\n');
    const small = { tool_name: 'Edit', tool_use_id: 't8', tool_input: { file_path: app, old_string: 'b', new_string: 'c' } };
    fx.hook('pre-tool-use.mjs', small);
    fx.hook('post-tool-use.mjs', { ...small, tool_response: { filePath: app } });
    assert.equal(call('t9', never, null), 'deny');
    assert.equal(call('t10', app, null), 'deny');
  } finally { fx.cleanup(); }
});
