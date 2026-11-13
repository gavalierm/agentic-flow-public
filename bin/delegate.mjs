#!/usr/bin/env node
// Support script for skill delegate (P-027, P-028): bundle brain skills whose trigger matches the task, and check a worker result.
//   delegate.mjs prepare --task "..."             -> task block with bundled skills (paste into the Agent prompt)
//   delegate.mjs prepare --task-file <file>       -> the same with the brief read from a file (flow-public#38)
//   delegate.mjs check (--file <result> | --stdin) -> verifies "Failures" section and the size limit
// Bundling (issue #28): a skill's full text goes into the brief only when at least STRONG_MATCHES meaningful task words
// match its trigger, and only while the bundled text stays under the size limit. Weaker matches are listed by name and path.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, readStdin, readText } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
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

if (process.argv[1]?.endsWith('delegate.mjs')) try {
  const ctx = loadContext({ project: args.project, requireBrain: cmd === 'prepare' });
  if (cmd === 'prepare') {
    // flow-public#38: a long brief from a file, not --task "$(cat file)".
    const task = args['task-file'] ? readText(path.resolve(String(args['task-file']))) : args.task;
    if (args['task-file'] && task === null) fail(`task file not found: ${args['task-file']}`);
    if (!task || task === true) fail('usage: delegate.mjs prepare --task "..." | --task-file <file>');
    const conflict = readBanConflict(task);
    if (conflict) fail(`the brief forbids reading files ("${conflict.ban}") and names ${conflict.file}: the worker needs the files the brief names (a source list, an input), so allow reading them and forbid only the rest (flow-public#48)`);
    const limit = ctx.policy.limits.worker_result_chars;
    const { bundled, listed } = bundleSkills(ctx.brainDir, readSkills(ctx.brainDir), String(task), {
      minMatches: ctx.policy.limits.worker_skill_min_matches ?? STRONG_MATCHES,
      limit: ctx.policy.limits.worker_skill_chars ?? BUNDLE_CHARS,
    });
    const parts = [];
    parts.push('## Zadanie', String(task).trim(), '');
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
  } else if (cmd === 'check') {
    const text = args.file ? fs.readFileSync(args.file, 'utf8') : readStdin();
    const errors = checkResult(text, ctx.policy.limits.worker_result_chars);
    if (errors.length) fail(`worker result rejected:\n- ${errors.join('\n- ')}`, 2);
    out(`worker result ok (${text.length} chars); process its Failures via workflow:error`);
  } else {
    fail('usage: delegate.mjs prepare --task "..." | prepare --task-file <file> | check --file <result>');
  }
} catch (err) {
  fail(err.message);
}
