// Shared fixture of the report intake tests (3b, D-0022, D-0024): a maintainer project with three held notices (its
// report topic, a feature topic, another project's report topic), a fake `t3 thread start`, cron env without a thread.
import fs from 'node:fs';
import path from 'node:path';
import { setup, PLUGIN_ROOT } from '../helpers.mjs';

export const STUB = path.join(PLUGIN_ROOT, 'tests', 'fixtures', 'comms-stub.mjs');
// Cron: no thread id and no harness variables (the tests themselves may run inside an agent's shell).
export const CRON = { WORKFLOW_THREAD_ID: '', T3CODE_THREAD_ID: '', CLAUDECODE: '', CODEX_HOME: '', CODEX_SANDBOX: '', CODEX_THREAD_ID: '' };
export const TOPIC = 'report-0123abcd';
export const FUTURE = '2999-01-01T00:00:00.000Z';
export const REPORT_TEXT = 'title: grep fails\n\nchyba: tajný obsah hlásenia';

/** Fake `t3 thread start`: logs every call, prints a thread id; fails while the file `t3-fail` exists. */
export function fakeT3(fx) {
  const log = path.join(fx.root, 't3-calls.jsonl');
  const failFlag = path.join(fx.root, 't3-fail');
  const file = path.join(fx.root, 'fake-t3.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';\nconst input = fs.readFileSync(0, 'utf8');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nif (fs.existsSync(${JSON.stringify(failFlag)})) { console.error('t3: server not reachable'); process.exit(1); }\nconsole.log(JSON.stringify({ threadId: 'mcp:launch:rt1' }));\n`);
  fs.writeFileSync(path.join(fx.brain, 'policy.json'), JSON.stringify({ topics: { thread_start_command: `${process.execPath} ${file}` } }));
  return {
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    fail: (on) => (on ? fs.writeFileSync(failFlag, '1') : fs.rmSync(failFlag, { force: true })),
  };
}

/** `config` goes to the project's local/workflow.json (e.g. its own mail project name). */
export function fixture({ expires = FUTURE, outcome = null, config = null } = {}) {
  const fx = setup();
  const stateFile = path.join(fx.root, 'stub-state.json');
  const notice = (id, project, topic, mid) => ({ id, kind: 'unregistered-topic', state: 'open', project, topic, message_id: mid, text: REPORT_TEXT, title: `new topic ${topic}?` });
  fs.writeFileSync(stateFile, JSON.stringify({
    notices: [notice('n-1', 'project', TOPIC, 'm-1'), notice('n-2', 'project', 'feature-x', 'm-2'), notice('n-3', 'elsewhere', 'report-89abcdef', 'm-3')],
    message: {
      'm-1': { id: 'm-1', state: 'held', project: 'project', topic: TOPIC, expires_at: expires, outcome },
      'm-2': { id: 'm-2', state: 'held', project: 'project', topic: 'feature-x', expires_at: FUTURE, outcome: null },
      'm-3': { id: 'm-3', state: 'held', project: 'elsewhere', topic: 'report-89abcdef', expires_at: FUTURE, outcome: null },
    },
  }));
  if (config) {
    fs.mkdirSync(path.join(fx.project, 'local'), { recursive: true });
    fs.writeFileSync(path.join(fx.project, 'local', 'workflow.json'), JSON.stringify(config));
  }
  Object.assign(fx.env, { WORKFLOW_COMMS_CLIENT: STUB, STUB_COMMS_STATE: stateFile, STUB_COMMS_LOG: path.join(fx.root, 'stub-log.jsonl') });
  fx.state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fx.setState = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...fx.state(), ...patch }));
  fx.calls = () => (fs.existsSync(fx.env.STUB_COMMS_LOG) ? fs.readFileSync(fx.env.STUB_COMMS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  fx.intake = (env = {}) => fx.run('report-intake.mjs', [], { env: { ...CRON, ...env } });
  fx.log = () => (fx.exists('local/report-intake.log') ? fx.read('local/report-intake.log') : '');
  return fx;
}
