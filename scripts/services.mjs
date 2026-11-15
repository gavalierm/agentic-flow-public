// Installed releases (v3, D-0003): ~/services/<repo>/ is a detached checkout of a release tag of the working repo in its
// domain. It is the only way ~/services changes: direct writes there are denied by PreToolUse (servicesWrite) unless the operator lists the path in domain.allow_outside.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './util.mjs';
import { servicesDir } from './config.mjs';
import { redactUrl } from './secrets.mjs';

function must(r, what) {
  if (r.status !== 0) throw new Error(`${what}: ${redactUrl(r.stderr || r.stdout)}`);
  return r.stdout;
}

/** Latest release tag of a repo (vX.Y.Z by version order). */
export function latestTag(repo) {
  const tags = must(git(['tag', '--list', 'v[0-9]*', '--sort=-v:refname'], { cwd: repo }), 'git tag').split('\n').filter(Boolean);
  if (!tags.length) throw new Error(`${repo} has no release tag v*`);
  return tags[0];
}

/**
 * Install (or switch) ~/services/<basename of repo> to a release tag of repo. Clones from the repo's origin when the
 * install is missing; refuses an install with local changes (a release is never edited in place).
 */
export function install(repo, tag, env = process.env) {
  const src = path.resolve(repo);
  if (!fs.existsSync(path.join(src, '.git'))) throw new Error(`${src} is not a git repository`);
  const name = path.basename(src);
  const dst = path.join(servicesDir(env), name);
  const want = tag || latestTag(src);
  must(git(['rev-parse', '-q', '--verify', `refs/tags/${want}`], { cwd: src }), `tag ${want} in ${src}`);
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const origin = git(['remote', 'get-url', 'origin'], { cwd: src });
    must(git(['clone', '-q', origin.status === 0 ? origin.stdout : src, dst]), 'git clone');
  } else {
    const dirty = must(git(['status', '--porcelain', '--untracked-files=no'], { cwd: dst }), 'git status');
    if (dirty) throw new Error(`${dst} has local changes; an installed release is never edited in place:\n${dirty}`);
  }
  must(git(['fetch', '-q', '--tags', 'origin'], { cwd: dst }), 'git fetch');
  must(git(['-c', 'advice.detachedHead=false', 'checkout', '-q', want], { cwd: dst }), `git checkout ${want}`);
  return { name, dir: dst, tag: want };
}
