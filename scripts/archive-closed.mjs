// Archive of topics closed before the hidden archive existed (D-0060, layout 2): a closed topic in temy/<id>/ with only
// handover.md and .tema.json moves to .brain/archive/topics/<id>/ (outside INDEX.md, find <id> finds it), as done --topic
// does at the close. A closed topic with other work (files outside tmp/, files in tmp/) or one whose id the hidden archive
// has already is only listed. One commit for all, INDEX.md in it (done.mjs --archive-closed).
import fs from 'node:fs';
import path from 'node:path';
import { dataLayoutVersion, dataRel, layoutOf, hasData } from './layout.mjs';
import { topicFiles } from './triage.mjs';
import { brainWrite } from './brain.mjs';

/** Files of a folder (recursive, relative), [] when it is missing. */
function filesIn(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * The closed topics of temy/ of a brain in layout 2: { archive: [id], other: [{ id, files }], clash: [id] }.
 * other.files: work files outside tmp/ and files in tmp/ (tmp/<file>), which the move would take along.
 */
export function closedTopicsPlan(brainDir) {
  if (!hasData(brainDir, 'topicHidden')) throw new Error(`${brainDir}: data layout ${dataLayoutVersion(brainDir)}; the hidden archive of topics is in layout 2 only`);
  const L = layoutOf(brainDir);
  const root = path.join(brainDir, ...L.topics.split('/'));
  const plan = { archive: [], other: [], clash: [] };
  let ids = [];
  try { ids = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return plan; }
  for (const id of ids) {
    let tema;
    try { tema = JSON.parse(fs.readFileSync(path.join(root, id, L.topicFile), 'utf8')); } catch { continue; }
    if (tema?.state !== 'closed' || tema.kind === 'main') continue;
    if (fs.existsSync(path.join(brainDir, ...dataRel(brainDir, 'topicHidden', id).split('/')))) { plan.clash.push(id); continue; }
    const files = [...topicFiles(brainDir, id), ...filesIn(path.join(root, id, L.topicTmp)).map((f) => `${L.topicTmp}/${f}`)];
    if (files.length) plan.other.push({ id, files });
    else plan.archive.push(id);
  }
  return plan;
}

/** The move of the plan's topics into the hidden archive, one commit. Returns the result of brainWrite or null. */
export function archiveClosed(ctx, plan) {
  if (!plan.archive.length) return null;
  const L = layoutOf(ctx.brainDir);
  // An empty tmp/ (no file inside, outside git) would move along: it is removed first.
  for (const id of plan.archive) {
    const tmp = path.join(ctx.brainDir, ...L.topics.split('/'), id, L.topicTmp);
    if (fs.existsSync(tmp) && !filesIn(tmp).length) fs.rmSync(tmp, { recursive: true });
  }
  const ops = plan.archive.map((id) => ({ from: dataRel(ctx.brainDir, 'topics', id), to: dataRel(ctx.brainDir, 'topicHidden', id) }));
  return brainWrite(ctx, { ops, internal: true, message: `done --archive-closed: ${plan.archive.length} closed topic(s) with only the handover into ${L.topicHidden}/ (D-0060)` });
}

export function formatClosedPlan(brainDir, plan, { dry = false } = {}) {
  const L = layoutOf(brainDir);
  const lines = [`brain ${brainDir}: closed topics with only ${L.handover} and ${L.topicFile}: ${plan.archive.length}${dry ? ' (dry run, nothing moved)' : ''}`];
  if (plan.archive.length) lines.push(`  ${dry ? 'would move' : 'moved'} to ${L.topicHidden}/: ${plan.archive.join(', ')}`);
  if (plan.other.length) {
    lines.push(`closed topics with other work, they stay in ${L.topics}/ (${plan.other.length}):`);
    for (const o of plan.other) lines.push(`  ${o.id}: ${o.files.length} file(s): ${o.files.slice(0, 5).join(', ')}${o.files.length > 5 ? ', …' : ''}`);
  }
  if (plan.clash.length) lines.push(`closed topics whose id ${L.topicHidden}/ has already, they stay (${plan.clash.length}): ${plan.clash.join(', ')}`);
  return lines.join('\n');
}
