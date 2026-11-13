// Published artifacts (report-80357d47, 2026-11-13): the harness keeps the binding "file path -> artifact url" only in the
// conversation context. After a compaction a publish of the same path without `url` made a new address instead of updating
// the one the client had. PostToolUse records each publish in <brain>/local/artifacts/<topic>.json; PreToolUse refuses a
// publish of a recorded path without `url`; a compacted session start lists the topic's artifacts.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, toPosix } from './util.mjs';
import { heldTopics } from './topic.mjs';

export const ARTIFACT_TOOL = 'Artifact';
const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

export const artifactsDir = (brainDir) => path.join(brainDir, 'local', 'artifacts');

function recordKey(brainDir, thread) {
  let id = null;
  try { id = heldTopics(brainDir, thread)[0]?.id || null; } catch { id = null; }
  return id || `thread-${encodeURIComponent(String(thread || 'none'))}`;
}

/** A page publish (not an asset upload, not a create from a type) with a local file: { file, url|null }. */
export function pagePublish(input) {
  if (input?.tool_name !== ARTIFACT_TOOL) return null;
  const ti = input.tool_input || {};
  if (ti.action && ti.action !== 'publish') return null;
  if (ti.asset || ti.type_url || typeof ti.file_path !== 'string' || !ti.file_path) return null;
  const file = path.resolve(input.cwd || process.cwd(), ti.file_path);
  return { file, url: typeof ti.url === 'string' && ti.url ? ti.url : null };
}

/** All recorded artifacts of this brain: [{ file, url, at, key }]. */
export function readArtifacts(brainDir) {
  const dir = artifactsDir(brainDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.flatMap((n) => {
    const data = readJson(path.join(dir, n), null);
    return Array.isArray(data?.artifacts) ? data.artifacts.map((a) => ({ ...a, key: n.slice(0, -5) })) : [];
  });
}

export function recordedUrl(brainDir, file) {
  const hits = readArtifacts(brainDir).filter((a) => a.file === file && a.url);
  hits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return hits[0]?.url || null;
}

/** PostToolUse: record the url a successful page publish used or got. */
export function recordPublish(ctx, input, now = Date.now()) {
  if (!ctx.brainDir || input.hook_event_name === 'PostToolUseFailure') return null;
  const p = pagePublish(input);
  if (!p) return null;
  const url = p.url || (String(JSON.stringify(input.tool_response ?? '')).match(URL_RE) || [])[0] || null;
  if (!url) return null;
  const file = path.join(artifactsDir(ctx.brainDir), `${recordKey(ctx.brainDir, ctx.thread)}.json`);
  const data = readJson(file, null) || { artifacts: [] };
  const rest = (data.artifacts || []).filter((a) => a.file !== p.file);
  writeJson(file, { artifacts: [...rest, { file: p.file, url, at: new Date(now).toISOString(), thread: ctx.thread || null }] });
  return url;
}

export const REPUBLISH_REASON = (file, url) => `${toPosix(file)} was already published to ${url}: a publish without url makes a new address (the harness forgets the path after a compaction or in a new session); publish with url "${url}" (read it first with action read if this context has not published it) (report-80357d47)`;

/** PreToolUse: a publish of a recorded path without url is refused. */
export function republishDeny(ctx, input) {
  if (!ctx.brainDir) return null;
  const p = pagePublish(input);
  if (!p || p.url) return null;
  const url = recordedUrl(ctx.brainDir, p.file);
  return url ? REPUBLISH_REASON(p.file, url) : null;
}

/** SessionStart compact: the artifacts this thread's topic published, so the summary does not lose their addresses. */
export function artifactsNote(ctx) {
  if (!ctx.brainDir || !ctx.thread) return null;
  const key = recordKey(ctx.brainDir, ctx.thread);
  const own = readArtifacts(ctx.brainDir).filter((a) => a.key === key);
  if (!own.length) return null;
  return `published artifacts of this topic (update them with url, never a new address): ${own.slice(-10).map((a) => `${toPosix(a.file)} -> ${a.url}`).join('; ')} (report-80357d47)`;
}
