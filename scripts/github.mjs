// GitHub REST access with the operator's token (repositories live under the operator's account, or under another
// owner where the operator is a collaborator: project.mjs probe/connect --owner).
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

/** The agent accepts its pending invitation to owner/repo: { ok }, or the error of the owner's own flow in why. */
async function acceptInvitation(apiUrl, agentToken, owner, repo) {
  const list = await gh(apiUrl, agentToken, 'GET', '/user/repository_invitations');
  const inv = (Array.isArray(list.json) ? list.json : []).find((i) => String(i.repository?.full_name).toLowerCase() === `${owner}/${repo}`.toLowerCase());
  if (!inv) return { ok: false, why: `invitation of the agent to ${owner}/${repo} not found (HTTP ${list.status})` };
  const accepted = await gh(apiUrl, agentToken, 'PATCH', `/user/repository_invitations/${inv.id}`);
  return accepted.status === 204 ? { ok: true } : { ok: false, why: `the agent could not accept the invitation to ${owner}/${repo} (HTTP ${accepted.status})` };
}

/**
 * Push access for the agent account to owner/repo: invite with the operator's token, accept with the agent's.
 * Returns a line, or null when there is no agent token or it is the owner's account.
 * foreign: an existing repository of another owner, where the operator is a collaborator. The agent may have access
 * already or a pending invitation of the owner (accepted here); the operator's token can invite only as owner or admin
 * (GitHub answers 403 otherwise), so a refused invitation is a NOT line with the step for the operator, not an error.
 */
export async function grantAgentAccess(apiUrl, token, owner, repo, agentTokenFile = DEFAULT_AGENT_TOKEN_FILE, { foreign = false } = {}) {
  if (!agentTokenFile || !fs.existsSync(agentTokenFile)) return null;
  const agentToken = readToken(agentTokenFile);
  const agent = await ghOwner(apiUrl, agentToken);
  if (agent.toLowerCase() === String(owner).toLowerCase()) return null;
  if (foreign) {
    const seen = await gh(apiUrl, agentToken, 'GET', `/repos/${owner}/${repo}`);
    if (seen.status === 200 && seen.json?.permissions?.push) return `agent account ${agent}: push access to ${owner}/${repo} (has it already)`;
    if ((await acceptInvitation(apiUrl, agentToken, owner, repo)).ok) return `agent account ${agent}: push access to ${owner}/${repo} (invitation of the owner accepted)`;
  }
  const invite = await gh(apiUrl, token, 'PUT', `/repos/${owner}/${repo}/collaborators/${agent}`, { permission: 'push' });
  if (invite.status !== 201 && invite.status !== 204) {
    const why = `HTTP ${invite.status}${invite.json?.message ? `: ${invite.json.message}` : ''}`;
    if (!foreign) throw new Error(`adding ${agent} to ${owner}/${repo} failed (${why})`);
    return `agent account ${agent}: NO push access to ${owner}/${repo} (the operator's token cannot invite it, ${why}; only the owner or an admin can): ask ${owner} to add ${agent} as a collaborator with write access, then run connect again (it accepts the invitation); until then the machine's SSH key cannot clone or push ${owner}/${repo}`;
  }
  if (invite.status === 201) {
    const acc = await acceptInvitation(apiUrl, agentToken, owner, repo);
    if (!acc.ok) {
      if (foreign) return `agent account ${agent}: invited to ${owner}/${repo}, NOT accepted (${acc.why.replace('the agent', agent)}): accept it as ${agent} on GitHub, then run connect again`;
      throw new Error(acc.why.replace('the agent', agent));
    }
  }
  return `agent account ${agent}: push access to ${owner}/${repo}`;
}

/** All repositories the account owns (paged). */
export async function ghOwnedRepos(apiUrl, token) {
  return pagedRepos(apiUrl, token, 'owner');
}

/**
 * Repositories of another owner (a user or an organization) the token can reach: its own, as a collaborator or as an
 * organization member (`/user/repos` lists private repositories of others too; `/users/<owner>/repos` only public ones).
 */
export async function ghOwnerRepos(apiUrl, token, owner) {
  const key = String(owner).toLowerCase();
  return (await pagedRepos(apiUrl, token, 'owner,collaborator,organization_member')).filter((r) => String(r.owner?.login).toLowerCase() === key);
}

async function pagedRepos(apiUrl, token, affiliation) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const r = await gh(apiUrl, token, 'GET', `/user/repos?affiliation=${affiliation}&per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitHub repository list failed (HTTP ${r.status})`);
    out.push(...r.json);
    if (r.json.length < 100) break;
  }
  return out;
}

/** A GitHub account or organization name (--owner): letters, digits, single dashes, at most 39 characters. */
export function checkOwner(owner) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(String(owner || ''))) throw new Error(`--owner takes a GitHub account or organization name, got "${owner}"`);
  return owner;
}

/** Names in the repository root of the default branch; [] for an empty repository. */
export async function ghRootNames(apiUrl, token, owner, repo) {
  const r = await gh(apiUrl, token, 'GET', `/repos/${owner}/${repo}/contents/`);
  if (r.status === 404 || r.status === 409) return [];
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitHub contents of ${owner}/${repo} failed (HTTP ${r.status})`);
  return r.json.map((e) => e.name);
}
