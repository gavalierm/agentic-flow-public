#!/usr/bin/env node
// Mail model pairing (D-0089, D-0090): the workflow is released together with the mail of one model, declared once in
// package.json `commsModel` (absent: 1). Tests, the release and the pilot run the workflow only against a mail revision
// of that model: the comms dev checkout when its model matches, else the newest tag of the comms repo with that model.
// The model of a mail revision is MAIL_MODEL in src/server/lifecycle.mjs; a revision without it (0.4.x, /health without
// `model`) is model 1. No revision with the model fails loudly: nothing is tested against another model.
//
// usage: node scripts/comms-pair.mjs flow-model [<flow repo> [<rev>]]          model the workflow declares
//        node scripts/comms-pair.mjs model <comms dir> | <comms repo> <rev>      model of a mail revision
//        node scripts/comms-pair.mjs pick <comms repo> [<model>] [--prefer <rev>] the rev to check out (pilot)
//        node scripts/comms-pair.mjs resolve <comms repo> --cache <dir> [<model>] the mail dir for the tests
// pick and resolve print one line "comms: ..." on stderr (which revision, its model, the workflow model), the result
// alone on stdout; exit 1 when no revision has the model.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIFECYCLE = 'src/server/lifecycle.mjs';

const git = (repo, args, opts = {}) => spawnSync('git', ['-C', repo, ...args], { encoding: opts.encoding ?? 'utf8', maxBuffer: 1 << 28 });

/** Model in the text of lifecycle.mjs (null text: the file is missing): MAIL_MODEL, else 1. */
export function modelOfSource(text) {
  const m = /export\s+const\s+MAIL_MODEL\s*=\s*(\d+)/.exec(text || '');
  return m ? Number(m[1]) : 1;
}

/** Mail model the workflow at <flowRoot> (or its <rev>) declares in package.json `commsModel`; absent: 1. */
export function flowModel(flowRoot = FLOW_ROOT, rev = null) {
  let text;
  if (rev) {
    const r = git(flowRoot, ['show', `${rev}:package.json`]);
    if (r.status !== 0) throw new Error(`no package.json at ${rev} in ${flowRoot}`);
    text = r.stdout;
  } else text = fs.readFileSync(path.join(flowRoot, 'package.json'), 'utf8');
  const m = JSON.parse(text).commsModel;
  return m == null ? 1 : Number(m);
}

/** Model of the mail in <dir> (working tree) or of <rev> in the repo <dir>. */
export function commsModel(dir, rev = null) {
  if (rev) {
    const r = git(dir, ['show', `${rev}:${LIFECYCLE}`]);
    return modelOfSource(r.status === 0 ? r.stdout : null);
  }
  const f = path.join(dir, LIFECYCLE);
  return modelOfSource(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
}

const short = (repo, rev) => (git(repo, ['rev-parse', '--short', `${rev}^{commit}`]).stdout || '').trim();

/** Tags v* of the repo, newest version first. */
function tags(repo) {
  const r = git(repo, ['tag', '--list', 'v*', '--sort=-v:refname']);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/**
 * Revision of <repo> with mail model <model>: <prefer> (default: the working tree) when its model matches, else the
 * newest tag with it. Returns { rev, tag, model, preferModel, line } or { error, line }.
 */
export function pick(repo, model, { prefer = null } = {}) {
  const preferModel = commsModel(repo, prefer);
  const what = prefer || `working tree ${short(repo, 'HEAD')}`;
  if (preferModel === model) {
    return { rev: prefer, tag: null, model, preferModel, line: `comms: ${repo} ${what} (mail model ${model} = workflow model ${model})` };
  }
  for (const t of tags(repo)) {
    if (commsModel(repo, t) === model) {
      return { rev: t, tag: t, model, preferModel, line: `comms: ${repo} ${t} ${short(repo, t)} (mail model ${model} = workflow model ${model}; ${what} is model ${preferModel})` };
    }
  }
  return { error: true, preferModel, line: `comms: no revision of ${repo} with mail model ${model} (${what} is model ${preferModel}, no tag v* of model ${model}): the workflow is not tested against another mail model` };
}

/**
 * Mail dir for the tests: <repo> itself when its working tree has the model, else an export of the tag under
 * <cache>/agentic-comms-<tag>-<sha> (written once, renamed into place).
 */
export function resolve(repo, model, cache) {
  const p = pick(repo, model);
  if (p.error) return p;
  if (!p.tag) return { ...p, dir: repo };
  const dir = path.join(cache, `agentic-comms-${p.tag}-${short(repo, p.tag)}`);
  if (!fs.existsSync(path.join(dir, 'bin', 'comms.mjs'))) {
    fs.mkdirSync(cache, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(cache, '.export-'));
    const tar = git(repo, ['archive', '--format=tar', p.tag], { encoding: 'buffer' });
    const x = tar.status === 0 ? spawnSync('tar', ['-x', '-C', tmp], { input: tar.stdout }) : { status: 1 };
    if (x.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { error: true, line: `comms: export of ${p.tag} from ${repo} failed` };
    }
    try { fs.renameSync(tmp, dir); } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { ...p, dir, line: `${p.line}: ${dir}` };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  const out = (p, value) => { process.stderr.write(p.line + '\n'); if (p.error) return 1; process.stdout.write(value + '\n'); return 0; };
  if (cmd === 'flow-model') { process.stdout.write(flowModel(rest[0] || FLOW_ROOT, rest[1] || null) + '\n'); return 0; }
  if (cmd === 'model' && rest[0]) { process.stdout.write(commsModel(rest[0], rest[1] || null) + '\n'); return 0; }
  if (cmd === 'pick' && rest[0]) {
    const prefer = opt('--prefer');
    const model = rest[1] ? Number(rest[1]) : flowModel();
    const p = pick(rest[0], model, { prefer });
    return out(p, p.rev || 'HEAD');
  }
  if (cmd === 'resolve' && rest[0]) {
    const cache = opt('--cache');
    if (!cache) { process.stderr.write('resolve needs --cache <dir>\n'); return 2; }
    const model = rest[1] ? Number(rest[1]) : flowModel();
    const p = resolve(path.resolve(rest[0]), model, path.resolve(cache));
    return out(p, p.dir);
  }
  process.stderr.write('usage: comms-pair.mjs flow-model [<flow repo> [<rev>]] | model <dir> [<rev>] | pick <repo> [<model>] [--prefer <rev>] | resolve <repo> --cache <dir> [<model>]\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
