// Identity of a brain in the mail (mail model 3, agentic-comms docs/MODEL.md "Identita témy"): a topic is brain + machine +
// project + topic. The one source of the brain id: `brain_id` of the brain's policy.json (brain-init.mjs writes a random
// one), else the first 12 characters of the oldest root commit of the brain's git history (the same in every clone,
// another one for another brain). A shallow clone or a brain without a commit has no id: an error, never a guess.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, git } from './util.mjs';
import { dataPath } from './layout.mjs';

const ids = new Map();

/** Readable name of the brain in the mail (X-Comms-Brain-Name): the name of its directory, not its identity. */
export function brainName(brainDir) {
  return path.basename(path.resolve(brainDir));
}

/** Brain id of `brainDir` (cached per process); throws with the fix when it cannot be told. */
export function brainId(brainDir) {
  const key = path.resolve(brainDir);
  if (ids.has(key)) return ids.get(key);
  const own = readJson(dataPath(key, 'policy'), null)?.brain_id;
  let id = typeof own === 'string' && own.trim() ? own.trim() : null;
  if (!id) {
    const fix = `set "brain_id" in ${dataPath(key, 'policy')} (a random id, e.g. node -e "console.log(require('crypto').randomBytes(6).toString('hex'))") and commit it`;
    const gitDir = path.join(key, '.git');
    const shallow = fs.existsSync(path.join(gitDir, 'shallow')) || (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory() ? git(['rev-parse', '--is-shallow-repository'], { cwd: key }).stdout === 'true' : false);
    if (shallow) throw new Error(`brain id of ${key}: a shallow clone has no root commit to take it from; fetch the full history (git fetch --unshallow) or ${fix}`);
    const roots = git(['log', '--max-parents=0', '--format=%ct %H', 'HEAD'], { cwd: key });
    const list = roots.ok ? roots.stdout.split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 2 && /^[0-9a-f]{12,}$/.test(p[1])) : [];
    if (!list.length) throw new Error(`brain id of ${key}: no commit in the brain; ${fix}`);
    list.sort((a, b) => Number(a[0]) - Number(b[0]) || a[1].localeCompare(b[1]));
    id = list[0][1].slice(0, 12);
  }
  ids.set(key, id);
  return id;
}
