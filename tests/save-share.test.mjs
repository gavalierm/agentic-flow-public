// ttl: 2027-05-18
// a project 2026-11-19: --retire removes a superseded skill in the other brain.
// a project 2026-11-19: a share overwrote the other brain's own edits made after the last share; now refused (--overwrite).
// A project 2026-11-18: a skill went into a peer's brain by `git commit --no-verify`, so each transfer asked the
// operator for a dialog against a standing order. save.mjs share copies the saved skill in one commit of the brain script,
// checked by the other brain's pre-commit and pushed; a file the skill no longer has goes; nothing else changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('share: the saved skill goes into the other brain by a checked commit, pushed; stale files go; refusals write nothing', () => {
  const fx = setup();
  const peer = setup({ brainName: 'peer' });
  try {
    const desc = 'Použi, keď treba skúšobný postup.';
    let r = fx.run('save.mjs', ['skill', 'demo-steps', '--description', desc, '--content', '1. krok', '--origin', 'routine']);
    assert.equal(r.status, 0, r.out);
    const rel = path.relative(fx.brain, path.dirname(fs.readdirSync(fx.brain, { recursive: true }).map((f) => path.join(fx.brain, String(f))).find((f) => f.endsWith(`demo-steps${path.sep}SKILL.md`))));
    // A file the skill no longer has, in the other brain.
    fs.mkdirSync(path.join(peer.brain, rel), { recursive: true });
    fs.writeFileSync(path.join(peer.brain, rel, 'old.mjs'), 'x\n');
    peer.git(peer.brain, 'add', '-A'); peer.git(peer.brain, 'commit', '-q', '--no-verify', '-m', 'old');

    // Not a brain: refused.
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', fx.project]);
    assert.notEqual(r.status, 0); assert.match(r.out, /no brain of the workflow/);
    // A change not saved in this brain: refused, nothing written there.
    const head = peer.git(peer.brain, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(fx.brain, rel, 'SKILL.md'), 'neuložené\n');
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain]);
    assert.notEqual(r.status, 0); assert.match(r.out, /not saved in this brain/);
    assert.equal(peer.git(peer.brain, 'rev-parse', 'HEAD'), head);
    fx.git(fx.brain, 'checkout', '--', '.');

    // a project 2026-11-19: the other brain's own commit on the skill would be overwritten: refused, named, nothing written.
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain]);
    assert.notEqual(r.status, 0); assert.match(r.out, /own commits on the skill[\s\S]*"old"[\s\S]*--overwrite/);
    assert.equal(peer.git(peer.brain, 'rev-parse', 'HEAD'), head);
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain, '--overwrite']);
    assert.equal(r.status, 0, r.out);
    assert.equal(peer.read(path.join(rel, 'SKILL.md')), fx.read(path.join(rel, 'SKILL.md')));
    assert.ok(!peer.exists(path.join(rel, 'old.mjs')), 'a file the skill no longer has is removed');
    assert.match(peer.git(peer.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] share skill demo-steps from brain/);
    assert.equal(peer.git(peer.brain, 'rev-parse', 'HEAD'), peer.git(peer.origin, 'rev-parse', 'main'), 'pushed to its origin');
    assert.equal(peer.git(peer.brain, 'status', '--porcelain'), '');
    // A later edit in the other brain after the share is refused again; the share commit itself is no foreign edit.
    fs.appendFileSync(path.join(peer.brain, rel, 'SKILL.md'), 'cudzia úprava\n');
    peer.git(peer.brain, 'add', '-A'); peer.git(peer.brain, 'commit', '-q', '--no-verify', '-m', 'peer edit');
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain]);
    assert.notEqual(r.status, 0); assert.match(r.out, /"peer edit"/); assert.doesNotMatch(r.out, /"old"/);
    peer.git(peer.brain, 'reset', '-q', '--hard', 'HEAD~1');
    // The same again: nothing to commit.
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain]);
    assert.equal(r.status, 0, r.out); assert.match(r.out, /nothing to share/);
    // Shared from the thread of a topic: the copy names that topic as its developer (a report on it reaches that thread).
    assert.equal(fx.run('topic.mjs', ['create', 'skill-dev', '--subject', 'S', '--class', 'ops']).status, 0);
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain]);
    assert.equal(r.status, 0, r.out); assert.match(r.out, /developed_in [0-9a-f]{12}:[^ ]+\/skill-dev/);
    assert.match(peer.read(path.join(rel, 'SKILL.md')), /^developed_in: "?[0-9a-f]{12}:[^\n"]+\/skill-dev"?$/m);

    // a project 2026-11-19: a skill superseded in the other brain is retired from here: without a reason refused, then one
    // checked commit that removes its files there, pushed; this brain keeps its own copy; a missing skill writes nothing.
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain, '--retire']);
    assert.notEqual(r.status, 0); assert.match(r.out, /--retire needs --reason/);
    r = fx.run('save.mjs', ['share', '--retire', 'demo-steps', '--to', peer.brain, '--reason', 'superseded by demo-new']);
    assert.equal(r.status, 0, r.out);
    assert.ok(!peer.exists(path.join(rel, 'SKILL.md')), 'removed in the other brain');
    assert.ok(fx.exists(path.join(rel, 'SKILL.md')), 'this brain keeps its skill');
    assert.match(peer.git(peer.brain, 'log', '-1', '--format=%s'), /^\[brain-script\] retire skill demo-steps from brain[^:]*: superseded by demo-new/);
    assert.equal(peer.git(peer.brain, 'rev-parse', 'HEAD'), peer.git(peer.origin, 'rev-parse', 'main'), 'pushed to its origin');
    const after = peer.git(peer.brain, 'rev-parse', 'HEAD');
    r = fx.run('save.mjs', ['share', 'demo-steps', '--to', peer.brain, '--retire', '--reason', 'x']);
    assert.notEqual(r.status, 0); assert.match(r.out, /no agentic skill demo-steps/);
    assert.equal(peer.git(peer.brain, 'rev-parse', 'HEAD'), after);
  } finally { fx.cleanup(); peer.cleanup(); }
});
