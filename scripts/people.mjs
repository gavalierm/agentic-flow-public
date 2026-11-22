// People (spec 6, 4 REPO OPERÁTORA, 11.8): one record per person in osoby/<id>.md of the operator repo, a generated
// INDEX.md alias -> person, profile.md naming the operator's own record. The operator repo and its profile.md come from the
// configuration of the installation (plan O9: ~/.config/agentic-flow/config.json, keys operator_repo and profile), not
// from a brain, because one brain is shared by machines of several operators.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, readJson, toPosix, today } from './util.mjs';
import { cloneWrite } from './own-clone.mjs';
import { parseFrontmatter, serializeFrontmatter, asList } from './frontmatter.mjs';
import { normalizeKey, isValidId } from './keys.mjs';
import { lc, machineStores, storeRecords, recordType } from './stores.mjs';
import { recordAuthors, localIdentity, sameIdentity } from './authors.mjs';

export const PEOPLE_DIR = 'osoby';
export const PEOPLE_INDEX = 'INDEX.md';
export const DEFAULT_PROFILE = 'profile.md';
/** Chars of the operator's record the session start shows (the rest is read from the file). */
export const PROFILE_CHARS = 1500;

const home = (env) => env.HOME || os.homedir();
const expand = (p, env) => String(p).replace(/^~(?=$|[\\/])/, home(env));

/** The configuration file of the installation; WORKFLOW_INSTALL_CONFIG replaces it (tests never read the real one). */
export const installConfigFile = (env = process.env) => env.WORKFLOW_INSTALL_CONFIG || path.join(home(env), '.config', 'agentic-flow', 'config.json');

/**
 * The operator repo of this installation: { dir, profile, configFile } or { error, configFile }; null when not configured.
 * operator_repo is absolute (or ~/...); profile is a path relative to the repo or absolute, default profile.md.
 */
export function operatorRepo(env = process.env) {
  const configFile = installConfigFile(env);
  const cfg = readJson(configFile, null);
  if (!cfg || typeof cfg !== 'object' || !cfg.operator_repo) return null;
  const dir = path.resolve(expand(cfg.operator_repo, env));
  if (!path.isAbsolute(expand(cfg.operator_repo, env))) return { error: `operator_repo "${cfg.operator_repo}" in ${toPosix(configFile)} is not absolute`, configFile };
  if (!fs.existsSync(path.join(dir, '.git'))) return { error: `operator_repo ${toPosix(dir)} is no git repo (${toPosix(configFile)})`, configFile };
  const profile = path.resolve(dir, expand(cfg.profile || DEFAULT_PROFILE, env));
  return { dir, profile, configFile };
}

/** The operator repo or an Error with what to configure. */
export function requireOperatorRepo(env = process.env) {
  const repo = operatorRepo(env);
  if (!repo) throw new Error(`operator repo not configured: ${toPosix(installConfigFile(env))} needs {"operator_repo": "<absolute path of the clone>", "profile": "profile.md"} (skill workflow:people)`);
  if (repo.error) throw new Error(repo.error);
  return repo;
}

/** One person file in the shape the code uses. */
function personOf(file, repoDir) {
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const id = path.basename(file, '.md');
  return {
    id,
    path: toPosix(path.relative(repoDir, file)),
    abs: file,
    name: String(data.name || id),
    aliases: asList(data.aliases).map(String),
    domains: asList(data.domains).map(String),
    data,
    body,
  };
}

/** Every person of the operator repo (osoby/*.md), sorted by id. */
export function readPeople(repoDir) {
  const dir = path.join(repoDir, PEOPLE_DIR);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== PEOPLE_INDEX && f !== 'README.md'); } catch { return []; }
  return files.sort().map((f) => personOf(path.join(dir, f), repoDir));
}

/** Names a person is found by: id, name and aliases, compared case-insensitively. */
export const personNames = (p) => [...new Set([p.id, p.name, ...p.aliases].filter((v) => String(v ?? '').trim()).map(lc))];

/** A person without domains is everybody's; otherwise one of its domains is the domain asked for (case-insensitive). */
export const inDomain = (p, domain) => !domain || !p.domains.length || p.domains.some((d) => lc(d) === lc(domain));

/** Persons the alias names, among those of the domain or without a domain restriction (spec 6.2). */
export function findPeople(people, alias, domain = null) {
  const want = lc(alias);
  if (!want) return [];
  return people.filter((p) => inDomain(p, domain) && personNames(p).includes(want));
}

const overlap = (a, b) => !a.domains.length || !b.domains.length || a.domains.some((d) => b.domains.some((e) => lc(d) === lc(e)));

/**
 * Duplicates and alias collisions (spec 6.5): a name two persons share is a duplicate (the same person twice?), an alias,
 * id or name of one that is the alias of another is a collision; only between persons a find of one domain sees both.
 */
export function peopleProblems(people) {
  const duplicates = [];
  const collisions = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i];
      const b = people[j];
      if (!overlap(a, b)) continue;
      const shared = personNames(a).filter((n) => personNames(b).includes(n));
      if (!shared.length) continue;
      const entry = { names: shared, paths: [a.path, b.path] };
      if (lc(a.name) === lc(b.name)) duplicates.push(entry); else collisions.push(entry);
    }
  }
  return { duplicates, collisions };
}

/** INDEX.md text: every name of every person -> the person file; a name of several persons is marked. */
export function indexText(people) {
  const by = new Map();
  for (const p of people) for (const n of personNames(p)) by.set(n, [...(by.get(n) || []), p]);
  const lines = [...by.keys()].sort().map((n) => {
    const ps = by.get(n);
    const to = ps.map((p) => `${p.path}${p.domains.length ? ` (${p.domains.join(', ')})` : ''}`).join(', ');
    return `- ${n} → ${to}${ps.length > 1 ? ' (kolízia: workflow:consolidate)' : ''}`;
  });
  return `# INDEX osôb\n\nGeneruje workflow (people.mjs) pri každom zápise; ručne nemeniť. Alias → osoba.\n\n${lines.join('\n')}\n`;
}

/** Person file text. */
export function personText({ name, aliases = [], domains = [], created = today(), body = '', extra = {} }) {
  return serializeFrontmatter({ ...extra, name, aliases, domains, created, updated: today() }, body);
}

/**
 * Write files into the operator repo with INDEX.md in one commit, through the own clone of the workflow (spec 4.1, plan B8):
 * pull, write, commit, push on the branch of the operator's checkout; a refused push pulls again and retries, a conflict in
 * INDEX.md is settled by writing it again, one in a person file is a question to the operator. The checkout is fast-forwarded
 * afterwards when it has no change of its own. files: { rel: text }. Returns lines for the output.
 */
export function writeOperatorRepo(repoDir, files, message) {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir });
  const branch = head.ok && head.stdout !== 'HEAD' ? head.stdout : 'main';
  // The records are read from this checkout and written through the own clone on origin: a local commit or change origin
  // does not have would be lost or doubled (a rename by hand left the old record beside the new one, 2026-11-16).
  const local = localOnly(repoDir, branch);
  if (local) throw new Error(`operator repo ${toPosix(repoDir)}: ${local}; push or drop it first (git -C ${toPosix(repoDir)} status), nothing written`);
  const res = cloneWrite(repoDir, {
    branch,
    name: 'operator repo',
    message,
    indexFiles: [PEOPLE_INDEX],
    derived: true,
    ops: Object.entries(files).map(([rel, content]) => (content === null ? { path: rel, remove: true } : { path: rel, content })),
    index: (dir) => {
      fs.writeFileSync(path.join(dir, PEOPLE_INDEX), indexText(readPeople(dir)));
      const add = git(['add', '--', PEOPLE_INDEX], { cwd: dir });
      if (!add.ok) throw new Error(`operator repo: git add ${PEOPLE_INDEX} failed: ${add.stderr}`);
    },
  });
  if (!res.committed) return ['nothing changed'];
  return [`committed: ${res.sha} ${message}`, 'pushed', ...res.notes];
}

/** What the checkout has that origin does not: commits ahead of origin/<branch> or changes of the records; null when none. */
function localOnly(repoDir, branch) {
  const ahead = git(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: repoDir });
  if (ahead.ok && Number(ahead.stdout) > 0) return `${ahead.stdout} local commit(s) not on origin/${branch}`;
  const st = git(['status', '--porcelain', '--', PEOPLE_DIR, PEOPLE_INDEX], { cwd: repoDir });
  if (st.ok && st.stdout.trim()) return `uncommitted changes (${st.stdout.trim().split('\n').map((l) => l.slice(3)).slice(0, 3).join(', ')})`;
  return null;
}

/** One line naming a person: path, name, aliases, domains. */
export const showPerson = (p) => `${p.path}: ${p.name}${p.aliases.length ? ` (aliases ${p.aliases.join(', ')})` : ''}${p.domains.length ? ` [domains ${p.domains.join(', ')}]` : ''}`;

/** Names another person already has: a new person by those names is likely the same one. */
function clashes(people, names, domains, self = null) {
  const probe = { id: '', name: '', aliases: names, domains };
  return people.filter((p) => p.id !== self && personNames(p).some((n) => personNames(probe).includes(n)) && (!p.domains.length || !domains.length || p.domains.some((d) => domains.includes(d))));
}

const listOf = (v) => (v === undefined ? undefined : asList(v === true ? '' : v).map(String));

/**
 * A new person osoby/<id>.md (people.mjs new, save.mjs person). Refused when the id is invalid or taken, or when another
 * person already has one of its names unless `another` (the operator said it is someone else). Returns output lines.
 */
export function newPerson(repo, { id, name, aliases, domains, content, another = false }) {
  if (!isValidId(id)) throw new Error(`id "${id}" is not lowercase ascii with hyphens (e.g. ${proposedId(id)})`);
  const short = shortIdProblem(id, [name, ...(Array.isArray(aliases) ? aliases : String(aliases || '').split(','))]);
  if (short) throw new Error(`${short}; nothing written`);
  if (!name || name === true) throw new Error('--name required');
  if (content === undefined || content === true) throw new Error('--content required (who it is, relation, preferences)');
  const rel = `${PEOPLE_DIR}/${id}.md`;
  if (fs.existsSync(path.join(repo.dir, rel))) throw new Error(`${rel} exists: people.mjs change ${id} ...`);
  const al = listOf(aliases) || [];
  const dom = listOf(domains) || [];
  const same = clashes(readPeople(repo.dir), [id, String(name), ...al], dom);
  if (same.length && !another) throw new Error(`already named by ${same.map(showPerson).join('; ')}: the same person → people.mjs change ${same[0].id} ...; another person → ask the operator, then pass --new; nothing written`);
  return [...writeOperatorRepo(repo.dir, { [rel]: personText({ name: String(name), aliases: al, domains: dom, body: String(content) }) }, `people: new ${id}`), `person ${rel}`];
}

/**
 * A change of the one person the alias names (people.mjs change, save.mjs person): each given field replaces that field.
 * 0 or 2+ matches are refused (the operator says who it is first, spec 6.2). Returns output lines.
 */
export function changePerson(repo, { alias, domain = null, name, aliases, domains, content, another = false }) {
  const people = readPeople(repo.dir);
  const hits = findPeople(people, alias, domain);
  if (!hits.length) throw new Error(`no person "${alias}"${domain ? ` in domain ${domain}` : ''}: ask the operator who it is; a new person: people.mjs new <id> --name ... --content ...; nothing written`);
  if (hits.length > 1) throw new Error(`${hits.length} persons "${alias}": ${hits.map(showPerson).join('; ')}; ask the operator which one, then people.mjs change <id>; nothing written`);
  const p = hits[0];
  if ([name, aliases, domains, content].every((v) => v === undefined)) throw new Error('nothing to change: give --name, --aliases, --domains or --content (each replaces that field)');
  const nm = name !== undefined ? String(name) : p.name;
  const al = listOf(aliases) ?? p.aliases;
  const dom = listOf(domains) ?? p.domains;
  const same = name !== undefined || aliases !== undefined ? clashes(people, [nm, ...al], dom, p.id) : [];
  if (same.length && !another) throw new Error(`already named by ${same.map(showPerson).join('; ')}: one name names one person; ask the operator, or pass --new to keep both; nothing written`);
  const { name: _n, aliases: _a, domains: _d, created, updated, ...extra } = p.data;
  const body = content !== undefined ? String(content) : p.body;
  // A first-name id with the full name known now: the record moves to meno-priezvisko, the old id stays an alias
  // (operator 2026-11-16).
  let rel = p.path;
  let aliasesOut = al;
  const files = {};
  if (shortIdProblem(p.id, [nm, ...al])) {
    const id = proposedId(fullNameOf([nm, ...al]));
    rel = `${PEOPLE_DIR}/${id}.md`;
    if (people.some((x) => x.path === rel)) throw new Error(`${rel} exists: the full name names another record; ask the operator; nothing written`);
    if (!aliasesOut.includes(p.id)) aliasesOut = [p.id, ...aliasesOut];
    files[p.path] = null;
  }
  files[rel] = personText({ name: nm, aliases: aliasesOut, domains: dom, created: created || undefined, body, extra });
  const moved = rel !== p.path ? [`renamed ${p.path} -> ${rel} (meno-priezvisko; ${p.id} stays an alias)`] : [];
  return [...writeOperatorRepo(repo.dir, files, `people: change ${p.id}${moved.length ? ` -> ${path.posix.basename(rel, '.md')}` : ''}`), ...moved, `person ${rel}`];
}

/** The person id of the operator: the first osoby/<id>.md that profile.md names. */
export function profilePersonId(text) {
  const m = new RegExp(`(?:^|[^\\w./-])${PEOPLE_DIR}/([a-z0-9][a-z0-9-]*)\\.md\\b`).exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * Session start (spec 4, profile.md -> osoby/<operator>.md "na štarte vždy"): { lines } with the operator record for the
 * status block, or { notice } when the installation has no operator repo or the profile does not resolve.
 */
export function operatorProfile(env = process.env) {
  const repo = operatorRepo(env);
  if (!repo) return { notice: `operator profile: not configured (${toPosix(installConfigFile(env))}: operator_repo, profile; skill workflow:people)` };
  if (repo.error) return { notice: `operator profile: ${repo.error}` };
  if (!fs.existsSync(repo.profile)) return { notice: `operator profile: ${toPosix(repo.profile)} missing (it names osoby/<id>.md of the operator; skill workflow:people)` };
  const id = profilePersonId(fs.readFileSync(repo.profile, 'utf8'));
  if (!id) return { notice: `operator profile: ${toPosix(repo.profile)} names no ${PEOPLE_DIR}/<id>.md` };
  const file = path.join(repo.dir, PEOPLE_DIR, `${id}.md`);
  if (!fs.existsSync(file)) return { notice: `operator profile: ${toPosix(repo.profile)} names ${PEOPLE_DIR}/${id}.md, which does not exist` };
  const p = personOf(file, repo.dir);
  let body = p.body.trim();
  if (body.length > PROFILE_CHARS) body = `${body.slice(0, PROFILE_CHARS)}… (rest in ${toPosix(file)})`;
  const head = `operator (${path.basename(repo.profile)} → ${p.path}): ${p.name}${p.aliases.length ? `, aliases ${p.aliases.join(', ')}` : ''}; the writer in this thread is this operator unless they introduce themselves (spec 6.1)`;
  return { lines: [head, ...(body ? [body] : [])], person: p };
}

/** Proposed id of a person from a name: lowercase ascii with hyphens. */
export const proposedId = (name) => normalizeKey(name) || 'person';

/**
 * The id of a person is meno-priezvisko when the surname is known (operator 2026-11-16: a first name alone is not
 * enough, two people share it): of the names of a person the one with the most words is the full name.
 */
const words = (n) => String(n ?? '').trim().split(/\s+/).filter(Boolean).length;
export const fullNameOf = (names) => [...names].map((n) => String(n ?? '').trim()).filter(Boolean).sort((a, b) => words(b) - words(a))[0] || '';
/** An id of one word while a name of two or more words is known: the refusal with the id to use, else null. */
export function shortIdProblem(id, names) {
  const full = fullNameOf(names);
  if (String(id).includes('-') || words(full) < 2) return null;
  return `id "${id}" is the first name only, while the full name "${full}" is known: the id of a person is meno-priezvisko, ${proposedId(full)} (operator 2026-11-16)`;
}

/**
 * Refusal of save memory person|operator (spec 4.3, 11.4: from the code release a fact about a person goes to osoby/):
 * the people.mjs command that writes it instead. operator: the operator's own record from profile.md.
 */
export function personRedirect(type, name, env = process.env) {
  const cmd = 'node <plugin>/bin/people.mjs';
  let to = null;
  try {
    const repo = operatorRepo(env);
    if (repo && !repo.error) {
      if (type === 'operator') to = operatorProfile(env).person || null;
      else {
        const hits = findPeople(readPeople(repo.dir), name);
        if (hits.length === 1) to = hits[0];
      }
    }
  } catch { /* the command below still applies */ }
  const how = to
    ? `${cmd} change ${to.id} --content "<the whole record with the new fact>" (${to.path})`
    : `${cmd} find "${name}", then ${cmd} change <id> --content "..." for the one match, or ${cmd} new ${proposedId(name)} --name "${name}" --content "..." when there is none (0 or 2+ matches: ask the operator first)`;
  return `${type} records are not written to memory any more: a fact about a person goes to ${PEOPLE_DIR}/ of the operator repo (skill workflow:people): ${how}; nothing saved`;
}

export { isValidId };

// --- collection (spec 11.8, plan O10): operator-*.md and person records of every brain of the machine ------------------

/**
 * Memory records about people in the brains of the machine: type person, or operator (the operator-*.md files). `domain`:
 * only the brains of that domain (a domain migrates on its own; the people of the others wait for theirs, mojprojekt
 * 2026-11-16: the plan of one domain had to put the other domains' people into dropped).
 */
export function personSources(ctx, { domain = null } = {}) {
  const out = [];
  const inDomain = (s) => !domain || (s.domainRoot && path.basename(s.domainRoot).toLowerCase() === String(domain).toLowerCase());
  for (const s of machineStores(ctx).filter((x) => x.kind === 'brain' && inDomain(x))) {
    const recs = storeRecords(s, ctx.brainDir || s.dir).filter((r) => r.kind === 'memory' && !r.topic && ['person', 'operator'].includes(recordType(r)));
    if (!recs.length) continue;
    const authors = recordAuthors(s.dir);
    for (const r of recs) {
      const author = authors.files.get(toPosix(path.relative(s.dir, r.abs))) || null;
      out.push({ r, store: s, author, domain: s.domainRoot ? path.basename(s.domainRoot) : null });
    }
  }
  return out;
}

const sourceLabel = (x) => `${x.store.name}:${toPosix(path.relative(x.store.dir, x.r.abs))}`;
const subjectNamesOf = (r) => [String(r.key).replace(/^person-/, ''), r.data?.name, ...(r.aliases || [])].filter((v) => String(v ?? '').trim()).map(lc);

/**
 * The list for the operator's approval: one entry per person. Person records whose key, name or alias meet are one entry;
 * the operator-*.md records of one author (git identity of the commit that added them) are one entry, the operator.
 * Every source is in exactly one entry, so applying the list loses no record.
 */
export function collectPlan(ctx, repo = null, { domain = null } = {}) {
  const entries = [];
  for (const x of personSources(ctx, { domain })) {
    const operator = recordType(x.r) === 'operator';
    const who = operator ? lc(x.author?.email || x.author?.name || 'unknown') : null;
    const names = operator ? [] : subjectNamesOf(x.r);
    let e = operator
      ? entries.find((o) => o.operator && o.author === who)
      : entries.find((o) => !o.operator && o.aliases.concat(o.name, o.id).map(lc).some((n) => names.includes(n)));
    if (!e) {
      const name = operator ? (x.author?.name || 'operator') : String(x.r.data?.name || String(x.r.key).replace(/^person-/, ''));
      e = { id: proposedId(name), name, aliases: [], domains: [], operator, sources: [], bodies: [] };
      if (operator) e.author = who;
      entries.push(e);
    }
    if (!operator) {
      for (const n of [x.r.data?.name, ...(x.r.aliases || [])].map((v) => String(v ?? '').trim()).filter(Boolean)) if (lc(n) !== lc(e.name) && !e.aliases.map(lc).includes(lc(n))) e.aliases.push(n);
      if (x.domain && !e.domains.includes(x.domain)) e.domains.push(x.domain);
    }
    e.sources.push({ label: sourceLabel(x), file: x.r.abs });
    const body = String(x.r.body || '').trim();
    const head = operator ? `## ${String(x.r.data?.name || x.r.key)}` : null;
    if (body && !e.bodies.some((b) => b.text === body)) e.bodies.push({ head, text: body });
  }
  // The id is meno-priezvisko when one of the names is the full name; the shorter names stay aliases (operator 2026-11-16).
  for (const e of entries) {
    if (e.operator && !e.name) continue;
    const full = fullNameOf([e.name, ...e.aliases]);
    if (words(full) > words(e.name)) {
      e.aliases = [...new Set([e.name, ...e.aliases.filter((a) => lc(a) !== lc(full))])];
      e.name = full;
    }
    e.id = proposedId(e.name);
    e.surname = words(e.name) >= 2;
  }
  // A person the operator repo has already (a second domain, a second machine of the same operator): the entry merges into
  // that file with migrated_from instead of proposing a new id (doma-pc 2026-11-16: the operator's own records got a new
  // id from the git identity next to osoby/<operator>.md with that identity as alias). An operator entry matches by the
  // author's name or e-mail name, or is the operator of profile.md when the author is this machine's git identity.
  const existing = repo && !repo.error ? readPeople(repo.dir) : [];
  const profileId = repo && !repo.error && fs.existsSync(repo.profile) ? profilePersonId(fs.readFileSync(repo.profile, 'utf8')) : null;
  const me = repo && !repo.error ? localIdentity(repo.dir) : null;
  for (const e of entries) {
    const names = e.operator
      ? [e.name, ...(e.author && e.author.includes('@') ? [e.author.split('@')[0]] : [e.author])].filter(Boolean).map(lc)
      : [e.id, e.name, ...e.aliases].map(lc);
    let hit = existing.find((p) => personNames(p).some((n) => names.includes(n)));
    if (!hit && e.operator && profileId && me && sameIdentity({ name: e.name, email: e.author?.includes('@') ? e.author : '' }, me)) hit = existing.find((p) => p.id === profileId);
    if (hit) { e.id = hit.id; e.existing = hit.path; }
  }
  // Entries that merge into the same person are one entry (the operator's records and a person record of them).
  for (let i = entries.length - 1; i > 0; i--) {
    const e = entries[i];
    const first = e.existing && entries.find((o, j) => j < i && o.existing === e.existing);
    if (!first) continue;
    first.sources.push(...e.sources);
    for (const b of e.bodies) if (!first.bodies.some((x) => x.text === b.text)) first.bodies.push(b);
    for (const n of [e.name, ...e.aliases]) if (lc(n) !== lc(first.name) && !first.aliases.map(lc).includes(lc(n))) first.aliases.push(n);
    first.domains = first.domains.length && e.domains.length ? [...new Set([...first.domains, ...e.domains])] : [];
    first.operator = first.operator || e.operator;
    entries.splice(i, 1);
  }
  // Two entries must not propose one id.
  const ids = new Map();
  for (const e of entries) {
    if (e.existing) continue;
    const n = (ids.get(e.id) || 0) + 1;
    ids.set(e.id, n);
    if (n > 1) e.id = `${e.id}-${n}`;
  }
  return { ...(domain ? { domain } : {}), people: entries.map(({ author, bodies, ...e }) => ({ ...e, body: bodies.map((b) => (b.head ? `${b.head}\n\n${b.text}` : b.text)).join('\n\n') })), dropped: [] };
}

/** Headings of a body that occur more than once: [{ head, n }] (three `## operator` sections of three machines). */
export function repeatedSections(body) {
  const counts = new Map();
  for (const m of String(body || '').matchAll(/^(#{2,3} .+)$/gm)) counts.set(m[1].trim(), (counts.get(m[1].trim()) || 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([head, n]) => ({ head, n }));
}

/**
 * One line per entry for the operator (the list to approve). An entry whose body repeats a section (records of several
 * machines merged word for word, mojprojekt 2026-11-16: three `## operator` sections, one with a stale role) is marked:
 * the agent merges them in the plan and checks each fact with the operator before --apply.
 */
export function planLines(plan) {
  const repeated = (p) => repeatedSections(p.body);
  return [
    ...plan.people.map((p) => `- ${PEOPLE_DIR}/${p.id}.md${p.existing ? ' (exists: merged into it)' : ''}${!p.existing && p.surname === false ? ' (surname unknown: ask the operator, the id is meno-priezvisko)' : ''}: ${p.name}${p.operator ? ' (operator)' : ''}${p.aliases.length ? `, aliases ${p.aliases.join(', ')}` : ''}${p.domains.length ? `, domains ${p.domains.join(', ')}` : ', all domains'}; from ${p.sources.map((s) => s.label).join(', ')}${repeated(p).length ? `\n  ! repeated sections ${repeated(p).map((x) => `"${x.head}" (${x.n}×)`).join(', ')}: merge them into one in the body of the plan and check each fact with the operator (a role or a fact may be stale) before --apply` : ''}`),
    ...(plan.dropped || []).map((d) => `- dropped ${d.label || d.file}: ${d.reason || '(no reason)'}`),
  ];
}

/**
 * Write an approved list (collectPlan, edited by the operator) into osoby/ in one commit. Refused, with nothing written,
 * when a person record of the brains is in no entry and not in dropped (with a reason), when an id is invalid or used twice,
 * or when a person file of that id exists already. profile.md is written when it is missing, or gets the line when it names
 * no osoby/<id>.md, and the list has one operator.
 */
export function applyPlan(ctx, repo, plan) {
  const people = Array.isArray(plan?.people) ? plan.people : [];
  const dropped = Array.isArray(plan?.dropped) ? plan.dropped : [];
  const covered = new Set([...people.flatMap((p) => asList(p.sources).map((s) => path.resolve(s.file || s))), ...dropped.filter((d) => String(d.reason || '').trim()).map((d) => path.resolve(d.file || ''))]);
  // A plan of one domain (collect --domain) covers the records of that domain only.
  const lost = personSources(ctx, { domain: plan?.domain || null }).filter((x) => !covered.has(path.resolve(x.r.abs))).map(sourceLabel);
  if (lost.length) throw new Error(`records about people in no entry of the list (add them to an entry, or to dropped with a reason): ${lost.join(', ')}; nothing written`);
  const seen = new Set();
  const files = {};
  for (const p of people) {
    if (!isValidId(p.id)) throw new Error(`id "${p.id}" is not lowercase ascii with hyphens; nothing written`);
    if (seen.has(p.id)) throw new Error(`id ${p.id} twice in the list; nothing written`);
    seen.add(p.id);
    const rel = `${PEOPLE_DIR}/${p.id}.md`;
    const labels = asList(p.sources).map((s) => s.label || s);
    if (fs.existsSync(path.join(repo.dir, rel))) {
      if (p.existing !== rel) throw new Error(`${rel} exists already: fold the entry into it with people.mjs change, then drop it from the list; nothing written`);
      // Merge into the person the repo has: its name and fields stay, new aliases and the bodies not in it yet are added,
      // migrated_from names every source (the move to data 2.1 removes those records from memory).
      const cur = personOf(path.join(repo.dir, rel), repo.dir);
      const aliases = [...cur.aliases];
      for (const n of [p.name, ...asList(p.aliases)].map(String)) if (n.trim() && !personNames(cur).includes(lc(n)) && !aliases.map(lc).includes(lc(n))) aliases.push(n);
      const domains = cur.domains.length && asList(p.domains).length ? [...new Set([...cur.domains, ...asList(p.domains).map(String)])] : [];
      const add = String(p.body || '').split(/\n(?=## )/).map((s) => s.trim()).filter((s) => s && !cur.body.includes(s));
      const body = [cur.body.trim(), ...add].filter(Boolean).join('\n\n');
      const { name: _n, aliases: _a, domains: _d, updated: _u, migrated_from: was, ...extra } = cur.data;
      files[rel] = personText({ name: cur.name, aliases, domains, created: cur.data.created || today(), body, extra: { ...extra, migrated_from: [...new Set([...asList(was).map(String), ...labels])] } });
      continue;
    }
    if (!String(p.name || '').trim()) throw new Error(`${p.id}: name missing; nothing written`);
    const short = shortIdProblem(p.id, [p.name, ...asList(p.aliases)]);
    if (short) throw new Error(`${short}; nothing written`);
    files[rel] = personText({ name: p.name, aliases: asList(p.aliases), domains: asList(p.domains), body: String(p.body || ''), extra: { migrated_from: labels } });
  }
  const operators = people.filter((p) => p.operator);
  const notes = [];
  // profile.md names the operator's record: written when missing; a profile that names no osoby/<id>.md yet (the operator
  // started the repo with one) gets the line appended.
  const profileText = fs.existsSync(repo.profile) ? fs.readFileSync(repo.profile, 'utf8') : null;
  if (profileText === null || !profilePersonId(profileText)) {
    const line = operators.length === 1 ? `Operátor tejto inštalácie: [${operators[0].name}](${PEOPLE_DIR}/${operators[0].id}.md)\n` : null;
    if (line) files[toPosix(path.relative(repo.dir, repo.profile))] = profileText === null ? `# Profil operátora\n\n${line}` : `${profileText.replace(/\n*$/, '\n\n')}${line}`;
    else notes.push(`${toPosix(repo.profile)} not written: the list has ${operators.length} operator entries; write it naming ${PEOPLE_DIR}/<id>.md of this installation's operator`);
  }
  if (!Object.keys(files).length) return ['nothing to write', ...notes];
  return [...writeOperatorRepo(repo.dir, files, `people: collect ${people.length} person(s) from the brains of the machine`), ...notes];
}
