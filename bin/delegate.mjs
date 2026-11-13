#!/usr/bin/env node
// Support script for skill delegate (P-027, P-028): bundle brain skills whose trigger matches the task, and check a worker result.
//   delegate.mjs prepare --task "..."             -> task block with bundled skills (paste into the Agent prompt)
//   delegate.mjs prepare --task-file <file>       -> the same with the brief read from a file (flow-public#38)
//   delegate.mjs prepare ... --agent <type>       -> checks the tools of the agent type the brief goes to (report-dd4ad700)
//   delegate.mjs prepare --implement [web|code|ops] [--topic <id>] --task-file <file>
//                                                 -> brief of an implementation worker in the code copy of a topic this
//                                                    thread holds (D-0020, D-0021): an "implement:" marker line (topic, class,
//                                                    model, copy, branch), the worker rules (only the copy, no commit), and on
//                                                    stderr the Agent call with model = subagent_model of the class (P-053);
//                                                    {at, class, model} goes into topics/<id>/topic.json (implementations)
//   delegate.mjs check (--file <result> | --stdin) -> verifies "Failures" section and the size limit
// Bundling (issue #28): a skill's full text goes into the brief only when at least STRONG_MATCHES meaningful task words
// match its trigger, and only while the bundled text stays under the size limit. Weaker matches are listed by name and path.
// Implementation class: a web, code or ops topic implements in its own class; a discussion topic names the class of the work
// (--implement web|code|ops) and needs its code copy first (topic.mjs copy <id> --operator-approved). The PreToolUse hook
// refuses an Agent call that names the copy without the marker or with another model.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, readStdin, readText } from '../scripts/util.mjs';
import { loadContext, inSubagent } from '../scripts/config.mjs';
import { heldTopics, hasCodeCopy, isDiscussionTopic, implementationClass, ensureCodeCopy, recordImplementation, implementMarker, IMPLEMENT_CLASSES, IMPLEMENT_HELP } from '../scripts/topic.mjs';
import { isMainTopic } from '../scripts/comms.mjs';
import { readSkills } from '../scripts/records.mjs';
import { tokens } from '../scripts/keys.mjs';
const toPosixPath = (p) => String(p).replace(/\\/g, '/');

export const STRONG_MATCHES = 2;
export const BUNDLE_CHARS = 12000;
// Common words (normalized, no diacritics) that occur in almost every task and trigger: they never count as a match.
const COMMON = new Set(['treba', 'pouzi', 'kedy', 'potom', 'alebo', 'tento', 'tato', 'toto', 'bude', 'budu', 'subor', 'subory', 'zadanie', 'zadania', 'vysledok', 'vysledky', 'skill', 'skills', 'workflow', 'worker', 'pracovnik', 'agent', 'brain', 'projekt', 'project', 'prompt', 'task', 'file', 'files', 'output', 'that', 'with', 'from', 'this', 'into', 'have', 'will', 'about', 'some', 'ktory', 'ktora', 'ktore', 'lebo', 'este', 'aby', 'tiez', 'user', 'the', 'and', 'for']);

const args = parseArgs(process.argv.slice(2));
const [cmd] = args._;
const out = (s) => process.stdout.write(s + '\n');

/** Skills with at least one meaningful task word in their name, description or aliases, most matches first (a count of distinct words). */
export function matchSkills(skills, task) {
  const want = new Set(tokens(task).filter((t) => t.length > 3 && !COMMON.has(t)));
  return skills
    .map((skill) => {
      const found = new Set(tokens(`${skill.skillName} ${skill.description} ${skill.aliases.join(' ')}`).filter((t) => want.has(t)));
      return { skill, score: found.size };
    })
    .filter((m) => m.score >= 1)
    .sort((a, b) => b.score - a.score || a.skill.skillName.localeCompare(b.skill.skillName));
}

/** Skills with a strong match (at least `minMatches` distinct meaningful words). */
export function selectSkills(skills, task, minMatches = STRONG_MATCHES) {
  return matchSkills(skills, task).filter((m) => m.score >= minMatches).map((m) => m.skill);
}

/** { bundled: [{ skill, body }], listed: [skill] }: full text for strong matches while the total stays under `limit` chars. */
export function bundleSkills(brainDir, skills, task, { minMatches = STRONG_MATCHES, limit = BUNDLE_CHARS } = {}) {
  const bundled = [];
  const listed = [];
  let used = 0;
  for (const { skill, score } of matchSkills(skills, task)) {
    const body = score >= minMatches ? readText(path.join(brainDir, skill.path), '').trim() : null;
    if (body !== null && used + body.length <= limit) {
      bundled.push({ skill, body });
      used += body.length;
    } else {
      listed.push(skill);
    }
  }
  return { bundled, listed };
}

export function checkResult(text, limit) {
  const errors = [];
  if (!/(^|\n)\s*(#+\s*|\*\*)?failures\b/i.test(text)) errors.push('missing "Failures" section (P-028)');
  if (text.length > limit) errors.push(`result ${text.length} chars > ${limit} (P-027)`);
  return errors;
}

// flow-public#48: a brief forbade reading the project's files and named the source list the worker had to read in one, so the
// worker could not use it. A ban on reading files in a brief that names a file is refused; a ban on the rest passes.
const READ_BAN = /(ne[čc][ií]taj|nesmie[sš]?\s+[čc][ií]ta[tť]|zak[aá]zan[eé]\s+[čc][ií]ta[tť]|do not read|don'?t read|never read|must not read)[^.\n]{0,40}?\b(s[uú]bor\w*|files?|projekt\w*|project|repo\w*)/i;
const NAMED_FILE = /(^|[\s`'"(])((\.{1,2}\/|\/|~\/)?[\w.-]+\/)*[\w-]+\.(md|csv|tsv|txt|json|jsonl|ya?ml|xml|html?|xlsx?|pdf)\b/i;
export function readBanConflict(task) {
  const text = String(task || '');
  const ban = text.match(READ_BAN);
  const file = text.match(NAMED_FILE);
  return ban && file ? { ban: ban[0].trim(), file: file[0].trim().replace(/^[`'"(]/, '') } : null;
}

// report-dd4ad700: a brief for an agent type of another plugin (no Bash, no Write) asked it to save raw API responses into
// scratch/; the agent could not, the data stayed only in the harness tool results. prepare --agent <type> reads the type's
// tools and refuses a brief that needs file writes from a type without Write, Edit and Bash.
const WRITE_TOOLS = ['Write', 'Edit', 'Bash'];
const splitTools = (v) => (v == null ? null : String(v).replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
function frontmatter(text) {
  const m = String(text).match(/^---\r?\n([^]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, ''); // YAML comment after a value ("tools: Read, Bash  # why")
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) { key = kv[1]; out[key] = kv[2]; continue; }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && key) out[key] = out[key] ? `${out[key]}, ${item[1]}` : item[1];
  }
  return out;
}
function* agentFiles(dir, name, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 6) {
      if (e.name === 'agents') { const f = path.join(p, `${name}.md`); if (fs.existsSync(f)) yield f; } else yield* agentFiles(p, name, depth + 1);
    }
  }
}
/** Definition file and tool set of an agent type ("plugin:name" or "name"); tools null = all tools of the harness. */
export function agentTools(type, { projectDir, home = process.env.HOME, pluginRoot = path.join(import.meta.dirname, '..') } = {}) {
  const [plugin, name] = String(type).includes(':') ? String(type).split(':') : [null, String(type)];
  const candidates = [];
  if (plugin === 'workflow') candidates.push(path.join(pluginRoot, 'agents', `${name}.md`));
  else if (plugin) {
    for (const f of agentFiles(path.join(home || '', '.claude', 'plugins'), name)) if (f.split(path.sep).includes(plugin)) candidates.push(f);
  } else candidates.push(path.join(projectDir || '', '.claude', 'agents', `${name}.md`), path.join(home || '', '.claude', 'agents', `${name}.md`));
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return null;
  const fm = frontmatter(fs.readFileSync(file, 'utf8'));
  return { file, tools: splitTools(fm.tools), disallowed: splitTools(fm.disallowedTools) || [] };
}
/** Write tools the agent type has (Write, Edit, Bash). */
export function writeToolsOf(def) {
  return WRITE_TOOLS.filter((t) => (!def.tools || def.tools.includes(t) || def.tools.includes('*')) && !def.disallowed.includes(t));
}
// A brief that asks the worker to store something (raw responses, a result file, scratch/).
const NEEDS_WRITE = /(ulo[žz]|zap[ií][šs]|uchovaj|save|store|write)\p{L}*[^.\n]{0,80}?(scratch|s[uú]bor\p{L}*|files?|json|csv|odpove\p{L}*|responses?|dat\p{L}*|data)|\bscratch\//iu;
export const needsWrite = (task) => NEEDS_WRITE.test(String(task || ''));
// report-dd4ad700: an agent skipped a paid data source because the brief named no budget.
const PAID = /(platen\p{L}*|plat[ií]\s+sa\s+za|spoplatn\p{L}*|\bpaid\b|\bpay-per\p{L}*|\bapi\s+s\s+poplatkom)/iu;
const BUDGET = /(rozpo[čc]\p{L}*|budget|limit\p{L}*\s+(ceny|n[aá]klad\p{L}*|kredit\p{L}*|\$|€)|najviac\s+\$?\d|max(\.|imum)?\s+\$?\d|nepou[žz][ií]va[jť]\s+platen|bez\s+platen)/iu;
export function paidWithoutBudget(task) {
  const text = String(task || '');
  const m = text.match(PAID);
  return m && !BUDGET.test(text) ? m[0].trim() : null;
}

/** The work topic this thread holds that an implementation goes into; --topic <id> picks one of several (D-0020). */
export function implementTopic(ctx, asked) {
  if (inSubagent()) throw new Error('delegate.mjs prepare --implement refused in subagent: the main agent of the topic thread delegates an implementation (P-025)');
  if (!ctx.thread) throw new Error('--implement needs a stable thread id (WORKFLOW_THREAD_ID / T3CODE_THREAD_ID, P-038): the thread that holds the topic delegates its implementation');
  if (asked === true || (asked !== undefined && !String(asked).trim())) throw new Error('--topic needs a topic id');
  const held = heldTopics(ctx.brainDir, ctx.thread).filter((t) => !isMainTopic(t));
  const ids = held.map((t) => t.id).join(', ') || 'none';
  if (asked) {
    const topic = held.find((t) => t.id === String(asked).trim());
    if (!topic) throw new Error(`this thread does not hold topic ${asked}: an implementation goes into a topic the thread holds (P-037); held: ${ids}`);
    return topic;
  }
  if (!held.length) throw new Error('this thread holds no work topic: an implementation goes into the code copy of a topic it holds (D-0020); create or claim the topic first');
  if (held.length > 1) throw new Error(`this thread holds ${held.length} topics (${ids}): pick one with --topic <id>`);
  return held[0];
}

/** Implementation of a brief (D-0020): topic, class, model, code copy; evidence recorded. Throws on every refusal. */
export function prepareImplementation(ctx, { implement, topic: askedTopic }) {
  const topic = implementTopic(ctx, askedTopic);
  if (!hasCodeCopy(topic)) {
    const approved = isDiscussionTopic(topic);
    throw new Error(`topic ${topic.id} (${topic.class ? `class ${topic.class}` : topic.kind}) has no code copy: ${approved ? `its implementation is approved by the operator (D-0020); after the operator's explicit yes: topic.mjs copy ${topic.id} --operator-approved` : `make it: topic.mjs copy ${topic.id}`}, then rerun delegate.mjs prepare --implement${IMPLEMENT_CLASSES.includes(topic.class) ? '' : ' <class>'} --task-file <file> (classes: ${IMPLEMENT_HELP})`);
  }
  const { cls, model } = implementationClass(ctx, topic, typeof implement === 'string' ? implement : null);
  const copy = ensureCodeCopy(ctx, topic.id);
  recordImplementation(ctx, topic.id, { cls, model });
  return { id: topic.id, cls, model, copy: copy.path, branch: copy.branch, marker: implementMarker({ id: topic.id, cls, model, copy: copy.path, branch: copy.branch }) };
}

if (process.argv[1]?.endsWith('delegate.mjs')) try {
  const ctx = loadContext({ project: args.project, requireBrain: cmd === 'prepare' });
  if (cmd === 'prepare') {
    // flow-public#38: a long brief from a file, not --task "$(cat file)".
    const task = args['task-file'] ? readText(path.resolve(String(args['task-file']))) : args.task;
    if (args['task-file'] && task === null) fail(`task file not found: ${args['task-file']}`);
    if (!task || task === true) fail('usage: delegate.mjs prepare --task "..." | --task-file <file>');
    const conflict = readBanConflict(task);
    if (conflict) fail(`the brief forbids reading files ("${conflict.ban}") and names ${conflict.file}: the worker needs the files the brief names (a source list, an input), so allow reading them and forbid only the rest (flow-public#48)`);
    const paid = paidWithoutBudget(task);
    if (paid) fail(`the brief names a paid source ("${paid}") without a budget: state the budget (rozpočet: najviac <suma> / <počet volaní>) or that the paid source is not used, so the worker neither skips it nor overspends (report-dd4ad700)`);
    let agentDef = null;
    if (args.agent && args.agent !== true) {
      agentDef = agentTools(args.agent, { projectDir: ctx.projectDir });
      if (!agentDef) fail(`agent type ${args.agent} not found (workflow:<name> in the plugin, <plugin>:<name> under ~/.claude/plugins, <name> in .claude/agents): prepare checks the tools of the type the brief goes to (report-dd4ad700)`);
      if (needsWrite(task) && !writeToolsOf(agentDef).length) fail(`agent type ${args.agent} has no Write, Edit or Bash (${toPosixPath(agentDef.file)}: tools ${agentDef.tools ? agentDef.tools.join(', ') : 'all'}${agentDef.disallowed.length ? `, disallowed ${agentDef.disallowed.join(', ')}` : ''}) and the brief asks it to store files: give the writing part to workflow:worker, or have the agent return the data and store it in the parent (report-dd4ad700)`);
    }
    const impl = args.implement ? prepareImplementation(ctx, { implement: args.implement, topic: args.topic }) : null;
    const limit = ctx.policy.limits.worker_result_chars;
    const { bundled, listed } = bundleSkills(ctx.brainDir, readSkills(ctx.brainDir), String(task), {
      minMatches: ctx.policy.limits.worker_skill_min_matches ?? STRONG_MATCHES,
      limit: ctx.policy.limits.worker_skill_chars ?? BUNDLE_CHARS,
    });
    const parts = [];
    parts.push('## Zadanie', String(task).trim(), '');
    if (impl) {
      const copy = toPosixPath(impl.copy);
      parts.push('## Implementácia (D-0020)', impl.marker,
        `- Meň iba súbory v kópii kódu ${copy} (vetva ${impl.branch}); mimo nej nezapisuj nič okrem pracovných súborov.`,
        '- Necommituj, nepushuj, nezlučuj (merge, rebase) ani netaguj: hook to v kópii odmietne; commit, zlúčenie a vydanie robí vlákno témy po kontrole (D-0020).',
        '- Nezapisuj do brain (P-013, P-025).',
        '- Vráť súhrn zmien (súbor a jedna veta ku každému) a spustené testy s výsledkom (počty prešlo/zlyhalo).', '');
    }
    if (agentDef) {
      const w = writeToolsOf(agentDef);
      parts.push('## Nástroje agenta', `- Typ ${args.agent}: ${agentDef.tools ? agentDef.tools.join(', ') : 'všetky nástroje'}${agentDef.disallowed.length ? ` (bez ${agentDef.disallowed.join(', ')})` : ''}.`,
        w.length ? `- Zápis súborov: ${w.join(', ')}.` : '- Súbory zapisovať nevie: dáta vráť vo výsledku, uloží ich rodič.', '');
    }
    parts.push('## Pravidlá výsledku', `- Vráť záver so zdrojmi, najviac ${limit} znakov; nie surový obsah.`, '- Nezapisuj do brain, nedrž tému, nekomunikuj s operátorom; výsledok vráť rodičovi (P-025).', '- Kód meň iba v kópii témy, ak ju zadanie uvádza.', '- Zdroj, ktorý zlyhá (403, timeout, blokovanie), nie je koniec úlohy: skús ho raz inou cestou, ktorú zadanie nezakazuje (iná adresa zdroja, `curl -sL` cez Bash), potom ho uveď vo Failures a pokračuj ďalšími zdrojmi. Prehliadač, ktorý sa nespustil a nahradil ho curl, patrí do Failures aj s vrátenou stránkou: curl nespúšťa JavaScript, obsah načítaný skriptom (tabuľky, EAN) v ňom chýba.', `- Pracovné súbory (pokusy, klon, medzivýsledky) iba do ${toPosixPath(path.join(ctx.projectDir, 'scratch'))}/, nikdy /tmp ani ~ (P-052).`, '- Výsledok MUSÍ končiť časťou "Failures: čo zlyhalo a čo nakoniec fungovalo" (alebo "Failures: none").', '');
    if (bundled.length) {
      parts.push('## Pribalené skilly');
      for (const { skill, body } of bundled) parts.push(`### ${skill.skillName} (${skill.path})`, body, '');
    } else {
      parts.push('## Pribalené skilly', '(žiadny skill brain nezodpovedá zadaniu)', '');
    }
    if (listed.length) {
      parts.push('## Ďalšie zhody (nepribalené; čítaj iba ak treba)');
      for (const s of listed) parts.push(`- ${s.skillName} (${s.path})`);
      parts.push('');
    }
    out(parts.join('\n'));
    const names = (list) => (list.length ? list.map((s) => s.skillName).join(', ') : 'none');
    process.stderr.write(`bundled skills: ${names(bundled.map((b) => b.skill))}; listed: ${names(listed)}\n`);
    if (impl) process.stderr.write(`agent: Agent tool (subagent_type workflow:worker) with model: "${impl.model}" and this block as the prompt (class ${impl.cls} of topic ${impl.id}, P-053); commit, merge and release stay in this thread (D-0020)\n`);
  } else if (cmd === 'check') {
    const text = args.file ? fs.readFileSync(args.file, 'utf8') : readStdin();
    const errors = checkResult(text, ctx.policy.limits.worker_result_chars);
    if (errors.length) fail(`worker result rejected:\n- ${errors.join('\n- ')}`, 2);
    out(`worker result ok (${text.length} chars); process its Failures via workflow:error`);
  } else {
    fail('usage: delegate.mjs prepare --task "..." | prepare --task-file <file> [--agent <type>] [--implement [web|code|ops] [--topic <id>]] | check --file <result>');
  }
} catch (err) {
  fail(err.message);
}
