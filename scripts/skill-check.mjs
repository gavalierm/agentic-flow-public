// Skill health (operator 2026-11-07): is a project skill a valid workflow skill, are its paths, references and scripts
// alive, is it free of known anti-patterns and of machine-specific paths. Scope: the skills of one project (its brain
// skills/operator and skills/agentic, and hand-written skills in <project>/.claude/skills that are not in brain).
// Findings: error (broken: the skill misleads or fails) and warn (heuristic: the agent judges).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, readJson } from './util.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { readSkills } from './records.mjs';
import { workflowSkillNames, GENERATED_MARKER, PROJECT_SKILLS_DIR, personaSkillPrefix } from './skills-sync.mjs';
import { dataLayoutVersion, topicHome, layoutFor, layoutVersions } from './layout.mjs';

const TRIGGER = /^(Použi|Použij|Use)\b/i;

/** NIST curve names (P-256 ...) look like principle ids; they are not references (Bob 2026-11-08, DNSSEC). */
const NIST_CURVES = new Set(['192', '224', '256', '384', '521']);

/** "skill `name`", "skillom `name`" ...: a reference to another skill by its name (flow-public#38). */
const SKILL_REF = /\bskill(?:om|u|y|ov|och|mi|e)?\s+`([a-z0-9][a-z0-9-]*)`/gi;

function principleIds() {
  const dir = path.join(PLUGIN_ROOT, 'docs', 'principles');
  try { return new Set(fs.readdirSync(dir).filter((f) => /^P-\d{3}\.md$/.test(f)).map((f) => f.slice(0, 5))); } catch { return null; }
}

/** Absolute paths (/..., ~/...) in a line, without trailing punctuation; placeholders (<x>, $X, *) are not checked. */
function pathsIn(line) {
  const out = [];
  for (const m of line.matchAll(/(?<![\w.$}-])(~\/|\/(?:home|root|opt|usr|etc|srv|var|tmp)\/)[^\s`'"()<>|;,]*/g)) {
    const p = m[0].replace(/[.:)\]]+$/, '');
    if (/[<>$*{}]/.test(p) || p.length < 3 || line[m.index + m[0].length] === '<') continue; // events.<thread>.log
    out.push(p);
  }
  return out;
}

const expand = (p, home) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

/** ~/agentic/alice/... when ~/agentic/Alice exists: the path from before the domain rename (P-052). */
function oldDomainPath(abs, home) {
  const root = path.join(home, 'agentic');
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return null;
  const first = rel.split(path.sep)[0];
  if (!/^[a-z]/.test(first)) return null;
  const upper = first[0].toUpperCase() + first.slice(1);
  if (fs.existsSync(path.join(root, first)) && fs.realpathSync(path.join(root, first)) !== path.join(root, first)) return path.join(root, upper, ...rel.split(path.sep).slice(1));
  if (!fs.existsSync(path.join(root, first)) && fs.existsSync(path.join(root, upper))) return path.join(root, upper, ...rel.split(path.sep).slice(1));
  return null;
}

// A line that names the anti-pattern as forbidden is a mention, not a use ("t3_thread_send … hook zamietne").
const MENTION = /(?<!\p{L})(nie|nikdy|never|not|zamietn\p{L}*|zakáz\p{L}*|denied|denies|forbidden|refuses)(?!\p{L})/iu;

// Anti-patterns: [regex, level, message]. Lines starting with "nie " (the documented wrong way) are skipped.
const ANTI = [
  [/--no-verify\b/, 'warn', 'skips git hooks (--no-verify): a bypass of a check (P-054)'],
  [/dangerouslyDisableSandbox/, 'warn', 'disables the sandbox: a bypass (P-054)'],
  [/\bgit\s+push\s+(?:\S+\s+)*(--force|-f)\b/, 'warn', 'force push rewrites shared history (P-018)'],
  [/\bgit\s+reset\s+--hard\b/, 'warn', 'git reset --hard discards work (P-018)'],
  [/\bt3_thread_send\b/, 'warn', 'another agent gets work only by mail, not t3_thread_send (P-041)'],
  [/--level\s+info\b/, 'error', 'mail level info was abolished (2026-11-02): assist'],
  [/\bsleep\s+\d{2,}/, 'warn', 'a long sleep is polling: wait on a notification or a timer (P-061)'],
  [/\bcd\s+"?\$\{?[A-Za-z_]/, 'warn', 'cd into a variable: the hook cannot resolve the target and asks (skill fix)'],
  [/(>|\btee\b|\bcp\b|\bmv\b|\brm\b|sed\s+-i).*~\/\.claude\/(?!skills\/workflow|projects)/, 'warn', 'writes into ~/.claude (user settings of the machine)'],
  [/\$\{CLAUDE_PLUGIN_ROOT\}/, 'error', '${CLAUDE_PLUGIN_ROOT} is not expanded in a project skill: use the script path the save output gives'],
];

/** The public command that prints and creates the work files folder of the thread (bin/work-dir.mjs, P-068). */
export const WORK_DIR_COMMAND = 'node ~/.claude/skills/workflow/bin/work-dir.mjs';

// "nie <wrong way>, lebo <why>" (also in a script comment): its paths document the wrong way, they are not a use.
const NIE_LINE = /^\s*(?:\/\/|#|\*|-)?\s*nie\s/i;
const NIE_LEBO = /(?<!\p{L})nie(?!\p{L}).*(?<!\p{L})lebo(?!\p{L})/iu;

/** Visible marker on a line that the check cannot tell from a use: its paths are not work files of the thread (P-068). */
export const WORK_PATH_OK = 'work-path: ok';
// A comment line of a script (#, //, /* or *): it describes, it does not use a path. The shebang is no path either.
const SCRIPT_COMMENT = /^\s*(?:#|\/\/|\/\*|\*)/;
// The label of a shell case branch (`scratch/?*)`): it matches a string, it does not touch the path.
const CASE_LABEL = /^\s*[^\s()|;]+(?:\|[^\s()|;]+)*\)/;
// The quoted message of echo or printf: text for the reader, a redirect after it stays checked.
const ECHO_MESSAGE = /\b(?:echo|printf)\s+(?:-\w+\s+)*(?:"[^"]*"|'[^']*')/g;
// The root before the path: a variable ($p/, ${p}/, not $HOME) or a placeholder (<projekt>/) names another folder
// chosen at run time (a pilot or a copied project), not the work files of this thread.
const FOREIGN_ROOT = String.raw`(?<!(?:\$(?!HOME\b)\w+|\$\{(?!HOME\})\w+\}|<[^<>\s]+>)\/)`;
const SCRATCH = new RegExp(String.raw`(?<![\w.$-])${FOREIGN_ROOT}scratch\/(?!,)`, 'g');
// The topic folders of every layout with work files per topic (temy/ in 2, topics/ in 3).
const TOPIC_DIRS = [...new Set(layoutVersions().map((v) => layoutFor(v)).filter((L) => L.topicTmp).map((L) => L.topics))].join('|');
const TOPIC_TMP = new RegExp(String.raw`(?<![\w.$-])${FOREIGN_ROOT}(?:${TOPIC_DIRS})\/[^\s/\`'"<>$*{}()[\]]+\/tmp(?![\w-])`, 'g');

/**
 * Fixed work files paths in one line (P-068): a use (write, read, cd, mktemp, redirect, command argument) of a literal
 * scratch/ or temy/<a concrete topic>/tmp. Not a use, so it passes: the placeholder temy/<téma>/tmp/ (also $X, ${x}, *);
 * "nie …, lebo …" lines; a shell variable named scratch ($scratch/); a path under another root in a variable or
 * placeholder ($p/scratch/, <projekt>/scratch/); the bare folder name in an enumeration ("scratch/, .worktrees");
 * the WORK_PATH_OK marker. In a script (script: true) also a comment line, a case label and an echo/printf message.
 * Meaningful only in a topic home of data layout 2.
 */
export function fixedWorkPaths(line, { script = false } = {}) {
  if (NIE_LINE.test(line) || NIE_LEBO.test(line) || line.includes(WORK_PATH_OK)) return [];
  let text = line;
  if (script) {
    if (SCRIPT_COMMENT.test(text)) return [];
    text = text.replace(CASE_LABEL, '').replace(ECHO_MESSAGE, '');
  }
  return [...text.matchAll(SCRATCH), ...text.matchAll(TOPIC_TMP)].map((m) => m[0]);
}

const workPathMessage = (p) => `fixed work files path ${p}: the folder depends on the topic the thread holds and the data layout; get it at run time with \`${WORK_DIR_COMMAND}\` (--main: topic main), in the text write the placeholder temy/<téma>/tmp/ (P-068); a line that only describes the path (data 1, another project) passes with the marker "${WORK_PATH_OK}"`;

/**
 * Check one skill. { name, dir, text, owner: operator|agentic|unmanaged, projectDir, home, limit, layout, scriptTexts }
 * -> findings [{ level, line, code, message }]. layout: data layout of the topic home (2: fixed work paths are errors);
 * scriptTexts: { <file>: content } of scripts being saved (others are read from dir). Pure apart from filesystem reads.
 */
export function checkSkill({ name, dir, text, owner, projectDir, home = os.homedir(), limit = 300, pendingScripts = [], removedScripts = [], known = null, layout = null, scriptTexts = {} }) {
  const findings = [];
  const add = (level, line, code, message) => findings.push({ level, line, code, message });
  // Work files per topic (no scratch/: layouts 2, 3): a fixed work files path is an error (P-068).
  let perTopic = false;
  try { perTopic = layout !== null && layout !== undefined && layoutFor(layout).scratch === null; } catch { perTopic = false; }
  const prefix = personaSkillPrefix(projectDir);
  const { data, body } = parseFrontmatter(text);
  const bodyStart = text.split('\n').length - body.split('\n').length; // lines before the body
  if (!data.name) add('error', 1, 'name', 'frontmatter has no name');
  else if (String(data.name) !== name) add('error', 1, 'name', `frontmatter name "${data.name}" differs from the folder ${name}`);
  if (workflowSkillNames().includes(name)) add('error', 1, 'name', `"${name}" is a workflow skill name (P-024)`);
  const desc = data.description ? String(data.description) : '';
  if (!desc) add('error', 1, 'description', 'no description: the skill has no trigger (P-003)');
  else {
    if (!TRIGGER.test(desc)) add('warn', 1, 'description', 'description does not start with "Použi, keď …": a trigger names the situation (P-003)');
    if (desc.length > limit) add('error', 1, 'description', `description over ${limit} chars (P-022)`);
  }
  if (owner === 'agentic' && !['error', 'routine'].includes(data.origin)) add('error', 1, 'origin', 'skill in agentic/ needs origin: error | routine (P-032)');
  if (owner === 'unmanaged') add('warn', 1, 'unmanaged', `not in brain: find and consolidate do not see it and other machines do not get it; move it to skills/operator/${name}`);

  const principles = principleIds();
  const wf = new Set(workflowSkillNames());
  const own = [...new Set([...(dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mjs|js|sh|py)$/.test(f)) : []), ...pendingScripts])].filter((f) => !removedScripts.includes(f));
  const referenced = new Set();
  const lines = body.split('\n');
  let additions = 0;
  let hasNie = false;
  lines.forEach((raw, i) => {
    const n = bodyStart + i + 1;
    const line = raw.trim();
    if (/^##\s+Doplnenie\b/.test(line)) additions++;
    for (const f of own) if (line.includes(f)) referenced.add(f);
    if (/^nie\s/i.test(line) || /\\nnie\s/.test(line)) hasNie = true;
    if (/^nie\s/i.test(line)) return;
    for (const m of line.matchAll(/\bworkflow:([a-z][a-z0-9-]*)/g)) if (!wf.has(m[1])) add('error', n, 'reference', `workflow:${m[1]} does not exist`);
    // flow-public#38: a project skill named a skill the project does not have and the checking worker did not load it.
    if (known) for (const m of line.matchAll(SKILL_REF)) if (!known.has(m[1])) add('error', n, 'reference', `skill ${m[1]} does not exist in this project`);
    if (principles) for (const m of line.matchAll(/\bP-(\d{3})\b/g)) if (!NIST_CURVES.has(m[1]) && !principles.has(`P-${m[1]}`)) add('error', n, 'reference', `P-${m[1]} does not exist`);
    for (const p of pathsIn(line)) {
      const abs = expand(p, home);
      const renamed = oldDomainPath(abs, home);
      if (renamed) { add('error', n, 'path', `${p}: path from before the domain rename; now ${renamed.replace(home, '~')}`); continue; }
      const inSkills = /\/\.claude\/skills\/[^/]+\/[^/]+\.(mjs|js|sh|py)$/.test(abs);
      // D-0065: a persona deploys its own skill <name> as <persona>-<name>; the deployed copy rewrites the brain path.
      const prefixed = inSkills && prefix ? path.join(path.dirname(path.dirname(abs)), prefix + path.basename(path.dirname(abs)), path.basename(abs)) : null;
      if (!fs.existsSync(abs) && !(prefixed && fs.existsSync(prefixed))) {
        // A script of this skill is deployed at session start: it exists in the skill folder of brain.
        const deployedOwn = inSkills && [name, prefix + name].includes(path.basename(path.dirname(abs))) && own.includes(path.basename(abs));
        if (!deployedOwn) add(inSkills ? 'error' : 'warn', n, 'path', `${p} does not exist`);
      }
      const inProject = projectDir && (abs + path.sep).startsWith(path.dirname(path.resolve(projectDir)) + path.sep);
      if (!inProject && !abs.startsWith(path.join(home, '.claude')) && /^\/(home|root)\//.test(abs) && !abs.startsWith(home + path.sep)) {
        add('warn', n, 'environment', `${p}: home of another user; the skill works only on this machine`);
      }
    }
    if (perTopic) for (const p of fixedWorkPaths(line)) add('error', n, 'work-path', workPathMessage(p));
    if (/\S\\n\S|\\n\d+\./.test(line.replace(/`[^`]*`/g, ''))) add('error', n, 'format', 'literal \\n in the text: the line breaks were saved as characters (pass real newlines)');
    for (const [re, level, message] of ANTI) if (re.test(line) && (level === 'error' || !MENTION.test(line))) add(level, n, 'anti-pattern', message);
  });
  if (owner === 'agentic' && data.origin === 'error' && !hasNie) add('warn', 0, 'nie-line', 'skill from an error has no "nie <wrong way>, lebo <why>" line (P-003)');
  // An appended section makes the skill a pile of additions instead of one procedure (operator 2026-11-08).
  if (additions >= 1) add('warn', 0, 'growth', `${additions} "## Doplnenie" section(s): merge them into one coherent body without loss of meaning (save skill --replace)`);
  if (body.length > 8000) add('warn', 0, 'growth', `body ${body.length} chars: shorten or split by tool`);
  for (const f of own) if (!referenced.has(f)) add('warn', 0, 'script', `${f} in the skill folder is not called from SKILL.md`);
  if (perTopic) {
    for (const f of own) {
      let content = scriptTexts[f];
      if (content === undefined) { try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; } }
      String(content).split('\n').forEach((l, i) => { for (const p of fixedWorkPaths(l, { script: true })) add('error', 0, 'work-path', `${f}:${i + 1}: ${workPathMessage(p)}`); });
    }
  }
  return findings;
}

/** Skills of the project: brain skills and hand-written ones in <project>/.claude/skills (not generated, not workflow). */
export function projectSkills(ctx) {
  const out = readSkills(ctx.brainDir).map((s) => ({ name: path.basename(path.dirname(s.path)), owner: s.owner, dir: path.dirname(path.join(ctx.brainDir, s.path)), file: path.join(ctx.brainDir, s.path) }));
  const target = path.join(ctx.projectDir, PROJECT_SKILLS_DIR);
  const generated = new Set(readJson(path.join(target, GENERATED_MARKER), { generated: [] }).generated || []);
  const known = new Set([...out.map((s) => s.name), ...workflowSkillNames()]);
  if (fs.existsSync(target)) {
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      const file = path.join(target, e.name, 'SKILL.md');
      if (e.isDirectory() && !generated.has(e.name) && !known.has(e.name) && fs.existsSync(file)) out.push({ name: e.name, owner: 'unmanaged', dir: path.join(target, e.name), file });
    }
  }
  return out;
}

/** Skill names a project skill may refer to: its brain and hand-written skills, skills deployed into the project (also from the domain brain), workflow skills and user-level skills. */
function knownSkillNames(ctx, skills) {
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
  return new Set([...skills.map((s) => s.name), ...dirs(path.join(ctx.projectDir, PROJECT_SKILLS_DIR)), ...workflowSkillNames(), ...dirs(path.join(os.homedir(), '.claude', 'skills'))]);
}

/** Data layout of the topic home whose work files the skills of this project use (topicHome: a brain in layout 2, else the project). */
export function workLayout(ctx) {
  const home = topicHome(ctx.brainDir, ctx.projectDir);
  return home ? dataLayoutVersion(home) : null;
}

export function checkProject(ctx, only = null) {
  const limit = ctx.policy?.limits?.skill_description_chars ?? 300;
  const skills = projectSkills(ctx);
  const known = knownSkillNames(ctx, skills);
  return skills.filter((s) => !only || s.name === only).map((s) => ({
    ...s,
    findings: checkSkill({ name: s.name, dir: s.dir, text: fs.readFileSync(s.file, 'utf8'), owner: s.owner, projectDir: ctx.projectDir, limit, known, layout: workLayout(ctx) }),
  }));
}

/**
 * Facts of a skill text whose change changes its meaning: commands and paths (code spans), principle and skill
 * references, "nie" lines, numbers with units. A cosmetic edit or refactor keeps them all (operator 2026-11-07:
 * an operator skill changes without approval only when the meaning stays).
 */
export function skillFacts(text) {
  const { data, body } = parseFrontmatter(text);
  const facts = new Set();
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) facts.add(`code:${norm(m[1])}`);
  for (const m of body.matchAll(/\bP-\d{3}\b|\bworkflow:[a-z][a-z0-9-]*/g)) facts.add(`ref:${m[0]}`);
  for (const l of body.split('\n')) if (/^\s*nie\s/i.test(l)) facts.add(`nie:${norm(l).replace(/[.;]$/, '')}`);
  for (const m of body.matchAll(/\b\d+(?:[.,]\d+)?\s?(?:s|ms|min|h|KB|MB|%|×|x)\b/g)) facts.add(`num:${norm(m[0])}`);
  facts.add(`description:${norm(String(data.description || ''))}`);
  return facts;
}

/** What an edit lost or added ([] = meaning kept). The case of a domain folder (~/agentic/alice -> Alice) is not meaning. */
export function meaningDiff(before, after) {
  const fix = (f) => f.replace(/agentic\/([A-Za-z])/g, (m, c) => `agentic/${c.toLowerCase()}`);
  const a = new Set([...skillFacts(before)].map(fix));
  const b = new Set([...skillFacts(after)].map(fix));
  const diff = [...[...a].filter((f) => !b.has(f)).map((f) => `lost ${f}`), ...[...b].filter((f) => !a.has(f)).map((f) => `added ${f}`)];
  // Rewording keeps the length; new sentences are new meaning.
  const words = (t) => parseFrontmatter(t).body.split(/\s+/).filter(Boolean).length;
  if (words(after) > words(before) * 1.15 + 10) diff.push(`added text (${words(before)} -> ${words(after)} words)`);
  return diff;
}

export function formatFindings(results) {
  const lines = [];
  for (const r of results) {
    const errors = r.findings.filter((f) => f.level === 'error').length;
    const warns = r.findings.length - errors;
    lines.push(`${r.name} (${r.owner}): ${r.findings.length ? `${errors} error, ${warns} warn` : 'ok'}`);
    for (const f of r.findings) lines.push(`  ${f.level} ${f.line ? `line ${f.line}` : 'skill'} [${f.code}] ${f.message}`);
  }
  return lines.join('\n');
}
