// Adoption (connect --adopt): the welcome thread "vitaj" starts at `wizard end`, not with connect, and knows the adoption
// topic tidies the older setup. Started with connect, it proposed moving CLAUDE.md into the brain while the adoption topic
// did the same: both threads deleted CLAUDE.md and edited the same skills (alice 2026-11-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

test('project.mjs t3 --adopt: no welcome thread until wizard end; then it starts once with the adoption note', () => {
  const fx = setup();
  try {
    const cfg = path.join(fx.root, 'cfg');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.claude.json'), '{"projects":{}}');
    const log = path.join(fx.root, 't3.log');
    const fake = path.join(fx.root, 'fake-t3.mjs');
    fs.writeFileSync(fake, `import fs from 'node:fs';\nconst input = process.argv.includes('-') ? fs.readFileSync(0, 'utf8') : '';\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');\nconsole.log('{"threadId":"t1"}');\n`);
    const t3 = `${process.execPath} ${fake}`;
    fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ project: { t3_project_add_command: `${t3} project add` }, topics: { thread_start_command: `${t3} thread start --json` } }));
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    const env = { env: { CLAUDE_CONFIG_DIR: cfg } };
    assert.equal(fx.run('project.mjs', ['wizard', 'start', 'shop'], env).status, 0);
    const r = fx.run('project.mjs', ['t3', fx.project, '--name', 'shop', '--adopt'], env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /welcome thread "vitaj" starts at wizard end/);
    assert.deepEqual(calls().map((c) => c.args.slice(0, 2)), [['project', 'add']], 'connect --adopt starts no thread');
    const end = fx.run('project.mjs', ['wizard', 'end'], env);
    assert.equal(end.status, 0, end.out);
    assert.match(end.out, /wizard closed[\s\S]*welcome thread "vitaj" started/);
    const threads = calls().filter((c) => c.args[0] === 'thread');
    assert.equal(threads.length, 1);
    assert.match(threads[0].input, /Vitaj v projekte shop[\s\S]*prevzatý[\s\S]*téma prevzatia/);
    fx.run('project.mjs', ['wizard', 'start', 'shop'], env);
    fx.run('project.mjs', ['wizard', 'end'], env);
    assert.equal(calls().filter((c) => c.args[0] === 'thread').length, 1, 'a second wizard end starts no second thread');
  } finally { fx.cleanup(); }
});
