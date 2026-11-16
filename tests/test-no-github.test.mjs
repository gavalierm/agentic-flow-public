// ttl: 2026-12-15
// agentic-flow-public#97: a test whose mail failed made error.mjs report fall back to a real GitHub issue with the
// machine token. The test env has no GitHub access: no token file, no gh, an unreachable API; a report then ends a draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('test env has no GitHub access, a report with failed mail is not an issue', () => {
  const fx = setup();
  // Checked before any run: on a test env with GitHub access the report below would file a real issue.
  for (const k of ['WORKFLOW_GITHUB_TOKEN_FILE', 'WORKFLOW_GH_CLI']) {
    assert.ok(fx.env[k], `${k} set in the test env`);
    assert.ok(!fs.existsSync(fx.env[k]), `${k} does not exist`);
  }
  assert.match(fx.env.WORKFLOW_GITHUB_API || '', /^http:\/\/127\.0\.0\.1:/);
  const client = path.join(fx.root, 'failing-client.cjs');
  fs.writeFileSync(client, "process.stderr.write('mail down\\n'); process.exit(1);\n");
  const r = fx.run('error.mjs', ['report', '--title', 'test report', '--text', 'chyba: test'], { env: { WORKFLOW_COMMS_CLIENT: client } });
  assert.doesNotMatch(r.out, /reported: issue|github\.com\/\S+\/issues\/\d+/, r.out);
  assert.match(r.out, /NOT reported: mail mail down\. task for the operator \(Úlohy pre operátora\)/, r.out);
});
