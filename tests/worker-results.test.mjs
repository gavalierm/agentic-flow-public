import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { citedScratch, untrackedKnowledge, workerTaskLine } from '../scripts/materialy.mjs';

// D-0032 (knowledge point 4): a worker result lived only in the conversation.
test('D-0032: an accepted worker result is kept in topics/<topic>/results.md, archived with the topic; done cites scratch paths', () => {
  const fx = setup();
  try {
    assert.equal(fx.run('topic.mjs', ['create', 'd1', '--subject', 'Discussion', '--class', 'discussion']).status, 0);
    const transcript = path.join(fx.root, 'agent-w1.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '## Zadanie\nSurvey the sources of point four.\nmore' } }) + '\n');
    fs.mkdirSync(path.join(fx.project, 'scratch', 'p'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'scratch', 'p', 'raw.json'), '{}');
    const result = 'Conclusion: two sources (raw data scratch/p/raw.json, gone scratch/p/missing.json).\n\nFailures: none';
    const out = fx.hook('subagent-stop.mjs', { agent_type: 'workflow:worker', agent_id: 'w1', agent_transcript_path: transcript, last_assistant_message: result });
    assert.deepEqual(out.json, {}, 'an accepted result is not blocked');
    const file = path.join(fx.brain, 'topics', 'd1', 'results.md');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^## \S+ w1 – Survey the sources of point four\.$/m);
    assert.match(text, /Conclusion: two sources/);
    assert.equal(fx.git(fx.brain, 'status', '--porcelain', '--', 'topics').trim(), '', 'committed');
    // a blocked result (no Failures section) is not kept
    fx.hook('subagent-stop.mjs', { agent_type: 'workflow:worker', agent_id: 'w2', last_assistant_message: 'no section' });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /no section/);
    // another agent type is not kept
    fx.hook('subagent-stop.mjs', { agent_type: 'Explore', agent_id: 'e1', last_assistant_message: 'explore\n\nFailures: none' });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /explore/);
    const done = fx.run('done.mjs', ['--topic', '--verified', 'x']);
    assert.equal(done.status, 0, done.out);
    assert.ok(fs.existsSync(path.join(fx.brain, 'topics', 'archive', 'd1', 'results.md')), 'archived with the topic');
    assert.match(done.out, /results: 1 scratch\/ path\(s\) cited in worker results of d1 exist only in scratch\/ \(not in git\): scratch\/p\/raw\.json\./);
  } finally { fx.cleanup(); }
});

test('D-0032: no held topic, nothing is written', () => {
  const fx = setup();
  try {
    fx.hook('subagent-stop.mjs', { agent_type: 'workflow:worker', agent_id: 'w1', last_assistant_message: 'r\n\nFailures: none' });
    assert.equal(fs.existsSync(path.join(fx.brain, 'topics')) ? fs.readdirSync(path.join(fx.brain, 'topics'), { recursive: true }).filter((f) => String(f).endsWith('results.md')).length : 0, 0);
  } finally { fx.cleanup(); }
});

test('D-0032: helpers: cited scratch paths, untracked docs and materialy, task line', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.project, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'scratch', 'a.md'), 'x');
    assert.deepEqual(citedScratch(fx.project, `see ${fx.project}/scratch/a.md, and scratch/a.md. and /elsewhere/scratch/a.md`), ['scratch/a.md']);
    fs.mkdirSync(path.join(fx.project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'docs', 'n.md'), 'x');
    assert.deepEqual(untrackedKnowledge(fx.project), ['docs/n.md']);
    assert.deepEqual(untrackedKnowledge(fx.root), [], 'no git: nothing');
    assert.equal(workerTaskLine(path.join(fx.root, 'none.jsonl')), '');
  } finally { fx.cleanup(); }
});
