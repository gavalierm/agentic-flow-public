// ttl: 2026-12-16
// doma-pc 2026-11-16: the first listing of a catalog source is refused once (the reminder says the same command passes
// again), and that refusal locked every path of the call for the turn (P-054), a memory record of the repo too: the
// read-only call counted as a write, because `B="D:/Claude projekty/x"` was split at the space inside its quotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { analyze } from '../scripts/bypass.mjs';

const decision = (r) => r.json.hookSpecificOutput?.permissionDecision || 'allow';
const reason = (r) => r.json.hookSpecificOutput?.permissionDecisionReason || '';

test('a quoted assignment with a space is one shell word: a read-only call stays read-only', () => {
  const c = `cd "D:/Claude projekty/shop/fb"; cat notes.md; B="D:/Claude projekty/shop/brain"; sed -n '1,40p' "$B/memory/a.md" 2>/dev/null`;
  assert.equal(analyze('Bash', { command: c }, '/x').write, false);
  assert.equal(analyze('Bash', { command: 'B="a b" rm -rf x' }, '/x').write, true, 'a program after the assignment still counts');
});

test('the catalog reminder locks nothing: the next read of a record in the same turn passes', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, 'materialy', 'a'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'materialy', 'a', 'x.md'), 'x\n');
    fs.writeFileSync(path.join(fx.project, 'notes.md'), 'n\n');
    const scan = fx.run('catalog.mjs', ['scan']);
    assert.equal(scan.status, 0, scan.stdout + scan.stderr);
    const first = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'cat notes.md; echo ----; ls materialy materialy/*; B="x y"; echo "$B"' } });
    assert.equal(decision(first), 'deny', JSON.stringify(first.json));
    assert.match(reason(first), /^katalóg: pre dáta v materialy najprv/);
    const second = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: 'cat notes.md; B="x y"; echo "$B"' } });
    assert.equal(decision(second), 'allow', reason(second));
  } finally { fx.cleanup(); }
});
