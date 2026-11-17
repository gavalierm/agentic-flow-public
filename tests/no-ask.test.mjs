// keep: core
// D-0042 (operator 2026-11-14): the workflow hook never holds the thread with a confirmation window. A step that needs the
// operator's consent (P-018: data git cannot restore) is refused with its reason and the way; leftovers of workflow tests
// (a wf-test-* fixture dir, an orphaned git worktree) are removed without consent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { NO_ASK_WAY, testLeftover } from '../hooks/pre-tool-use.mjs';

const bash = (fx, command) => fx.hook('pre-tool-use.mjs', { tool_name: 'Bash', tool_input: { command }, cwd: fx.project }).json?.hookSpecificOutput || {};

test('D-0042: rm of a target git cannot restore is a deny with the reason and the way, never an ask', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'ďalej' });
    const data = path.join(fx.project, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'export.csv'), 'x\n');
    const out = bash(fx, `rm -rf ${data}`);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /targets not recoverable from git: .*data.*\(P-018\); the dialog names exactly: "[^"]*\/data"\. this step needs the operator's consent/);
    assert.ok(out.permissionDecisionReason.endsWith(NO_ASK_WAY), out.permissionDecisionReason);
    assert.ok(fs.existsSync(data), 'the data stays');
    // the deny locks nothing: a later call on the same path is checked by P-018 again, not refused as a bypass (P-054)
    assert.doesNotMatch(bash(fx, `rm -rf ${data}`).permissionDecisionReason || '', /P-054/);
  } finally { fx.cleanup(); }
});

test('D-0042: a subagent gets the deny too and no consent path', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.project, 'notes.txt'), 'x\n');
    const out = fx.hook('pre-tool-use.mjs', { agent_id: 'sub-1', tool_name: 'Bash', tool_input: { command: `rm ${path.join(fx.project, 'notes.txt')}` }, cwd: fx.project }).json?.hookSpecificOutput || {};
    assert.equal(out.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

// report-dd7a8da4: P-018 sent the agent to a dialog naming the exact targets, D-0039 refused the paths
// in it as internal marks; the dialog without paths got the yes and P-018 then refused the step. A target of a step refused
// for consent in this turn stays in the dialog, and the yes of that dialog lets the step pass.
test('D-0042 with D-0039: the dialog may name the paths of a step refused for consent, its yes lets the step pass', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'uprac to' });
    fs.mkdirSync(path.join(fx.project, 'local', 'cache'), { recursive: true });
    const a = path.join(fx.project, 'local', 'cache', 'stare.json');
    const other = path.join(fx.project, 'local', 'cache', 'ine.json');
    fs.writeFileSync(a, '{}\n');
    fs.writeFileSync(other, '{}\n');
    const cmd = 'rm local/cache/stare.json';
    assert.equal(bash(fx, cmd).permissionDecision, 'deny');
    const q = 'Upratujem staré súbory, ktoré vytvoril iný beh. Zmazať súbor local/cache/stare.json? Git ho neobnoví a nikto ho už nepoužíva.';
    const ask = (question) => fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', cwd: fx.project, tool_input: { questions: [{ question, header: 'Zmazanie', options: [
      { label: 'Zmazať (Recommended)', description: 'Súbor sa zmaže, lebo je to zvyšok starého behu.' },
      { label: 'Nechať', description: 'Súbor ostane na disku.' }] }] } }).json?.hookSpecificOutput || {};
    assert.notEqual(ask(q).permissionDecision, 'deny', 'the consent target is no internal mark');
    // another path is still a mark (a new turn, so the once-per-turn repeat does not let it pass)
    fx.hook('user-prompt-submit.mjs', { prompt: 'uprac aj toto' });
    assert.equal(bash(fx, cmd).permissionDecision, 'deny');
    const out = ask(q.replace('local/cache/stare.json', 'local/cache/ine.json'));
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /local\/cache\/ine\.json \(file path\)/);
    assert.match(out.permissionDecisionReason, /targets of a step refused for consent \(P-018\)/);
    fx.hook('post-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q, header: 'Zmazanie', options: [{ label: 'Zmazať (Recommended)' }, { label: 'Nechať' }] }] }, tool_response: { answers: { [q]: 'Zmazať (Recommended)' } } });
    const granted = bash(fx, cmd);
    assert.equal(granted.permissionDecision, 'allow', granted.permissionDecisionReason);
    assert.ok(fs.existsSync(other), 'nothing else is touched');
  } finally { fx.cleanup(); }
});

// report-dd7a8da4 (follow-up): `cd <repo>; rm local/.env local/s.json; ls -a local local/tajomstva` — the folders ls only
// reads counted as targets the dialog had to name, so the yes of a dialog naming both files paired with nothing.
test('D-0042: the yes pairs with the files a shell command removes, not with the folders it only reads', () => {
  const fx = setup();
  try {
    fx.hook('user-prompt-submit.mjs', { prompt: 'zmaž' });
    fs.mkdirSync(path.join(fx.project, 'local', 'tajomstva'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', '.env'), 'A=b\n');
    fs.writeFileSync(path.join(fx.project, 'local', 'shoptet-session.json'), '{}\n');
    const cmd = `cd ${fx.project}; rm local/.env local/shoptet-session.json; ls -a local local/tajomstva`;
    assert.equal(bash(fx, cmd).permissionDecision, 'deny');
    const q = 'Ochrana dát chce potvrdenie s presnými cestami. Zmazať tieto dva súbory, ktorých kópie sú už v priečinku tajomstiev: local/.env a local/shoptet-session.json?';
    const dialog = { questions: [{ question: q, header: 'Zmazanie', options: [
      { label: 'Áno, zmaž (Recommended)', description: 'Oba súbory sa zmažú, lebo ich kópie už sú v priečinku tajomstiev.' },
      { label: 'Nie', description: 'Súbory ostanú.' }] }] };
    assert.notEqual(fx.hook('pre-tool-use.mjs', { tool_name: 'AskUserQuestion', cwd: fx.project, tool_input: dialog }).json?.hookSpecificOutput?.permissionDecision, 'deny');
    fx.hook('post-tool-use.mjs', { tool_name: 'AskUserQuestion', tool_input: dialog, tool_response: { answers: { [q]: 'Áno, zmaž (Recommended)' } } });
    const out = bash(fx, cmd);
    assert.equal(out.permissionDecision, 'allow', out.permissionDecisionReason);
  } finally { fx.cleanup(); }
});
