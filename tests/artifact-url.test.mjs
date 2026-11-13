// report-80357d47: after a compaction a publish of the same file without url made a new artifact address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { artifactsDir } from '../scripts/artifacts.mjs';

const ADDR = 'https://claude.ai/code/artifact/0a1b2c3d-report';

test('a published artifact path is recorded; a later publish without url is refused, with url passes; compact start lists it', () => {
  const fx = setup();
  try {
    const page = path.join(fx.project, 'scratch', 'report.html');
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, '<p>x</p>');
    const publish = { tool_name: 'Artifact', tool_input: { file_path: page, icon: 'chart' } };
    let r = fx.hook('pre-tool-use.mjs', publish);
    assert.notEqual(r.json?.hookSpecificOutput?.permissionDecision, 'deny', 'first publish passes');
    r = fx.hook('post-tool-use.mjs', { ...publish, hook_event_name: 'PostToolUse', tool_response: [{ type: 'text', text: `Published: ${ADDR}` }] });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readdirSync(artifactsDir(fx.brain)).length, 'the url is recorded');

    r = fx.hook('pre-tool-use.mjs', publish);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, new RegExp(ADDR));

    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Artifact', tool_input: { file_path: page, url: ADDR } });
    assert.notEqual(r.json?.hookSpecificOutput?.permissionDecision, 'deny', 'publish with url passes');
    r = fx.hook('pre-tool-use.mjs', { tool_name: 'Artifact', tool_input: { action: 'read', url: ADDR } });
    assert.notEqual(r.json?.hookSpecificOutput?.permissionDecision, 'deny', 'read passes');

    r = fx.hook('session-start.mjs', { source: 'compact' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.context, new RegExp(`report\\.html -> ${ADDR}`));
  } finally { fx.cleanup(); }
});

test('the hook matcher sends Artifact calls to pre-tool-use', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  assert.ok(new RegExp(`^(${hooks.hooks.PreToolUse[0].matcher})$`).test('Artifact'));
});
