// keep: core
// P-023: every registered hook declares its output class and limit (HOOK_META) and exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT } from './helpers.mjs';

test('hooks.json handlers exist and export HOOK_META with class and limit', async () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const events = Object.keys(hooks.hooks);
  for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']) assert.ok(events.includes(e), e);
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    for (const g of groups) for (const h of g.hooks) {
      const rel = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
      const file = path.join(PLUGIN_ROOT, rel);
      assert.ok(fs.existsSync(file), `${event}: ${rel} exists`);
      const mod = await import(pathToFileURL(file).href);
      assert.ok(mod.HOOK_META, `${rel}: HOOK_META`);
      assert.ok(mod.HOOK_META.class, `${rel}: class`);
      assert.ok(mod.HOOK_META.limit, `${rel}: limit`);
      assert.ok(mod.HOOK_META.event.includes(event), `${rel}: event ${event}`);
      assert.ok(typeof h.timeout === 'number', `${event}: timeout declared`);
    }
  }
});
