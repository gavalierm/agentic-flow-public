// Suspected malfunction: compare loaded and installed workflow version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { shortSha, PLUGIN_ROOT } from '../scripts/util.mjs';

test('same version asks for a report; older loaded version prints the current rules', () => {
  const fx = setup();
  try {
    const sha = shortSha(PLUGIN_ROOT);
    const same = fx.run('check.mjs', ['--loaded', sha]);
    assert.equal(same.status, 0, same.out);
    assert.match(same.stdout, /up to date: .*error\.mjs report --title/);
    const older = fx.run('check.mjs', ['--loaded', '0000000']);
    assert.equal(older.status, 0, older.out);
    assert.match(older.stdout, /newer workflow installed/);
    assert.match(older.stdout, /## |P-0/);
    assert.notEqual(fx.run('check.mjs', []).status, 0);
  } finally {
    fx.cleanup?.();
  }
});

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

test('pinClone: brain policy workflow_version moves a release install to that tag, older or newer; fetches a missing tag', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { git } = await import('../scripts/util.mjs');
  const { pinClone } = await import('../scripts/update.mjs');
  const { pinWorkflow } = await import('../hooks/session-start.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pin-'));
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...a) => { const r = git(a, { cwd, env }); assert.ok(r.ok, r.stderr); return r.stdout; };
  try {
    const origin = path.join(dir, 'origin');
    fs.mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    for (const v of ['v1.0.1', 'v1.0.2']) { g(origin, 'commit', '-q', '--allow-empty', '-m', v); g(origin, 'tag', v); }
    const { PIN_MIN } = await import('../scripts/update.mjs');
    assert.match(pinClone(origin, 'v0.9.10').reason, new RegExp(`predates workflow_version \\(first in ${PIN_MIN}\\)`));
    const clone = path.join(dir, 'clone');
    g(dir, 'clone', '-q', origin, clone);
    g(clone, 'checkout', '-q', 'v1.0.2');
    assert.deepEqual(pinClone(clone, '1.0.1'), { status: 'updated', from: 'v1.0.2', to: 'v1.0.1' }, 'older pin');
    assert.equal(pinClone(clone, 'v1.0.1').status, 'current');
    g(origin, 'commit', '-q', '--allow-empty', '-m', 'v1.0.3'); g(origin, 'tag', 'v1.0.3');
    assert.deepEqual(pinClone(clone, 'v1.0.3'), { status: 'updated', from: 'v1.0.1', to: 'v1.0.3' }, 'tag fetched from origin');
    assert.match(pinClone(clone, 'v1.0.9').reason, /release v1.0.9 does not exist/);
    assert.match(pinClone(clone, 'newest').reason, /not a release tag/);
    // "latest" follows the newest release of origin at every session start (operator 2026-11-07: another machine
    // should get each release without editing its pin).
    g(origin, 'commit', '-q', '--allow-empty', '-m', 'v1.0.4'); g(origin, 'tag', 'v1.0.4');
    assert.deepEqual(pinClone(clone, 'latest'), { status: 'updated', from: 'v1.0.3', to: 'v1.0.4' });
    assert.equal(pinClone(clone, 'latest').status, 'current');
    g(clone, 'checkout', '-q', 'v1.0.3');
    // SessionStart note: switch announced; a development clone (branch) stays without a note.
    g(clone, 'checkout', '-q', 'v1.0.1');
    assert.match(pinWorkflow({ policy: { workflow_version: 'v1.0.3' } }, clone), /workflow switched v1.0.1 -> v1.0.3 per brain policy/);
    // a fixed pin behind the newest release says so at every start, instead of passing for up to date (operator 2026-11-08)
    assert.match(pinWorkflow({ policy: { workflow_version: 'v1.0.3' } }, clone), /pinned to v1.0.3 .*newest release v1.0.4: the pin holds this machine back.*pin latest/);
    const { newerReleases } = await import('../scripts/update.mjs');
    assert.equal(newerReleases(clone, 'v1.0.4'), null);
    assert.equal(newerReleases(clone, 'latest'), null);
    assert.deepEqual(newerReleases(clone, '1.0.3'), { update: 'v1.0.4', upgrade: null });
    // No pin in the brain policy: the default is "latest", a fixed release is the fallback (operator 2026-11-08).
    assert.match(pinWorkflow({ policy: {} }, clone), /switched v1.0.3 -> v1.0.4 per default workflow_version latest/);
    assert.equal(pinWorkflow({ policy: {} }, clone), null, 'newest release: no note');
    fs.writeFileSync(path.join(clone, 'x'), 'local');
    assert.match(pinWorkflow({ policy: { workflow_version: 'v1.0.2' } }, clone), /not switched to v1.0.2 .*local changes/);
    fs.rmSync(path.join(clone, 'x'));
    g(clone, 'checkout', '-q', 'main');
    assert.equal(pinWorkflow({ policy: { workflow_version: 'v1.0.2' } }, clone), null);
    // Two brains on one machine with different pins (flow-public#2): the clone follows the brain that set it or a pin the
    // operator just changed; the other brain reports the conflict instead of switching the clone back.
    g(clone, 'checkout', '-q', 'v1.0.1');
    const penv = { WORKFLOW_PIN_FILE: path.join(dir, 'pin.json') };
    const [a, b] = ['brain-a', 'brain-b'].map((n) => { const d = path.join(dir, n); fs.mkdirSync(d); return d; });
    const pin = (brainDir, v) => pinWorkflow({ brainDir, policy: { workflow_version: v } }, clone, penv);
    assert.match(pin(a, 'v1.0.3'), /switched v1.0.1 -> v1.0.3/);
    assert.match(pin(b, 'v1.0.2'), /not switched to v1.0.2 .*brain-a pins v1.0.3/);
    assert.match(pin(b, 'v1.0.2'), /brain-a pins v1.0.3/, 'still a conflict at the next start');
    assert.match(pin(a, 'v1.0.3'), /^workflow pinned to v1.0.3 .*newest release v1.0.4/, 'no conflict; only the held-back note');
    assert.match(pin(b, 'v1.0.4'), /switched v1.0.3 -> v1.0.4/, 'the operator changed the pin of brain b');
    assert.match(pin(a, 'v1.0.3'), /brain-b pins v1.0.4/);
    assert.equal(pin(a, 'v1.0.4'), null, 'same pin: no conflict');
    // A brain without a pin follows "latest" and is listed (brain.mjs pin --all); adding a pin there counts as the
    // operator's change.
    const c = path.join(dir, 'brain-c'); fs.mkdirSync(c);
    assert.match(pinWorkflow({ brainDir: c, policy: {} }, clone, penv), /not switched to latest \(default workflow_version latest.*brain-a pins v1.0.4/);
    assert.equal(JSON.parse(fs.readFileSync(penv.WORKFLOW_PIN_FILE, 'utf8')).brains[fs.realpathSync(c)], 'latest');
    assert.match(pin(c, 'v1.0.3'), /switched v1.0.4 -> v1.0.3/);
    // A brain recorded without a pin (null) by an older release counts as "latest": no change of the operator, so a
    // fixed pin of another brain is a conflict, not switched back.
    const d = path.join(dir, 'brain-d'); fs.mkdirSync(d);
    const rec = JSON.parse(fs.readFileSync(penv.WORKFLOW_PIN_FILE, 'utf8'));
    rec.brains[fs.realpathSync(d)] = null; fs.writeFileSync(penv.WORKFLOW_PIN_FILE, JSON.stringify(rec));
    assert.match(pinWorkflow({ brainDir: d, policy: {} }, clone, penv), /not switched to latest \(default workflow_version latest.*brain-c pins v1.0.3/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
