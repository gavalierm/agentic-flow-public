// Move of a domain from data layout 2 to layout 3 (flow v2, spec 11.2, 11.5 to 11.10, 11.12; plan B17). The second table
// of moves of migrate.mjs (bin/migrate.mjs --to 3): a domain moves at once, the brain with every project repo of the
// domain (the repos in the domain folder whose .workflow.json names the brain), one commit in each repository, so a revert
// of these commits brings layout 2 back (11.7). A repository in layout 1 moves to layout 2 first (migrate.mjs --apply).
//
// The brain (LAYOUTS[2] -> layout 3 brain map): .brain/<memory|rules|skills|exceptions|logs|runbooks>/ to the root,
// .brain/policy.json -> policy.json (data_layout 3, policy keys of 1.8.0 removed), vystupy/rozhodnutia/ -> decisions/,
// temy/<id>/ -> topics/<id>/ with zavery/ flattened into the topic folder (11.9), the handover with the sixth section
// "## Úlohy pre operátora" (P-011 of 2.0 refuses five), the topic record without orchestrator and fix_gate and with mode,
// repos and turn (spec 13, O1), consents.json removed; a closed topic and the hidden archive .brain/archive/topics are
// removed (layout 3 has no archive: a closed topic ends, spec 5); INDEX.md regenerated; paths in the text records rewritten.
// vystupy/<typ>/ and zdroje/ of the brain go to a project repo (spec 4.5, 11.12): each item by a TSV row the operator
// confirmed (--confirmed: cesta, navrh `<repo>:vystupy/<typ>/` | `<repo>:zdroje/<tema>/` | pomocne, tema (front matter
// `topic:` of an output), dovod); without a confirmed row the apply is refused. The same rows move any other item of the
// brain (a topic folder, a skill, a rule) into another repository of layout 3 (the brain of a new domain, 11.12).
// A fact about a person in .brain/memory/ is removed only when people.mjs collect --apply carried it into osoby/ of the
// operator repo (its `migrated_from`), or when the operator approved its removal (11.8). A rule or a skill of the domain
// that names a principle 2.0 does not adopt (NOT_ADOPTED, spec kap. 9) blocks the apply until --approve names it
// (`zmazat`, or `prepisat <file>` with a new text without the reference, 11.9).
// A project repo: data_layout 3 in .brain/policy.json, knowledge_branch of .workflow.json -> target_branch (O12), the
// hidden archive removed, references to moved paths of its brain rewritten in .brain/ and vystupy/, incoming outputs
// and sources from the brain (with their sources.json entries), INDEX.md regenerated.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, readJson, PLUGIN_ROOT } from './util.mjs';
import { BRAIN_COMMIT_TAG, MIGRATE_MOVE_ENV, DOMAIN_MARKER, WORKFLOW_CONFIG, WORKTREES_DIR, brainScriptEnv } from './config.mjs';
import { LAYOUTS, LAYOUT_KEY, ROLE_BRAIN, ROLE_REPO, layoutFor, dataLayoutVersion, layoutRole } from './layout.mjs';
import { checkBrainFile, checkHandover, TASKS_SECTION, QUESTIONS_SECTION, handoverNextStep, handoverQuestions, handoverTasks } from './brain-checks.mjs';
import { INDEX_FILE, refreshIndex, indexProblem, commitIndexAfterMerge } from './data-index.mjs';
import { MODES } from './topic-files.mjs';
import { turnFields } from './topic-state.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { operatorRepo, readPeople } from './people.mjs';
import { trackedFiles, readyForMove, readTriage, regenerateAdapter, adapterCommand } from './migrate.mjs';
import { defaultRepoName } from './target.mjs';

const L2 = LAYOUTS[2];
const B3 = layoutFor(3, ROLE_BRAIN);
const R3 = layoutFor(3, ROLE_REPO);
export const FROM = 2;
export const TO = 3;
export const COMMIT_SUBJECT = 'migrate data layout 2 -> 3';
/** The record of the move beside the policy of the layout: the brain's root, .brain/ of a project repo. */
export const RECORD_NAME = 'migrate-2-3.tsv';
export const recordRel = (role) => path.posix.join(path.posix.dirname(role === ROLE_REPO ? R3.policy : B3.policy), RECORD_NAME).replace(/^\.\//, '');
/** Principles of 1.8.0 that 2.0 does not adopt (spec kap. 9, plan 3.2): P-050, P-055, P-064, P-075. */
export const NOT_ADOPTED = ['P-050', 'P-055', 'P-064', 'P-075'];
/** The principles of NOT_ADOPTED a line names. */
const namedPrinciples = (line) => [...new Set([...String(line).matchAll(new RegExp(`\\b(${NOT_ADOPTED.join('|')})\\b`, 'g'))].map((m) => m[1]))];
/** Policy keys of 1.8.0 that 2.0 has no more (B7, B15, B6, P-027). */
export const REMOVED_POLICY_KEYS = [['topics', 'auto'], ['topics', 'auto_max_active'], ['topics', 'stall_check_minutes'], ['limits', 'worker_result_chars']];
/** Fields of a topic record that 2.0 has no more (B7: no orchestrator, no fix gate). */
export const REMOVED_TOPIC_FIELDS = ['orchestrator', 'fix_gate'];
const CONSENTS = 'consents.json';
const CONCLUSIONS = 'zavery';
const OLD_RECORD = `${path.posix.dirname(L2.policy)}/migrate-1-2.tsv`;
const SOURCES = `${path.posix.dirname(L2.policy)}/sources.json`;
const PERSON_TYPES = ['person', 'operator'];
const INFRA = new Set(['.gitattributes', '.gitignore', '.githooks', 'README.md', 'CLAUDE.md', 'AGENTS.md', WORKFLOW_CONFIG, '.claude', '.codex', '.agents', '.mcp.json', INDEX_FILE]);
const TEXT_EXT = new Set(['.md', '.json', '.txt', '.yml', '.yaml', '.html', '.htm']);
const OUTPUTS = L2.docs.split('/')[0]; // vystupy
const KNOWLEDGE = path.posix.dirname(L2.policy); // .brain
/** Records of the brain of layout 2 under .brain/ and their place in layout 3. */
const BRAIN_FOLDERS = ['memory', 'rules', 'skills', 'exceptions', 'logs', 'runbooks'];
const STATUS = { move: 'presun', stay: 'ostava', out: 'do-repa', removed: 'zmazane', closed: 'uzavreta-zmazana', archive: 'archiv-zmazany', person: 'osoba-zmazana', lesson: 'poucenie-zmazane', rewritten: 'poucenie-prepisane', placeholder: 'zastupny-zmazany' };

const posix = (p) => String(p).split(path.sep).join('/');
const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const same = (a, b) => real(a) === real(b);
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const firstLine = (s) => String(s || '').split('\n')[0];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isText = (rel) => TEXT_EXT.has(path.posix.extname(rel).toLowerCase());
const GIT_PATHS = ['-c', 'core.quotepath=false'];

/** Content of a file: text, or the bytes of a binary one. */
function readContent(abs) {
  const buf = fs.readFileSync(abs);
  return buf.includes(0) ? buf : buf.toString('utf8');
}

// ---- domain -----------------------------------------------------------------------------------------------------------

/**
 * The domain of a repository: { brain, domainDir, repos }. The brain is the repository itself when its .workflow.json
 * names none or names itself (a persona), else the one it names. Project repos: the git repositories of the domain folder
 * (marker .agentic-domain, or `domain` of the brain's .workflow.json) whose .workflow.json names that brain.
 */
export function domainOf(dir) {
  const start = path.resolve(dir);
  const cfg = readJson(path.join(start, WORKFLOW_CONFIG), null);
  const named = cfg && typeof cfg.brain === 'string' && cfg.brain.trim() ? path.resolve(start, cfg.brain) : null;
  const brain = named && !same(named, start) ? named : start;
  const bcfg = readJson(path.join(brain, WORKFLOW_CONFIG), null);
  let domainDir = bcfg && typeof bcfg.domain === 'string' ? path.resolve(brain, bcfg.domain) : null;
  if (!domainDir && fs.existsSync(path.join(path.dirname(brain), DOMAIN_MARKER))) domainDir = path.dirname(brain);
  const repos = [];
  const add = (d) => { if (!same(d, brain) && !repos.some((r) => same(r, d))) repos.push(d); };
  if (!same(start, brain)) add(start);
  if (domainDir && fs.existsSync(domainDir)) {
    for (const e of fs.readdirSync(domainDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const d = path.join(domainDir, e.name);
      const c = readJson(path.join(d, WORKFLOW_CONFIG), null);
      if (!fs.existsSync(path.join(d, '.git')) || !c || typeof c.brain !== 'string') continue;
      if (same(path.resolve(d, c.brain), brain)) add(d);
    }
  }
  repos.sort((a, b) => a.localeCompare(b));
  return { brain, domainDir, repos };
}

/** A target repository of a TSV row: a repository of the domain by name, else a path relative to the domain folder. */
function resolveRepo(name, dom) {
  const base = dom.domainDir || path.dirname(dom.brain);
  const all = [dom.brain, ...dom.repos];
  const byName = all.find((d) => path.basename(d) === name);
  if (byName) return byName;
  const dir = path.resolve(base, name);
  return fs.existsSync(path.join(dir, '.git')) ? dir : null;
}

// ---- path rules and the rewriter --------------------------------------------------------------------------------------

/**
 * Rules from paths of the brain in layout 2 to their place after the move: { from, repo, to } (a folder ends with `/`;
 * repo: the absolute repository the path is in after the move). The rewriter renders a target relative to the
 * repository of the file it rewrites (`../<repo>/vystupy/...` from another repo) and keeps an absolute path absolute.
 */
function makeRewriter(rules, brainDir) {
  const folders = rules.filter((r) => r.from.endsWith('/')).sort((a, b) => b.from.length - a.from.length);
  const files = new Map(rules.filter((r) => !r.from.endsWith('/')).map((r) => [r.from, r]));
  const resolve = (p) => {
    if (files.has(p)) return { repo: files.get(p).repo, to: files.get(p).to };
    for (const f of folders) {
      if (p.startsWith(f.from)) return { repo: f.repo, to: f.to + p.slice(f.from.length) };
      if (p === f.from.slice(0, -1)) return { repo: f.repo, to: f.to.replace(/\/$/, '') };
    }
    return null;
  };
  const render = (hit, fromRepo) => {
    const rel = posix(path.relative(fromRepo, hit.repo));
    return rel ? `${rel}/${hit.to}` : hit.to;
  };
  const split = (raw) => /^(.*?)((?:#[^/]*|:\d+(?::\d+)?)?[.:!?]*)$/.exec(raw).slice(1);
  // A path starts after a space or an opening bracket or quote (never with one: `[temy/x.md]` is the path temy/x.md).
  const TOKEN = /(^|[\s(\[{<"'`=,])(\.\/)?([^\s)\]}>"'`,;|*(\[{<][^\s)\]}>"'`,;|*]*)/g;
  const prefixes = [...new Set([path.resolve(brainDir), real(brainDir)])].map((p) => `${posix(p)}/`);
  const name = path.basename(path.resolve(brainDir));
  /**
   * The text with the references rewritten. relative: references relative to the brain are read (a file of the brain or
   * one that comes from it); always: absolute paths under the brain; `../<brain>/` from a project repo.
   */
  const rewrite = (text, { fileRepo = brainDir, relative = true } = {}) => {
    const hits = [];
    let out = String(text);
    if (relative) {
      out = out.replace(TOKEN, (all, lead, dot, raw) => {
        const [p, tail] = split(raw);
        const hit = p.split('/').length >= 2 ? resolve(p) : null;
        if (!hit) return all;
        hits.push({ from: p, to: render(hit, fileRepo) });
        return `${lead}${dot || ''}${render(hit, fileRepo)}${tail}`;
      });
    }
    for (const pre of prefixes) {
      out = out.replace(new RegExp(`${escRe(pre)}([^\\s)\\]}>"'\`,;|*]+)`, 'g'), (all, raw) => {
        const [p, tail] = split(raw);
        const hit = resolve(p);
        if (!hit) return all;
        hits.push({ from: `${pre}${p}`, to: posix(path.join(hit.repo, hit.to)) });
        return `${posix(path.join(hit.repo, hit.to))}${hit.to.endsWith('/') ? '/' : ''}${tail}`;
      });
    }
    if (!same(fileRepo, brainDir)) {
      const up = `${posix(path.relative(fileRepo, brainDir))}/`;
      out = out.replace(new RegExp(`(^|[\\s(\\[{<"'\`=,])${escRe(up)}([^\\s)\\]}>"'\`,;|*]+)`, 'g'), (all, lead, raw) => {
        const [p, tail] = split(raw);
        const hit = resolve(p);
        if (!hit) return all;
        hits.push({ from: `${up}${p}`, to: render(hit, fileRepo) });
        return `${lead}${render(hit, fileRepo)}${tail}`;
      });
    }
    return { text: out, hits };
  };
  return { rewrite, find: (text, opts) => rewrite(text, opts).hits };
}

/** The folder rules of the brain map (layout 2 -> 3), independent of a plan: what a check finds as an old path. */
function mapRules(brainDir) {
  const rules = BRAIN_FOLDERS.filter((n) => L2[n] !== B3[n]).map((n) => ({ from: `${L2[n]}/`, repo: brainDir, to: `${B3[n]}/` }));
  rules.push({ from: `${L2.decisions}/`, repo: brainDir, to: `${B3.decisions}/` });
  rules.push({ from: `${L2.topics}/`, repo: brainDir, to: `${B3.topics}/` });
  rules.push({ from: L2.policy, repo: brainDir, to: B3.policy });
  return rules;
}

// ---- small transforms -------------------------------------------------------------------------------------------------

/** The handover with the sixth section (empty) after Otvorené otázky; null when it has it. */
export function withTasksSection(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const lines = src.replace(/\n+$/, '').split('\n');
  if (lines.some((l) => l.trim() === TASKS_SECTION)) return null;
  const q = lines.findIndex((l) => l.trim() === QUESTIONS_SECTION);
  const next = q === -1 ? -1 : lines.findIndex((l, j) => j > q && /^## /.test(l.trim()));
  lines.splice(next === -1 ? lines.length : next, 0, TASKS_SECTION, '-');
  return `${lines.join('\n')}\n`;
}

/** The record of a topic for 2.0: without orchestrator, fix_gate; with mode, repos and turn (from the handover facts). */
export function topicRecord3(tema, handover) {
  const t = { ...tema };
  for (const k of REMOVED_TOPIC_FIELDS) delete t[k];
  if (!MODES.includes(t.mode)) t.mode = String(t.class) === 'discussion' ? 'discussion' : 'off';
  const validRepos = t.repos && typeof t.repos === 'object' && 'main' in t.repos && Array.isArray(t.repos.list);
  if (!validRepos) t.repos = t.repo ? { main: t.repo, list: [t.repo] } : { main: null, list: [] };
  if (!t.turn || typeof t.turn !== 'object' || !t.turn.state) {
    const text = handover || '';
    t.turn = turnFields({ next: handoverNextStep(text) || [], questions: handoverQuestions(text) || [], tasks: handoverTasks(text) || [] });
  }
  return t;
}

/**
 * The code copy path of a topic moved into the brain of another domain (11.12), relative to that brain (`copy` is relative
 * to the brain that holds the record): a worktree under `.worktrees/` of the old domain goes under `.worktrees/` of the new
 * one (the repo moves there with its worktrees, 11.12 step 5), any other copy stays where it is.
 */
export function movedCopy(copy, dom, toBrain) {
  const abs = path.resolve(dom.brain, copy);
  const rel = path.relative(path.join(dom.domainDir || path.dirname(dom.brain), WORKTREES_DIR), abs);
  const inWorktrees = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const target = inWorktrees ? path.join(domainOf(toBrain).domainDir || path.dirname(toBrain), WORKTREES_DIR, rel) : abs;
  return posix(path.relative(toBrain, target));
}

/**
 * A policy without the keys of 1.8.0 (REMOVED_POLICY_KEYS, empty parents too), with data_layout 3. The brain's policy
 * (`brain`: { dir, domainDir, defaultRepo }) keeps the repos of topics.auto.projects (relative to the brain) as
 * topics.shared_checkouts (relative to the domain: the D-0038 guard reads only that key in 2.0) and gets default_repo in
 * the form scripts/target.mjs reads (defaultRepoName: the repo's folder name, O18).
 */
export function policy3(policy, { brain = null } = {}) {
  const p = JSON.parse(JSON.stringify(policy || {}));
  const removed = [];
  const projects = Object.keys(p.topics?.auto?.projects || {});
  if (brain && projects.length) {
    const shared = projects.map((k) => posix(path.relative(brain.domainDir || path.dirname(brain.dir), path.resolve(brain.dir, k))));
    const have = Array.isArray(p.topics.shared_checkouts) ? p.topics.shared_checkouts : [];
    p.topics.shared_checkouts = [...new Set([...have, ...shared])];
  }
  if (brain?.defaultRepo) p.default_repo = brain.defaultRepo;
  for (const [a, b] of REMOVED_POLICY_KEYS) {
    if (p[a] && typeof p[a] === 'object' && Object.hasOwn(p[a], b)) {
      delete p[a][b];
      removed.push(`${a}.${b}`);
      if (!Object.keys(p[a]).length) delete p[a];
    }
  }
  p[LAYOUT_KEY] = TO;
  return { policy: p, removed };
}

/** The keys of 1.8.0 a policy still has. */
const oldPolicyKeys = (p) => REMOVED_POLICY_KEYS.filter(([a, b]) => p && p[a] && typeof p[a] === 'object' && Object.hasOwn(p[a], b)).map(([a, b]) => `${a}.${b}`);

/**
 * .workflow.json for 2.0 (O12): knowledge_branch -> target_branch; a repo without it gets the branch its checkout is on
 * when that is not main (done merged into the checkout's branch until 2.0, plan risk 11). Returns { cfg, note } or null.
 */
export function workflowConfig3(dir, cfg) {
  if (!cfg) return null;
  const c = { ...cfg };
  if (typeof c.knowledge_branch === 'string' && c.knowledge_branch.trim()) {
    if (!c.target_branch) c.target_branch = c.knowledge_branch.trim();
    delete c.knowledge_branch;
    return { cfg: c, note: `knowledge_branch -> target_branch ${c.target_branch}` };
  }
  if (Object.hasOwn(c, 'knowledge_branch')) { delete c.knowledge_branch; }
  if (c.target_branch || same(path.resolve(dir, String(c.brain || '')), dir)) return Object.hasOwn(cfg, 'knowledge_branch') ? { cfg: c, note: 'knowledge_branch removed' } : null;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).stdout;
  if (branch && branch !== 'HEAD' && branch !== 'main') {
    c.target_branch = branch;
    return { cfg: c, note: `target_branch ${branch} (the branch of the checkout; without it 2.0 merges into main)` };
  }
  return Object.hasOwn(cfg, 'knowledge_branch') ? { cfg: c, note: 'knowledge_branch removed' } : null;
}

/** An output with its topic in the front matter (`topic:`, spec 4, B12). */
export function withTopic(text, topic) {
  if (!topic) return text;
  const src = String(text);
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4);
    if (end !== -1) {
      const head = src.slice(4, end).split('\n').filter((l) => !/^topic:/.test(l));
      return `---\n${[...head, `topic: ${topic}`].join('\n')}${src.slice(end)}`;
    }
  }
  return `---\ntopic: ${topic}\n---\n${src}`;
}

/** The .gitignore of a brain of layout 3: temy/*\/tmp/ -> topics/*\/tmp/, local/ kept; null when unchanged. */
function gitignore3(text) {
  const old = `${L2.topics}/*/${L2.topicTmp}`;
  const lines = String(text || '').split('\n').map((l) => (l.trim().replace(/\/$/, '') === old ? `${B3.topics}/*/${B3.topicTmp}/` : l));
  const have = new Set(lines.map((l) => l.trim().replace(/\/$/, '')));
  for (const need of [`${B3.local}/`, `${B3.topics}/*/${B3.topicTmp}/`]) if (!have.has(need.replace(/\/$/, ''))) lines.splice(lines.length && lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, need);
  const out = lines.join('\n').replace(/\n*$/, '\n');
  return out === text ? null : out;
}

/** Lines of rules and skills that name a principle 2.0 does not adopt: [{ file, line, ids }]. */
function principleRefs(dir, files, folders) {
  const out = [];
  for (const rel of files) {
    if (!folders.some((f) => under(rel, f)) || !isText(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    text.split('\n').forEach((l, i) => {
      const ids = namedPrinciples(l);
      if (ids.length) out.push({ file: rel, line: i + 1, ids });
    });
  }
  return out;
}

/** Approvals of the operator (--approve): Map cesta -> { action: zmazat|prepisat, file } (cesta of a repo: <repo>:<path>). */
export function readApprove(file) {
  const out = new Map();
  if (!file) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#') || /^cesta\t/i.test(line)) continue;
    const [p, action = '', src = ''] = line.split('\t').map((s) => s.trim());
    if (p) out.set(posix(p).replace(/^\.\//, ''), { action, file: src ? path.resolve(path.dirname(file), src) : '' });
  }
  return out;
}

/** The approval row for a path or one of its folders (a skill folder `skills/agentic/x/`). */
function approvalOf(approve, key) {
  if (approve.has(key)) return { key, ...approve.get(key) };
  const parts = key.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const k = `${parts.slice(0, i).join('/')}/`;
    if (approve.has(k)) return { key: k, ...approve.get(k) };
  }
  return null;
}

/** Memory records about people (type person or operator) in the memory folder `memory` of a brain: [{ rel, type }]. */
function personRecords(brainDir, files, memory = L2.memory) {
  const out = [];
  for (const rel of files) {
    if (!under(rel, memory) || !rel.endsWith('.md')) continue;
    let data = {};
    try { data = parseFrontmatter(fs.readFileSync(path.join(brainDir, rel), 'utf8')).data || {}; } catch { continue; }
    const type = String(data.type || String(data.key || path.posix.basename(rel, '.md')).split('-')[0]);
    if (PERSON_TYPES.includes(type)) out.push({ rel, type });
  }
  return out;
}

/** Labels (`<brain>:<path>`) people.mjs collect --apply wrote into osoby/ (`migrated_from`); null without an operator repo. */
function migratedLabels(env) {
  const repo = operatorRepo(env);
  if (!repo || repo.error) return { labels: null, error: repo?.error || 'operator repo not configured' };
  const labels = new Set();
  for (const p of readPeople(repo.dir)) for (const l of [].concat(p.data?.migrated_from || [])) labels.add(String(l));
  return { labels, dir: repo.dir };
}

// ---- plan -------------------------------------------------------------------------------------------------------------

/** The navrh of a TSV row: { remove } (pomocne), { repo, to } or { error }. */
function parseTarget(row, dom) {
  const p = String(row?.proposal || '').trim();
  if (!p || p === 'bez navrhu' || p === 'ostava') return { error: 'no confirmed target (layout 3 keeps no outputs or sources in the brain)' };
  if (p === 'pomocne') return { remove: true };
  const i = p.indexOf(':');
  if (i <= 0) return { error: `navrh ${p}: expected <repo>:vystupy/<typ>/, <repo>:zdroje/<tema>/ or pomocne` };
  const repo = resolveRepo(p.slice(0, i), dom);
  const to = p.slice(i + 1).replace(/^\.\//, '');
  if (!repo) return { error: `navrh ${p}: repository ${p.slice(0, i)} not found in the domain (${dom.domainDir || path.dirname(dom.brain)})` };
  if (!to || to.split('/').includes('..') || path.isAbsolute(to)) return { error: `navrh ${p}: the path after : must be relative inside the repository` };
  return { repo, to };
}

/** The target path is a place of layout 3 in its repository (role): vystupy/<typ>/, zdroje/<tema>/ or a brain folder. */
function validTarget(to, role) {
  const parts = to.split('/').filter(Boolean);
  if (role === ROLE_REPO) return (parts[0] === R3.outputs || parts[0] === R3.materialy) && parts.length >= 2;
  return [B3.topics, B3.memory, B3.decisions, B3.rules, B3.skills].includes(parts[0]) && parts.length >= 2;
}

/** The repository a path of the brain of layout 2 belongs to: the item of a triage (vystupy/<x>/<entry>, zdroje/<entry>). */
function triageItem(rel) {
  const parts = rel.split('/');
  if (parts[0] === L2.materialy) return parts.length > 2 ? `${parts[0]}/${parts[1]}/` : rel;
  if (parts[0] === OUTPUTS) return parts.length > 3 ? `${parts.slice(0, 3).join('/')}/` : rel;
  return null;
}

/**
 * The plan of the domain. { dom, brain: <repo plan>, repos: [<repo plan>], targets: [<repo plan>], triage, people,
 * lessons, blockers, notes }. A repo plan: { dir, name, role, version, moves: [{ from, to }], removes: [{ path, status }],
 * content: Map rel -> text|Buffer, rows: [record rows], tmp: [{ from, to }], notes }.
 */
export function planDomain(dir, { confirmed = new Map(), proposals = new Map(), approve = new Map(), env = process.env } = {}) {
  const dom = domainOf(dir);
  const blockers = [];
  const notes = [];
  const version = dataLayoutVersion(dom.brain);
  const mk = (d, role) => ({ dir: d, name: path.basename(d), role, version: dataLayoutVersion(d), moves: [], removes: [], content: new Map(), rows: [], tmp: [], notes: [], incoming: [], outgoing: [] });
  const brain = mk(dom.brain, ROLE_BRAIN);
  const plan = { dom, version, brain, repos: dom.repos.map((d) => mk(d, ROLE_REPO)), targets: [], triage: [], people: [], lessons: [], blockers, notes };
  if (version === 1) { blockers.push(`brain ${dom.brain} is in data layout 1: move it to layout 2 first (migrate.mjs ${dom.brain} --apply), then --to 3`); return plan; }
  if (version === TO) { notes.push(`brain ${dom.brain} is in data layout 3 already: nothing to move`); return plan; }
  if (version !== FROM) { blockers.push(`brain ${dom.brain}: data layout ${version}, this step moves only 2 to 3`); return plan; }
  for (const r of plan.repos) {
    if (r.version === 1) blockers.push(`repo ${r.dir} is in data layout 1: move it to layout 2 first (migrate.mjs ${r.dir} --apply), then --to 3`);
    else if (r.version !== FROM) blockers.push(`repo ${r.dir}: data layout ${r.version}, its brain has 2; the domain moves at once`);
  }
  const files = trackedFiles(dom.brain).filter((f) => f.mode !== '160000').map((f) => f.rel);
  const fileSet = new Set(files);
  const read = (rel) => { try { return fs.readFileSync(path.join(dom.brain, rel), 'utf8'); } catch { return null; } };

  // Topics: open ones move, closed ones end (spec 5: removal in git, no archive).
  const topicIds = [...new Set(files.filter((r) => under(r, L2.topics) && r.split('/').length > 2).map((r) => r.split('/')[1]))];
  const closed = new Set(topicIds.filter((id) => (readJson(path.join(dom.brain, L2.topics, id, L2.topicFile), {}) || {}).state === 'closed'));

  // Destination of every file of the brain inside the brain (layout 3), or a removal, or a triage item.
  const dest = new Map(); // rel -> { to } | { remove: status } | { item }
  for (const rel of files) {
    const top = rel.split('/')[0];
    if (INFRA.has(top)) { dest.set(rel, { to: rel }); continue; }
    if (rel === L2.policy) { dest.set(rel, { to: B3.policy }); continue; }
    if (rel === OLD_RECORD || rel === SOURCES) { dest.set(rel, { remove: STATUS.removed }); continue; }
    if (under(rel, L2.topicHidden)) { dest.set(rel, { remove: STATUS.archive }); continue; }
    const folder = BRAIN_FOLDERS.find((n) => under(rel, L2[n]));
    if (folder) { dest.set(rel, { to: `${B3[folder]}${rel.slice(L2[folder].length)}` }); continue; }
    if (rel === L2.repoHandover) { dest.set(rel, { to: B3.repoHandover }); continue; }
    if (under(rel, L2.decisions)) { dest.set(rel, { to: rel === `${L2.decisions}/.gitkeep` ? `${B3.decisions}/.gitkeep` : `${B3.decisions}${rel.slice(L2.decisions.length)}` }); continue; }
    if (under(rel, L2.topics)) {
      const [, id, ...restParts] = rel.split('/');
      if (!restParts.length) { dest.set(rel, { to: `${B3.topics}/${id}` }); continue; }
      if (closed.has(id)) { dest.set(rel, { remove: STATUS.closed }); continue; }
      const rest = restParts.join('/');
      if (rest === CONSENTS) { dest.set(rel, { remove: STATUS.removed }); continue; }
      if (restParts[0] === CONCLUSIONS && restParts.length > 1) {
        const inner = restParts.slice(1).join('/');
        const clash = fileSet.has(`${L2.topics}/${id}/${inner}`);
        dest.set(rel, { to: `${B3.topics}/${id}/${clash ? `${CONCLUSIONS}-${inner}` : inner}` });
        continue;
      }
      dest.set(rel, { to: `${B3.topics}/${id}/${rest}` });
      continue;
    }
    if (top === OUTPUTS || top === L2.materialy) {
      if (path.posix.basename(rel) === '.gitkeep') { dest.set(rel, { remove: STATUS.placeholder }); continue; }
      dest.set(rel, { item: triageItem(rel) });
      continue;
    }
    if (top === KNOWLEDGE) { blockers.push(`${rel}: outside the map of layout 2 (${KNOWLEDGE}/); move or remove it first`); dest.set(rel, { to: rel }); continue; }
    dest.set(rel, { to: rel });
    if (!notes.some((n) => n.startsWith(`${top}`))) notes.push(`${top}${rel.includes('/') ? '/' : ''}: outside the map of layout 3, stays in the brain`);
  }

  // People (11.8): carried into osoby/ by people.mjs collect --apply, or removed with the operator's approval.
  const persons = personRecords(dom.brain, files);
  if (persons.length) {
    const { labels, error } = migratedLabels(env);
    for (const p of persons) {
      const label = `${path.basename(dom.brain)}:${p.rel}`;
      const ok = labels?.has(label);
      const ap = approvalOf(approve, p.rel);
      const approved = ap && ap.action === 'zmazat';
      plan.people.push({ rel: p.rel, type: p.type, collected: !!ok, approved: !!approved });
      if (ok || approved) dest.set(p.rel, { remove: STATUS.person });
      else blockers.push(`${p.rel}: a fact about a person (${p.type}) not in osoby/ of the operator repo${labels ? '' : ` (${error})`}: people.mjs collect, the operator approves the list, people.mjs collect --apply <plan>; or --approve "${p.rel}<TAB>zmazat" (spec 11.8)`);
    }
  }

  // Lessons naming a principle 2.0 does not adopt (11.9): listed, removed or rewritten only with --approve.
  const lessonFolders = (role) => [L2.rules, L2.skills];
  const lessonPlan = (rp, rel, refs, key, readFile, setDest) => {
    const ap = approvalOf(approve, key);
    const entry = { repo: rp.name, file: rel, key, lines: refs.map((r) => `${r.line} (${r.ids.join(', ')})`), action: ap?.action || null };
    plan.lessons.push(entry);
    if (!ap) { blockers.push(`${key}: names ${[...new Set(refs.flatMap((r) => r.ids))].join(', ')}, which 2.0 does not adopt (lines ${refs.map((r) => r.line).join(', ')}): --approve "${key}<TAB>zmazat" or "${key}<TAB>prepisat<TAB><file>" (spec 11.9)`); return; }
    if (ap.action === 'zmazat') { setDest({ remove: STATUS.lesson }, ap.key); return; }
    if (ap.action === 'prepisat') {
      if (!ap.file || !fs.existsSync(ap.file)) { blockers.push(`${key}: prepisat needs an existing file with the new text (${ap.file || 'none'})`); return; }
      const text = fs.readFileSync(ap.file, 'utf8');
      if (text.split('\n').some((l) => namedPrinciples(l).length)) { blockers.push(`${key}: the new text ${ap.file} still names ${NOT_ADOPTED.join('/')}`); return; }
      setDest({ text }, null);
      return;
    }
    blockers.push(`${key}: --approve action ${ap.action}: expected zmazat or prepisat`);
  };
  const brainLessons = new Map();
  for (const r of principleRefs(dom.brain, files, lessonFolders())) {
    if (!brainLessons.has(r.file)) brainLessons.set(r.file, []);
    brainLessons.get(r.file).push(r);
  }
  const rewrittenLessons = new Map();
  for (const [rel, refs] of brainLessons) {
    lessonPlan(brain, rel, refs, rel, read, (d, folderKey) => {
      if (d.remove) {
        for (const f of files) if (folderKey && folderKey.endsWith('/') ? f.startsWith(folderKey) : f === rel) dest.set(f, { remove: d.remove });
      } else rewrittenLessons.set(rel, d.text);
    });
  }

  // TSV rows: the triage items (outputs and sources) and further items moved into another repository (11.12).
  const items = new Map();
  for (const [rel, d] of dest) if (d.item) { if (!items.has(d.item)) items.set(d.item, []); items.get(d.item).push(rel); }
  const defaultRepo = (() => {
    const p = readJson(path.join(dom.brain, L2.policy), {}) || {};
    if (defaultRepoName(p)) return defaultRepoName(p);
    return plan.repos.length === 1 ? plan.repos[0].name : null;
  })();
  const relocated = new Map(); // brain rel -> { repo, to, topic }
  const targetOf = (repoDir) => {
    if (same(repoDir, dom.brain)) return brain;
    const known = plan.repos.find((r) => same(r.dir, repoDir)) || plan.targets.find((r) => same(r.dir, repoDir));
    if (known) return known;
    const t = mk(repoDir, layoutRole(repoDir));
    t.external = true;
    if (t.version !== TO) blockers.push(`target ${repoDir}: data layout ${t.version}; a repository outside the domain takes files only in layout 3 (brain-init.mjs --layout 3 for a new domain)`);
    plan.targets.push(t);
    return t;
  };
  const rowFor = (key) => confirmed.get(key) || null;
  for (const [item, rels] of [...items].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = rowFor(item);
    const proposal = proposals.get(item) || (defaultRepo ? { proposal: `${defaultRepo}:${item.startsWith(`${L2.materialy}/`) ? (item.endsWith('/') ? item : `${L2.materialy}/`) : `${item.split('/').slice(0, 2).join('/')}/`}`, topic: '', reason: 'default repo of the domain' } : null);
    const t = { path: item, files: rels, proposal: row?.proposal || proposal?.proposal || 'bez navrhu', topic: row?.topic || proposal?.topic || '', reason: row?.reason || proposal?.reason || '', confirmed: !!row, to: null, error: null };
    plan.triage.push(t);
    if (!row) { t.error = 'not confirmed'; blockers.push(`${item}: output or source of the brain without a confirmed row (--confirmed <tsv>: cesta, navrh <repo>:vystupy/<typ>/ | <repo>:zdroje/<tema>/ | pomocne, tema, dovod)`); continue; }
    const tg = parseTarget(row, dom);
    if (tg.error) { t.error = tg.error; blockers.push(`${item}: ${tg.error}`); continue; }
    if (tg.remove) { t.to = 'pomocne'; for (const rel of rels) dest.set(rel, { remove: STATUS.removed }); continue; }
    const target = targetOf(tg.repo);
    const role = target.role;
    if (!validTarget(tg.to, role)) { t.error = `${tg.to}: not a place of layout 3 in ${target.name} (${role === ROLE_REPO ? `${R3.outputs}/<typ>/ or ${R3.materialy}/<tema>/` : 'topics/, memory/, decisions/, rules/, skills/'})`; blockers.push(`${item}: ${t.error}`); continue; }
    t.to = `${target.name}:${tg.to}`;
    for (const rel of rels) {
      const rest = item.endsWith('/') ? rel.slice(item.length) : path.posix.basename(rel);
      const to = tg.to.endsWith('/') ? `${tg.to}${rest}` : tg.to;
      relocated.set(rel, { repo: target.dir, to, topic: t.topic && to.startsWith(`${R3.outputs}/`) && rel.endsWith('.md') ? t.topic : '' });
    }
  }
  // Rows for other items of the brain (a topic, a skill, a rule into the brain of another domain, 11.12).
  for (const [key, row] of confirmed) {
    if (items.has(key) || plan.triage.some((t) => t.path === key)) continue;
    const mine = files.filter((f) => (key.endsWith('/') ? f.startsWith(key) : f === key) && dest.get(f)?.to);
    if (!mine.length) { if (!approve.has(key)) notes.push(`--confirmed ${key}: no file of the brain moves there; row ignored`); continue; }
    const tg = parseTarget(row, dom);
    if (tg.error || tg.remove) { blockers.push(`${key}: ${tg.error || 'pomocne only for outputs and sources'}`); continue; }
    const target = targetOf(tg.repo);
    if (target === brain) { blockers.push(`${key}: a move inside the brain is not a row of the TSV`); continue; }
    if (!validTarget(tg.to, target.role)) { blockers.push(`${key}: ${tg.to} is not a place of layout 3 in ${target.name}`); continue; }
    const base = key.endsWith('/') ? ruleMapFolder(key, dest, files) : null;
    for (const rel of mine) {
      const to3 = dest.get(rel).to;
      const rest = key.endsWith('/') ? (base && to3.startsWith(base) ? to3.slice(base.length) : rel.slice(key.length)) : path.posix.basename(to3);
      relocated.set(rel, { repo: target.dir, to: tg.to.endsWith('/') ? `${tg.to}${rest}` : tg.to, topic: '' });
    }
    plan.triage.push({ path: key, files: mine, proposal: row.proposal, topic: row.topic || '', reason: row.reason || '', confirmed: true, to: `${target.name}:${tg.to}`, error: null, extra: true });
  }

  // Rewrite rules: every file to its final place; folder rules of the map and of the moved items.
  const finalOf = (rel) => relocated.get(rel) || (dest.get(rel)?.to ? { repo: dom.brain, to: dest.get(rel).to } : null);
  const rules = [];
  for (const rel of files) { const f = finalOf(rel); if (f && f.to !== rel) rules.push({ from: rel, repo: f.repo, to: f.to }); }
  for (const id of topicIds) if (!closed.has(id) && files.some((f) => f.startsWith(`${L2.topics}/${id}/${CONCLUSIONS}/`))) rules.push({ from: `${L2.topics}/${id}/${CONCLUSIONS}/`, repo: dom.brain, to: `${B3.topics}/${id}/` });
  for (const t of plan.triage) if (t.to && t.to !== 'pomocne' && t.path.endsWith('/')) {
    const [name, ...p] = t.to.split(':');
    const repo = resolveRepo(name, dom) || dom.brain;
    rules.push({ from: t.path, repo, to: p.join(':').endsWith('/') ? p.join(':') : `${p.join(':')}/` });
  }
  rules.push(...mapRules(dom.brain).filter((r) => !rules.some((x) => x.from === r.from)));
  const { rewrite } = makeRewriter(rules, dom.brain);
  plan.rules = rules;

  // Contents of the brain's files at their final place.
  const handovers = new Map();
  for (const rel of files) {
    const d = dest.get(rel);
    if (!d?.to && !relocated.has(rel)) continue;
    const fin = finalOf(rel);
    const owner = same(fin.repo, dom.brain) ? brain : targetOf(fin.repo);
    let content = rewrittenLessons.has(rel) ? rewrittenLessons.get(rel) : null;
    let changed = content !== null;
    if (content === null) {
      try { content = readContent(path.join(dom.brain, rel)); } catch { continue; }
    }
    if (typeof content === 'string') {
      const base = path.posix.basename(rel);
      if (under(rel, L2.topics) && base === L2.handover && rel.split('/').length === 3) {
        const h = withTasksSection(content);
        if (h !== null) { content = h; changed = true; }
        const missing = checkHandover(content);
        if (missing.length) blockers.push(`${rel}: ${missing.join('; ')}`);
        handovers.set(rel.split('/')[1], content);
      }
      if (rel === L2.policy) {
        const { policy, removed } = policy3(readJson(path.join(dom.brain, rel), {}) || {}, { brain: { dir: dom.brain, domainDir: dom.domainDir, defaultRepo } });
        content = json(policy);
        changed = true;
        if (removed.length) brain.notes.push(`policy: removed ${removed.join(', ')}`);
      }
      if (rel === '.gitignore') { const g = gitignore3(content); if (g !== null) { content = g; changed = true; } }
      if (rel === WORKFLOW_CONFIG) { const w = workflowConfig3(dom.brain, readJson(path.join(dom.brain, rel), null)); if (w) { content = json(w.cfg); changed = true; brain.notes.push(`${WORKFLOW_CONFIG}: ${w.note}`); } }
      if (rel === 'README.md') {
        const old = path.join(PLUGIN_ROOT, 'templates', 'brain-2', 'README.md');
        if (fs.existsSync(old) && fs.readFileSync(old, 'utf8') === content) { content = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'brain-3', 'README.md'), 'utf8'); changed = true; }
      }
      const rewritable = isText(rel) && rel !== INDEX_FILE && !['.githooks', '.claude', '.codex', '.agents'].includes(rel.split('/')[0]) && !under(rel, L2.logs) && !under(rel, L2.materialy);
      if (rewritable) {
        const r = rewrite(content, { fileRepo: fin.repo });
        if (r.text !== content) { content = r.text; changed = true; }
      }
      const topic = relocated.get(rel)?.topic;
      if (topic) { content = withTopic(content, topic); changed = true; }
    }
    if (owner === brain) {
      if (d.to !== rel) brain.moves.push({ from: rel, to: d.to });
      if (changed) brain.content.set(d.to, content);
      brain.rows.push([rel, d.to, d.to === rel ? STATUS.stay : STATUS.move]);
    } else {
      brain.removes.push({ path: rel, status: STATUS.out });
      brain.rows.push([rel, `${posix(path.relative(dom.brain, owner.dir))}:${fin.to}`, STATUS.out]);
      owner.content.set(fin.to, content);
      owner.incoming.push({ from: rel, to: fin.to });
      brain.outgoing.push({ from: rel, repo: owner.name, to: fin.to });
    }
  }
  for (const rel of files) {
    const d = dest.get(rel);
    if (d?.remove) { brain.removes.push({ path: rel, status: d.remove }); brain.rows.push([rel, '-', d.remove]); }
  }
  // Topic records: after their handover is known.
  for (const id of topicIds) {
    if (closed.has(id)) continue;
    const rel = `${L2.topics}/${id}/${L2.topicFile}`;
    if (!fileSet.has(rel)) continue;
    const fin = finalOf(rel);
    if (!fin) continue;
    const owner = same(fin.repo, dom.brain) ? brain : targetOf(fin.repo);
    const tema = readJson(path.join(dom.brain, rel), null);
    if (!tema) { blockers.push(`${rel}: not valid JSON`); continue; }
    const record = topicRecord3(tema, handovers.get(id));
    if (owner !== brain && typeof record.copy === 'string' && record.copy) record.copy = movedCopy(record.copy, dom, owner.dir);
    const text = rewrite(json(record), { fileRepo: fin.repo }).text;
    owner.content.set(fin.to, text);
  }
  // Sources moved out: their entries of .brain/sources.json go with them (spec 4: data of a source beside the repo's policy).
  const sources = readJson(path.join(dom.brain, SOURCES), {}) || {};
  for (const [key, val] of Object.entries(sources)) {
    const fin = relocated.get(key) || relocated.get(key.replace(/\.record\.json$/, ''));
    if (!fin) continue;
    const owner = targetOf(fin.repo);
    if (owner.role !== ROLE_REPO) continue;
    owner.sources = owner.sources || {};
    owner.sources[fin.to + (key.endsWith('.record.json') && !fin.to.endsWith('.record.json') ? '.record.json' : '')] = val;
  }
  // Work files outside git (temy/<id>/tmp/) follow their topic; a closed topic's stay where they are (listed).
  for (const id of topicIds.concat(fs.existsSync(path.join(dom.brain, L2.topics)) ? fs.readdirSync(path.join(dom.brain, L2.topics)).filter((n) => !topicIds.includes(n)) : [])) {
    const from = `${L2.topics}/${id}/${L2.topicTmp}`;
    if (!fs.existsSync(path.join(dom.brain, from))) continue;
    if (closed.has(id)) { brain.notes.push(`${from}/: work files of a closed topic, outside git, stay (remove them by hand)`); continue; }
    const fin = finalOf(`${L2.topics}/${id}/${L2.handover}`) || { repo: dom.brain, to: `${B3.topics}/${id}/${L2.handover}` };
    const owner = same(fin.repo, dom.brain) ? brain : targetOf(fin.repo);
    owner.tmp.push({ fromAbs: path.join(dom.brain, from), to: `${path.posix.dirname(fin.to)}/${B3.topicTmp}` });
  }

  // Project repos of the domain.
  for (const r of plan.repos) {
    if (r.version !== FROM) continue;
    planRepo(r, { dom, rewrite, approve, blockers, lessonPlan });
  }
  // Incoming files of every target: clash with a file it tracks, sources.json, record rows.
  for (const t of [brain, ...plan.repos, ...plan.targets]) {
    if (t === brain) continue;
    const tracked = new Set(trackedFiles(t.dir).map((f) => f.rel));
    for (const inc of t.incoming) if (tracked.has(inc.to)) blockers.push(`${t.name}:${inc.to} exists; ${inc.from} of the brain not moved (another target in --confirmed)`);
    if (t.sources) {
      const rel = path.posix.join(path.posix.dirname(R3.policy), 'sources.json');
      const have = t.content.has(rel) ? JSON.parse(t.content.get(rel)) : readJson(path.join(t.dir, rel), {}) || {};
      const all = { ...have, ...t.sources };
      t.content.set(rel, json(Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]))));
    }
    for (const inc of t.incoming) t.rows.push([`${posix(path.relative(t.dir, dom.brain))}:${inc.from}`, inc.to, STATUS.move]);
  }
  // Two files of the brain onto one place.
  const seen = new Map();
  for (const t of [brain, ...plan.repos, ...plan.targets]) {
    for (const m of [...t.moves.map((x) => x.to), ...t.incoming.map((x) => x.to)]) {
      const k = `${t.dir}\0${m}`;
      if (seen.has(k)) blockers.push(`${t.name}:${m}: two files of the brain move there`);
      seen.set(k, true);
    }
  }
  plan.defaultRepo = defaultRepo;
  return plan;
}

/** The folder a folder item of layout 2 maps to inside the brain of layout 3 (temy/x/ -> topics/x/), or null. */
function ruleMapFolder(key, dest, files) {
  const first = files.find((f) => f.startsWith(key) && dest.get(f)?.to);
  if (!first) return null;
  const to = dest.get(first).to;
  const rest = first.slice(key.length);
  if (to.endsWith(rest)) return to.slice(0, to.length - rest.length);
  const top = key.split('/')[0];
  if (top === L2.topics) return `${B3.topics}/${key.split('/')[1]}/`;
  const folder = BRAIN_FOLDERS.find((n) => under(key.replace(/\/$/, ''), L2[n]));
  return folder ? `${B3[folder]}${key.slice(L2[folder].length)}` : null;
}

/** The plan of a project repo of the domain (layout 2 -> 3). */
function planRepo(r, { dom, rewrite, approve, blockers, lessonPlan }) {
  const files = trackedFiles(r.dir).filter((f) => f.mode !== '160000').map((f) => f.rel);
  const refs = new Map();
  for (const x of principleRefs(r.dir, files, [L2.rules, L2.skills])) {
    if (!refs.has(x.file)) refs.set(x.file, []);
    refs.get(x.file).push(x);
  }
  const removed = new Set();
  const rewritten = new Map();
  for (const [rel, list] of refs) {
    lessonPlan(r, rel, list, `${r.name}:${rel}`, null, (d, folderKey) => {
      if (d.remove) {
        const folder = folderKey && folderKey.endsWith('/') ? folderKey.slice(r.name.length + 1) : null;
        for (const f of files) if (folder ? f.startsWith(folder) : f === rel) removed.add(f);
      } else rewritten.set(rel, d.text);
    });
  }
  for (const rel of files) {
    if (rel === OLD_RECORD) { r.removes.push({ path: rel, status: STATUS.removed }); r.rows.push([rel, '-', STATUS.removed]); continue; }
    if (L2.topicHidden && under(rel, L2.topicHidden)) { r.removes.push({ path: rel, status: STATUS.archive }); r.rows.push([rel, '-', STATUS.archive]); continue; }
    if (removed.has(rel)) { r.removes.push({ path: rel, status: STATUS.lesson }); r.rows.push([rel, '-', STATUS.lesson]); continue; }
    if (under(rel, L2.topics)) blockers.push(`${r.name}:${rel}: a topic in a project repo; layout 3 keeps topics in the brain (move it there first)`);
    r.rows.push([rel, rel, STATUS.stay]);
    let content = rewritten.has(rel) ? rewritten.get(rel) : null;
    let changed = content !== null;
    if (rel === L2.policy) {
      const { policy, removed: keys } = policy3(readJson(path.join(r.dir, rel), {}) || {});
      r.content.set(rel, json(policy));
      if (keys.length) r.notes.push(`policy: removed ${keys.join(', ')}`);
      continue;
    }
    if (rel === WORKFLOW_CONFIG) {
      const w = workflowConfig3(r.dir, readJson(path.join(r.dir, rel), null));
      if (w) { r.content.set(rel, json(w.cfg)); r.notes.push(`${WORKFLOW_CONFIG}: ${w.note}`); }
      continue;
    }
    // References to the brain's moved paths (`../<brain>/temy/...`, absolute) in the knowledge and outputs of the repo.
    if (!isText(rel) || !(under(rel, KNOWLEDGE) || under(rel, OUTPUTS))) { if (changed) r.content.set(rel, content); continue; }
    if (content === null) { try { content = fs.readFileSync(path.join(r.dir, rel), 'utf8'); } catch { continue; } }
    if (content.includes('\0')) continue;
    const out = rewrite(content, { fileRepo: r.dir, relative: false }).text;
    if (out !== content || changed) r.content.set(rel, out);
  }
  if (!files.includes(L2.policy)) blockers.push(`${r.name}: ${L2.policy} missing (data layout 2 is read from it)`);
}

// ---- format -----------------------------------------------------------------------------------------------------------

/** Moves grouped by folder: `from/ -> to/ (n)` when every file of the folder keeps its name below one target folder. */
function groupMoves(moves) {
  const byDir = new Map();
  for (const m of moves) {
    const d = path.posix.dirname(m.from);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(m);
  }
  const lines = [];
  for (const [d, list] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dirs = new Set(list.map((m) => (path.posix.basename(m.to) === path.posix.basename(m.from) ? path.posix.dirname(m.to) : null)));
    if (list.length > 1 && dirs.size === 1 && !dirs.has(null)) lines.push(`${d}/ -> ${[...dirs][0]}/ (${list.length} files)`);
    else for (const m of list) lines.push(`${m.from} -> ${m.to}`);
  }
  return lines;
}

export function formatPlan(plan, { all = false } = {}) {
  const lines = [`domain: brain ${plan.dom.brain} (data layout ${plan.version})${plan.dom.repos.length ? `, repos ${plan.dom.repos.map((d) => path.basename(d)).join(', ')}` : ', no project repo'}`];
  if (plan.version !== FROM) { lines.push(...plan.blockers.map((b) => `refused: ${b}`), ...plan.notes.map((n) => `note: ${n}`)); return lines.join('\n'); }
  for (const t of [plan.brain, ...plan.repos, ...plan.targets]) {
    lines.push(`repository ${t.dir} (${t.role}${t.external ? ', outside the domain' : ''}, data layout ${t.version} -> ${TO}):`);
    if (t.moves.length) { lines.push(`  moves (${t.moves.length}):`); for (const l of all ? t.moves.map((m) => `${m.from} -> ${m.to}`) : groupMoves(t.moves)) lines.push(`    ${l}`); }
    const byStatus = new Map();
    for (const r of t.removes) { if (!byStatus.has(r.status)) byStatus.set(r.status, []); byStatus.get(r.status).push(r.path); }
    for (const [st, list] of byStatus) {
      if (st === STATUS.out) continue;
      lines.push(`  removed, ${st} (${list.length}):`);
      for (const l of all || list.length <= 10 ? list : [...list.slice(0, 10), `… ${list.length - 10} more (--all lists them)`]) lines.push(`    ${l}`);
    }
    if (t.outgoing.length) { lines.push(`  into other repositories (${t.outgoing.length}):`); for (const o of t.outgoing) lines.push(`    ${o.from} -> ${o.repo}:${o.to}`); }
    if (t.incoming.length) { lines.push(`  from the brain (${t.incoming.length}):`); for (const o of t.incoming) lines.push(`    ${o.from} -> ${o.to}`); }
    const rewritten = [...t.content.keys()].filter((k) => !t.incoming.some((i) => i.to === k));
    if (rewritten.length) lines.push(`  written with a new content (${rewritten.length}): ${(all ? rewritten : rewritten.slice(0, 12)).join(', ')}${!all && rewritten.length > 12 ? ', …' : ''}`);
    for (const m of t.tmp) lines.push(`  outside git: ${posix(m.fromAbs)}/ -> ${m.to}/`);
    for (const n of t.notes) lines.push(`  note: ${n}`);
  }
  lines.push(`outputs and sources of the brain (${plan.triage.length}; TSV: cesta, navrh, tema, dovod):`);
  for (const t of plan.triage) lines.push(`  ${t.path}\t${t.proposal}\t${t.topic}\t${t.reason}\t${t.to ? `-> ${t.to}` : `stays (${t.error})`} (${t.files.length} file(s))`);
  if (plan.people.length) {
    lines.push(`facts about people in memory (${plan.people.length}; spec 11.8):`);
    for (const p of plan.people) lines.push(`  ${p.rel} (${p.type}): ${p.collected ? 'in osoby/, removed' : p.approved ? 'removal approved' : 'not in osoby/'}`);
  }
  if (plan.lessons.length) {
    lines.push(`rules and skills naming ${NOT_ADOPTED.join(', ')} (${plan.lessons.length}; --approve: cesta, zmazat | prepisat, subor):`);
    for (const l of plan.lessons) lines.push(`  ${l.key}: lines ${l.lines.join(', ')}${l.action ? ` -> ${l.action}` : ''}`);
  }
  for (const n of plan.notes) lines.push(`note: ${n}`);
  if (plan.blockers.length) { lines.push(`--apply is refused until these are settled (${plan.blockers.length}):`); for (const b of plan.blockers) lines.push(`  ${b}`); }
  return lines.join('\n');
}

/** The triage TSV of a plan (outputs and sources with their proposals). */
export function formatTriageTsv(plan) {
  return ['cesta\tnavrh\ttema\tdovod', ...plan.triage.filter((t) => !t.extra).map((t) => [t.path, t.proposal, t.topic, t.reason].join('\t'))].join('\n') + '\n';
}

// ---- apply ------------------------------------------------------------------------------------------------------------

/** Files the move writes that the content checks of a brain of layout 3 refuse (the pre-commit refuses them at --apply). */
export function contentProblems(plan) {
  const out = [];
  for (const t of [plan.brain, ...plan.targets.filter((x) => x.role === ROLE_BRAIN)]) {
    const policy = t === plan.brain ? policy3(readJson(path.join(t.dir, L2.policy), {}) || {}).policy : readJson(path.join(t.dir, B3.policy), {}) || {};
    for (const [rel, text] of t.content) for (const e of checkBrainFile(rel, typeof text === 'string' ? text : null, { policy, version: TO })) out.push(`${t.name}:${e.startsWith(rel) ? e : `${rel}: ${e}`}`);
    for (const m of t.moves) if (!t.content.has(m.to)) for (const e of checkBrainFile(m.to, null, { policy, version: TO })) out.push(`${t.name}:${e}`);
  }
  return out;
}

const chunks = (list, n = 200) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/** One commit of a repo plan: git mv, git rm, written contents, the record, INDEX.md. Returns the short sha. */
function commitRepo(t, message) {
  const env = { ...brainScriptEnv(), [MIGRATE_MOVE_ENV]: '1' };
  const run = (args) => { const r = git([...GIT_PATHS, ...args], { cwd: t.dir, env }); if (!r.ok) throw new Error(`${t.name}: git ${args[0]}: ${firstLine(r.stderr || r.stdout)}`); return r; };
  for (const m of t.moves) {
    fs.mkdirSync(path.dirname(path.join(t.dir, m.to)), { recursive: true });
    run(['mv', '--', m.from, m.to]);
  }
  const removes = t.removes.map((r) => r.path);
  for (const list of chunks(removes)) run(['rm', '-q', '--', ...list]);
  const record = t.external ? null : recordRel(t.role);
  if (record) t.content.set(record, ['# from\tto\tstatus', `# kind ${t.role}`, ...t.rows.map((r) => r.join('\t'))].join('\n') + '\n');
  for (const [rel, data] of t.content) {
    fs.mkdirSync(path.dirname(path.join(t.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(t.dir, rel), data);
  }
  for (const list of chunks([...t.content.keys()])) run(['add', '--', ...list]);
  // The adapter of a project repo on the new layout (its .workflow.json and generated files) goes into the same commit, so
  // the tree stays clean and one revert brings everything back. A persona brain commits its own files: after the commit.
  if (t.role === ROLE_REPO && !t.external) {
    t.adapter = regenerateAdapter(t.dir);
    if (t.adapter) run(['add', '-u']);
  }
  refreshIndex(t.dir, env);
  const c = spawnSync('git', ['commit', '--quiet', '-m', `${BRAIN_COMMIT_TAG} ${message}`], { cwd: t.dir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (c.status !== 0) throw new Error(`${t.name}: commit failed: ${(c.stderr || c.stdout || '').trim()}`);
  return git(['rev-parse', '--short', 'HEAD'], { cwd: t.dir }).stdout;
}

/** Empty folders left under `rel` (no file inside), outermost first; removed. */
function pruneEmpty(dir, rel) {
  const abs = path.join(dir, rel);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== '.git') out.push(...pruneEmpty(dir, `${rel}/${e.name}`));
  try { if (!fs.readdirSync(abs).length) { fs.rmdirSync(abs); out.push(`${rel}/`); } } catch { /* stays */ }
  return out;
}

/**
 * The apply: every repository ready (clean, up to date with origin), no blocker, no content problem; then one commit in
 * each (brain, project repos, targets outside the domain), all or none (a failure resets the commits made before it;
 * nothing is pushed). Work files outside git move after the commits. Returns { ok, commits: [{ dir, sha }], plan, check }.
 */
export function applyDomain(dir, { confirmedFile = null, approveFile = null, env = process.env } = {}) {
  const dom = domainOf(dir);
  if (dataLayoutVersion(dom.brain) === TO) return { ok: true, nothing: true, message: `brain ${dom.brain} is in data layout 3 already: nothing to move` };
  const confirmed = readTriage(confirmedFile);
  const approve = readApprove(approveFile);
  let plan = planDomain(dir, { confirmed, approve, env });
  if (plan.blockers.length) return { ok: false, error: `${plan.blockers.length} item(s) to settle first:\n${plan.blockers.map((b) => `  ${b}`).join('\n')}`, plan };
  for (const t of [plan.brain, ...plan.repos, ...plan.targets]) {
    const ready = readyForMove(t.dir);
    if (!ready.ok) return { ok: false, error: `${t.dir}: ${ready.error}`, plan };
    if (ready.note && /updated from origin/.test(ready.note)) plan.notes.push(`${t.name}: ${ready.note}`);
  }
  plan = planDomain(dir, { confirmed, approve, env });
  if (plan.blockers.length) return { ok: false, error: `${plan.blockers.length} item(s) to settle first:\n${plan.blockers.map((b) => `  ${b}`).join('\n')}`, plan };
  const problems = contentProblems(plan);
  if (problems.length) return { ok: false, error: `content checks of layout 3 refuse files the move writes (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`, plan };
  const commits = [];
  const heads = [];
  const env2 = { ...brainScriptEnv(), [MIGRATE_MOVE_ENV]: '1' };
  try {
    for (const t of [plan.brain, ...plan.repos, ...plan.targets]) {
      heads.push({ dir: t.dir, head: git(['rev-parse', 'HEAD'], { cwd: t.dir }).stdout });
      const what = t === plan.brain ? `${t.moves.length} file(s) moved, ${t.removes.length} removed, ${t.outgoing.length} into project repos`
        : t.external ? `${t.incoming.length} file(s) from brain ${plan.brain.name}` : `${t.incoming.length} file(s) from brain ${plan.brain.name}, ${t.removes.length} removed`;
      commits.push({ dir: t.dir, name: t.name, sha: commitRepo(t, `${COMMIT_SUBJECT}: ${what} (migrate.mjs --to 3, spec 11)`) });
    }
  } catch (err) {
    for (const h of heads) {
      git(['reset', '--quiet', '--hard', h.head], { cwd: h.dir, env: env2 });
    }
    return { ok: false, error: `${err.message}; every commit of the move was reset, nothing changed`, plan };
  }
  const moved = [];
  for (const t of [plan.brain, ...plan.repos, ...plan.targets]) {
    for (const m of t.tmp) {
      const to = path.join(t.dir, m.to);
      if (fs.existsSync(to)) { t.notes.push(`${posix(m.fromAbs)}: not moved, ${m.to} exists`); continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(m.fromAbs, to);
      moved.push(`${posix(m.fromAbs)} -> ${t.name}:${m.to}`);
    }
  }
  const pruned = [L2.topics, OUTPUTS, L2.materialy, KNOWLEDGE].flatMap((rel) => pruneEmpty(plan.brain.dir, rel));
  const adapters = [...plan.repos.map((t) => ({ name: t.name, res: t.adapter })), { name: plan.brain.name, res: regenerateAdapter(plan.brain.dir) }].filter((a) => a.res);
  const check = checkDomain(plan.brain.dir);
  return { ok: true, commits, plan, moved, pruned, adapters, check };
}

// ---- check ------------------------------------------------------------------------------------------------------------

/** Commits of the move in a repository (subject of migrate --to 3), newest first: [{ sha, subject }]. */
function moveCommits(dir) {
  const r = git(['log', '--format=%h\t%s', '--fixed-strings', `--grep=${BRAIN_COMMIT_TAG} ${COMMIT_SUBJECT}`], { cwd: dir });
  return (r.ok ? r.stdout.split('\n').filter(Boolean) : []).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; }).filter((c) => c.subject.startsWith(`${BRAIN_COMMIT_TAG} ${COMMIT_SUBJECT}`));
}

/** The check of one repository in layout 3 after the move: { dir, name, problems, notes }. */
export function checkRepo(dir, { brainDir = null } = {}) {
  const problems = [];
  const notes = [];
  const name = path.basename(dir);
  const version = dataLayoutVersion(dir);
  if (version !== TO) return { dir, name, problems: [`data layout is ${version}, not ${TO}`], notes };
  const role = layoutRole(dir);
  const map = layoutFor(TO, role);
  const files = trackedFiles(dir).map((f) => f.rel);
  const record = recordRel(role);
  if (!files.includes(record)) problems.push(`${record} missing: no record of the move 2 -> 3`);
  const commits = moveCommits(dir);
  if (commits.length !== 1) problems.push(`${commits.length} commit(s) of the move (expected one): ${commits.map((c) => c.sha).join(', ') || 'none'}`);
  const policy = readJson(path.join(dir, map.policy), {}) || {};
  const old = oldPolicyKeys(policy);
  if (old.length) problems.push(`${map.policy}: keys of 1.8.0 left: ${old.join(', ')}`);
  const index = indexProblem(dir);
  if (index) problems.push(`${INDEX_FILE}: ${index} in HEAD; regenerate it: migrate.mjs ${dir} --to 3 --check --fix`);
  const lessonDirs = role === ROLE_REPO ? [R3.rules, R3.skills] : [B3.rules, B3.skills];
  for (const r of principleRefs(dir, files, lessonDirs)) problems.push(`${r.file}:${r.line}: names ${r.ids.join(', ')}, which 2.0 does not adopt (spec 11.9)`);
  if (role === ROLE_REPO) {
    const cfg = readJson(path.join(dir, WORKFLOW_CONFIG), null);
    if (cfg && Object.hasOwn(cfg, 'knowledge_branch')) problems.push(`${WORKFLOW_CONFIG}: knowledge_branch left (2.0 reads target_branch, O12)`);
    for (const rel of files) {
      if (L2.topicHidden && under(rel, L2.topicHidden)) { problems.push(`${rel}: the hidden archive of layout 2 left`); break; }
    }
    for (const rel of files) if (under(rel, L2.topics)) { problems.push(`${rel}: a topic in a project repo (layout 3 keeps topics in the brain)`); break; }
    if (brainDir) {
      const { find } = makeRewriter(mapRules(brainDir), brainDir);
      for (const rel of files) {
        if (!isText(rel) || !(under(rel, KNOWLEDGE) || under(rel, OUTPUTS))) continue;
        let text; try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
        for (const h of find(text, { fileRepo: dir, relative: false })) problems.push(`${rel}: old path ${h.from} of the brain (now ${h.to})`);
      }
    }
    return { dir, name, problems, notes };
  }
  // The brain.
  const L2tops = [KNOWLEDGE, L2.topics, OUTPUTS, L2.materialy];
  const left = new Map();
  for (const rel of files) { const top = L2tops.find((t) => under(rel, t)); if (top) left.set(top, (left.get(top) || 0) + 1); }
  for (const [top, n] of left) problems.push(`${top}/: ${n} tracked file(s) of layout 2 left in the brain`);
  const topicFiles = files.filter((r) => under(r, B3.topics));
  for (const rel of topicFiles) {
    const parts = rel.split('/');
    if (parts[2] === CONCLUSIONS && parts.length > 3) problems.push(`${rel}: ${CONCLUSIONS}/ not moved into ${B3.topics}/${parts[1]}/ (spec 11.9)`);
    if (parts.length === 3 && parts[2] === CONSENTS) problems.push(`${rel}: consents of 1.8.0 left`);
    if (parts.length === 3 && parts[2] === B3.handover) {
      const errors = checkHandover(fs.readFileSync(path.join(dir, rel), 'utf8'));
      if (errors.length) problems.push(`${rel}: ${errors.join('; ')}`);
    }
    if (parts.length === 3 && parts[2] === B3.topicFile) {
      const t = readJson(path.join(dir, rel), null);
      if (!t) { problems.push(`${rel}: not valid JSON`); continue; }
      const fields = REMOVED_TOPIC_FIELDS.filter((k) => Object.hasOwn(t, k));
      if (fields.length) problems.push(`${rel}: fields of 1.8.0 left: ${fields.join(', ')}`);
      if (!MODES.includes(t.mode)) problems.push(`${rel}: mode ${t.mode ?? 'missing'} (expected ${MODES.join(' or ')})`);
      if (!t.repos || typeof t.repos !== 'object' || !Array.isArray(t.repos.list) || !('main' in t.repos)) problems.push(`${rel}: repos { main, list } missing`);
      if (t.state === 'closed') problems.push(`${rel}: a closed topic left (layout 3 has no archive)`);
    }
  }
  for (const p of personRecords(dir, files, B3.memory).map((x) => x.rel)) problems.push(`${p}: a fact about a person in memory (osoby/ of the operator repo, spec 11.8)`);
  const { find } = makeRewriter(mapRules(dir), dir);
  for (const rel of files) {
    if (!isText(rel) || rel === INDEX_FILE || rel === record || under(rel, B3.logs) || ['.githooks', '.claude', '.codex', '.agents'].includes(rel.split('/')[0])) continue;
    let text; try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    for (const h of find(text, { fileRepo: dir })) problems.push(`${rel}: old path ${h.from} (now ${h.to})`);
  }
  // The rows of the record: every file has its new place.
  if (files.includes(record)) {
    const tracked = new Set(files);
    for (const line of fs.readFileSync(path.join(dir, record), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [from, to, status] = line.split('\t');
      if (to === '-') continue;
      const i = to.indexOf(':');
      if (status === STATUS.out && i > 0) {
        const other = path.resolve(dir, to.slice(0, i));
        if (!fs.existsSync(path.join(other, to.slice(i + 1)))) problems.push(`${from}: moved to ${to}, not there`);
      } else if (!tracked.has(to)) problems.push(`${from}: new place ${to}, not tracked`);
    }
  }
  return { dir, name, problems, notes };
}

/** The check of the domain: the brain and every project repo of it. */
export function checkDomain(dir) {
  const dom = domainOf(dir);
  const results = [checkRepo(dom.brain), ...dom.repos.map((r) => checkRepo(r, { brainDir: dom.brain }))];
  return { ok: results.every((r) => !r.problems.length), results };
}

/** --check --fix: INDEX.md of every repository of the domain regenerated (one commit each where stale). */
export function fixIndexes(dir) {
  const dom = domainOf(dir);
  const out = [];
  for (const d of [dom.brain, ...dom.repos]) {
    if (dataLayoutVersion(d) !== TO || !indexProblem(d)) continue;
    if (!git(['diff', '--cached', '--quiet'], { cwd: d }).ok) { out.push(`${path.basename(d)}: staged changes, ${INDEX_FILE} not regenerated`); continue; }
    const done = commitIndexAfterMerge(d, { env: brainScriptEnv(), message: `${BRAIN_COMMIT_TAG} regenerate ${INDEX_FILE} (migrate --to 3 --check --fix)` });
    out.push(`${path.basename(d)}: ${INDEX_FILE} ${done ? `regenerated, committed ${git(['rev-parse', '--short', 'HEAD'], { cwd: d }).stdout} (not pushed)` : 'current'}`);
  }
  return out;
}

export function formatCheck(check) {
  const lines = [check.ok ? 'check (layout 3): ok' : `check (layout 3): ${check.results.reduce((n, r) => n + r.problems.length, 0)} problem(s)`];
  for (const r of check.results) {
    lines.push(`  ${r.name}: ${r.problems.length ? `${r.problems.length} problem(s)` : 'ok'}`);
    for (const p of r.problems) lines.push(`    ${p}`);
    for (const n of r.notes) lines.push(`    note: ${n}`);
  }
  return lines.join('\n');
}

// ---- revert -----------------------------------------------------------------------------------------------------------

/**
 * The commits a return of the domain reverts (spec 11.7): in every repository of the domain and every target named in the
 * brain's record, the commit of the move and each commit after it (the trial topic, --check --fix), newest first, with
 * the command. Only before the threads of the domain start, and only with the operator's consent.
 */
export function revertList(dir) {
  const dom = domainOf(dir);
  const dirs = [dom.brain, ...dom.repos];
  const rec = path.join(dom.brain, recordRel(ROLE_BRAIN));
  if (fs.existsSync(rec)) {
    for (const line of fs.readFileSync(rec, 'utf8').split('\n')) {
      const [, to, status] = line.split('\t');
      if (status !== STATUS.out || !to?.includes(':')) continue;
      const other = path.resolve(dom.brain, to.slice(0, to.indexOf(':')));
      if (!dirs.some((d) => same(d, other))) dirs.push(other);
    }
  }
  const out = [];
  for (const d of dirs) {
    const [move] = moveCommits(d);
    if (!move) { out.push({ dir: d, name: path.basename(d), commits: [], error: 'no commit of the move' }); continue; }
    const later = git(['log', '--format=%h\t%s', `${move.sha}..HEAD`], { cwd: d }).stdout.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
    out.push({ dir: d, name: path.basename(d), commits: [...later, move] });
  }
  return out;
}

export function formatRevert(list) {
  const lines = ['revert of the move to layout 3 (spec 11.7: only before the threads of the domain start, with the operator\'s consent; a revert is a new commit):'];
  for (const r of list) {
    if (r.error) { lines.push(`  ${r.name}: ${r.error}`); continue; }
    lines.push(`  ${r.name}: ${r.commits.length} commit(s), newest first:`);
    for (const c of r.commits) lines.push(`    ${c.sha} ${c.subject}`);
    lines.push(`    WORKFLOW_BRAIN_SCRIPT=1 git -C ${posix(r.dir)} revert --no-edit ${r.commits.map((c) => c.sha).join(' ')}`);
  }
  const again = [domainOf(list[0]?.dir || '.').brain].map((d) => adapterCommand(d)).filter(Boolean);
  if (again.length) lines.push(`  then run the adapter again: ${again.join('; ')}`);
  return lines.join('\n');
}
