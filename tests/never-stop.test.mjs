// Work never stops (P-061, operator 2026-11-03/08): "Stav: čakám" ends a turn only with a real waker; the Stop hook
// blocks it once and then arms the timer itself; the timer rings through the closed turn; the question tool is denied;
// the rule texts no longer tell a recipient or a sender to stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from './helpers.mjs';
import { waitingClaim, waitOnlyStep, parseDelay, wakerFromTool, validWaker, recordWaker, setTimer, activeTimer } from '../scripts/waker.mjs';
import { updateNotice } from '../scripts/update-notice.mjs';
import { assembleRules } from '../scripts/rules.mjs';

const stateOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), 'utf8'));

test('waitingClaim (handover steps): Slovak and English waiting claims, with and without diacritics; code and quotes are data', () => {
  for (const t of ['Poslal som blocker, čakám na odpoveď.', 'Cakam na Carol.', 'Počkám, kým to dobehne.', 'Teraz čakáme na build.', 'Vlákno čaká na operátora.', 'Waiting for the reply.', "I'll wait until it finishes.", 'Zostáva len čakanie na teba, takže tu končím.', 'Potrebujem od teba, čo mám urobiť.', 'Bez tvojho pokynu nič z toho nerobím.', 'Ak to nevyriešiš, čakám na teba.'])
    assert.ok(waitingClaim(t), t);
  for (const t of ['Hotové, vydané.', 'Text `čakám` je v kóde.', 'Hook blokuje slovo „čakám“ bez budíka.', 'Čakanie je zakázané.', 'Tieto frázy sa teraz rátajú ako čakanie na teba.', '- Keď krok čaká na neskoršiu udalosť, hook teraz agentovi káže skončiť.', 'If the step waits for an event, the hook ends the turn.', '```\nčakám\n```', '', undefined])
    assert.equal(waitingClaim(t), null, String(t));
});

test('waitOnlyStep, parseDelay, wakerFromTool', () => {
  assert.ok(waitOnlyStep('Čakať na hlásenie témy carol. Potom vydanie.'));
  assert.ok(waitOnlyStep('Operátor rozhodne o presune.'));
  assert.equal(waitOnlyStep('Vydať v0.9.29.'), null);
  assert.equal(parseDelay('30m'), 1_800_000); assert.equal(parseDelay('2h'), 7_200_000); assert.equal(parseDelay('90s'), 90_000); assert.equal(parseDelay('15'), 900_000); assert.equal(parseDelay('soon'), null);
  const now = Date.parse('2026-11-03T10:00:00Z');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }, now).kind, 'background');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, now), null);
  assert.equal(wakerFromTool({ tool_name: 'mcp__t3-code__schedule_task', tool_input: {} }, now).kind, 'scheduler');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'node bin/comms.mjs send --level blocker --to x --text y' }, tool_response: { stdout: 'sent m1' } }, now).kind, 'mail');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'node bin/comms.mjs send --reply-to m1 --text y' }, tool_response: { stdout: 'sent m2' } }, now), null, 'a reply wakes nobody');
  const st = { turn_started_at: '2026-11-03T10:00:00Z', wakers: [{ kind: 'background', at: '2026-11-03T09:00:00Z', until: '2026-11-03T09:30:00Z' }] };
  assert.equal(validWaker(st, now), null, 'a waker from an earlier turn that ran out does not count');
  assert.ok(validWaker({ ...st, timer: { at: '2026-11-03T10:30:00Z' } }, now));
});

test('waker: a harness schedule stays a waker in later turns until removed; a one-shot cron until it fires', () => {
  const fx = setup();
  try {
    const now = Date.parse('2026-11-03T08:00:00Z');
    const w = wakerFromTool({ tool_name: 'mcp__t3-code__schedule_task', tool_input: { prompt: 'p', schedule: { type: 'fixed_time', timeOfDay: '06:00' } }, tool_response: '{"scheduledTaskId":"st1","nextRunAt":"2026-11-04T05:00:00Z"}' }, now);
    assert.deepEqual([w.recurring, w.id], [true, 'st1']);
    assert.equal(wakerFromTool({ tool_name: 'mcp__t3-code__schedule_task', tool_input: { prompt: 'p', bindToCurrentThread: false } }, now), null, 'a run in a new thread wakes nobody here');
    recordWaker(fx.brain, fx.thread, w);
    const evening = Date.parse('2026-11-03T20:00:00Z');
    assert.ok(validWaker({ ...stateOf(fx), turn_started_at: '2026-11-03T19:00:00Z' }, evening), 'the daily task counts 12 h later');
    recordWaker(fx.brain, fx.thread, wakerFromTool({ tool_name: 'mcp__t3-code__delete_scheduled_task', tool_input: { scheduledTaskId: 'st1' } }, evening));
    assert.equal(validWaker({ ...stateOf(fx), turn_started_at: '2026-11-03T20:30:00Z' }, evening), null, 'a deleted task is no waker');
    const c = wakerFromTool({ tool_name: 'CronCreate', tool_input: { cron: '23 6 4 11 *', recurring: false }, tool_response: { id: 'c1', nextFireAt: Date.parse('2026-11-04T06:23:00Z') } }, evening);
    assert.equal(c.until, '2026-11-04T06:38:00.000Z', 'a one-shot cron holds until it fires');
  } finally { fx.cleanup(); }
});

test('Stop: "Stav: čakám" without a waker blocks once; ending anyway arms the timer; a timer lets it pass', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    const msg = 'Poslal som otázku Carol.\n\nStav: čakám';
    assert.match(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.reason, /no waker is armed/);
    assert.equal(stateOf(fx).timer, undefined, 'a blocked stop arms nothing');
    // Ending anyway never leaves the thread idle: code arms the timer, silently (P-061).
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: msg }).json.decision, undefined);
    const st = stateOf(fx);
    assert.ok(activeTimer(st), 'the Stop hook armed the timer itself');
    assert.equal(st.timer.auto, true);
    assert.equal(st.auto_timer_n, 1);
    // A timer armed in the turn lets the waiting end pass.
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.equal(stateOf(fx).timer, undefined, 'an operator prompt clears the timer');
    setTimer(fx.brain, fx.thread, { delayMs: 30 * 60_000, then: 'check the reply' });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.decision, undefined);
    // A bell turn is held to the protocol too: a promise is no state (bob 2026-11-08).
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const f = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...stateOf(fx), turn_source: 'wake' }));
    const promise = 'Commitnem a pushnem pri tvojej najbližšej správe.';
    assert.match(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: promise }).json.reason, /no state line/);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: promise }).json.decision, undefined);
    assert.ok(activeTimer(stateOf(fx)), 'the bell turn got a timer too');
  } finally { fx.cleanup(); }
});

test('UserPromptSubmit: a fired timer names its step; the update notice re-injects the rules once', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'začni' });
    const f = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...stateOf(fx), timer: { at: new Date(Date.now() - 1000).toISOString(), then: 'check the reply to m7', set_at: new Date(Date.now() - 900_000).toISOString() } }));
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'turn ended with a next step, continue from handover' });
    assert.match(r.context, /timer fired .*: check the reply to m7/);
    assert.equal(stateOf(fx).timer, undefined);
  } finally { fx.cleanup(); }
  assert.equal(updateNotice({ plugin_sha: 'aaa' }, { sha: 'aaa', version: '1' }), null);
  const n = updateNotice({ plugin_sha: 'aaa' }, { sha: 'bbb', version: '2' }, () => ['comms', 'topic']);
  assert.ok(n.line); assert.equal(n.patch.plugin_sha, 'bbb');
  // Tokens (operator 2026-11-03): only the changed skills are named; none changed says so; no diff falls back to all.
  assert.match(n.line, /changed skills: comms, topic: read one again/);
  assert.match(updateNotice({ plugin_sha: 'aaa' }, { sha: 'bbb' }, () => []).line, /no skill changed/);
  assert.match(updateNotice({ plugin_sha: 'aaa' }, { sha: 'bbb' }, () => null).line, /changed skills: all/);
});

test('PreToolUse: AskUserQuestion is denied (it halts the turn); a subagent is not affected', () => {
  const fx = setup();
  try {
    const r = fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }).json;
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /do all work that does not need the answer.*Pre teba.*Stav: otázka/);
    const hooks = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    assert.match(hooks.hooks.PreToolUse[0].matcher, /AskUserQuestion/);
  } finally { fx.cleanup(); }
});

test('PreToolUse: the project wizard asks in a dialog while its window is open, only in an operator turn (operator 2026-11-04)', () => {
  const fx = setup();
  try {
    const ask = () => fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }).json?.hookSpecificOutput?.permissionDecision;
    const project = (...a) => spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'project.mjs'), ...a], { cwd: fx.project, encoding: 'utf8', env: fx.env });
    const r = project('wizard', 'start', 'novy');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wizard open for novy/);
    assert.notEqual(ask(), 'deny');
    const state = stateOf(fx);
    fs.writeFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), JSON.stringify({ ...state, turn_source: 'wake' }));
    assert.equal(ask(), 'deny', 'a turn started by a message does not open a dialog');
    fs.writeFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), JSON.stringify({ ...state, wizard: { name: 'novy', until: '2026-01-01T00:00:00Z' } }));
    assert.equal(ask(), 'deny', 'an expired window');
    fs.writeFileSync(path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`), JSON.stringify(state));
    assert.equal(project('wizard', 'end').status, 0);
    assert.equal(ask(), 'deny');
    assert.equal(stateOf(fx).wizard, undefined);
  } finally { fx.cleanup(); }
});

test('rule texts: no level and no rule tells an agent to stop the work; the core rules leave room for project rules', () => {
  const rules = assembleRules({ policy: { limits: {} } });
  assert.doesNotMatch(rules.text, /zastaví prácu na nej|\(stojíš\)|AskUserQuestion`, odporúčaná/);
  assert.match(rules.text, /prácu NEZASTAVÍ/);
  // Operator 2026-11-03: rules must not grow without end; a new principle replaces or tightens an old one.
  assert.ok(rules.chars <= 8200, `core rules ${rules.chars} chars > 8200: fold the change into an existing principle`);
});

test('changedSkills: names the skills a real update changed (v0.8.18 -> v0.8.19 changed topic)', async () => {
  const { changedSkills } = await import('../scripts/update-notice.mjs');
  const tags = spawnSync('git', ['tag', '-l', 'v0.8.18', 'v0.8.19'], { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' }).stdout.trim().split('\n');
  if (tags.length < 2) return; // shallow clone without the tags
  assert.deepEqual(changedSkills('v0.8.18', 'v0.8.19', path.join(import.meta.dirname, '..')), ['topic']);
  assert.equal(changedSkills('nope1', 'nope2', path.join(import.meta.dirname, '..')), null);
});

test('UserPromptSubmit: an update with unchanged rules sends the update line without the rules block (tokens)', () => {
  const fx = setup();
  try {
    fx.hook('session-start.mjs', { source: 'startup' });
    fx.hook('user-prompt-submit.mjs', { prompt: 'a' });
    const f = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(st.rules_hash, 'rules hash recorded');
    fs.writeFileSync(f, JSON.stringify({ ...st, plugin_sha: '0000000', plugin_version: '0.0.1' }));
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'b' });
    assert.match(r.context, /workflow updated during this session/);
    assert.doesNotMatch(r.context, /Platné pravidlá od tohto ťahu/);
  } finally { fx.cleanup(); }
});

test('Stop: a thread without a topic asking the operator for one gets no auto timer; with a topic it does (flow-public#1)', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'spustam' });
    const ask = 'pilot / bez témy\n\nDostupné témy:\n- žiadne\n\n**Pre teba:** Aká bude téma?\n\nStav: otázka';
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: ask }).json.decision, undefined);
    assert.equal(activeTimer(stateOf(fx)), null, 'no timer: nothing to continue, the operator answers the topic question');
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotová prvá časť.\n\n**Pre teba:** Pokračovať variantom A? Odporúčam A.\n\nStav: otázka' });
    assert.equal(stateOf(fx).timer?.auto, true, 'a held topic still gets the P-061 timer');
  } finally { fx.cleanup(); }
});
