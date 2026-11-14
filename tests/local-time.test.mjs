import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localTime } from '../scripts/util.mjs';

const UTIL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'util.mjs');

/** localTime in a child process with a fixed TZ: the zone comes from the process, not from an argument. */
function inZone(tz, value) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { localTime } from ${JSON.stringify(UTIL)}; process.stdout.write(localTime(${JSON.stringify(value)}))`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('localTime: winter CET and summer CEST from the process zone (TZ=Europe/Bratislava)', () => {
  assert.equal(inZone('Europe/Bratislava', '2026-11-13T23:30:05.717Z'), '2026-11-14 00:30 CET');
  assert.equal(inZone('Europe/Bratislava', '2026-07-01T22:15:00.000Z'), '2026-07-02 00:15 CEST');
});

test('localTime: ms and Date work, an explicit zone overrides the process, junk comes back as given', () => {
  const ms = Date.parse('2026-11-13T23:41:00.576Z');
  assert.equal(localTime(ms, { timeZone: 'Europe/Bratislava' }), '2026-11-14 00:41 CET');
  assert.equal(localTime(new Date(ms), { timeZone: 'UTC' }), '2026-11-13 23:41 UTC');
  assert.equal(localTime('not a time'), 'not a time');
  assert.equal(localTime(null), null);
  assert.equal(localTime(undefined), undefined);
});
