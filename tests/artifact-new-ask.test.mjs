// ttl: 2026-12-18
// Operator 2026-11-18: two nearly identical reports, and an artifact cannot be deleted from a T3 thread. A new page in a
// topic that already has pages is refused once per path with those pages; a repeat, an update (url) or a first page passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newArtifactDeny, artifactsDir } from '../scripts/artifacts.mjs';

const thread = 't-1';
function brain(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-new-'));
  if (records) {
    fs.mkdirSync(artifactsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(artifactsDir(dir), `thread-${thread}.json`), JSON.stringify({ artifacts: records }));
  }
  return dir;
}
const publish = (file, url) => ({ tool_name: 'Artifact', cwd: '/', tool_input: { file_path: file, ...(url ? { url } : {}) } });
const old = { file: '/w/report-a.html', url: 'https://claude.ai/artifact/AAA', at: '2026-11-17T22:00:00Z' };

test('a new page in a topic with a page is refused once and names the page; a repeat passes', () => {
  const ctx = { brainDir: brain([old]), thread };
  const res = newArtifactDeny(ctx, publish('/w/report-b.html'));
  assert.equal(res.file, '/w/report-b.html');
  assert.match(res.reason, /report-a\.html -> https:\/\/claude\.ai\/artifact\/AAA/);
  assert.equal(newArtifactDeny(ctx, publish('/w/report-b.html'), [res.file]), null);
});

test('an update with url, the first page of a topic and an asset upload pass', () => {
  assert.equal(newArtifactDeny({ brainDir: brain([old]), thread }, publish('/w/report-b.html', old.url)), null);
  assert.equal(newArtifactDeny({ brainDir: brain(null), thread }, publish('/w/report-b.html')), null);
  const asset = { tool_name: 'Artifact', cwd: '/', tool_input: { file_path: '/w/a.png', url: old.url, asset: true } };
  assert.equal(newArtifactDeny({ brainDir: brain([old]), thread }, asset), null);
});
