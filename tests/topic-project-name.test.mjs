// ttl: 2026-12-14
// topic.mjs --project <name>: a bare repo name from the persona brain finds the sibling repo of the domain
// (maintainer/workflow-dev 2026-11-14: --project agentic-flow resolved as <brain>/agentic-flow, "brain unavailable").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { persona2, gitq } from './layout-2-helpers.mjs';
import { initProject } from './helpers.mjs';

function domainFixture() {
  const p = persona2();
  fs.writeFileSync(path.join(p.root, '.agentic-domain'), '{"brain":"bob"}');
  const srv = path.join(p.root, 'srv');
  initProject(srv, { brainRel: '../bob' });
  return { ...p, srv };
}

test('create --project <repo name> from the persona brain finds the sibling repo of the domain', () => {
  const fx = domainFixture();
  try {
    const r = fx.run('topic.mjs', ['create', 'alpha', '--class', 'code', '--subject', 's', '--project', 'srv', '--here', '--no-copy']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /brain unavailable/);
    assert.match(r.out, /topic alpha created/);
    const log = gitq(fx.dir, 'log', '--oneline', '-3');
    assert.match(log, /alpha/);
  } finally { fx.cleanup(); }
});

test('create --project <unknown name> says it expects a repo name of the domain or a path and lists the repos', () => {
  const fx = domainFixture();
  try {
    const r = fx.run('topic.mjs', ['create', 'beta', '--class', 'code', '--subject', 's', '--project', 'nope', '--here', '--no-copy']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /expected the name of a repo in the domain or a path to it/);
    assert.match(r.out, /repos: .*srv/);
  } finally { fx.cleanup(); }
});
