#!/usr/bin/env node
// Skill people (spec 6, 8): persons in osoby/ of the operator repo (configuration of the installation, plan O9).
//   people.mjs find <alias> [--domain [<domain>]] [--json]
//   people.mjs new <id> --name "<name>" [--aliases a,b] [--domains d1,d2] --content "<who, relation, preferences>" [--new]
//   people.mjs change <alias|id> [--domain [<domain>]] [--name ..] [--aliases a,b] [--domains d1,d2] [--content ..]
//   people.mjs collect [--domain <d>] [--out <plan.json>] | collect --apply <plan.json>      (spec 11.8, plan O10)
//     --domain: only the brains of that domain (a domain migrates on its own); the plan names it and --apply checks it
// --domain without a value is the domain of the session. find with 0 or 2+ matches only reports; new and change refuse
// then, so the agent asks the operator before it writes a fact (spec 6.2).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, toPosix } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { requireOperatorRepo, readPeople, findPeople, collectPlan, planLines, applyPlan, newPerson, changePerson, showPerson as show } from '../scripts/people.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;
const out = (s) => process.stdout.write(s + '\n');
const USAGE = 'usage: people.mjs find <alias> [--domain [<d>]] | new <id> --name "<name>" --content "..." [--aliases a,b] [--domains d1,d2] | change <alias|id> [--name] [--aliases] [--domains] [--content] | collect [--domain <d>] [--out <plan.json>] | collect --apply <plan.json>';

/** The domain the search is limited to: --domain <name>, bare --domain = the domain of the session, none = all. */
function domainOf() {
  if (args.domain === undefined) return null;
  if (args.domain !== true) return String(args.domain);
  const ctx = loadContext({ project: args.project, requireBrain: false });
  if (!ctx.domain?.root) fail('--domain without a name: this session has no domain; name it: --domain <domain>');
  return path.basename(ctx.domain.root);
}

function find(repo) {
  const alias = rest.join(' ');
  if (!alias) fail(USAGE);
  const domain = domainOf();
  const hits = findPeople(readPeople(repo.dir), alias, domain);
  if (args.json) return out(JSON.stringify(hits.map(({ abs, data, ...p }) => p), null, 2));
  const where = domain ? ` in domain ${domain} or without a domain` : '';
  if (!hits.length) return out(`no person "${alias}"${where}: go on without a person record; before writing a fact about them ask the operator who it is (spec 6.2)`);
  if (hits.length > 1) return out(`${hits.length} persons "${alias}"${where}: ${hits.map(show).join('; ')}\nbefore writing a fact ask the operator which one (spec 6.2)`);
  out(`${show(hits[0])}\n${fs.readFileSync(hits[0].abs, 'utf8').trim()}`);
}

function create(repo) {
  const id = rest[0];
  if (!id || rest.length > 1) fail(USAGE);
  for (const line of newPerson(repo, { id, name: args.name, aliases: args.aliases, domains: args.domains, content: args.content, another: !!args.new })) out(line);
}

function change(repo) {
  const alias = rest.join(' ');
  if (!alias) fail(USAGE);
  for (const line of changePerson(repo, { alias, domain: domainOf(), name: args.name, aliases: args.aliases, domains: args.domains, content: args.content, another: !!args.new })) out(line);
}

function collect(repo) {
  // Run inside a brain too (no .workflow.json there): the brains of the machine are found from it (mojprojekt 2026-11-16:
  // "brain unavailable: no brain configured" in the brain itself).
  const ctx = loadContext({ project: args.project, requireBrain: false });
  const domain = args.domain === undefined ? null : domainOf();
  if (args.apply !== undefined) {
    if (args.apply === true) fail('collect --apply <plan.json>: the list the operator approved');
    const plan = JSON.parse(fs.readFileSync(path.resolve(String(args.apply)), 'utf8'));
    for (const line of applyPlan(ctx, repo, plan)) out(line);
    return;
  }
  const plan = collectPlan(ctx, repo, { domain });
  if (args.out && args.out !== true) {
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify(plan, null, 2) + '\n');
    out(`plan: ${toPosix(path.resolve(String(args.out)))} (${plan.people.length} person(s))`);
  }
  out(plan.people.length ? planLines(plan).join('\n') : `no records about people in the brains of ${domain ? `domain ${domain}` : 'this machine'}`);
  if (domain) out(`domain ${domain} only: the people of the other domains are collected when their domain migrates (collect --domain <d>)`);
  if (plan.people.length) out(`show this list to the operator; after the approval (edit the plan: id, name, aliases, domains, body; a record that is no person goes to "dropped" with a reason): people.mjs collect --apply <plan.json> writes it in one commit`);
}

try {
  const repo = requireOperatorRepo();
  if (cmd === 'find') find(repo);
  else if (cmd === 'new') create(repo);
  else if (cmd === 'change') change(repo);
  else if (cmd === 'collect') collect(repo);
  else fail(USAGE);
} catch (err) {
  fail(err.message);
}
