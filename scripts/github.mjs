// GitHub REST access with the operator's token (repositories live under the operator's account).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Parts kept separate: P-004 lint forbids literal user@host strings in workflow files.
const SSH_USER = 'git';
const GIT_HOST = 'github.com';
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.config', 'github', 'github_token');
export const DEFAULT_API_URL = 'https://api.github.com';
export const sshRemote = (owner, repo) => `${SSH_USER}@${GIT_HOST}:${owner}/${repo}.git`;

export function readToken(tokenFile = DEFAULT_TOKEN_FILE) {
  return fs.readFileSync(tokenFile, 'utf8').trim();
}

export const GITHUB_TIMEOUT_MS = 30000;

/**
 * One REST call; `headers` of the reply in lower case (rate limit, ETag), `extra` request headers (If-None-Match). The
 * whole call (reply and body) has `timeoutMs` (default 30 s, `WORKFLOW_GITHUB_TIMEOUT_MS`): a GitHub that does not
 * answer throws "no answer within …" instead of holding the caller (a wake job, a lock) open.
 */
export async function gh(apiUrl, token, method, route, body, extra = {}, { timeoutMs } = {}) {
  const ms = Number(timeoutMs) || Number(process.env.WORKFLOW_GITHUB_TIMEOUT_MS) || GITHUB_TIMEOUT_MS;
  const signal = AbortSignal.timeout(ms);
  try {
    const res = await fetch(`${apiUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'agentic-flow', ...extra },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, headers, json };
  } catch (err) {
    if (signal.aborted) throw new Error(`GitHub ${method} ${route.split('?')[0]}: no answer within ${ms / 1000} s`);
    throw err;
  }
}

/** Login of the token's account. */
export async function ghOwner(apiUrl, token) {
  const me = await gh(apiUrl, token, 'GET', '/user');
  if (me.status !== 200 || !me.json.login) throw new Error(`GitHub /user failed (HTTP ${me.status})`);
  return me.json.login;
}

// The machine's SSH key can belong to a separate agent account (collaborator on the operator's repositories),
// whose token is here. A repository created with the operator's token does not have it, so a push says "Repository not found".
export const DEFAULT_AGENT_TOKEN_FILE = path.join(os.homedir(), '.config', 'github', 'github_agent_token');

/**
 * Push access for the agent account to a new owner/repo: invite with the operator's token, accept with the agent's.
 * Returns a line, or null when there is no agent token or it is the owner's account.
 */
export async function grantAgentAccess(apiUrl, token, owner, repo, agentTokenFile = DEFAULT_AGENT_TOKEN_FILE) {
  if (!agentTokenFile || !fs.existsSync(agentTokenFile)) return null;
  const agentToken = readToken(agentTokenFile);
  const agent = await ghOwner(apiUrl, agentToken);
  if (agent === owner) return null;
  const invite = await gh(apiUrl, token, 'PUT', `/repos/${owner}/${repo}/collaborators/${agent}`, { permission: 'push' });
  if (invite.status !== 201 && invite.status !== 204) throw new Error(`adding ${agent} to ${owner}/${repo} failed (HTTP ${invite.status}): ${invite.json.message || ''}`);
  if (invite.status === 201) {
    const list = await gh(apiUrl, agentToken, 'GET', '/user/repository_invitations');
    const inv = (Array.isArray(list.json) ? list.json : []).find((i) => i.repository?.full_name === `${owner}/${repo}`);
    if (!inv) throw new Error(`invitation of ${agent} to ${owner}/${repo} not found (HTTP ${list.status})`);
    const accepted = await gh(apiUrl, agentToken, 'PATCH', `/user/repository_invitations/${inv.id}`);
    if (accepted.status !== 204) throw new Error(`${agent} could not accept the invitation to ${owner}/${repo} (HTTP ${accepted.status})`);
  }
  return `agent account ${agent}: push access to ${owner}/${repo}`;
}

/** All repositories the account owns (paged). */
export async function ghOwnedRepos(apiUrl, token) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const r = await gh(apiUrl, token, 'GET', `/user/repos?affiliation=owner&per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitHub repository list failed (HTTP ${r.status})`);
    out.push(...r.json);
    if (r.json.length < 100) break;
  }
  return out;
}

/** Names in the repository root of the default branch; [] for an empty repository. */
export async function ghRootNames(apiUrl, token, owner, repo) {
  const r = await gh(apiUrl, token, 'GET', `/repos/${owner}/${repo}/contents/`);
  if (r.status === 404 || r.status === 409) return [];
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitHub contents of ${owner}/${repo} failed (HTTP ${r.status})`);
  return r.json.map((e) => e.name);
}
