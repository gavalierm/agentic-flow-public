// relates_to links (D-0029): a link is a record key, a decision, a principle or a file git tracks. save refused nothing
// (beszel next to service-beszel, topic names, local/ paths), nobody listed such links, and find never read bodies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, memoryRecord } from './helpers.mjs';

/** Write and commit a record straight into the fixture brain (an old record from before the check). */
function plant(fx, rel, text) {
  fs.mkdirSync(path.dirname(path.join(fx.brain, rel)), { recursive: true });
  fs.writeFileSync(path.join(fx.brain, rel), text);
  fx.git(fx.brain, 'add', '-A');
  fx.git(fx.brain, 'commit', '-q', '--no-verify', '-m', 'fixture');
}

const service = (fx) => {
  const r = fx.run('save.mjs', ['memory', 'service', 'beszel', '--content', 'Monitors the hosts.']);
  assert.equal(r.status, 0, r.out);
};

test('save memory: a new link must resolve; a free word is refused with the similar key, nothing saved', () => {
  const fx = setup();
  try {
    service(fx);
    let r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'Checks the port.', '--relates-to', 'beszel']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /relates_to: beszel: no record key, decision, principle or file tracked in git \(similar key: service-beszel\)/);
    assert.match(r.stderr, /a topic or a free word belongs in the body; nothing saved/);
    assert.equal(fx.exists('memory/tool-probe.md'), false, 'nothing saved');
    fs.writeFileSync(path.join(fx.project, 'notes.md'), 'not in git\n');
    r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'Checks the port.', '--relates-to', 'notes.md']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /notes\.md: the file exists but git does not track it/);
    r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'Checks the port.', '--relates-to', 'P-999']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /P-999: the workflow has no principle P-999/);
    r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'Checks the port.', '--relates-to', 'service-beszel,P-008,src/app.js,src']);
    assert.equal(r.status, 0, r.out);
    assert.match(fx.read('memory/tool-probe.md'), /^relates_to: \[service-beszel, P-008, src\/app\.js, src\]$/m);
  } finally { fx.cleanup(); }
});

test('save memory: --relates-to or --unrelate alone changes only the links; an old broken link is named', () => {
  const fx = setup();
  try {
    service(fx);
    plant(fx, 'memory/tool-probe.md', memoryRecord('tool-probe', 'Checks the port.\n\nSecond line.', 'origin: derived\nsources: [README.md]\nfingerprint: abc123\nrelates_to: [beszel]\n').replace('origin: operator\n', ''));
    let r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--unrelate', 'beszel', '--relates-to', 'service-beszel']);
    assert.equal(r.status, 0, r.out);
    const text = fx.read('memory/tool-probe.md');
    assert.match(text, /^relates_to: \[service-beszel\]$/m);
    assert.match(text, /^origin: derived$/m, 'origin stays');
    assert.match(text, /^fingerprint: abc123$/m, 'the sources were not read again');
    assert.match(text, /Checks the port\.\n\nSecond line\./, 'the body stays');
    r = fx.run('save.mjs', ['memory', 'tool', 'ghost', '--relates-to', 'service-beszel']);
    assert.equal(r.status, 1, 'no record to change');
    assert.match(r.stderr, /tool-ghost does not exist: --relates-to or --unrelate without --content/);
    plant(fx, 'memory/tool-old.md', memoryRecord('tool-old', 'Old.', 'relates_to: [workflow-dev]\n'));
    r = fx.run('save.mjs', ['memory', 'tool', 'old', '--content', 'Old, rewritten.']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /note: links of tool-old that resolve to nothing .*workflow-dev: no record key/);
  } finally { fx.cleanup(); }
});

test('save decision: links must resolve; --relink adds and drops links and keeps at least one', () => {
  const fx = setup();
  try {
    service(fx);
    let r = fx.run('save.mjs', ['decision', 'Monitor hosts', '--what', 'Beszel.', '--reason', 'Cheap.', '--relates-to', 'workflow-dev']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /relates_to: workflow-dev: no record key/);
    r = fx.run('save.mjs', ['decision', 'Monitor hosts', '--what', 'Beszel.', '--reason', 'Cheap.', '--relates-to', 'P-008']);
    assert.equal(r.status, 0, r.out);
    const file = fs.readdirSync(path.join(fx.brain, 'decisions')).find((f) => f.startsWith('d-0001'));
    r = fx.run('save.mjs', ['decision', '--relink', 'D-0001', '--relates-to', 'beszel']);
    assert.equal(r.status, 1, 'a new link is checked');
    assert.match(r.stderr, /similar key: service-beszel/);
    r = fx.run('save.mjs', ['decision', '--relink', 'D-0001', '--relates-to', 'service-beszel', '--unrelate', 'P-008']);
    assert.equal(r.status, 0, r.out);
    const text = fx.read(`decisions/${file}`);
    assert.match(text, /^relates_to: \[service-beszel\]$/m);
    assert.match(text, /\*\*Rozhodnuté:\*\* Beszel\./, 'the body stays');
    r = fx.run('save.mjs', ['decision', '--relink', 'D-0001', '--unrelate', 'service-beszel']);
    assert.equal(r.status, 1, 'the last link stays');
    assert.match(r.stderr, /keeps at least one link/);
  } finally { fx.cleanup(); }
});

test('consolidate lists each link that resolves to nothing with the save command that fixes it', () => {
  const fx = setup();
  try {
    service(fx);
    plant(fx, 'memory/tool-probe.md', memoryRecord('tool-probe', 'Checks the port.', 'relates_to: [beszel, service-beszel, local/plan.md]\n'));
    plant(fx, 'decisions/d-0001-monitor.md', '---\nkey: D-0001\nid: D-0001\ntitle: Monitor\nstatus: valid\nrelates_to: [workflow-dev]\n---\nRozhodnuté: x.\n');
    const r = fx.run('consolidate.mjs', ['report']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /tool-probe\.md: beszel: no record key, decision, principle or file tracked in git \(similar key: service-beszel\)\n {4}save\.mjs memory tool probe --unrelate beszel --relates-to service-beszel/);
    assert.match(r.stdout, /tool-probe\.md: local\/plan\.md: no record key/);
    assert.match(r.stdout, /d-0001-monitor\.md: workflow-dev: no record key.*\n {4}save\.mjs decision --relink D-0001 --unrelate workflow-dev --relates-to <key\|D-NNNN\|P-NNN\|file>/);
    assert.doesNotMatch(r.stdout, /: service-beszel: /, 'a resolving link is not listed');
  } finally { fx.cleanup(); }
});

test('find: no match in the fields reads the bodies and prints only paths', () => {
  const fx = setup();
  try {
    service(fx);
    const r = fx.run('save.mjs', ['memory', 'tool', 'probe', '--content', 'Checks the port.\n\nRuns from the workflow-dev topic.']);
    assert.equal(r.status, 0, r.out);
    const f = fx.run('find.mjs', ['workflow-dev']);
    assert.equal(f.status, 0, f.out);
    assert.match(f.stdout, /^no match in key, name, aliases or description: workflow-dev; in the body of:\nmemory\/tool-probe\.md$/m);
    assert.doesNotMatch(f.stdout, /Checks the port/, 'only the path');
  } finally { fx.cleanup(); }
});
