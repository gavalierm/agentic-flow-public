// report-ef63d010: `.mcp.json` `${VAR}` with the value only in settings env stays literal; the boot names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { mcpEnvNote, mcpRefs } from '../scripts/mcp-env.mjs';

function writeProject(dir, { mcp, local, shared }) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (mcp) fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(mcp));
  if (local) fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(local));
  if (shared) fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(shared));
}

const MCP = { mcpServers: { seo: { command: 'npx', args: ['-y', 'seo-mcp'], env: { API_USER: '${SEO_USER}', API_PASS: '${SEO_PASS}', MODE: '${SEO_MODE:-live}' } } } };

test('mcpRefs: names without a default, per server', () => {
  assert.deepEqual(mcpRefs(MCP), [{ server: 'seo', vars: ['SEO_PASS', 'SEO_USER'] }]);
  assert.deepEqual(mcpRefs({}), []);
});

test('boot names a .mcp.json variable defined only in settings.local.json env, without its value (report-ef63d010)', () => {
  const fx = setup();
  try {
    writeProject(fx.project, { mcp: MCP, local: { env: { SEO_USER: 'secret-user-value', SEO_PASS: 'secret-pass-value' } } });
    const r = fx.hook('session-start.mjs', { source: 'startup' }, { env: { SEO_USER: 'secret-user-value', SEO_PASS: 'secret-pass-value' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.context, /mcp: server seo in \.mcp\.json gets the literal \$\{…\} for SEO_PASS \(only in \.claude\/settings\.local\.json env\), SEO_USER \(only in/);
    assert.doesNotMatch(r.context, /secret-(user|pass)-value/);
  } finally { fx.cleanup(); }
});

test('unset variable is named; one from the launch environment or with a default is not', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'mcp-env-'));
  try {
    writeProject(dir, { mcp: MCP });
    assert.match(mcpEnvNote(dir, { SEO_USER: 'x' }), /SEO_PASS \(unset\)$|SEO_PASS \(unset\);/);
    assert.doesNotMatch(mcpEnvNote(dir, { SEO_USER: 'x' }), /SEO_USER|SEO_MODE/);
    assert.equal(mcpEnvNote(dir, { SEO_USER: 'x', SEO_PASS: 'y' }), null);
    assert.equal(mcpEnvNote(fs.mkdtempSync(path.join(dir, 'none-')), {}), null, 'no .mcp.json');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
