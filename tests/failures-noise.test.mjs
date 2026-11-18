// ttl: 2027-05-18
// Operator 2026-11-18: what the flow settles safely it settles itself. Old failures without a lesson are dropped by code;
// a failure that may hold a lesson is never dropped (it stays for the thread's own triage, not a question to the operator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noiseFailure } from '../scripts/logs.mjs';
import { curlNullWrite } from '../hooks/post-tool-use.mjs';

const L = (what, err) => `2026-11-01T10:00:00.000Z a1 s1 ${what} :: ${err}`;

test('noiseFailure: external site, worker result without a failure, one-off work-file script, grep without a match', () => {
  assert.ok(noiseFailure(L('WebFetch', 'getaddrinfo ENOTFOUND www.example.com')));
  assert.ok(noiseFailure(L('worker-result', 'žiadne zdroje nezlyhali.')));
  assert.ok(noiseFailure(L('worker-result', '- example.com vrátilo 404 (WebFetch). Záver je z predajcov.')));
  assert.ok(noiseFailure(L('cd /x/topics/t/tmp && node -e " const a=1"', 'Exit code 1')));
  assert.ok(noiseFailure(L('cd /x/skills/s && grep -rn "TYPES" lib.mjs', 'Exit code 1')));
  assert.ok(noiseFailure(L('curl -s -o /dev/null -w "%{http_code}" https://x', 'Exit code 23')));
  // a possible lesson stays
  assert.ok(!noiseFailure(L('worker-result', 'Foreground sleep zablokoval hook (P-061), použil som nohup.')));
  assert.ok(!noiseFailure(L('worker-result', 'publish-batch.mjs prekročil 64 KB')));
  assert.ok(!noiseFailure(L('cd /x/skills/s && grep -rn "TYPES" lib.mjs', 'Exit code 2')));
  assert.ok(!noiseFailure(L('git commit -q -m x', 'Exit code 1')));
});

test('curl -o /dev/null exiting 23 (Windows Git Bash) is no failure; another curl exit is', () => {
  assert.ok(curlNullWrite('curl -s -o /dev/null -w "%{http_code}" https://x', 'Exit code 23\n200'));
  assert.ok(!curlNullWrite('curl -s -o out.html https://x', 'Exit code 23'));
  assert.ok(!curlNullWrite('curl -s -o /dev/null https://x', 'Exit code 6'));
});
