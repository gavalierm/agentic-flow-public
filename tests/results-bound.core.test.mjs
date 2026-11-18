// keep: core
// P-078 (data protection): a result of a topic is bound to its work file and never goes stale; the work files shown to the
// operator (Artifact, html_preview), cited by the handover or saved earlier under the same name are saved without a
// command at the end of the turn; done --topic saves before the work files end and refuses while a handover cites a
// folder of them; another open topic that cites them gets them saved into its own results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { domain3, gitq } from './layout-2-helpers.mjs';
import { syncResults } from '../scripts/results.mjs';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const tmp = (fx, id, rel) => path.join(fx.brain, 'topics', id, 'tmp', ...rel.split('/'));
const inGit = (fx, rel) => gitq(fx.brain, 'show', `HEAD:${rel}`);
// A released end of the turn (the second attempt passes the protocol checks, spec 10.3): only the writes are tested.
const stop = (fx) => fx.hook('stop.mjs', { stop_hook_active: true, last_assistant_message: 'ok\n\n**Stav:** hotovo' });
const DONE = ['--topic', '--verified', 'observed', '--knowledge', 'nic nové'];

test('a saved result follows its work file; shown, cited and older same-name work files are saved at the end of the turn', () => {
  const fx = domain3({ defaultRepo: 'project', web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 't1', '--subject', 'Parametre', '--class', 'ops']).status, 0);
    // save.mjs result from the work files binds the result to its source.
    write(tmp(fx, 't1', 'register.json'), '{"types":1}\n');
    let r = fx.run('save.mjs', ['result', tmp(fx, 't1', 'register.json')]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /bound to topics\/t1\/tmp\/register\.json/);
    assert.equal(fx.json('topics/t1/.tema.json').results['register.json'].from, 'topics/t1/tmp/register.json');
    // The work copy changes later (a decision adds a type): the end of the turn copies it over the saved result.
    write(tmp(fx, 't1', 'register.json'), '{"types":2}\n');
    // A page published from the work files, a generator the handover names, and an older result saved before binding.
    write(tmp(fx, 't1', 'stranka.html'), '<p>v1</p>\n');
    fx.hook('post-tool-use.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Artifact', tool_input: { file_path: tmp(fx, 't1', 'stranka.html') }, tool_response: 'published https://claude.ai/artifact/AbC123' });
    assert.equal(inGit(fx, 'topics/t1/stranka.html'), '<p>v1</p>', 'the shown page is saved at once');
    assert.equal(fx.json('topics/t1/.tema.json').results['stranka.html'].url, 'https://claude.ai/artifact/AbC123');
    write(tmp(fx, 't1', 'gen/gen-page.mjs'), 'console.log(1)\n');
    assert.equal(fx.run('save.mjs', ['handover', 't1', '--task', 'T', '--done', 'stránka z tmp/gen/gen-page.mjs', '--next', '']).status, 0);
    write(path.join(fx.brain, 'topics', 't1', 'velkosti.html'), 'old\n');
    gitq(fx.brain, 'add', '-A'); gitq(fx.brain, 'commit', '-q', '--no-verify', '-m', 'older result');
    write(tmp(fx, 't1', 'velkosti.html'), 'new, marked invalid\n');
    write(tmp(fx, 't1', 'stranka.html'), '<p>v2</p>\n');
    write(tmp(fx, 't1', 'pomocny.txt'), 'intermediate\n');
    stop(fx);
    assert.equal(inGit(fx, 'topics/t1/register.json'), '{"types":2}');
    assert.equal(inGit(fx, 'topics/t1/stranka.html'), '<p>v2</p>', 'a republished page follows its source');
    assert.equal(inGit(fx, 'topics/t1/gen-page.mjs'), 'console.log(1)', 'a work file the handover cites is saved');
    assert.equal(inGit(fx, 'topics/t1/velkosti.html'), 'new, marked invalid', 'an older result follows the one work file of its name');
    assert.ok(!fx.exists('topics/t1/pomocny.txt'), 'an intermediate file nobody named stays in the work files');
    const bound = fx.json('topics/t1/.tema.json').results;
    assert.equal(bound['gen-page.mjs'].via, 'handover');
    assert.equal(bound['velkosti.html'].via, 'inferred');
    // Saving the same source again needs no --replace.
    write(tmp(fx, 't1', 'register.json'), '{"types":3}\n');
    r = fx.run('save.mjs', ['result', tmp(fx, 't1', 'register.json')]);
    assert.equal(r.status, 0, r.out);
    assert.equal(inGit(fx, 'topics/t1/register.json'), '{"types":3}');
  } finally { fx.cleanup(); }
});

test('done --topic saves before the work files end: a cited folder refuses the close, another topic citing a work file gets it saved', () => {
  const fx = domain3({ defaultRepo: 'project', web: false });
  try {
    fx.thread();
    assert.equal(fx.run('topic.mjs', ['create', 'a1', '--subject', 'Skill', '--class', 'ops']).status, 0);
    write(tmp(fx, 'a1', 'nazvoslovie/podklady.md'), '# Podklady\n');
    write(tmp(fx, 'a1', 'nazvoslovie/raw.json'), '{}\n');
    assert.equal(fx.run('save.mjs', ['handover', 'a1', '--task', 'T', '--done', 'podklady v tmp/nazvoslovie/', '--next', '']).status, 0);
    // Another open topic (another thread) reads a work file of a1: its handover cites it by the brain path.
    const other = { env: { WORKFLOW_THREAD_ID: 'b-thread' } };
    let r0 = fx.run('topic.mjs', ['create', 'b1', '--subject', 'Názvy', '--class', 'ops'], other);
    assert.equal(r0.status, 0, r0.out);
    // b1 cites its own work file too, named against P-049 (a project 2026-11-18: it refused the close of a1).
    write(tmp(fx, 'b1', 'SKILL-navrh.md'), '# Návrh\n');
    r0 = fx.run('save.mjs', ['handover', 'b1', '--task', 'T', '--done', `podklady: ${path.basename(fx.brain)}/topics/a1/tmp/nazvoslovie/podklady.md; návrh tmp/SKILL-navrh.md`, '--next', ''], other);
    assert.equal(r0.status, 0, r0.out);
    let r = fx.run('done.mjs', [...DONE, '--topic-id', 'a1']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /the handover of a1 cites the folder topics\/a1\/tmp\/nazvoslovie\/ \(2 file\(s\)\)/);
    assert.ok(fs.existsSync(tmp(fx, 'a1', 'nazvoslovie/raw.json')), 'nothing of the work files is removed');
    assert.equal(inGit(fx, 'topics/b1/podklady.md'), '# Podklady', 'the work file b1 cites is saved into b1 before a1 ends');
    assert.ok(!fx.exists('topics/b1/SKILL-navrh.md') && !fx.exists('topics/b1/skill-navrh.md'), 'nothing else of b1 is synced by the close of a1');
    // b1's own sync saves it under a name by P-049.
    const b1 = syncResults(fx.brain, 'b1', {});
    assert.deepEqual(b1.saved.map((x) => x.name), ['skill-navrh.md']);
    // The manager saves what is needed and rewrites the handover: the close goes on.
    assert.equal(fx.run('save.mjs', ['result', tmp(fx, 'a1', 'nazvoslovie/podklady.md'), '--topic', 'a1']).status, 0);
    assert.equal(fx.run('save.mjs', ['handover', 'a1', '--task', 'T', '--done-replace', 'podklady v podklady.md', '--next', '']).status, 0);
    r = fx.run('done.mjs', [...DONE, '--topic-id', 'a1']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\? podklady\.md/, 'the saved result goes to the triage');
  } finally { fx.cleanup(); }
});
