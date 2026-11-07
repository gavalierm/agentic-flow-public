#!/usr/bin/env node
// Single entry point for writing knowledge (P-013, P-007, P-031, P-009, P-008, P-035, P-032, P-011).
// The agent classifies; this script only writes in a fixed format, deduplicates via find, commits via brain.mjs, regenerates indexes.
//   save.mjs memory <type> <name> --content "..." [--origin operator|derived|observed] [--aliases a,b] [--relates-to x,y] [--sources f1,f2] [--summary "..."] [--new]
//   save.mjs decision "<title>" --what "..." --alternatives "..." --reason "..." --relates-to x,y [--supersedes D-0001]
//   save.mjs rule <name> --content "..." (--enforced-by <file>[:<symbol>][,...] | --unenforced "<why code cannot check it>") [--title "..."] | --remove --reason "..."
//   save.mjs exception P-XXX --wording "..." --reason "..." [--layer project|harness|machine|local] [--title "..."]
//   save.mjs skill <name> --description "..." --content "..." --origin error|routine [--aliases a,b] [--script <file>[,<file>]] [--replace | --sed 's/<pattern>/<replacement>/[gim]'] [--from-procedure <name>] [--from-sequence <seq>] | --remove --reason "..."
//   save.mjs handover <topic> (--task ".." --done "a; b" --next ".." --files "a; b" --questions "a; b" | --file <path>)
//   save.mjs docs [--message "..."]   persona only: commits the files written directly into docs/ (P-024)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs, fail, today, readText } from '../scripts/util.mjs';
import { loadContext, isWakeTurn, machineName, foreignProjectCwd } from '../scripts/config.mjs';
import { brainWrite, formatWriteResult, syncAndCheckHolder } from '../scripts/brain.mjs';
import { parseFrontmatter, serializeFrontmatter, asList } from '../scripts/frontmatter.mjs';
import { makeKey, normalizeKey, hasDiacritics, isValidId, KEY_TYPES } from '../scripts/keys.mjs';
import { find, findSimilar } from '../scripts/find.mjs';
import { readDecisions, readSkills, nextDecisionId } from '../scripts/records.mjs';
import { assembleRules } from '../scripts/rules.mjs';
import { ruleCorpus, judgeRule, unanswered, onlyCondenses } from '../scripts/rule-gate.mjs';
import { buildIndexes } from '../scripts/index.mjs';
import { renderHandover, checkHandover } from '../scripts/brain-checks.mjs';
import { removeNames } from '../scripts/logs.mjs';
import { setTopicState, readTopic } from '../scripts/topic.mjs';
import { workflowSkillNames, PROJECT_SKILLS_DIR } from '../scripts/skills-sync.mjs';
import { checkSkill, meaningDiff } from '../scripts/skill-check.mjs';

const args = parseArgs(process.argv.slice(2));
const [category, ...rest] = args._;
const out = (s) => process.stdout.write(s + '\n');
const toPosixPath = (p) => String(p).replace(/\\/g, '/');

function fingerprint(projectDir, sources) {
  const h = createHash('sha1');
  for (const s of sources) {
    const file = path.resolve(projectDir, s);
    h.update(s + '\n');
    h.update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from('missing'));
  }
  return h.digest('hex').slice(0, 12);
}

function finish(ctx, res, paths) {
  out(formatWriteResult(res, paths));
  const idx = buildIndexes(ctx.brainDir, ctx.policy);
  for (const w of idx.warnings) out(`limit: ${w}`);
  // P-022: the agent keeps its own rules within the limit; nobody else hands it the task (operator 2026-11-01).
  const rules = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: 'claude-code' });
  if (rules.overLimit.length) out(`limit: ${rules.overLimit.join('; ')}: condense your project rules after the current unit of work (skill workflow:consolidate; mandated by the workflow, not out of scope, P-002): merge overlapping ones, shorten wording, remove those a core principle covers (save rule <name> --remove --reason "superseded by P-XXX"), P-022`);
}

function saveMemory(ctx) {
  const [type, ...nameParts] = rest;
  const name = nameParts.join(' ');
  if (!type || !name) fail(`usage: save.mjs memory <type> <name> --content "..." (types: ${KEY_TYPES.join(', ')})`);
  if (args.content === undefined) fail('--content required');
  const key = makeKey(type, name);
  const origin = args.origin || 'operator';
  if (!['operator', 'derived', 'observed'].includes(origin)) fail('origin must be operator | derived | observed (P-009)');
  const sources = asList(args.sources);
  if (origin === 'derived' && !sources.length) fail('derived record needs --sources f1,f2 (P-009)');
  const matches = find(ctx.brainDir, key).filter((m) => m.kind === 'memory');
  const byAlias = matches.length ? matches : find(ctx.brainDir, name).filter((m) => m.kind === 'memory' && m.key.startsWith(type + '-'));
  let rel = `memory/${key}.md`;
  let existing = null;
  if (byAlias.length) {
    rel = byAlias[0].path;
    existing = parseFrontmatter(readText(path.join(ctx.brainDir, rel), ''));
  } else {
    const similar = findSimilar(ctx.brainDir, key);
    if (similar.length && !args.new) {
      fail(`similar key exists (P-031): ${similar.map((s) => `${s.key} (${s.path})`).join(', ')}\nchoose explicitly: reuse the existing name, or pass --new to create ${key}`);
    }
  }
  const data = {
    key: existing?.data.key || key,
    type,
    name: existing?.data.name || name,
    origin,
    aliases: [...new Set([...(asList(existing?.data.aliases)), ...asList(args.aliases)])],
    relates_to: [...new Set([...(asList(existing?.data.relates_to)), ...asList(args['relates-to'])])],
    summary: args.summary || existing?.data.summary || undefined,
    created: existing?.data.created || today(),
    updated: today(),
  };
  if (origin === 'derived') {
    data.sources = sources;
    data.fingerprint = fingerprint(ctx.projectDir, sources);
  }
  const res = brainWrite(ctx, { ops: [{ path: rel, content: serializeFrontmatter(data, String(args.content)) }], message: `save memory ${data.key}` });
  finish(ctx, res, [rel]);
}

function saveDecision(ctx) {
  const title = rest.join(' ');
  if (!title) fail('usage: save.mjs decision "<title>" --what "..." --alternatives "..." --reason "..." --relates-to x,y');
  const relates = asList(args['relates-to']);
  if (!relates.length) fail('decision needs --relates-to (P-008, P-031)');
  if (!args.what || !args.reason) fail('decision needs --what and --reason (P-008)');
  const id = nextDecisionId(ctx.brainDir);
  const slug = normalizeKey(title).slice(0, 40);
  const rel = `decisions/${id.toLowerCase()}-${slug}.md`;
  const ops = [];
  if (args.supersedes) {
    const old = readDecisions(ctx.brainDir).find((d) => (d.id || d.key) === args.supersedes);
    if (!old) fail(`decision ${args.supersedes} not found`);
    const parsed = parseFrontmatter(readText(path.join(ctx.brainDir, old.path), ''));
    ops.push({ path: old.path, content: serializeFrontmatter({ ...parsed.data, status: `superseded-by ${id}`, updated: today() }, parsed.body) });
  }
  const data = { key: id, id, title, status: 'valid', relates_to: relates, aliases: asList(args.aliases), supersedes: args.supersedes || undefined, created: today() };
  const body = `**Rozhodnuté:** ${args.what}\n\n**Zamietnuté alternatívy:** ${args.alternatives || '-'}\n\n**Dôvod:** ${args.reason}\n`;
  ops.push({ path: rel, content: serializeFrontmatter(data, body) });
  const res = brainWrite(ctx, { ops, message: `save decision ${id} ${slug}` });
  finish(ctx, res, [rel]);
  out(`decision ${id}: reference it in the commit message of the change it drives (P-008)`);
}

const PRECEDENCE_RE = /prednos[tť]|\boverrid|takes? precedence/i;
// P-007: a rule is a gate (MUST / MUST NOT, or a pointer to a skill); steps and commands belong in a skill (Bob 2026-11-02).
const STEP_LINE_RE = /^\s*(\d+[.)]|[-*]\s*(najprv|potom|nakoniec|first|then|finally)\b)/i;
const COMMAND_RE = /`[^`\n]*\b(node|npm|npx|git|sudo|systemctl|docker|curl|ssh|scp|sed|awk|apt|pip|python3?)\s[^`\n]*`/;

/** Why the content reads as a procedure (numbered steps or shell commands), or null. */
function procedureSignal(content) {
  const text = String(content);
  const steps = text.split('\n').filter((l) => STEP_LINE_RE.test(l)).length;
  if (steps >= 2) return `${steps} step lines`;
  const cmd = COMMAND_RE.exec(text);
  if (cmd) return `command ${cmd[0]}`;
  return null;
}

/**
 * A rule only in text is unreliable (operator 2026-11-02: "rules are unreliable, solve it in code"): every saved rule names
 * the code that enforces it (hook, script, test) or states why code cannot check it. `<file>[:<symbol>]` resolves against
 * the workflow, the project and brain; the symbol must occur in the file. Returns frontmatter fields or fails.
 */
function enforcementOf(ctx, existing, opts = args) {
  const given = opts['enforced-by'] !== undefined && opts['enforced-by'] !== true;
  const why = opts.unenforced !== undefined && opts.unenforced !== true ? String(opts.unenforced).trim() : null;
  if (given && why) fail('--enforced-by and --unenforced exclude each other');
  if (!given && !why) {
    if (existing.enforced_by?.length) return { enforced_by: existing.enforced_by };
    if (existing.unenforced) return { unenforced: existing.unenforced };
    fail('a rule needs --enforced-by <file>[:<symbol>] (the hook, script or test that blocks the violation; write that code first, skill fix) or --unenforced "<why code cannot check it>"; a rule only in text is not reliable (operator 2026-11-02)');
  }
  if (why) {
    if (why.length < 20) fail('--unenforced needs the reason why code cannot check the rule (at least 20 characters)');
    return { unenforced: why };
  }
  const refs = asList(opts['enforced-by']);
  const roots = [ctx.pluginRoot, ctx.projectDir, ctx.brainDir].filter(Boolean);
  for (const ref of refs) {
    const [file, symbol] = ref.split(':');
    const abs = roots.map((r) => path.resolve(r, file)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!abs) fail(`--enforced-by ${ref}: file ${file} not found in the workflow, the project or brain`);
    if (symbol && !fs.readFileSync(abs, 'utf8').includes(symbol)) fail(`--enforced-by ${ref}: ${symbol} does not occur in ${file}`);
  }
  return { enforced_by: refs };
}

/**
 * New rule gate (operator 2026-11-03: rules multiply without end, eat the limit and still do not stop the errors): the
 * rules must stay within the limit; an existing rule on the same subject is extended instead of a second rule; a
 * conflict is resolved in the conflicting rule first; and a new rule the code could replace is refused.
 */
function ruleGate(ctx, name, content, oldBody, isNew, enforcedBy) {
  const rules = assembleRules({ brainDir: ctx.brainDir, policy: ctx.policy, harness: 'claude-code' });
  const limit = ctx.policy?.limits?.rules_chars ?? 10000;
  const grow = content.trim().length - oldBody.trim().length + (isNew ? name.length + 6 : 0);
  if (grow > 0 && rules.chars + grow > limit) fail(`rules would have ${rules.chars + grow} chars > ${limit}: a rule must not grow the rules over the limit; put the gate into the code (hook, script) or into an existing rule by rewording it shorter, and condense first (skill workflow:consolidate, P-022)`);
  // Condensing a rule (fewer words, none new) is what the limit asks for; judging it again only re-reports the old wording.
  if (!isNew && onlyCondenses(content, oldBody)) return;
  const corpus = ruleCorpus({ brainDir: ctx.brainDir, coreDir: path.join(ctx.pluginRoot, 'rules'), skip: name });
  const verdict = judgeRule({ id: name, text: content, enforcedBy, oldText: isNew ? '' : oldBody }, corpus, { spawn: spawnSync });
  const list = (a) => a.map((x) => `${x.id} (${x.how})`).join('; ');
  const fix = (id) => (/^P-\d{3}$/.test(id) ? `${id} is a workflow principle: report it to maintainer/workflow-dev (send --level assist) or save an exception` : `save.mjs rule ${id} --content "<reworded>"`);
  if (verdict.conflicts.length) fail(`rule ${name} conflicts with ${list(verdict.conflicts)}: two rules must not order different behaviour; resolve the conflict in that rule first (${verdict.conflicts.map((c) => fix(c.id)).join('; ')}), then save this one only if something is left [${verdict.by}]`);
  if (!isNew) return;
  const open = unanswered(verdict.overlaps, args.distinct);
  if (open.length) fail(`rule ${name} overlaps ${list(verdict.overlaps.filter((o) => open.includes(o.id)))}: extend or narrow the existing rule instead of a new one (${open.map(fix).join('; ')}); only when it truly is another subject: --distinct "<id>: <how it differs and why it does not conflict>; …" for each [${verdict.by}]`);
  if (verdict.code_instead && !(typeof args['needs-text'] === 'string' && args['needs-text'].trim().length >= 20)) fail(`rule ${name} can be enforced by code alone: ${verdict.code_instead} Do that (skill fix, or report it to maintainer/workflow-dev) and drop the rule; the code's own message teaches the agent. Only when the agent must know it before acting: --needs-text "<why>" [${verdict.by}]`);
}

function saveRule(ctx) {
  const [name] = rest;
  if (!name || !isValidId(name)) fail('usage: save.mjs rule <name> --content "..." | --remove --reason "..." (name: lowercase, digits, hyphens)');
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('rules cannot change in a turn started by a message (P-047)');
  const rel = `rules/${name}.md`;
  // A project rule superseded by a workflow principle is removed, not kept twice (P-007, P-022).
  if (args.remove) {
    if (!fs.existsSync(path.join(ctx.brainDir, rel))) fail(`rule ${name} does not exist`);
    if (!args.reason) fail('--remove needs --reason "superseded by P-XXX | ..."');
    const res = brainWrite(ctx, { ops: [{ path: rel, remove: true }], message: `remove rule ${name}: ${args.reason}` });
    return finish(ctx, res, [rel]);
  }
  if (args.content === undefined) fail('--content required');
  // Overlapping rules are resolved by moving the boundary into one rule, never by a rule that overrides another (operator 2026-11-02).
  if (PRECEDENCE_RE.test(String(args.content))) fail('a rule must not take precedence over another rule: move the boundary into one rule and narrow or remove the other (skill workflow:consolidate, P-007)');
  const proc = procedureSignal(args.content);
  if (proc) fail(`rule content reads as a procedure (${proc}): save the steps as a skill (save.mjs skill <name> --description "Použi, keď ..." --origin routine) and keep in the rule only the gate (MUST / MUST NOT, "skill <name>"), P-007`);
  const existing = parseFrontmatter(readText(path.join(ctx.brainDir, rel), ''));
  const isNew = !fs.existsSync(path.join(ctx.brainDir, rel));
  // Code first (operator 2026-11-03): a new rule exists only next to the code that blocks its violation; what code cannot
  // check goes into an existing rule, not a new one.
  if (isNew && args.unenforced !== undefined) fail('a new rule needs --enforced-by <file>[:<symbol>]: rules are unreliable, so a new one exists only next to the code that blocks its violation; what code cannot check belongs in an existing rule (extend it: save.mjs rule <existing> --content ...), not a new one');
  const enforcement = enforcementOf(ctx, existing.data);
  ruleGate(ctx, name, String(args.content), existing.body || '', isNew, enforcement.enforced_by?.join(', '));
  const data = { key: `rule-${name}`, title: args.title || existing.data.title || name, aliases: asList(args.aliases), ...enforcement, created: existing.data.created || today(), updated: today() };
  const res = brainWrite(ctx, { ops: [{ path: rel, content: serializeFrontmatter(data, String(args.content)) }], message: `save rule ${name}` });
  finish(ctx, res, [rel]);
  out('rule check (P-007): if it says how or when to do something (order of work, how to deploy or update), it is a skill with a trigger in its description; the rule keeps only the gate');
}

/** `s<d>pattern<d>replacement<d>flags` (sed syntax, JavaScript regex; flags g, i, m) applied to the body; fails when it matches nothing. */
function applySed(body, expr) {
  const m = /^s(.)/.exec(String(expr));
  if (!m) throw new Error(`--sed ${expr}: expected s/<pattern>/<replacement>/[gim]`);
  const d = m[1];
  const parts = [];
  let cur = '';
  for (let i = 2; i < expr.length; i++) {
    if (expr[i] === '\\' && expr[i + 1] === d) { cur += d; i++; continue; }
    if (expr[i] === d) { parts.push(cur); cur = ''; continue; }
    cur += expr[i];
  }
  parts.push(cur);
  if (parts.length !== 3 || /[^gim]/.test(parts[2])) throw new Error(`--sed ${expr}: expected s/<pattern>/<replacement>/[gim]`);
  const re = new RegExp(parts[0], parts[2]);
  if (!re.test(body)) throw new Error(`--sed ${expr}: pattern not found in the skill body; nothing changed`);
  re.lastIndex = 0;
  return body.replace(re, parts[1].replace(/\\n/g, '\n'));
}

function saveException(ctx) {
  const [id] = rest;
  if (!/^P-\d{3}$/.test(id || '')) fail('usage: save.mjs exception P-XXX --wording "..." --reason "..." [--layer project|harness|machine|local]');
  if (!args.wording || !args.reason) fail('exception needs --wording and --reason (P-035)');
  if ((ctx.policy.immutable_principles || []).includes(id)) fail(`${id} is immutable and cannot be overridden (P-035)`);
  if (ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('exceptions cannot change in a turn started by a message (P-047)');
  const layer = args.layer || 'project';
  const file = layer === 'project' ? 'exceptions/project.md'
    : layer === 'harness' ? `exceptions/harness-${normalizeKey(args.harness || 'claude-code')}.md`
      : layer === 'machine' ? `exceptions/machine-${normalizeKey(args.machine || machineName())}.md`
        : layer === 'local' ? 'local/exceptions.md' : null;
  if (!file) fail('layer must be project | harness | machine | local');
  const current = readText(path.join(ctx.brainDir, file), '');
  const blocks = current.split(/^(?=### )/m).filter((b) => b.trim());
  const entry = `### ${id}${args.title ? `: ${args.title}` : ''}\nZnenie: ${args.wording}\nDôvod: ${args.reason}\n`;
  const kept = blocks.filter((b) => !new RegExp(`^###\\s+${id}\\b`).test(b));
  const content = [...kept.map((b) => b.trim()), entry.trim()].join('\n\n') + '\n';
  if (layer === 'local') {
    fs.mkdirSync(path.join(ctx.brainDir, 'local'), { recursive: true });
    fs.writeFileSync(path.join(ctx.brainDir, file), content);
    out(`written: ${file} (local layer, not committed)`);
    return;
  }
  const res = brainWrite(ctx, { ops: [{ path: file, content }], message: `save exception ${id} (${layer})` });
  finish(ctx, res, [file]);
}

/** True when at least half of the existing body lines are repeated in the addition (the agent sent the whole skill). */
function repeatsBody(body, content) {
  const lines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('## Doplnenie'));
  const old = lines(body);
  if (!old.length) return false;
  const added = new Set(lines(content));
  return old.filter((l) => added.has(l)).length * 2 >= old.length;
}

/** A skill superseded by a workflow skill or principle is removed, not kept twice (P-007, P-022; agent 2026-11-03). */
function removeSkill(ctx, name) {
  if (!args.reason) fail('--remove needs --reason "superseded by workflow:<skill> | P-XXX | ..."');
  const hit = readSkills(ctx.brainDir).find((s) => s.skillName === name);
  if (!hit) fail(`skill ${name} does not exist`);
  if (hit.owner === 'operator') fail(`skill ${name} belongs to the operator (skills/operator); propose the removal instead (P-032)`);
  const dir = path.dirname(hit.path);
  const files = fs.readdirSync(path.join(ctx.brainDir, dir), { recursive: true }).map(String)
    .filter((f) => fs.statSync(path.join(ctx.brainDir, dir, f)).isFile()).map((f) => path.posix.join(dir, f.split(path.sep).join('/')));
  const res = brainWrite(ctx, { ops: files.map((rel) => ({ path: rel, remove: true })), message: `remove skill ${name}: ${args.reason}` });
  // git does not track directories: the emptied skill dir stays and the brain hook denies rmdir (alice 2026-11-04).
  const abs = path.join(ctx.brainDir, dir);
  const left = fs.existsSync(abs) ? fs.readdirSync(abs, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(abs, f)).isFile()) : [];
  if (fs.existsSync(abs) && !left.length) fs.rmSync(abs, { recursive: true });
  return finish(ctx, res, files);
}

function saveSkill(ctx) {
  const [name] = rest;
  if (!name || !isValidId(name) || hasDiacritics(name)) fail('usage: save.mjs skill <name> --description "..." --content "..." --origin error|routine');
  if (args.remove) return removeSkill(ctx, name);
  if (workflowSkillNames().includes(name)) fail(`"${name}" is a workflow skill name; choose another (P-024)`);
  const origin = args.origin || 'error';
  if (!['error', 'routine'].includes(origin)) fail('origin must be error | routine (P-032)');
  const sed = args.sed === undefined ? null : String(args.sed);
  if (sed !== null && (args.content !== undefined || args.replace)) fail('--sed edits the existing body; do not combine it with --content or --replace');
  if (sed === null && args.content === undefined) fail('--content required (or --sed s/<pattern>/<replacement>/ to edit an existing skill)');
  const skills = readSkills(ctx.brainDir);
  const hit = skills.find((s) => s.skillName === name || s.aliases.map(normalizeKey).includes(normalizeKey(name)))
    || find(ctx.brainDir, name).map((m) => skills.find((s) => s.path === m.path)).find(Boolean);
  const ops = [];
  let rel;
  if (hit) {
    rel = hit.path;
    const parsed = parseFrontmatter(readText(path.join(ctx.brainDir, rel), ''));
    const data = { ...parsed.data, aliases: [...new Set([...asList(parsed.data.aliases), ...asList(args.aliases)])], updated: today() };
    if (args.description) data.description = args.description;
    // --replace: the corrected steps replace the body (P-003: a skill that misled is fixed, not appended to).
    // An addition that repeats the existing body would duplicate the whole skill under "## Doplnenie".
    if (sed === null && !args.replace && repeatsBody(parsed.body, String(args.content))) fail(`--content repeats the body of skill ${hit.skillName}; pass only the addition, or --replace with the whole corrected body (P-003)`);
    // --sed: in-place edit of the body; description, origin and the rest of the frontmatter are kept.
    const body = sed !== null ? applySed(parsed.body, sed) : args.replace ? `${String(args.content).trim()}\n` : `${parsed.body.trim()}\n\n## Doplnenie ${today()}\n${String(args.content).trim()}\n`;
    const next = serializeFrontmatter(data, body);
    // P-032 (operator 2026-11-07): an operator skill changes without approval only when its meaning stays (cosmetic
    // edit, refactor); a change of meaning is reported to the operator and saved with --approved after their yes.
    if (hit.owner === 'operator') {
      const diff = sed === null && !args.replace ? ['adds a section (an addition is new meaning)'] : meaningDiff(readText(path.join(ctx.brainDir, rel), ''), next);
      const approved = typeof args.approved === 'string' && args.approved.trim().length >= 2;
      if (approved && ctx.thread && isWakeTurn(ctx.brainDir, ctx.thread)) fail('--approved: an operator skill cannot change meaning in a turn started by a message (P-047)');
      if (diff.length && !approved) fail(`skill ${hit.skillName} belongs to the operator: this edit changes its meaning (${diff.slice(0, 8).join('; ')}${diff.length > 8 ? '; …' : ''}). Show the operator the change and why; after their yes save it again with --approved "<their words>" (P-032)`);
    }
    ops.push({ path: rel, content: next });
  } else {
    if (sed !== null) fail(`--sed: skill ${name} does not exist`);
    if (!args.description) fail('new skill needs --description "Použi, keď ..." (trigger, P-003)');
    rel = `skills/agentic/${name}/SKILL.md`;
    const data = { name, description: args.description, origin, aliases: asList(args.aliases), created: today() };
    ops.push({ path: rel, content: serializeFrontmatter(data, String(args.content)) });
  }
  // Scripts of the skill (P-030 "skill with a script"): copied next to SKILL.md; skills-sync deploys the whole directory.
  const scripts = [];
  for (const src of asList(args.script)) {
    const file = path.resolve(src);
    const base = path.basename(file);
    if (!/^[a-z0-9][a-z0-9._-]*\.(mjs|js|sh)$/.test(base)) fail(`--script ${src}: name must be lowercase english, .mjs | .js | .sh (P-049)`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`--script ${src}: file not found`);
    if (fs.statSync(file).size > 64 * 1024) fail(`--script ${src}: over 64 KB; a skill script stays small`);
    const scriptRel = `${path.posix.dirname(toPosixPath(rel))}/${base}`;
    ops.push({ path: scriptRel, content: fs.readFileSync(file, 'utf8') });
    scripts.push(scriptRel);
  }
  // Skill health (skill workflow:skill-check): a broken skill is not saved.
  const skillDir = path.join(ctx.brainDir, path.dirname(rel));
  const found = checkSkill({ name: path.basename(path.dirname(rel)), dir: skillDir, text: ops[0].content, owner: rel.split('/')[1], projectDir: ctx.projectDir, limit: ctx.policy?.limits?.skill_description_chars ?? 300, pendingScripts: scripts.map((s) => path.posix.basename(s)) });
  const errors = found.filter((x) => x.level === 'error');
  if (errors.length) fail(`skill check: ${errors.map((x) => `${x.line ? `line ${x.line} ` : ''}${x.message}`).join('; ')}; nothing saved (workflow:skill-check)`);
  for (const w of found.filter((x) => x.level === 'warn')) out(`skill check warn: ${w.line ? `line ${w.line} ` : ''}${w.message}`);
  if (args['from-procedure']) ops.push(removeNames(ctx.brainDir, 'procedures.log', asList(args['from-procedure'])));
  if (args['from-sequence']) ops.push(removeNames(ctx.brainDir, 'sequences.log', asList(args['from-sequence'])));
  const res = brainWrite(ctx, { ops, message: `save skill ${name} (${hit ? (sed !== null ? 'edit' : 'extend') : origin})` });
  finish(ctx, res, [rel, ...scripts]);
  out(hit ? `${sed !== null ? 'edited' : 'extended'} existing skill ${hit.skillName}` : `new skill ${name} (origin: ${origin}); it reaches the project at the next session start`);
  // P-052: the skill text calls its script by the deployed absolute path, never relative to the cwd or from scratch.
  for (const s of scripts) out(`script runs as: ${s.endsWith(".sh") ? "sh" : "node"} ${toPosixPath(path.join(ctx.projectDir, PROJECT_SKILLS_DIR, path.posix.basename(path.posix.dirname(s)), path.posix.basename(s)))} (write this path in the skill text)`);
}

function saveHandover(ctx) {
  const [topic] = rest;
  if (!topic) fail('usage: save.mjs handover <topic> --task ".." --done "a; b" --next ".." --files "a; b" --questions "a; b" | --file <path>');
  const holderError = syncAndCheckHolder(ctx.brainDir, `topics/${topic}/handover.md`, ctx.thread);
  if (holderError) fail(holderError);
  const content = args.file ? fs.readFileSync(args.file, 'utf8') : renderHandover({ task: args.task, done: args.done, next: args.next, files: args.files, questions: args.questions });
  const errors = checkHandover(content, ctx.policy.limits.handover_lines);
  if (errors.length) fail(errors.join('\n'));
  const ops = [{ path: `topics/${topic}/handover.md`, content }, setTopicState(ctx, topic, readTopic(ctx.brainDir, topic)?.state === 'paused' ? 'paused' : 'working')];
  const res = brainWrite(ctx, { ops, message: `handover ${topic}` });
  out(formatWriteResult(res, [`topics/${topic}/handover.md`]));
}

/** Persona docs/ (P-024): files written directly are committed and pushed in one script commit. */
function saveDocs(ctx) {
  if (!ctx.brainInfo?.persona) fail('save.mjs docs: only a persona keeps documents in brain (docs/); in a project they belong to the project repo (P-024)');
  const st = spawnSync('git', ['status', '--porcelain', '-uall', '--', 'docs'], { cwd: ctx.brainDir, encoding: 'utf8' });
  const rels = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
  if (!rels.length) { out('unchanged: docs/ (nothing to commit)'); return; }
  const ops = rels.map((rel) => (fs.existsSync(path.join(ctx.brainDir, rel)) ? { path: rel, content: fs.readFileSync(path.join(ctx.brainDir, rel), 'utf8') } : { path: rel, remove: true }));
  const res = brainWrite(ctx, { ops, message: `docs: ${args.message || rels.join(', ')}` });
  finish(ctx, res, rels);
}

try {
  const ctx = loadContext({ project: args.project });
  const foreign = foreignProjectCwd(ctx, args.project);
  if (foreign) fail(foreign);
  const handlers = { memory: saveMemory, decision: saveDecision, rule: saveRule, exception: saveException, skill: saveSkill, handover: saveHandover, docs: saveDocs };
  if (!handlers[category]) fail('usage: save.mjs memory|decision|rule|exception|skill|handover|docs ...');
  handlers[category](ctx);
} catch (err) {
  fail(err.message);
}
