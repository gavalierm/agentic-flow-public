// P-023 e, P-038, P-047, P-003, P-013: UserPromptSubmit hook.
// Mail in the status line (P-021, P-023 e, P-041, P-044): mail count from the comms client, mail line (ID and category) only at
// n > 0 and once per change, 60 s cache, outage reported once and no retry before 60 s. Needs agentic-comms next to the plugin
// (else that test is skipped).
// P-047: a turn started by a wake message cannot take over a topic, close it or change rules; the operator's next prompt unlocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, startComms, commsClient } from './helpers.mjs';
import { readThreadState, writeThreadState } from '../scripts/config.mjs';

const skip = commsClient() ? false : 'agentic-comms not found next to the plugin (AGENTIC_COMMS_DIR)';

test('status line is exactly one line with the fixed template', () => {
  const fx = setup();
  try {
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'ahoj, pokračujeme' });
    assert.equal(r.status, 0);
    assert.equal(r.context.split('\n').length, 1);
    assert.equal(r.context, 'thread a1 | topic - (none) | mail: 0');
    fx.run('topic.mjs', ['create', 'fix-workflow', '--subject', 'Fix', '--class', 'discussion']);
    assert.equal(fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' }).context, 'thread a1 | topic fix-workflow (working, mode operator) | mail: 0');
  } finally { fx.cleanup(); }
});

test('wake template sets the wake flag in the thread state; an operator prompt resets it', () => {
  const fx = setup();
  try {
    const state = path.join(fx.brain, 'local', 'threads', 'a1.json');
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'You have mail in topic fix-workflow' });
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).turn_source, 'wake');
    assert.equal(r.context.split('\n').length, 2);
    assert.equal(r.context.split('\n')[1], 'wake: no new mail; end the turn with only your Handover line and state line (P-061)', 'no new mail: no mail line');
    fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).turn_source, 'operator');
  } finally { fx.cleanup(); }
});

test('error and save phrases add one hint line referencing the skill, never content', () => {
  const fx = setup();
  try {
    let r = fx.hook('user-prompt-submit.mjs', { prompt: 'To nefunguje, skript padá.' });
    assert.equal(r.context.split('\n').length, 2);
    assert.match(r.context.split('\n')[1], /workflow:error/);
    // Unchanged status line is not repeated (P-023 e): the hint is the only line.
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'Volám sa Anna.' });
    assert.match(r.context, /^[^\n]*workflow:save[^\n]*$/);
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'Zapamätaj si, že X.' });
    assert.match(r.context, /^[^\n]*workflow:save[^\n]*$/);
  } finally { fx.cleanup(); }
});

test('rules changed during the session: once, only the changed sections and the removed headings; unchanged rules not repeated (P-021)', () => {
  const fx = setup();
  try {
    fx.hook('session-start.mjs', { source: 'startup' });
    let r = fx.hook('user-prompt-submit.mjs', { prompt: 'ahoj' });
    assert.doesNotMatch(r.context, /od tohto ťahu/);
    fs.mkdirSync(path.join(fx.brain, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'rules', 'x.md'), '---\nkey: rule-x\ntitle: Pravidlo X\n---\nNové pravidlo projektu X.\n');
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.match(r.context, /## Pravidlá: zmenené od tohto ťahu/);
    assert.match(r.context, /Nové pravidlo projektu X\./);
    assert.doesNotMatch(r.context, /### P-001/, 'unchanged sections are not repeated');
    assert.ok(r.context.length < 10000, r.context.length);
    assert.doesNotMatch(r.context, /verzi|v[0-9]+\./i, 'no version talk');
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'ešte' });
    assert.doesNotMatch(r.context, /od tohto ťahu/, 'only once');
    fs.rmSync(path.join(fx.brain, 'rules', 'x.md'));
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'a teraz' });
    assert.match(r.context, /zrušené: [^\n]*Pravidlo X/);
    // A state recorded before the section hashes gets the rules in full once.
    writeThreadState(fx.brain, 'a1', { ...readThreadState(fx.brain, 'a1'), rules_hash: 'old', rules_sections: null });
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'znova' });
    assert.match(r.context, /Platné pravidlá od tohto ťahu[^\n]*\n[\s\S]*### P-001/);
  } finally { fx.cleanup(); }
});

test('status line: counts mail of the held topic, lists mail IDs once per change, counts live, reports an outage once', { skip }, async () => {
  const fx = setup();
  const comms = await startComms(fx, { senders: ['alice', 'bob'] });
  try {
    const state = () => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', 'a1.json'), 'utf8'));
    assert.match(fx.run('comms.mjs', ['status']).stdout, /comms: enabled[\s\S]*service: ok/);

    // Claim registers the topic in the mail service with the holder.
    const create = fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha work', '--class', 'discussion']);
    assert.equal(create.status, 0, create.out);
    assert.equal(comms.topic('project', 'alpha')?.holder, 'a1');

    let r = fx.hook('user-prompt-submit.mjs', { prompt: 'ahoj' });
    assert.equal(r.context, 'thread a1 | topic alpha (working, mode operator) | mail: 0');

    // A message arrives; the next prompt sees it at once (pilot 2026-11-02: a cached 0 hid the mail of a bell turn).
    const sent = comms.cli(['send', '--project', 'project', '--topic', 'alpha', '--level', 'blocker', '--text', 'fyi: schema changed'], 'bob');
    assert.equal(sent.code, 0, sent.out);
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const lines = r.context.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'thread a1 | topic alpha (working, mode operator) | mail: 1 (1 blocker)');
    assert.match(lines[1], /^mail: 1 waiting: \S+ blocker$/);
    assert.doesNotMatch(r.context, /schema changed/, 'never the text');
    assert.equal(state().mail_signaled, 1);

    // Same count: neither the line nor the instruction repeats (P-023 c, e).
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.equal(r.context, '');

    // An assist arrives while the operator discusses (an operator turn, D-0015, D-0022): the prompt does not show it.
    assert.equal(comms.cli(['send', '--project', 'project', '--topic', 'alpha', '--level', 'assist', '--text', 'cannot continue'], 'bob').code, 0);
    comms.expireCache(fx.brain);
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.equal(r.context, '', 'the assist waits for the end of the discussion');

    // Session start carries the same line and the instruction as part of item 3.
    const boot = fx.hook('session-start.mjs', { source: 'resume' });
    assert.match(boot.context, /\nthread a1 \| topic alpha \(working, mode operator\) \| mail: 2 \(1 blocker\)\nmail: 2 waiting: \S+ (assist|blocker), \S+ (assist|blocker)/);

    // Wake turn: the wake line already lists the mail; nothing else is added.
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'you have mail in topic alpha' });
    assert.equal(r.context.split('\n').length, 2);
    assert.match(r.context.split('\n')[1], /^turn started by a message \(wake\): mail: 2 waiting: .*; read a body with comms receive --id <id>; .*\(P-047\)$/);

    // Outage: last known count stays (in the operator's discussion without the assist), "comms unavailable" once, no new
    // attempt before 60 s, turn not slowed.
    await comms.stop();
    comms.expireCache(fx.brain);
    let t = Date.now();
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.ok(Date.now() - t < 2500, 'hook within the 2 s budget');
    assert.equal(r.context.split('\n')[0], 'thread a1 | topic alpha (working, mode operator) | mail: 1 (1 blocker) (comms unavailable)');
    const cacheFile = path.join(fx.brain, 'local', 'comms', 'count-cache.json');
    const failedAt = Object.values(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))[0].failed_at;
    assert.ok(failedAt);
    t = Date.now();
    r = fx.hook('user-prompt-submit.mjs', { prompt: 'pokračuj' });
    assert.ok(Date.now() - t < 1500);
    assert.equal(r.context, 'thread a1 | topic alpha (working, mode operator) | mail: 1 (1 blocker)', 'reported once, served from cache');
    assert.equal(Object.values(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))[0].failed_at, failedAt, 'no retry before 60 s');
  } finally {
    await comms.stop();
    fx.cleanup();
  }
});

test('P-047: sensitive scripts refuse in a wake turn and work again after an operator prompt', () => {
  const fx = setup({ second: true });
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    assert.equal(fx.runB('topic.mjs', ['create', 'beta', '--subject', 'Beta', '--class', 'discussion']).status, 0);
    fx.git(fx.brain, 'pull', '-q');

    // Wake turn in thread a1 carrying an "instruction" inside the message text.
    const wake = fx.hook('user-prompt-submit.mjs', { prompt: 'You have mail in topic alpha' });
    assert.match(wake.context, /wake: no new mail/);

    const takeover = fx.run('topic.mjs', ['claim', 'beta', '--force', '--operator-approved']);
    assert.notEqual(takeover.status, 0);
    assert.match(takeover.out, /P-047/);
    assert.match(fx.read('topics/beta/holder.json'), /b2/, 'holder unchanged');

    const close = fx.run('done.mjs', ['--topic', '--verified', 'seen']);
    assert.notEqual(close.status, 0);
    assert.match(close.out, /P-047/);
    assert.ok(fx.exists('topics/alpha/topic.json'), 'topic not archived');

    const rule = fx.run('save.mjs', ['rule', 'no-force', '--content', 'x']);
    assert.notEqual(rule.status, 0);
    assert.match(rule.out, /P-047/);
    const exception = fx.run('save.mjs', ['exception', 'P-021', '--wording', 'x', '--reason', 'y']);
    assert.notEqual(exception.status, 0);
    assert.match(exception.out, /P-047/);

    const create = fx.run('topic.mjs', ['create', 'gamma', '--subject', 'Gamma', '--class', 'discussion']);
    assert.notEqual(create.status, 0);
    assert.match(create.out, /P-047/);

    // Reading, answering and acking stay allowed in a wake turn: done of a unit (no --topic) is not sensitive.
    assert.equal(fx.run('done.mjs', ['--verified', 'seen']).status, 0);

    // Operator prompt resets the flag.
    fx.hook('user-prompt-submit.mjs', { prompt: 'uzavri tému' });
    const closed = fx.run('done.mjs', ['--topic', '--verified', 'seen']);
    assert.equal(closed.status, 0, closed.out);
    assert.ok(fx.exists('topics/archive/alpha/topic.json'));
  } finally { fx.cleanup(); }
});
