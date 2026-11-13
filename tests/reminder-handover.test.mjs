// Operator 2026-11-11: a reminder is a T3 timer (schedule_task), not text in the handover or memory. The re-auth reminder
// ("budík ~13:41Z") lived only in the handover text and was closed instead of moved before the new expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { reminderStep } from '../scripts/waker.mjs';

test('reminderStep: a reminder word, a clock time, a date with a preposition, hours ahead, tomorrow; not versions or incident dates', () => {
  assert.equal(reminderStep('budík ~13:41Z: over re-auth'), 'budík');
  assert.equal(reminderStep('over login do 12.11.'), 'do 12.11.');
  assert.equal(reminderStep('obnov prihlásenie o 28 h'), 'o 28 h');
  assert.equal(reminderStep('skontroluj to o 14:30'), 'o 14:30');
  assert.equal(reminderStep('zajtra vydaj'), 'zajtra');
  assert.equal(reminderStep('pilot-sync, pilot, release v0.9.58'), null);
  assert.equal(reminderStep('Bob 2026-11-11 skončil hotovo; oprav bypass.mjs:218'), null);
  assert.equal(reminderStep('o 30 min skontroluj výsledok pracovníka'), null, 'minutes are the thread timer, not a reminder');
});

test('save handover: a reminder step without an armed schedule is refused; schedule_task arms it', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'r1', '--subject', 'Login', '--class', 'discussion']).status, 0);
    const save = () => fx.run('save.mjs', ['handover', 'r1', '--task', 'T', '--done', 'x', '--next', 'pripomeň re-auth claude CLI pred expiráciou']);
    const r = save();
    assert.notEqual(r.status, 0);
    assert.match(r.out, /reminder is a T3 timer.*schedule_task/s);
    assert.ok(!fx.exists('topics/r1/handover.md') || !/pripomeň/.test(fx.read('topics/r1/handover.md')), 'nothing saved');
    fx.hook('post-tool-use.mjs', { hook_event_name: 'PostToolUse', tool_name: 'mcp__t3-code__schedule_task', tool_input: { prompt: 'over re-auth' }, tool_response: '{"scheduledTaskId":"st1"}' });
    assert.equal(save().status, 0, 'the armed schedule lets it pass');
    fx.hook('post-tool-use.mjs', { hook_event_name: 'PostToolUse', tool_name: 'mcp__t3-code__delete_scheduled_task', tool_input: { scheduledTaskId: 'st1' }, tool_response: '{}' });
    assert.notEqual(save().status, 0, 'a deleted schedule is no reminder: move it, do not close it');
    assert.equal(fx.run('save.mjs', ['handover', 'r1', '--task', 'T', '--done', 'x', '--next', 'pilot-sync a vydanie']).status, 0);
  } finally { fx.cleanup(); }
});
