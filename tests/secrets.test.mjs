// keep: core
// Secrets stay in local/ (P-018, P-052): a token, a credential or a private key written anywhere else is denied with the
// local/ route; a placeholder, a format check naming the PEM header and a command that writes no file pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { findSecret } from '../scripts/secrets.mjs';

const HEADER = '-----BEGIN ' + 'PRIVATE KEY-----';
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision || null;
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';

test('findSecret: a key with its body and a token are secrets; a PEM header alone and placeholders are not', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'BKcwggSjAgEAAoIBAQC7'.repeat(3);
  assert.equal(findSecret(`${HEADER}\n${body}\n`), 'token');
  assert.equal(findSecret(`{"private_key": "${HEADER}\\n${body}\\n"}`), 'token', 'JSON-escaped newline');
  assert.equal(findSecret(`print(pk.startswith("${HEADER}"))`), null);
  assert.equal(findSecret('tok' + 'en = "<your-token-here>"\napi' + '_key: "${API_KEY}"\n'), null);
});

test('hook: a secret written outside local/ is denied with the local/ route; local/, placeholders and a command writing no file pass', () => {
  const fx = setup();
  try {
    const token = 'ghp_' + 'A1b2'.repeat(9);
    let r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'scratch', 'notes.md'), content: `use ${token}\n` } });
    assert.equal(decision(r), 'deny');
    assert.match(reason(r), /secret \(token\).*scratch\/notes\.md.*local\//);
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(fx.project, 'README.md'), old_string: 'x', new_string: 'password = "' + 'S3cr3tValue99xx' + '"' } });
    assert.equal(decision(r), 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `echo ${token} > scratch/t.txt` } });
    assert.equal(decision(r), 'deny');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(fx.project, 'local', 'gh.env'), content: `GH_TOKEN=${token}\n` } });
    assert.notEqual(decision(r), 'deny', 'local/ is the place for secrets');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: token ${token}" https://api.github.com/user` } });
    assert.notEqual(decision(r), 'deny', 'a command that writes no file is not stopped');
    fs.mkdirSync(path.join(fx.project, 'local', 'tool'), { recursive: true });
    const check = `python3 -I - /x/key.json <<'EOF'\nimport json,sys\nd=json.load(open(sys.argv[1]))\nprint(d.get("private_key","").startswith("${HEADER}"))\nEOF\nprintf '%s' "$PWD/local/tool/key.json" > scratch/key-path.txt`;
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command: check } });
    assert.notEqual(decision(r), 'deny', 'a format check naming the PEM header');
  } finally { fx.cleanup(); }
});
