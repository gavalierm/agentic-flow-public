// ttl: 2026-12-15
// flow-public#87: the drift judge refused the assigned work of a code topic: it got only the topic subject (the task was
// not kept with the topic) and offered the orchestrator topic that assigned the work as "belongs to".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { readTopicRecord } from '../scripts/topic-files.mjs';
import { driftJob, driftPrompt } from '../scripts/drift.mjs';

test('topic create keeps --task with the topic', () => {
  const fx = setup();
  try {
    const r = fx.run('topic.mjs', ['create', 'gaps-t', '--subject', 'Gaps of the migration', '--class', 'discussion', '--task', 'point 2: archive closed topics', '--here']);
    assert.equal(r.status, 0, r.out);
    assert.equal(readTopicRecord(fx.brain, 'gaps-t').task, 'point 2: archive closed topics');
  } finally { fx.cleanup(); }
});

test('drift judge gets the topic task and not the assigning orchestrator topic', () => {
  const held = [{ id: 'gaps', subject: 'Gaps of the migration', task: 'point 2: archive closed topics', orchestrator: { topic: 'dev' }, state: 'working' }];
  const job = driftJob(held, [{ id: 'dev', subject: 'Workflow development' }, { id: 'other', subject: 'Another job' }]);
  assert.deepEqual(job.others.map((t) => t.id), ['other']);
  const prompt = driftPrompt({ ...job, task: 'do point 2' });
  assert.match(prompt, /# Topic task[^\n]*\npoint 2: archive closed topics/);
  assert.match(prompt, /part of it/);
  assert.doesNotMatch(prompt, /dev: Workflow development/);
});
