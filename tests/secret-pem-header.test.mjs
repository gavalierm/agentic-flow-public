// report-123b3205 (2026-11-13): a command that checks a key file's format (private_key starts with the PEM header) and
// writes only the key file's path to scratch/ was denied as a secret (token): the PEM header alone matched. The refusal
// then locked local/, the very place it names for secrets, for the rest of the turn (P-054).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { findSecret } from '../scripts/secrets.mjs';

const HEADER = '-----BEGIN ' + 'PRIVATE KEY-----';
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision || null;

test('findSecret: a PEM header without a key body is no secret; a key with its body is', () => {
  assert.equal(findSecret(`print(pk.startswith("${HEADER}"))`), null);
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'BKcwggSjAgEAAoIBAQC7'.repeat(3);
  assert.equal(findSecret(`${HEADER}\n${body}\n`), 'token');
  assert.equal(findSecret(`{"private_key": "${HEADER}\\n${body}\\n"}`), 'token', 'JSON-escaped newline');
});

test('a format check naming the PEM header passes; a secret refusal does not lock local/', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, 'local', 'tool'), { recursive: true });
    const check = `python3 -I - /x/key.json <<'EOF'\nimport json,sys\nd=json.load(open(sys.argv[1]))\nprint(d.get("private_key","").startswith("${HEADER}"))\nEOF\nprintf '%s' "$PWD/local/tool/key.json" > scratch/key-path.txt`;
    let r = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: check } });
    assert.notEqual(decision(r), 'deny', r.out);
    const token = 'ghp_' + 'A1b2'.repeat(9);
    r = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${token} > local/tool/t.txt; echo ${token} > scratch/t.txt` } });
    assert.equal(decision(r), 'deny', r.out);
    r = fx.hook('pre-tool-use.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'local', 'tool', 't.txt'), content: `${token}\n` } });
    assert.doesNotMatch(JSON.stringify(r.json || {}), /P-054/, 'local/ is the way the refusal names, not a bypass');
  } finally { fx.cleanup(); }
});
