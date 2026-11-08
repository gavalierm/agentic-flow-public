#!/usr/bin/env node
// materialy.mjs record <súbor> --from <odkiaľ> [--topic <téma>]   záznam veľkého súboru (nad limitom) namiesto súboru v gite
//               check                                              súbory v materialy/ nad limitom (kód 1, ak nejaké sú)
// Materiály témy: materialy/<téma>/ v repe projektu (pravidlo P-062, skill materialy).
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { heldTopics } from '../scripts/topic.mjs';
import { recordBigFile, oversized, maxBytes } from '../scripts/materialy.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd, file] = args._;
const out = (s) => process.stdout.write(`${s}\n`);

try {
  const ctx = loadContext({ project: args.project });
  if (cmd === 'record') {
    if (!file) fail('usage: materialy.mjs record <súbor> --from <odkiaľ> [--topic <téma>]');
    const topic = typeof args.topic === 'string' ? args.topic : (ctx.brainDir ? heldTopics(ctx.brainDir, ctx.thread)[0]?.id : null);
    if (!topic) fail('chýba téma: --topic <téma> (vlákno nedrží žiadnu)');
    const { file: rec, record } = recordBigFile(ctx.projectDir, topic, file, { from: typeof args.from === 'string' ? args.from : null });
    out(`záznam: ${rec}\n${record.size} B, sha256 ${record.sha256.slice(0, 12)}…; súbor ostal ${record.stored_at}; do gitu patrí iba záznam`);
  } else if (cmd === 'check') {
    const big = oversized(ctx.projectDir, ctx.policy);
    if (!big.length) out(`ok: v materialy/ nič nad ${maxBytes(ctx.policy) / 1048576} MB`);
    else {
      for (const b of big) out(`nad limitom: ${b.path} (${(b.size / 1048576).toFixed(0)} MB)`);
      fail(`${big.length} súbor(ov) nad ${maxBytes(ctx.policy) / 1048576} MB: presuň ich mimo gitu (stiahnuté do scratch/) a zaznamenaj cez record`);
    }
  } else {
    fail('usage: materialy.mjs record <súbor> --from <odkiaľ> [--topic <téma>] | check');
  }
} catch (err) {
  fail(err.message);
}
