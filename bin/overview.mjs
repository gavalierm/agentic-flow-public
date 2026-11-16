#!/usr/bin/env node
// The supervisor's overview without an agent (flow v2 spec 3.9, 4.2.2, 12.1; plan B6, O6, O23): the state of every open
// topic of every domain of this machine (.tema.json and handover, layout of each brain): stuck steps, idle locks, topics
// hotovo without work outside mode discussion. Read only.
//   overview.mjs [--root <projects root>] [--now <iso>]   print the overview (exit 0)
//   overview.mjs wake [--project <dir>] [--now <iso>]     job `overview` of the wake module (wake.json, written by
//                                                         adapter.mjs claude-code / project.mjs t3, every policy
//                                                         overview.interval_min): a new finding mails the supervisor
//                                                         (policy supervisor.comms, level assist, one message replaces the
//                                                         unpicked one); no new finding, no mail
//   overview.mjs --pre-release [--root <projects root>] [--no-mail]
//                                                         readiness check before the release of 2.0 (spec 11.4, plan
//                                                         B19, scripts/pre-release.mjs): live topics without a step or a
//                                                         question, topic work not on origin, open P-055/P-075 mail,
//                                                         brains in layout 1; lists the domains still to migrate to
//                                                         layout 3 with the commands. Exit 1 while a finding is left.
import { parseArgs, fail } from '../scripts/util.mjs';
import { loadContext } from '../scripts/config.mjs';
import { runClient, commsSettings, supervisorOf, parseAddress } from '../scripts/comms.mjs';
import { overview, overviewLines, findingLine, findingKey, newFindings, readOverviewState, writeOverviewState } from '../scripts/overview.mjs';
import { preRelease, preReleaseLines } from '../scripts/pre-release.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'show';
const now = typeof args.now === 'string' ? Date.parse(args.now) : Date.now();
const out = (s) => process.stdout.write(`${s}\n`);
const root = typeof args.root === 'string' ? args.root : null;

try {
  if (cmd === 'show' && args['pre-release']) {
    let ctx = null;
    try { ctx = loadContext({ project: args.project, requireBrain: false }); } catch { ctx = null; }
    const res = preRelease({ root, ctx, mail: !args['no-mail'] });
    if (!res.root && !res.brains) fail('overview --pre-release: no projects root of this machine (project.mjs root <dir>) and no domain above this folder; give --root <dir>');
    for (const l of preReleaseLines(res)) out(l);
    process.exitCode = res.findings.length ? 1 : 0;
  } else if (cmd === 'show') {
    let ctx = null;
    try { ctx = loadContext({ project: args.project, requireBrain: false }); } catch { ctx = null; }
    const res = overview({ root, ctx, now });
    if (!res.root && !res.brains) fail('overview: no projects root of this machine (project.mjs root <dir>) and no domain above this folder; give --root <dir>');
    for (const l of overviewLines(res)) out(l);
  } else if (cmd === 'wake') {
    // Code without a thread id: the mail goes out as the project, never as an inherited thread.
    delete process.env.WORKFLOW_THREAD_ID;
    delete process.env.T3CODE_THREAD_ID;
    const ctx = loadContext({ project: args.project, requireBrain: false });
    const res = overview({ root, ctx, now });
    const fresh = newFindings(res.findings, readOverviewState());
    const keys = res.findings.map(findingKey);
    if (!fresh.length) {
      writeOverviewState({ keys, at: new Date(now).toISOString() });
      out(`overview: ${res.findings.length ? `${res.findings.length} finding(s), none new` : 'nothing waits'}; the supervisor is not woken`);
    } else {
      const sup = supervisorOf(ctx.policy);
      const s = commsSettings(ctx);
      const addr = sup.comms ? parseAddress(sup.comms, s.project) : null;
      if (!addr) fail(`overview: ${fresh.length} new finding(s), but no supervisor address (brain.mjs supervisor --comms <address>); nothing sent`);
      const to = addr.persona ? ['--persona', addr.persona] : ['--project', addr.project, '--topic', addr.topic];
      const text = [`Prehľad supervisora (overview.mjs, spec 3.9): ${fresh.length} nový nález(y), spolu ${res.findings.length}.`, ...res.findings.map((f) => `- ${findingLine(f)}`)].join('\n');
      const sent = runClient(ctx, ['send', '--text', '-', '--level', 'assist', ...to, '--supersede-key', 'overview'], { input: text, timeoutMs: 10000 });
      if (!sent.ok) fail(`overview: ${fresh.length} new finding(s), mail to ${sup.comms} failed (${sent.error}); the next run tries again`);
      // Only a sent mail records the findings: a failed one is tried again at the next run.
      writeOverviewState({ keys, at: new Date(now).toISOString() });
      out(`overview: ${fresh.length} new finding(s) mailed to ${sup.comms}${sent.data?.id ? ` (${sent.data.id})` : ''}`);
    }
  } else {
    fail('usage: overview.mjs [--root <dir>] | wake [--project <dir>]');
  }
} catch (err) {
  fail(`overview: ${err.message}`);
}
