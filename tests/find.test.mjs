// P-031: deterministic find.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { find, findWords, findRelatesTo, findSimilar } from '../scripts/find.mjs';

test('P-031: find: key, alias and normalized name match; similar key does not; --relates-to finds decisions', () => {
  const fx = setup();
  try {
    fs.writeFileSync(path.join(fx.brain, 'memory', 'service-x-service.md'), '---\nkey: service-x-service\ntype: service\nname: X Service\norigin: operator\naliases: [xs, "X Svc"]\n---\nprístup a tokeny\n');
    fs.writeFileSync(path.join(fx.brain, 'memory', 'tool-curl.md'), '---\nkey: tool-curl\ntype: tool\nname: curl\norigin: operator\n---\nflags\n');
    fs.writeFileSync(path.join(fx.brain, 'decisions', 'd-0001-lib.md'), '---\nkey: D-0001\nid: D-0001\ntitle: Library A over B\nstatus: valid\nrelates_to: [src/app.js, deploy-web-docker]\n---\nA, nie B\n');
    fs.mkdirSync(path.join(fx.brain, 'skills', 'agentic', 'x-api'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'agentic', 'x-api', 'SKILL.md'), '---\nname: x-api\ndescription: Použi, keď voláš X API\norigin: error\naliases: [xapi]\n---\nx\n');

    let m = find(fx.brain, 'service-x-service');
    assert.equal(m.length, 1); assert.equal(m[0].path, 'memory/service-x-service.md'); assert.equal(m[0].description, 'prístup a tokeny');
    assert.equal(find(fx.brain, 'xs')[0].path, 'memory/service-x-service.md');
    assert.equal(find(fx.brain, 'X Svc')[0].path, 'memory/service-x-service.md');
    assert.equal(find(fx.brain, 'x service')[0].path, 'memory/service-x-service.md');
    assert.deepEqual(find(fx.brain, 'service-xs'), []);
    assert.deepEqual(find(fx.brain, 'service-x'), []);
    assert.equal(find(fx.brain, 'xapi')[0].kind, 'skill');
    assert.ok(findSimilar(fx.brain, 'service-x-service-prod').some((s) => s.key === 'service-x-service'));
    assert.deepEqual(findSimilar(fx.brain, 'tool-x-service'), []);
    const rel = findRelatesTo(fx.brain, 'src/app.js');
    assert.equal(rel.length, 1); assert.equal(rel[0].id, 'D-0001');
    assert.equal(findRelatesTo(fx.brain, path.join(fx.project, 'src', 'app.js')).length, 1);
    assert.equal(findRelatesTo(fx.brain, 'deploy-web-docker').length, 1);
    assert.deepEqual(findRelatesTo(fx.brain, 'src/other.js'), []);

    const cli = fx.run('find.mjs', ['xs']);
    assert.equal(cli.stdout.trim(), 'memory/service-x-service.md: prístup a tokeny');
    assert.equal(fx.run('find.mjs', ['nothing-here']).stdout.trim(), 'no match: nothing-here');
    assert.match(fx.run('find.mjs', ['--relates-to', 'src/app.js']).stdout, /decisions\/d-0001-lib\.md: Library A over B/);
  } finally { fx.cleanup(); }
});

test('P-031: findWords: word from description or name finds a skill; exact find stays exact; CLI falls back', () => {
  const fx = setup();
  try {
    fs.mkdirSync(path.join(fx.brain, 'skills', 'agentic', 'nasadzovanie-na-server'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'skills', 'agentic', 'nasadzovanie-na-server', 'SKILL.md'), '---\nname: nasadzovanie-na-server\ndescription: Použi, keď nasadzuješ službu na server alebo upravuješ personu\norigin: error\n---\nx\n');
    assert.deepEqual(find(fx.brain, 'server'), []);
    assert.equal(findWords(fx.brain, 'server')[0].path, 'skills/agentic/nasadzovanie-na-server/SKILL.md');
    assert.equal(findWords(fx.brain, 'personu')[0].kind, 'skill');
    assert.equal(findWords(fx.brain, 'server službu').length, 1);
    assert.deepEqual(findWords(fx.brain, 'server docker'), []);
    const out = fx.run('find.mjs', ['server']).stdout;
    assert.match(out, /^no exact match: server; word matches:\nskills\/agentic\/nasadzovanie-na-server\/SKILL\.md: Použi/);
    assert.equal(fx.run('find.mjs', ['nasadzovanie-na-server']).stdout.split('\n')[0], 'skills/agentic/nasadzovanie-na-server/SKILL.md: Použi, keď nasadzuješ službu na server alebo upravuješ personu');
    assert.equal(fx.run('find.mjs', ['docker']).stdout.trim(), 'no match: docker');
  } finally { fx.cleanup(); }
});
