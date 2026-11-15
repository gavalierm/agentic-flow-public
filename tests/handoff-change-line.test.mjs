// ttl: 2026-12-15
// agent-alice/D-0082, point 4 (observed 2026-11-15): three minutes after the orchestrator resumed domain-migrate, the
// operator gave Alfa and Beta in domain-migrate's own thread; it wrote decisions and changed its next step while
// the orchestrator kept a stale copy. The giver now sees `handoff <topic>: <what changed> (<time>)` in the status block of
// every prompt and once after a tool, until it saves its handover. No mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const t2 = { env: { WORKFLOW_THREAD_ID: 't2' } };

test('the target changes its next step and writes a decision: the giver sees the handoff line until it saves its handover', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'orch', '--subject', 'Orchestrácia', '--class', 'discussion', '--here']).status, 0);
    assert.equal(fx.run('topic.mjs', ['create', 'domain-migrate', '--subject', 'Migrácia domén', '--class', 'discussion', '--task', 'migrácia domén', '--for-thread', 't2']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'domain-migrate', '--task', 'migrácia domén', '--done', 'Bratislava', '--next', 'ďalšia doména Alfa iba na pokyn operátora'], t2).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'dohľad nad domain-migrate']).status, 0);
    // nothing changed since the giver's save
    let p = fx.hook('user-prompt-submit.mjs', { prompt: 'ako to ide?' });
    assert.doesNotMatch(p.context, /handoff domain-migrate/);
    // the operator gives Alfa and Beta in the target's own thread
    assert.equal(fx.run('save.mjs', ['handover', 'domain-migrate', '--task', 'migrácia domén', '--done', 'Bratislava; Alfa', '--next', 'Beta teraz'], t2).status, 0);
    const d = fx.run('save.mjs', ['decision', 'Alfa presunúť hneď', '--what', 'Alfa ide teraz', '--reason', 'pokyn operátora', '--relates-to', 'src/app.js'], t2);
    assert.equal(d.status, 0, d.out);
    const id = /decision (D-\d{4})/.exec(d.out)[1];
    p = fx.hook('user-prompt-submit.mjs', { prompt: 'ako to ide?' });
    const line = p.context.split('\n').find((l) => l.includes('handoff domain-migrate:'));
    assert.ok(line, p.context);
    assert.match(line, /Ďalší krok/);
    assert.match(line, new RegExp(id));
    assert.match(line, /\(\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+\)/);
    // every prompt until the save
    p = fx.hook('user-prompt-submit.mjs', { prompt: 'a teraz?' });
    assert.match(p.context, /handoff domain-migrate:/);
    // once after a tool
    const tool = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: 'x' };
    let post = fx.hook('post-tool-use.mjs', tool);
    assert.match(post.context, /handoff domain-migrate:/);
    post = fx.hook('post-tool-use.mjs', tool);
    assert.doesNotMatch(post.context, /handoff domain-migrate:/);
    // the giver saves its handover: the section is refreshed, the line goes
    assert.equal(fx.run('save.mjs', ['handover', 'orch', '--task', 'orchestrácia', '--done', 'zadané', '--next', 'dohľad nad domain-migrate']).status, 0);
    assert.match(fx.read('topics/orch/handover.md'), /ďalej: Beta teraz/);
    p = fx.hook('user-prompt-submit.mjs', { prompt: 'a teraz?' });
    assert.doesNotMatch(p.context, /handoff domain-migrate/);
    // closing is a change too
    assert.equal(fx.run('done.mjs', ['--topic', '--topic-id', 'domain-migrate', '--knowledge', 'nic nové', '--verified', 'hotovo'], t2).status, 0);
    p = fx.hook('user-prompt-submit.mjs', { prompt: 'a teraz?' });
    assert.match(p.context, /handoff domain-migrate: .*uzavretá/);
  } finally { fx.cleanup(); }
});
