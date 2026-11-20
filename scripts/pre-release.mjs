// Readiness check before the release of 2.0 (flow v2 spec 11.4, 11.5, 11.9; plan B19, O22; phase 2 of the plan): over
// every brain of every domain of this machine (the projects root, as the supervisor's overview) code lists what keeps the
// release from starting the threads again:
//   1. a live topic whose handover has neither a step (Ďalší krok) nor a question (Otvorené otázky) (11.4);
//   2. work of a live topic that is not on origin: a local branch topic/<t> or topic/<t>--<task> whose commits origin lacks,
//      uncommitted changes in the topic's worktree or a task worktree (3.7, 11.4);
//   3. an open message of the mail that 2.0 does not process (`comms obligations` of each live topic): the fix question of
//      a topic with a fix gate to its orchestrator (P-075) and the work handed between topics (P-055, handoffs.json); it is
//      closed by an answer or withdrawn (11.4); a mail that cannot be asked is a finding too (not checked is no pass);
//   4. a brain in data layout 1 (O22: 2.0 needs layout 2 at least), with its migrate command.
// Further lines (no finding): each domain not yet in layout 3 with its repos and the exact migrate commands (the projects
// migrate at the release, 11.5), a handover without the sixth section, a brain policy whose shared checkouts 2.0 no longer
// reads from topics.auto.projects. Read only: no fetch (git ls-remote), status without optional locks, nothing written.
import fs from 'node:fs';
import path from 'node:path';
import { gitAccessProblem } from './brain.mjs';
import { DOMAIN_MARKER as DOMAIN_MARKER_FILE } from './config.mjs';
import { git, gitRemote, readJson, PLUGIN_ROOT } from './util.mjs';
import { domainBrains, unmarkedDomains } from './stores.mjs';
import { layoutOf, layoutRole, dataLayoutVersion, dataPath, dataName, ROLE_BRAIN, ROLE_REPO } from './layout.mjs';
import { deployIgnoreGaps, deployIgnoreLines } from './data-index.mjs';
import { branchProblems } from './topic-branches.mjs';
import { leftovers, leftoverLines, junkText, workMap } from './leftovers.mjs';
import { repoWorkFinding } from './work-classes.mjs';
import { listTopicRecords } from './topic-files.mjs';
import { isMainTopic, commsProjectName, readObligations } from './comms.mjs';
import { handoverNextStep, handoverQuestions, handoverTasks, TASKS_SECTION } from './brain-checks.mjs';
import { overviewRoot } from './overview.mjs';
import { domainOf } from './migrate-3.mjs';
import { loadContext } from './config.mjs';

/** The handoff records of 1.8.1 in a topic folder (P-055, D-0082): [{ to, project }]. */
export const HANDOFFS_FILE = 'handoffs.json';

const posix = (p) => String(p).split(path.sep).join('/');
const short = (sha) => String(sha || '').slice(0, 7);
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const same = (a, b) => real(a) === real(b);
const MIGRATE = posix(path.join(PLUGIN_ROOT, 'bin', 'migrate.mjs'));

/** Mail context of a brain: its own (loadContext of the brain), else the session's with the brain's folders. */
function brainCtx(dir, sessionCtx) {
  try {
    const c = loadContext({ project: dir, requireBrain: false });
    if (c?.brainDir && same(c.brainDir, dir)) return c;
  } catch { /* a domain brain without its own configuration */ }
  return { ...(sessionCtx || {}), brainDir: dir, projectDir: dir, projectName: path.basename(dir), config: sessionCtx?.config || {} };
}

/** The repos a topic works in: repos.list of its record, else its one repo (1.8.1). */
const topicRepoNames = (topic) => (Array.isArray(topic?.repos?.list) && topic.repos.list.length ? topic.repos.list : topic?.repo ? [topic.repo] : []);

/** Checkout of a repo by name: in the domain folder, or the brain itself. */
function repoDirOf(name, brain) {
  if (brain.domainRoot) {
    const d = path.join(brain.domainRoot, name);
    if (fs.existsSync(path.join(d, '.git'))) return d;
  }
  return path.basename(brain.dir) === name ? brain.dir : null;
}

/** State of a repo for the branch check, once per repo: origin heads topic/* (ls-remote, no fetch) and its worktrees. */
function repoState(dir, cache) {
  const key = real(dir);
  if (cache.has(key)) return cache.get(key);
  const st = { dir, origin: git(['remote', 'get-url', 'origin'], { cwd: dir }).ok, remote: null, error: null, worktrees: [] };
  if (st.origin) {
    const r = gitRemote(['ls-remote', '--heads', 'origin', 'refs/heads/topic/*'], { cwd: dir });
    if (r.ok) st.remote = new Map(r.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ref] = l.split(/\s+/); return [ref.replace(/^refs\/heads\//, ''), sha]; }));
    else st.error = r.stderr.split('\n')[0] || 'ls-remote failed';
  }
  let cur = null;
  for (const line of git(['worktree', 'list', '--porcelain'], { cwd: dir }).stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null }; st.worktrees.push(cur); } else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  cache.set(key, st);
  return st;
}

/** Findings of the code work of one topic in one repo: local branches origin lacks, uncommitted worktrees. */
function branchFindings(id, name, dir, cache) {
  const st = repoState(dir, cache);
  const out = [];
  const mine = (b) => b === `topic/${id}` || String(b).startsWith(`topic/${id}--`);
  const refs = git(['for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', `refs/heads/topic/${id}`, `refs/heads/topic/${id}--*`], { cwd: dir });
  for (const line of refs.stdout.split('\n').filter(Boolean)) {
    const [branch, sha] = line.split(' ');
    if (!st.origin) { out.push({ kind: 'branch', repo: name, branch, text: `${name} has no remote origin: ${branch} (${short(sha)}) is on this machine only` }); continue; }
    if (st.error) { out.push({ kind: 'branch', repo: name, branch, text: `${name}: origin not reachable (${st.error}): ${branch} not checked` }); continue; }
    const rsha = st.remote.get(branch);
    if (rsha === sha) continue;
    const known = rsha && git(['cat-file', '-e', `${rsha}^{commit}`], { cwd: dir }).ok;
    if (known && git(['merge-base', '--is-ancestor', sha, rsha], { cwd: dir }).ok) continue;
    const why = !rsha ? 'not on origin' : known ? `origin ${short(rsha)} lacks commits of it` : `origin has ${short(rsha)}, which this machine lacks (fetch and compare)`;
    out.push({ kind: 'branch', repo: name, branch, text: `${name}: ${branch} (${short(sha)}) ${why}: git -C ${posix(dir)} push origin ${branch}` });
  }
  for (const wt of st.worktrees.filter((w) => w.branch && mine(w.branch) && fs.existsSync(w.path))) {
    const s = git(['--no-optional-locks', 'status', '--porcelain'], { cwd: wt.path });
    const files = s.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S{1,2}\s+/, ''));
    if (files.length) out.push({ kind: 'dirty', repo: name, branch: wt.branch, text: `${name}: worktree ${posix(wt.path)} (${wt.branch}) has uncommitted changes (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}): commit them on ${wt.branch}, then push` });
  }
  return out;
}

/** Pairs of mail addresses whose messages 2.0 does not process: fix question to the orchestrator, handoffs (P-075, P-055). */
function oldPairs(topics) {
  const pairs = new Map();
  const add = (a, b, why) => { pairs.set(`${a}|${b}`, why); pairs.set(`${b}|${a}`, why); };
  for (const t of topics) {
    const o = t.topic.orchestrator;
    if (t.topic.fix_gate === true || (o && typeof o === 'object' && o.topic)) {
      if (o?.topic) add(t.addr, `${o.project || t.project}/${o.topic}`, 'P-075 fix question');
      t.fix = true;
    }
    for (const r of t.handoffs) if (r?.to) add(t.addr, `${r.project || t.project}/${r.to}`, 'P-055 handoff');
  }
  return pairs;
}

/** The counterpart address of an open message: the sender topic of an owed one, the recipient of an awaited one. */
const counterpart = (item, side) => (side === 'owed' ? (item.from_project && item.from_topic ? `${item.from_project}/${item.from_topic}` : null) : (typeof item.to === 'string' ? item.to.replace(/^@/, '') : null));

/**
 * The readiness check of the machine: { root, brains, topics, findings, notes, migrate }. `brains` may be given (tests),
 * else every brain of every domain under the projects root. `mail: false` skips the mail (then a finding says so).
 */
export function preRelease({ root = null, ctx = null, brains = null, env = process.env, mail = true } = {}) {
  const base = brains ? null : overviewRoot({ root, ctx, env });
  const list = brains || (base ? domainBrains(base) : []);
  const findings = [];
  const notes = [];
  const migrate = [];
  const cache = new Map();
  const topics = [];
  const doms = new Map();
  // A domain folder without .agentic-domain is invisible to this check and to the move to data 2.1 (doma-pc 2026-11-16).
  for (const u of base ? unmarkedDomains(base) : []) findings.push({ kind: 'domain-marker', where: path.basename(u.dir), text: `${posix(u.dir)} has no ${DOMAIN_MARKER_FILE}, though its repos name the brain ${u.brain}: this check and migrate --to 2.1 do not see the domain; write ${posix(path.join(u.dir, DOMAIN_MARKER_FILE))} with {"brain": "${u.brain}"}, then run the check again` });
  for (const b of list) {
    const version = dataLayoutVersion(b.dir);
    const where = `${b.domainRoot ? `${path.basename(b.domainRoot)}/` : ''}${b.name}`;
    if (version === 1) findings.push({ kind: 'layout1', where, text: `brain ${posix(b.dir)} is in data 1: 2.0 needs data 2.0 (O22): node ${MIGRATE} ${posix(b.dir)} (preview), then node ${MIGRATE} ${posix(b.dir)} --apply [--confirmed <tsv>]` });
    const policy = readJson(dataPath(b.dir, 'policy'), {}) || {};
    const autoProjects = Object.keys(policy?.topics?.auto?.projects || {});
    if (autoProjects.length && !Array.isArray(policy?.topics?.shared_checkouts)) {
      const shared = autoProjects.map((p) => posix(path.relative(b.domainRoot || path.dirname(b.dir), path.resolve(b.dir, p))));
      notes.push(`${where}: shared checkouts (D-0038) come from topics.shared_checkouts in 2.0, topics.auto.projects is no longer read: add "shared_checkouts": ${JSON.stringify(shared)} under topics of ${posix(path.relative(b.dir, dataPath(b.dir, 'policy')))} (migrate --to 2.1 carries it)`);
    }
    // A repo git refuses (dubious ownership: cloned through another account) fails every check below without a word.
    let domRepos = [];
    try { domRepos = domainOf(b.dir).repos; } catch { domRepos = []; }
    for (const d of [b.dir, ...domRepos]) {
      const access = gitAccessProblem(d);
      if (access) findings.push({ kind: 'git-access', where, text: access });
      // Leftovers outside git in folders of an older layout and work folders over the limit (doma-pc 2026-11-16).
      const v = dataLayoutVersion(d);
      if (v === 1 || access) continue;
      const role = v === 3 ? layoutRole(d) : (d === b.dir ? ROLE_BRAIN : ROLE_REPO);
      const found = leftovers(d, { version: v, role });
      if (found.junk.length) findings.push({ kind: 'leftovers', where, text: `${posix(d)}: ${junkText(found.junk)} outside git, left by a move of the data: node ${MIGRATE} ${posix(d)}${v === 3 ? ' --to 2.1' : ''} --check --fix removes them` });
      if (found.other.length) findings.push({ kind: 'leftovers', where, text: `${posix(d)}: outside git in folders of an older data layout, left by a move of the data: ${leftoverLines(found.other, { max: 5 }).join('; ')}; triage with the operator: remove what is not needed, move work into the work folder of its topic` });
      const work = repoWorkFinding(d, workMap(v, role));
      if (work) findings.push({ kind: 'work-files', where, text: work.text });
      // A deployed web repo whose deploy ignore files do not exclude every path of the workflow (gma 2026-11-16).
      if (role === ROLE_REPO) for (const l of branchProblems(d)) findings.push({ kind: 'topic-branch', where, text: `${posix(d)}: ${l}` });
      if (role === ROLE_REPO) for (const l of deployIgnoreLines(deployIgnoreGaps(d), `node ${MIGRATE} ${posix(d)}${v === 3 ? ' --to 2.1' : ''} --check --fix`)) findings.push({ kind: 'deploy-ignore', where, text: `${posix(d)}: ${l}` });
    }
    if (version !== 3) {
      const dom = domainOf(b.dir);
      const key = real(dom.brain);
      if (!doms.has(key)) doms.set(key, { brain: dom.brain, domainDir: dom.domainDir, repos: dom.repos, version });
    }
    const bctx = brainCtx(b.dir, ctx);
    let project = null;
    try { project = commsProjectName(bctx); } catch { project = path.basename(b.dir); }
    let recs = [];
    try { recs = listTopicRecords(b.dir); } catch { recs = []; }
    const L = layoutOf(b.dir);
    for (const rec of recs) {
      if (isMainTopic({ ...rec.topic, id: rec.id }) || rec.topic?.state === 'closed') continue;
      const handoffs = readJson(path.join(rec.dir, HANDOFFS_FILE), []);
      topics.push({ brain: b, where, ctx: bctx, id: rec.id, topic: rec.topic || {}, dir: rec.dir, handover: path.join(rec.dir, L.handover), project, addr: `${rec.topic?.project || project}/${rec.id}`, handoffs: Array.isArray(handoffs) ? handoffs : [] });
    }
  }
  const pairs = oldPairs(topics);
  const mailDown = new Map();
  const noTasks = new Map();
  for (const t of topics) {
    const at = `${t.where}/${t.id}`;
    let text = null;
    try { text = fs.readFileSync(t.handover, 'utf8'); } catch { text = null; }
    if (text === null) findings.push({ kind: 'handover', at, text: `${at}: no handover: save.mjs handover ${t.id} --next "<step>" (or a question in --questions)` });
    else {
      const steps = handoverNextStep(text) || [];
      const questions = handoverQuestions(text) || [];
      if (!steps.length && !questions.length) findings.push({ kind: 'handover', at, text: `${at}: the handover has neither a step (Ďalší krok) nor a question (Otvorené otázky): save.mjs handover ${t.id} --next "<step>" if the work goes on, else the question (spec 11.4)` });
      if (handoverTasks(text) === null) { if (!noTasks.has(t.where)) noTasks.set(t.where, []); noTasks.get(t.where).push(t.id); }
    }
    if (t.topic.kind === 'code' || t.topic.copy) {
      const names = topicRepoNames(t.topic);
      if (!names.length) notes.push(`${at}: code topic without a repo in its record: branches not checked`);
      for (const name of names) {
        const dir = repoDirOf(name, t.brain);
        if (!dir) { notes.push(`${at}: repo ${name} is not on this machine: its branches are checked on the machine that has it`); continue; }
        for (const f of branchFindings(t.id, name, dir, cache)) findings.push({ ...f, at, text: `${at}: ${f.text}` });
      }
    }
    if (!mail) continue;
    const bk = real(t.brain.dir);
    if (mailDown.has(bk)) continue;
    const res = readObligations(t.ctx, { topics: [t.addr], thread: null });
    const data = res.ok ? res.data : null;
    if (!data || data.offline || data.unavailable) {
      mailDown.set(bk, true);
      findings.push({ kind: 'mail', at: t.where, text: `${t.where}: comms obligations not readable (${res.error || (data?.offline ? 'offline backup only' : 'no answer')}): open messages of its topics not checked; run the check again when the mail answers` });
      continue;
    }
    for (const side of ['owed', 'awaiting']) {
      for (const item of data[side] || []) {
        const other = counterpart(item, side);
        const why = other ? pairs.get(`${t.addr}|${other}`) : null;
        const own = !why && t.fix && side === 'awaiting' ? 'P-075 fix question' : null;
        if (!why && !own) continue;
        const close = side === 'owed' ? `answer it (comms send --reply-to ${item.id} --state hotovo) or settle it (comms settle --id ${item.id})` : `withdraw it (comms withdraw --id ${item.id}) or wait for the answer`;
        findings.push({ kind: 'mail', at, text: `${at}: open message ${item.id} (${item.level || '-'}, ${side} ${side === 'owed' ? 'from' : 'to'} ${other || '?'}): ${why || own}, which 2.0 does not process: ${close} (spec 11.4)` });
      }
    }
  }
  for (const [where, ids] of noTasks) notes.push(`${where}: ${ids.length} handover(s) without "${TASKS_SECTION}" (${ids.join(', ')}): the first save handover of each under 2.0 writes it, the turn end blocks until then (P-011 of 2.0 has six sections); migrate --to 2.1 adds it`);
  for (const d of doms.values()) {
    const repos = d.repos.map((r) => ({ name: path.basename(r), version: dataLayoutVersion(r) }));
    const tsv = posix(path.join(d.domainDir || path.dirname(d.brain), 'migrate-2-3.tsv'));
    const first = [d.version === 1 ? path.basename(d.brain) : null, ...repos.filter((r) => r.version === 1).map((r) => r.name)].filter(Boolean);
    migrate.push({
      brain: d.brain,
      text: `${posix(d.brain)} (data ${dataName(d.version)})${repos.length ? `, repos ${repos.map((r) => `${r.name} (data ${dataName(r.version)})`).join(', ')}` : ''}: ${first.length ? `first 1 -> 2.0 for ${first.join(', ')} (node ${MIGRATE} <repo> --apply); then ` : ''}node ${MIGRATE} ${posix(d.brain)} --to 2.1 --write-triage ${tsv}; node ${MIGRATE} ${posix(d.brain)} --to 2.1 --apply --confirmed ${tsv} [--approve <tsv>]; node ${MIGRATE} ${posix(d.brain)} --to 2.1 --check`,
    });
  }
  return { root: base, brains: list.length, topics: topics.length, findings, notes, migrate };
}

/** The check as lines: a head line, the findings, then the notes and the domains still to migrate. */
export function preReleaseLines(res) {
  const head = res.findings.length
    ? `pre-release: ${res.findings.length} finding(s) in ${res.topics} live topic(s) of ${res.brains} brain(s): settle each before the threads stop (spec 11.4)`
    : `pre-release: ready, no finding (${res.topics} live topic(s) of ${res.brains} brain(s))`;
  return [
    head,
    ...res.findings.map((f) => `- ${f.text}`),
    ...(res.notes.length ? ['notes:', ...res.notes.map((n) => `- ${n}`)] : []),
    ...(res.migrate.length ? ['not in data 2.1 yet (projects migrate at the release, spec 11.5; each domain at once):', ...res.migrate.map((m) => `- ${m.text}`)] : ['every brain is in data 2.1']),
  ];
}
