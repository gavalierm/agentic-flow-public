// keep: core
// Suspected malfunction: compare loaded and installed workflow version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { shortSha, PLUGIN_ROOT } from '../scripts/util.mjs';

test('updateClone: a release install moves to the newest release tag; a branch or dirty clone stays', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { git } = await import('../scripts/util.mjs');
  const { updateClone } = await import('../scripts/update.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-update-'));
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...a) => { const r = git(a, { cwd, env }); assert.ok(r.ok, r.stderr); return r.stdout; };
  try {
    const origin = path.join(dir, 'origin');
    fs.mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    for (const v of ['v0.2.0', 'v0.10.0', 'v0.9.1']) { g(origin, 'commit', '-q', '--allow-empty', '-m', v); g(origin, 'tag', v); }
    const clone = path.join(dir, 'clone');
    g(dir, 'clone', '-q', origin, clone);
    g(clone, 'checkout', '-q', 'v0.2.0');
    assert.deepEqual(updateClone(clone), { status: 'updated', from: 'v0.2.0', to: 'v0.10.0' }, 'semver, not text order');
    assert.equal(updateClone(clone).status, 'current');
    g(clone, 'checkout', '-q', 'v0.2.0');
    fs.writeFileSync(path.join(clone, 'x'), 'local');
    assert.equal(updateClone(clone).status, 'skipped', 'local changes');
    fs.rmSync(path.join(clone, 'x'));
    g(clone, 'checkout', '-q', 'main');
    assert.equal(updateClone(clone).status, 'skipped', 'a branch (dev clone) is not switched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('major version guard: latest updates within the major version, a new major is only announced; pin N upgrades (D-0050, P-066)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { git } = await import('../scripts/util.mjs');
  const { pinClone, updateClone, pinValue } = await import('../scripts/update.mjs');
  const { pinWorkflow } = await import('../hooks/session-start.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-major-'));
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...a) => { const r = git(a, { cwd, env }); assert.ok(r.ok, r.stderr); return r.stdout; };
  try {
    const origin = path.join(dir, 'origin');
    fs.mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    for (const v of ['v0.9.98', 'v0.9.99', 'v1.0.0', 'v1.1.0']) { g(origin, 'commit', '-q', '--allow-empty', '-m', v); g(origin, 'tag', v); }
    const clone = path.join(dir, 'clone');
    g(dir, 'clone', '-q', origin, clone);
    g(clone, 'checkout', '-q', 'v0.9.98');
    // "latest" (and the default without a pin): 0.9.x stays on 0.9.x, the newest 0.9.x
    assert.deepEqual(pinClone(clone, 'latest'), { status: 'updated', from: 'v0.9.98', to: 'v0.9.99' }, 'latest must not cross to 1.0.0');
    assert.deepEqual(updateClone(clone), { status: 'current', from: 'v0.9.99', to: 'v0.9.99' });
    const note = pinWorkflow({ policy: {} }, clone);
    assert.match(note, /new major version v1\.1\.0 exists, this machine runs v0\.9\.99: an upgrade, not an update, never done automatically.*brain\.mjs pin 1 --all/);
    assert.equal(g(clone, 'describe', '--tags', '--exact-match'), 'v0.9.99', 'the announcement did not switch');
    // a fixed pin: update (same major) and upgrade (new major) told apart
    g(clone, 'checkout', '-q', 'v0.9.98');
    const fixed = pinWorkflow({ policy: { workflow_version: 'v0.9.98' } }, clone);
    assert.match(fixed, /pinned to v0\.9\.98 .*newest release v0\.9\.99: the pin holds this machine back \(update within the major version/);
    assert.match(fixed, /new major version v1\.1\.0 exists/);
    // deliberate upgrade: pin "1" (newest 1.x) or a 1.x tag
    assert.deepEqual(pinValue('1'), { want: '1' });
    assert.equal(pinValue('v0').error, undefined);
    assert.deepEqual(pinClone(clone, '1'), { status: 'updated', from: 'v0.9.98', to: 'v1.1.0' });
    assert.deepEqual(pinClone(clone, 'v1'), { status: 'current', from: 'v1.1.0', to: 'v1.1.0' });
    assert.match(pinClone(clone, '7').reason, /no release of major version 7 exists/);
    g(clone, 'checkout', '-q', 'v1.0.0');
    assert.deepEqual(pinClone(clone, 'latest'), { status: 'updated', from: 'v1.0.0', to: 'v1.1.0' }, '1.x follows 1.x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updateClone: a release tag moved on origin (the clone keeps the old one) does not stop the update (2026-11-16)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { git } = await import('../scripts/util.mjs');
  const { updateClone } = await import('../scripts/update.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-update-'));
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...a) => { const r = git(a, { cwd, env }); assert.ok(r.ok, r.stderr); return r.stdout; };
  try {
    const origin = path.join(dir, 'origin');
    fs.mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    g(origin, 'commit', '-q', '--allow-empty', '-m', 'a');
    g(origin, 'tag', 'v2.0.0');
    const clone = path.join(dir, 'clone');
    g(dir, 'clone', '-q', origin, clone);
    g(clone, 'checkout', '-q', 'v2.0.0');
    // origin moves v2.0.0 (a fix under the same tag), then releases v2.0.1.
    g(origin, 'commit', '-q', '--allow-empty', '-m', 'fix');
    g(origin, 'tag', '-f', 'v2.0.0');
    g(origin, 'commit', '-q', '--allow-empty', '-m', 'b');
    g(origin, 'tag', 'v2.0.1');
    assert.deepEqual(updateClone(clone), { status: 'updated', from: 'v2.0.0', to: 'v2.0.1' });
    assert.equal(g(clone, 'rev-parse', 'v2.0.0'), g(origin, 'rev-parse', 'v2.0.0'), 'the moved tag follows origin');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Operator 2026-11-17: check always reported "nothing to update", even when the workflow had been updated: the agent passed
// the sha installed meanwhile as --loaded. The loaded version comes from the session start (thread state), the last line
// `result:` names the update.
test('check.mjs: the loaded version comes from the session start, not from --loaded; the result line names an update during the session', async () => {
  const fs = await import('node:fs');
  const { threadStateFile } = await import('../scripts/config.mjs');
  const fx = setup();
  try {
    fx.hook('session-start.mjs', { source: 'startup' });
    const file = threadStateFile(fx.brain, fx.thread);
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(st.boot_plugin_sha, shortSha(PLUGIN_ROOT), 'SessionStart records the loaded version');
    fs.writeFileSync(file, JSON.stringify({ ...st, boot_plugin_sha: 'abc1234', boot_plugin_version: '2.0.24' }));
    const r = fx.run('check.mjs', ['--loaded', shortSha(PLUGIN_ROOT)]);
    assert.match(r.stdout, /^loaded: workflow v2\.0\.24 \(abc1234\) \(session start\)/m);
    assert.match(r.stdout, /^result: updated during this session: v2\.0\.24 \(abc1234\) -> /m);
    assert.doesNotMatch(r.stdout, /^up to date/m);
  } finally { fx.cleanup(); }
});
