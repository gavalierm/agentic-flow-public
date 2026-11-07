// Create a persona: private GitHub repo "agent-<name>" + brain in its domain ~/agentic/<Name>/agent-<name> (P-024, v3;
// the domain folder has an upper case first letter, domainDirName).
// The domain folder carries the .agentic-domain marker with brain agent-<name>; the persona repo is its own brain (".").
// The repo name is derived here; if it already exists the script fails (no fallback name).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { personaRepoName } from './persona-name.mjs';
import { brainInit } from '../bin/brain-init.mjs';
import { gh, sshRemote, DEFAULT_TOKEN_FILE } from './github.mjs';
import { DOMAIN_MARKER, domainDir } from './config.mjs';

export async function createPersona(name, {
  root = path.join(os.homedir(), 'agentic'),
  tokenFile = DEFAULT_TOKEN_FILE,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  remoteFor = sshRemote,
} = {}) {
  const repo = personaRepoName(name);
  const domain = domainDir(path.resolve(root), name);
  const dir = path.join(domain, repo);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  const marker = path.join(domain, DOMAIN_MARKER);
  if (fs.existsSync(marker) && (JSON.parse(fs.readFileSync(marker, 'utf8') || '{}').brain || repo) !== repo) throw new Error(`${marker} names another brain; a domain has one brain`);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();

  const me = await gh(apiUrl, token, 'GET', '/user');
  if (me.status !== 200 || !me.json.login) throw new Error(`GitHub /user failed (HTTP ${me.status})`);
  const owner = me.json.login;

  const probe = await gh(apiUrl, token, 'GET', `/repos/${owner}/${repo}`);
  if (probe.status === 200) throw new Error(`repository ${owner}/${repo} already exists; resolve it (archive/rename the old one) and run again - no other name is used`);
  if (probe.status !== 404) throw new Error(`cannot verify that ${owner}/${repo} is free (HTTP ${probe.status})`);

  const made = await gh(apiUrl, token, 'POST', '/user/repos', { name: repo, private: true });
  if (made.status !== 201) throw new Error(`creating ${owner}/${repo} failed (HTTP ${made.status}): ${made.json.message || ''}`);
  if (made.json.name !== repo) throw new Error(`GitHub created "${made.json.name}" instead of "${repo}"`);

  fs.mkdirSync(domain, { recursive: true });
  const res = brainInit(dir, { remote: remoteFor(owner, repo), persona: true });
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ brain: repo }, null, 2) + '\n');
  return { owner, repo, dir, domain, created: res.created };
}
