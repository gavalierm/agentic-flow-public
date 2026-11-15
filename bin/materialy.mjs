#!/usr/bin/env node
// materialy.mjs record <súbor> --from <odkiaľ> [--topic <téma>] [--description "..."]   záznam veľkého súboru (nad limitom) namiesto súboru v gite
//               add <súbor|priečinok> [--topic <téma>] [--description "..."] [--from <odkiaľ>] [--as <meno|podcesta>] [--project <repo>]
//                                                                  priečinok: každý súbor pod ním do zdroje/<téma>/<meno>/<cesta> jedným
//                                                                  commitom, mená podľa pravidla mien (malé, bez diakritiky a medzier;
//                                                                  mapovanie vypíše); --as môže byť podcesta (a/b); --project: repo
//                                                                  projektu, do ktorého zdroj patrí (inak projekt session)
//                                                                  zdroj do repa cez workflow: skopíruje súbor do zdrojov témy (súbor už
//                                                                  v zdrojoch ostane na mieste) a commitne ho; v tvare 2 s popisom v
//                                                                  .brain/sources.json a INDEX.md v tom istom commite
//               add <súbor> --result [--topic <téma>] [--as <meno>] [--replace]
//                                                                  výsledok práce témy do práce témy (D-0056): brain v tvare 2
//                                                                  temy/<téma>/<meno> (zápis brainu s INDEX.md), inak ako dnes
//                                                                  v repe projektu (tvar 1 materialy/<téma>/, tvar 2 temy/<téma>/)
//               check                                              súbory v materialy/ nad limitom (kód 1, ak nejaké sú)
// Zdroje témy: materialy/<téma>/ (tvar 1) alebo zdroje/<téma>/ (tvar 2) v repe projektu (pravidlo P-062, skill materialy). V tvare dát 2
// record zapíše popis, pôvod a dátum zdroja do .brain/sources.json a záznam, sources.json aj INDEX.md commitne (bez push v repe projektu; v persone, kde repo je brain, ako každý zápis brainu).
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, fail, toPosix } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { recordBigFile, oversized, maxBytes, materialyDir, sourceAddOp, sourceAddDirOps, resultAddOp } from '../scripts/materialy.mjs';
import { topicHome, topicWorkLabel } from '../scripts/layout.mjs';
import { hasDataIndex, sourcesFileRel, sourcesWith } from '../scripts/data-index.mjs';
import { brainWrite, formatWriteResult } from '../scripts/brain.mjs';

const args = parseArgs(process.argv.slice(2));
// `add --result <súbor>`: parseArgs takes the file as the value of --result.
const [cmd, file = typeof args.result === 'string' ? args.result : undefined] = args._;
const out = (s) => process.stdout.write(`${s}\n`);
const ADD_USAGE = 'usage: materialy.mjs add <súbor|priečinok> [--topic <téma>] [--description "..."] [--from <odkiaľ>] [--as <meno|podcesta>] [--project <repo>] | add <súbor> --result [--topic <téma>] [--as <meno>] [--replace]';

/**
 * A source from outside into the sources of the project repo (zdroje/ or materialy/), with sources.json and INDEX.md in
 * layout 2. A folder: every file under it in one commit, names normalized by the rule of names (the mapping is printed).
 */
function addSource(ctx, topic) {
  const from = typeof args.from === 'string' ? args.from : '';
  const name = typeof args.as === 'string' ? args.as : null;
  const folder = fs.existsSync(file) && fs.statSync(file).isDirectory();
  const added = folder ? sourceAddDirOps(ctx.projectDir, topic, file, { name, policy: ctx.policy }) : null;
  const one = folder ? null : sourceAddOp(ctx.projectDir, topic, file, { name, policy: ctx.policy });
  const files = folder ? added.ops : [one];
  const date = folder ? added.date : one.date;
  const ops = files.map((f) => ({ path: f.rel, content: f.content }));
  const rels = files.map((f) => f.rel);
  const paths = folder ? [`${rels.length} file(s) under ${path.posix.dirname(rels[0]) === '.' ? rels[0] : commonDir(rels)}/`] : [rels[0]];
  if (hasDataIndex(ctx.projectDir)) {
    const sourcesRel = sourcesFileRel(ctx.projectDir);
    ops.push({ path: sourcesRel, content: sourcesWith(ctx.projectDir, rels, { description: typeof args.description === 'string' ? args.description : '', from, date }) });
    paths.push(sourcesRel, 'INDEX.md');
  } else if (typeof args.description === 'string' || from) out('--description a --from: iba v tvare dát 2 (INDEX.md); tu sa nezapíšu');
  const isBrain = ctx.brainDir && path.resolve(ctx.brainDir) === path.resolve(ctx.projectDir);
  const res = brainWrite({ brainDir: ctx.projectDir, thread: ctx.thread, policy: ctx.policy }, { ops, message: folder ? `materialy add ${commonDir(rels)}/ (${rels.length} file(s))` : `materialy add ${rels[0]}`, sync: !!isBrain });
  out(formatWriteResult(res, paths));
  if (added?.mapping.length) {
    out(`mená podľa pravidla mien (${added.mapping.length}):`);
    for (const [a, b] of added.mapping) out(`  ${a} -> ${b}`);
  }
}

/** The longest folder all paths are under. */
function commonDir(rels) {
  const parts = rels.map((r) => r.split('/').slice(0, -1));
  const out = [];
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0][i]); i++) out.push(parts[0][i]);
  return out.join('/');
}

/**
 * A result of the topic's work into the work of the topic in its topic home (D-0056): a brain in layout 2 temy/<téma>/<meno>
 * (a brain write, INDEX.md of the brain in the same commit), else the project repo as before (layout 1 materialy/<téma>/,
 * layout 2 temy/<téma>/). No sources.json: a result is no source from outside.
 */
function addResult(ctx, topic) {
  const home = topicHome(ctx.brainDir, ctx.projectDir);
  const { rel, content } = resultAddOp(home, topic, file, { name: typeof args.as === 'string' ? args.as : null, policy: ctx.policy, replace: args.replace === true });
  if (typeof args.description === 'string' || typeof args.from === 'string') out('--description a --from: iba pri zdroji zvonka; výsledok práce ich nezapíše');
  const inBrain = !!ctx.brainDir && path.resolve(ctx.brainDir) === path.resolve(home);
  const res = brainWrite(inBrain ? ctx : { brainDir: home, thread: ctx.thread, policy: ctx.policy }, { ops: [{ path: rel, content }], message: `materialy add --result ${rel}`, sync: inBrain });
  const shown = inBrain && path.resolve(home) !== path.resolve(ctx.projectDir) ? `brain ${rel}` : rel;
  out(formatWriteResult(res, [shown, ...(hasDataIndex(home) ? ['INDEX.md'] : [])]));
}

try {
  const ctx = loadContext({ project: args.project });
  if (cmd === 'record') {
    if (!file) fail('usage: materialy.mjs record <súbor> --from <odkiaľ> [--topic <téma>] [--description "..."]');
    const topic = typeof args.topic === 'string' ? args.topic : (ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread)[0]?.id : null);
    if (!topic) fail('chýba téma: --topic <téma> (vlákno nedrží žiadnu)');
    const from = typeof args.from === 'string' ? args.from : null;
    const { file: rec, record } = recordBigFile(ctx.projectDir, topic, file, { from, brainDir: ctx.brainDir });
    out(`záznam: ${rec}\n${record.size} B, sha256 ${record.sha256.slice(0, 12)}…; súbor ostal ${record.stored_at}; do gitu patrí iba záznam`);
    if (hasDataIndex(ctx.projectDir)) {
      // Layout 2: description, origin and date of the source go to .brain/sources.json (key: its path in zdroje/), the
      // record, sources.json and INDEX.md into one commit.
      const rel = toPosix(path.relative(ctx.projectDir, rec));
      const srcRel = rel.replace(/\.zaznam\.json$/, '');
      const sourcesRel = sourcesFileRel(ctx.projectDir);
      const sources = sourcesWith(ctx.projectDir, srcRel, { description: typeof args.description === 'string' ? args.description : '', from: from || '', date: record.date });
      const isBrain = ctx.brainDir && path.resolve(ctx.brainDir) === path.resolve(ctx.projectDir);
      const res = brainWrite({ brainDir: ctx.projectDir, thread: ctx.thread, policy: ctx.policy }, { ops: [{ path: rel, content: fs.readFileSync(rec, 'utf8') }, { path: sourcesRel, content: sources }], message: `materialy record ${srcRel}`, sync: !!isBrain });
      out(formatWriteResult(res, [rel, sourcesRel, 'INDEX.md']));
    } else if (typeof args.description === 'string') out('--description: iba v tvare dát 2 (INDEX.md); tu sa nezapíše');
  } else if (cmd === 'add') {
    // A source into the repo through the workflow (not git by hand): layout 2 commits it with its data in
    // .brain/sources.json and INDEX.md in one commit; layout 1 commits it into materialy/<téma>/ (no INDEX.md there).
    if (!file) fail(ADD_USAGE);
    const topic = typeof args.topic === 'string' ? args.topic : (ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread)[0]?.id : null);
    if (!topic) fail('chýba téma: --topic <téma> (vlákno nedrží žiadnu)');
    if (args.result !== undefined) addResult(ctx, topic);
    else addSource(ctx, topic);
  } else if (cmd === 'check') {
    const big = oversized(ctx.projectDir, ctx.policy);
    if (!big.length) out(`ok: v ${materialyDir(ctx.projectDir)}/ nič nad ${maxBytes(ctx.policy) / 1048576} MB`);
    else {
      for (const b of big) out(`nad limitom: ${b.path} (${(b.size / 1048576).toFixed(0)} MB)`);
      fail(`${big.length} súbor(ov) nad ${maxBytes(ctx.policy) / 1048576} MB: presuň ich mimo gitu (stiahnuté do ${topicWorkLabel(ctx.brainDir, ctx.projectDir)}) a zaznamenaj cez record`);
    }
  } else {
    fail(`usage: materialy.mjs record <súbor> --from <odkiaľ> [--topic <téma>] [--description "..."] | ${ADD_USAGE.replace('usage: materialy.mjs ', '')} | check`);
  }
} catch (err) {
  fail(err.message);
}
