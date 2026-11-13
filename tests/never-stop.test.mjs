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

test('waker.mjs: waitOnlyStep, parseDelay, wakerFromTool and validWaker classify steps, delays and tool calls', () => {
  assert.ok(waitOnlyStep('Čakať na hlásenie témy carol. Potom vydanie.'));
  assert.ok(waitOnlyStep('Operátor rozhodne o presune.'));
  assert.equal(waitOnlyStep('Vydať v0.9.29.'), null);
  assert.equal(parseDelay('30m'), 1_800_000); assert.equal(parseDelay('2h'), 7_200_000); assert.equal(parseDelay('90s'), 90_000); assert.equal(parseDelay('15'), 900_000); assert.equal(parseDelay('soon'), null);
  const now = Date.parse('2026-11-03T10:00:00Z');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }, now).kind, 'background');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, now), null);
  assert.equal(wakerFromTool({ tool_name: 'mcp__t3-code__schedule_task', tool_input: {} }, now).kind, 'scheduler');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'node bin/comms.mjs send --level blocker --to x --text y' }, tool_response: { stdout: 'sent m1' } }, now).kind, 'mail');
  assert.equal(wakerFromTool({ tool_name: 'Bash', tool_input: { command: 'node bin/comms.mjs send --level assist --to x --text y' }, tool_response: { stdout: 'sent m1 (assist)' } }, now).for, 'm1', 'the mail waker names its message');
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

test('Stop: "Stav: čakám" without a waker passes and code arms the timer with the wait target; an operator prompt keeps a timer until Stop', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'oprav to' });
    const msg = 'Poslal som otázku Carol.\n\nStav: čakám (na odpoveď Carol)';
    // No block (7 of 8 such blocks only led to timer.mjs, audit 2026-11-11): the thread is never left idle, code arms the timer.
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.decision, undefined);
    const st = stateOf(fx);
    assert.ok(activeTimer(st), 'the Stop hook armed the timer itself');
    assert.equal(st.timer.auto, true);
    assert.match(st.timer.then, /\*\*Stav:\*\* čakám \(na odpoveď Carol\)" without a waker: check it now/, 'the timer carries the wait target');
    assert.equal(st.auto_timer_n, 1);
    // An operator prompt keeps the timer (12 of 59 timers were dropped by one, audit 2026-11-11); its auto timer is spent at Stop.
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    assert.ok(stateOf(fx).timer, 'an operator prompt keeps the timer until Stop');
    // A timer armed in the turn lets the waiting end pass and stays.
    setTimer(fx.brain, fx.thread, { delayMs: 30 * 60_000, then: 'check the reply' });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.decision, undefined);
    assert.equal(stateOf(fx).timer.then, 'check the reply', 'a timer set in this turn is not spent');
    // The next operator turn ends without čakám: the timer is spent; a turn ending čakám keeps the agent's own timer.
    fx.hook('user-prompt-submit.mjs', { prompt: 'ešte toto' });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: msg }).json.decision, undefined);
    assert.equal(stateOf(fx).timer.then, 'check the reply', 'čakám keeps the agent timer');
    fx.hook('user-prompt-submit.mjs', { prompt: 'a toto' });
    fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: 'Hotové.\n\nStav: hotovo' });
    assert.equal(stateOf(fx).timer, undefined, 'an operator turn ending without čakám spends the timer');
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

test('UserPromptSubmit: a fired timer names its step and is spent', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'začni' });
    const f = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...stateOf(fx), timer: { at: new Date(Date.now() - 1000).toISOString(), then: 'check the reply to m7', set_at: new Date(Date.now() - 900_000).toISOString() } }));
    const r = fx.hook('user-prompt-submit.mjs', { prompt: 'turn ended with a next step, continue from handover' });
    assert.match(r.context, /timer fired .*: check the reply to m7/);
    assert.equal(stateOf(fx).timer, undefined);
  } finally { fx.cleanup(); }
});

test('PreToolUse: AskUserQuestion passes in every turn, so T3 shows "Awaiting Input"; the dialog time is kept (operator 2026-11-08)', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const ask = () => fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }).json?.hookSpecificOutput?.permissionDecision;
    assert.notEqual(ask(), 'deny');
    assert.ok(stateOf(fx).dialog_at >= stateOf(fx).turn_started_at, 'dialog of this turn recorded');
    const f = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...stateOf(fx), turn_source: 'wake' }));
    assert.notEqual(ask(), 'deny', 'a bell turn asks in the dialog too');
    const hooks = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    assert.match(hooks.hooks.PreToolUse[0].matcher, /AskUserQuestion/);
  } finally { fx.cleanup(); }
});

test('Stop: a question to the operator only in text blocks once with the dialog; after a dialog in the turn the text passes', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const text = 'Návrh je hotový.\n\n**Otázky na operátora:** Vydať teraz? Odporúčam áno.\n\nStav: otázka';
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: text }).json;
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /with AskUserQuestion now.*Awaiting Input/);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: text }).json.decision, undefined, 'blocks once');
    // P-059: the question of the first turn was answered by the operator; the fallback turn asks another one.
    const text2 = 'Návrh je hotový.\n\n**Otázky na operátora:** Ktorú farbu tlačidla použiť? Odporúčam modrú.\n\nStav: otázka';
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: text2 }).json.decision, undefined, 'the dialog failed: text fallback');
    // A dialog of an earlier turn does not count for this one.
    const f = path.join(fx.brain, 'local', 'threads', `${fx.thread}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...stateOf(fx), dialog_at: '2020-01-01T00:00:00.000Z' }));
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: text2 }).json.decision, 'block');
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

test('update notice: only the changed skills are named; an update with unchanged rules sends the update line without the rules block (tokens)', () => {
  assert.equal(updateNotice({ plugin_sha: 'aaa' }, { sha: 'aaa', version: '1' }), null);
  const n = updateNotice({ plugin_sha: 'aaa' }, { sha: 'bbb', version: '2' }, () => ['comms', 'topic']);
  assert.ok(n.line); assert.equal(n.patch.plugin_sha, 'bbb');
  // Tokens (operator 2026-11-03): only the changed skills are named; none changed says so; no diff falls back to all.
  assert.match(n.line, /changed skills: comms, topic: read one again/);
  assert.match(updateNotice({ plugin_sha: 'aaa' }, { sha: 'bbb' }, () => []).line, /no skill changed/);
  assert.match(updateNotice({ plugin_sha: 'aaa' }, { sha: 'bbb' }, () => null).line, /changed skills: all/);
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

test('Stop: "<project> / bez témy" in a reply blocks once unless it ends with the topic question (P-050, operator 2026-11-08)', () => {
  const fx = setup();
  try {
    const project = path.basename(fx.project);
    fx.hook('user-prompt-submit.mjs', { prompt: 'Chcem riešiť tému predaja pneumatík' });
    const block = `${project} / bez témy\n\nDostupné témy:\n- žiadne\n\n`;
    // Work without a topic under the status block of a thread without a topic.
    const work = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: `${block}Návrhy sú v scratch/kampan.md.\n\nStav: hotovo` }).json;
    assert.equal(work.decision, 'block');
    assert.match(work.reason, /goes on without a topic: .*topic\.mjs create/);
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: `${block}Hotovo.\n\nStav: hotovo` }).json.decision, undefined, 'blocks once');
    // The unknown topic asked with the block passes.
    fx.hook('user-prompt-submit.mjs', { prompt: 'ahoj' });
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: `${block}**Otázky na operátora:** Aká bude téma?\n\nStav: otázka` }).json.decision, undefined);
    // A topic created in the turn: the block must name it.
    assert.equal(fx.run('topic.mjs', ['create', 'predaj-pneumatik', '--subject', 'Predaj pneumatík', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const stale = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: `${block}Návrhy sú hotové.\n\nStav: hotovo` }).json;
    assert.equal(stale.decision, 'block');
    assert.match(stale.reason, new RegExp(`holds topic predaj-pneumatik: start the reply with "${project} / predaj-pneumatik"`));
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: `${project} / predaj-pneumatik\n\nNávrhy sú hotové.\n\nStav: hotovo` }).json.decision, undefined);
  } finally { fx.cleanup(); }
});

// Pilot 2026-11-12: the operator chose "Bez témy" in the topic dialog and Stop asked for the topic again (D-0010).
test('Stop: after the operator chose "Bez témy" in the dialog, "<project> / bez témy" passes without the topic question (P-050, D-0010)', () => {
  const fx = setup();
  try {
    const project = path.basename(fx.project);
    fx.hook('user-prompt-submit.mjs', { prompt: 'kto si' });
    const q = 'Aká bude téma?';
    const pt = fx.hook('post-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q, options: [{ label: 'web – Web' }, { label: 'Bez témy' }] }] }, tool_response: { answers: { [q]: 'Bez témy' } } });
    // Pilot 2026-11-13: the verbatim status block led the reply to ask the answered topic question again; the line after the answer says how to start.
    const said = pt.json?.hookSpecificOutput?.additionalContext || '';
    assert.ok(said.includes(`the operator chose "Bez témy": start the final reply with the line "${project} / bez témy" alone, without the list of topics and without "Aká bude téma?"`), said);
    const r = fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: `${project} / bez témy\n\nDostupné témy:\n- web – Web\n\nSom agent tohto projektu.\n\nStav: hotovo` }).json;
    assert.equal(r.decision, undefined, r.reason);
  } finally { fx.cleanup(); }
});

test('Stop: a thread without a topic asking the operator for one gets no auto timer; with a topic it does (flow-public#1)', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'spustam' });
    const ask = 'pilot / bez témy\n\nDostupné témy:\n- žiadne\n\n**Otázky na operátora:** Aká bude téma?\n\nStav: otázka';
    assert.equal(fx.hook('stop.mjs', { stop_hook_active: false, last_assistant_message: ask }).json.decision, undefined);
    assert.equal(activeTimer(stateOf(fx)), null, 'no timer: nothing to continue, the operator answers the topic question');
    assert.equal(fx.run('topic.mjs', ['create', 'alpha', '--subject', 'Alpha', '--class', 'discussion']).status, 0);
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: 'Hotová prvá časť.\n\n**Otázky na operátora:** Pokračovať variantom A? Odporúčam A.\n\nStav: otázka' });
    assert.equal(stateOf(fx).timer?.auto, true, 'a held topic still gets the P-061 timer');
  } finally { fx.cleanup(); }
});
